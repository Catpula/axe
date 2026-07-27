/**
 * Prompts the agent asked to be woken with, and when.
 *
 * A schedule is a thread id plus a prompt plus a time, because resuming is
 * already solved: `axe -c <thread> -x <prompt>` replays the transcript through
 * `Thread.recover()`, so a wake-up continues where the turn stopped with its
 * full history. Nothing here needs to store context.
 *
 * Nothing here runs in the background either. The OS scheduler calls
 * `axe schedule run`, which fires whatever is due and exits. A daemon would be
 * a process to supervise, and axe is a CLI.
 */
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { atomicWrite } from "../artifacts.ts"
import { AXE_HOME, Thread } from "./thread.ts"

const FILE = join(AXE_HOME, "schedules.json")
const FILE_MODE = 0o600

/** How far back a cron sweep looks, so a schedule missed while the machine slept still fires once. */
const CATCHUP_MS = 60 * 60 * 1000

export type Schedule = {
	id: string
	/** `"0 9 * * *"` or `"every 10m"`. */
	when: string
	prompt: string
	cwd: string
	threadId: string
	createdAt: string
	lastRun?: string
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Null for anything that would never fire, so `add` can refuse it. */
export function parseWhen(expr: string): { kind: "every"; ms: number } | { kind: "cron" } | null {
	const every = /^every\s+(\d+)\s*([mhd])$/i.exec(expr.trim())
	if (every) {
		const n = Number(every[1])
		if (n <= 0) return null
		return { kind: "every", ms: n * UNIT_MS[every[2]!.toLowerCase()]! }
	}
	return cronFields(expr) ? { kind: "cron" } : null
}

const RANGES: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
]

/** Each of the five fields as the set of values it allows, or null if unparseable. */
function cronFields(expr: string): Set<number>[] | null {
	const fields = expr.trim().split(/\s+/)
	if (fields.length !== 5) return null
	const out: Set<number>[] = []
	for (let i = 0; i < 5; i++) {
		const [lo, hi] = RANGES[i]!
		const allowed = new Set<number>()
		for (const term of fields[i]!.split(",")) {
			const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term)
			if (!m) return null
			const step = m[2] ? Number(m[2]) : 1
			if (step <= 0) return null
			let from = lo
			let to = hi
			if (m[1] !== "*") {
				const [a, b] = m[1]!.split("-")
				from = Number(a)
				to = b === undefined ? Number(a) : Number(b)
				// A step over a single value means "from here to the end", the way
				// `0/15` reads in crontab.
				if (b === undefined && m[2]) to = hi
			}
			if (from < lo || to > hi || from > to) return null
			for (let v = from; v <= to; v += step) allowed.add(v)
		}
		if (!allowed.size) return null
		out.push(allowed)
	}
	return out
}

export function matchesCron(expr: string, date: Date): boolean {
	const fields = cronFields(expr)
	if (!fields) return false
	// Day-of-month and day-of-week are an OR in crontab when both are restricted,
	// which is the one rule in cron nobody guesses right.
	const domRestricted = fields[2]!.size !== 31
	const dowRestricted = fields[4]!.size !== 7
	const dom = fields[2]!.has(date.getDate())
	const dow = fields[4]!.has(date.getDay())
	const day = domRestricted && dowRestricted ? dom || dow : dom && dow
	return (
		fields[0]!.has(date.getMinutes()) &&
		fields[1]!.has(date.getHours()) &&
		fields[3]!.has(date.getMonth() + 1) &&
		day
	)
}

export function isDue(s: Schedule, now: Date = new Date()): boolean {
	const parsed = parseWhen(s.when)
	if (!parsed) return false
	const last = s.lastRun ? Date.parse(s.lastRun) : Number.NaN
	if (parsed.kind === "every") {
		// Never run is due now: the agent asked for this and waiting a full
		// interval first would make `every 1d` silent for a day.
		return !Number.isFinite(last) || now.getTime() - last >= parsed.ms
	}
	// ponytail: sweeps at most CATCHUP_MS of minutes backwards, which is enough
	// for a scheduler ticking every minute or every five. If a lid closed for
	// half a day must still fire, compute the next run forwards and store it on
	// the record instead.
	const floor = Number.isFinite(last) ? last + 60_000 : now.getTime() - CATCHUP_MS
	const from = Math.max(floor, now.getTime() - CATCHUP_MS)
	for (let t = Math.floor(now.getTime() / 60_000) * 60_000; t >= from; t -= 60_000) {
		if (matchesCron(s.when, new Date(t))) return true
	}
	return false
}

/** A state file nobody can read is not a reason to fail a session. */
export async function loadSchedules(): Promise<Schedule[]> {
	try {
		const parsed = JSON.parse(await readFile(FILE, "utf8"))
		return Array.isArray(parsed) ? parsed.filter(valid) : []
	} catch {
		return []
	}
}

function valid(s: unknown): s is Schedule {
	if (!s || typeof s !== "object") return false
	const r = s as Record<string, unknown>
	return (
		typeof r.id === "string" &&
		typeof r.when === "string" &&
		typeof r.prompt === "string" &&
		typeof r.cwd === "string" &&
		typeof r.threadId === "string"
	)
}

export async function saveSchedules(list: Schedule[]): Promise<void> {
	await mkdir(AXE_HOME, { recursive: true, mode: 0o700 })
	// Rename, not link: this file is replaced far more often than created, and a
	// rename covers both cases.
	await atomicWrite(FILE, `${JSON.stringify(list, null, "\t")}\n`, FILE_MODE, false)
}

export async function addSchedule(
	init: Omit<Schedule, "id" | "createdAt">,
): Promise<Schedule> {
	if (!parseWhen(init.when)) {
		throw new Error(`Cannot schedule "${init.when}": want a 5-field cron expression or "every 10m".`)
	}
	if (!init.prompt.trim()) throw new Error("A schedule needs a prompt.")
	const schedule: Schedule = {
		id: randomBytes(4).toString("hex"),
		createdAt: new Date().toISOString(),
		...init,
	}
	await saveSchedules([...(await loadSchedules()), schedule])
	return schedule
}

/** False when no schedule had that id, so the caller can say so. */
export async function removeSchedule(id: string): Promise<boolean> {
	const list = await loadSchedules()
	const left = list.filter((s) => s.id !== id)
	if (left.length === list.length) return false
	await saveSchedules(left)
	return true
}

export type FireReport = { fired: Schedule[]; dropped: Schedule[] }

/**
 * Fires everything due and returns. Each wake-up is a detached `axe -c <thread>
 * -x <prompt>`, so it outlives this process and the scheduler's tick is over in
 * milliseconds no matter how long the work takes.
 */
export async function runDue(now: Date = new Date()): Promise<FireReport> {
	const list = await loadSchedules()
	const report: FireReport = { fired: [], dropped: [] }
	if (!list.length) return report

	const keep: Schedule[] = []
	for (const s of list) {
		if (!isDue(s, now)) {
			keep.push(s)
			continue
		}
		// A thread that is gone cannot be resumed, and a schedule pointing at one
		// would fire forever with nothing to continue.
		if (!(await Thread.find(s.threadId))) {
			report.dropped.push(s)
			continue
		}
		report.fired.push(s)
		keep.push({ ...s, lastRun: now.toISOString() })
	}
	// Saved before anything is spawned: two overlapping scheduler ticks would
	// otherwise both see the same schedule as due and run the prompt twice.
	if (report.fired.length || report.dropped.length) await saveSchedules(keep)
	for (const s of report.fired) wake(s)
	return report
}

/**
 * The argv a wake-up runs with, as a value rather than as a side effect.
 *
 * A schedule's whole job is to fire the right command, and the only way to check
 * that by spawning is to spawn — which costs a process per case and can only
 * observe what the process happens to print. Built here so it can be asserted on
 * directly: `-c <thread>` is what routes the prompt through `Thread.recover()`,
 * and `-x` is what makes it exit instead of opening a REPL nobody is at.
 */
export function wakeArgs(s: Schedule): string[] {
	return [...execArgv(), CLI, "-c", s.threadId, "-x", s.prompt]
}

function wake(s: Schedule): void {
	const child = spawn(process.execPath, wakeArgs(s), {
		cwd: s.cwd,
		detached: true,
		stdio: "ignore",
	})
	child.on("error", () => {})
	child.unref()
}

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url))

/** A compiled binary needs no loader flag; running from source does. */
function execArgv(): string[] {
	return CLI.endsWith(".ts") ? ["--experimental-strip-types", "--no-warnings"] : []
}

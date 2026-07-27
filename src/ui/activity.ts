import { displayWidth, fitCells, formatElapsed, padBetween } from "./cells.ts"

/**
 * What the agent is doing right now, as a list rather than as a sentence.
 *
 * A single status row can say "Working" and nothing else. It cannot say that
 * four file reads are in flight, that one of them is a subagent, or that the
 * subagent has been on the same grep for forty seconds. That is the whole
 * reason this exists: a turn is a tree of concurrent work, and the only honest
 * way to show a tree is to show its rows.
 *
 * Nothing here touches a terminal. Everything is a pure function or a plain
 * class, so the tests can drive it without a TTY.
 */

export type ActivityKind = "tool" | "agent"

export type Activity = {
	id: string
	kind: ActivityKind
	/** Tool name, or the subagent's role. */
	name: string
	/** The one thing that makes this row different from the row above it. */
	subject: string
	/** The agent that spawned it, if any. Indents the row one level. */
	parent?: string
	startedAt: number
	endedAt?: number
	ok?: boolean
}

export type ActivityStart = Omit<Activity, "startedAt" | "endedAt" | "ok">

/**
 * How long a finished row stays on screen. Without it a fast tool appears and
 * vanishes inside one frame, which reads as a flicker rather than as work
 * completed.
 */
export const LINGER_MS = 800

export class ActivityTracker {
	private readonly items = new Map<string, Activity>()

	start(a: ActivityStart, now: number = Date.now()): void {
		// Starting the same id updates what the work is called without creating a
		// duplicate row. `task` uses this when its generic tool row becomes a
		// concrete subagent role such as `search`.
		this.items.set(a.id, { ...a, startedAt: this.items.get(a.id)?.startedAt ?? now })
	}

	get(id: string): Activity | undefined {
		return this.items.get(id)
	}

	/** Finishing something unknown is a no-op: a late end must not resurrect a row. */
	finish(id: string, ok: boolean, now: number = Date.now()): void {
		const item = this.items.get(id)
		if (!item || item.endedAt !== undefined) return
		item.endedAt = now
		item.ok = ok
	}

	/**
	 * Rows worth drawing: everything running, plus whatever finished recently
	 * enough to still be worth a tick mark. Children follow their parent, so the
	 * indentation reads as the tree it is.
	 */
	live(now: number = Date.now()): Activity[] {
		const fresh: Activity[] = []
		for (const item of this.items.values()) {
			if (item.endedAt !== undefined && now - item.endedAt >= LINGER_MS) {
				this.items.delete(item.id)
				continue
			}
			fresh.push(item)
		}
		fresh.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

		const children = new Map<string, Activity[]>()
		const roots: Activity[] = []
		for (const item of fresh) {
			// An orphan is a root. A child whose parent already aged out would
			// otherwise disappear while it is still running.
			if (item.parent !== undefined && this.items.has(item.parent)) {
				const list = children.get(item.parent) ?? []
				list.push(item)
				children.set(item.parent, list)
			} else {
				roots.push(item)
			}
		}

		const out: Activity[] = []
		for (const root of roots) {
			out.push(root)
			for (const child of children.get(root.id) ?? []) out.push(child)
		}
		return out
	}

	clear(): void {
		this.items.clear()
	}
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function spinnerFrame(frame: number): string {
	return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length]!
}

const BAR_TRACK = "─"
const BAR_BLOCK = "━"
const BAR_BLOCK_WIDTH = 3

/**
 * An indeterminate progress bar: a block that slides to the right edge and back.
 * Indeterminate on purpose — no tool tells us how far along it is, and a bar
 * that invents a percentage is worse than a bar that admits it does not know.
 */
export function slideBar(width: number, frame: number): string {
	if (width < BAR_BLOCK_WIDTH + 1) return BAR_TRACK.repeat(Math.max(0, width))
	const span = width - BAR_BLOCK_WIDTH
	const period = span * 2
	const step = ((frame % period) + period) % period
	const at = step <= span ? step : period - step
	return BAR_TRACK.repeat(at) + BAR_BLOCK.repeat(BAR_BLOCK_WIDTH) + BAR_TRACK.repeat(span - at)
}

/** Sub-second work is real work, and "0s" makes it look like nothing happened. */
export function formatDuration(ms: number): string {
	const clamped = Math.max(0, ms)
	if (clamped < 10_000) return `${(clamped / 1_000).toFixed(1)}s`
	return formatElapsed(clamped / 1_000)
}

const BAR_WIDTH = 12
/** Below this there is no room for a bar, and the subject matters more. */
const BAR_MIN_ROW = 44

/**
 * One panel row, already clamped to exactly `width` cells.
 *
 * Colour is applied by the caller, not here: this returns plain text so its
 * width is the width it claims, and so the tests can read it.
 */
export function activityRow(a: Activity, now: number, frame: number, width: number): string {
	const indent = a.parent === undefined ? " " : "   "
	const running = a.endedAt === undefined
	const icon = running ? spinnerFrame(frame) : a.ok ? "✓" : "✗"
	const elapsed = formatDuration((a.endedAt ?? now) - a.startedAt)
	const head = `${indent}${icon} ${a.name}`
	const bar = running && width >= BAR_MIN_ROW ? `${slideBar(BAR_WIDTH, frame)}  ` : ""
	const tail = `${bar}${elapsed} `

	const room = width - displayWidth(head) - displayWidth(tail) - 2
	const subject = a.subject && room >= 4 ? ` ${clamp(a.subject, room)}` : ""
	return padBetween(`${head}${subject}`, tail, width)
}

function clamp(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ").trim()
	if (displayWidth(flat) <= width) return flat
	return `${fitCells(flat, Math.max(1, width - 1)).trimEnd()}…`
}

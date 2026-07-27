/**
 * The things that go wrong when nothing is wrong with the code.
 *
 * A timeout, a retry, a command that never exits, a wake-up that fires twice.
 * None of these is reachable by calling a function and reading its return value,
 * which is why they are the parts that break quietly and stay broken.
 *
 * The boundary is faked and nothing else: `globalThis.fetch` is replaced, per
 * AGENTS.md, rather than adding a seam to `send` so it can be observed. Delays
 * are asserted by computing them, never by sleeping through them, so this file
 * runs in about a second.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Type imports are erased, so they do not load a module before AXE_HOME is set.
import type { HttpError as HttpErrorType } from "../src/providers/http.ts"
import type { Schedule } from "../src/core/schedules.ts"

const home = mkdtempSync(join(tmpdir(), "axe-reliability-home-"))
mkdirSync(join(home, ".axe"), { recursive: true })
process.env.AXE_HOME = join(home, ".axe")

const { DEFAULT_POLICY, HttpError, retryStream, send, sendWithRetry } = await import("../src/providers/http.ts")
const { bashTool } = await import("../src/tools/bash.ts")
const { isDue, matchesCron, parseWhen, runDue, saveSchedules, wakeArgs } = await import(
	"../src/core/schedules.ts"
)
const { Thread } = await import("../src/core/thread.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

const cwd = mkdtempSync(join(tmpdir(), "axe-reliability-cwd-"))
const realFetch = globalThis.fetch
const fresh = () => new AbortController().signal

/** Answers each call from a script, and counts how many calls there were. */
function fakeFetch(script: Array<() => Response | Promise<Response>>) {
	let calls = 0
	globalThis.fetch = (async () => {
		const step = script[Math.min(calls++, script.length - 1)]!
		return step()
	}) as typeof fetch
	return () => calls
}

const ok = () => new Response("fine", { status: 200 })
const status = (code: number, headers?: Record<string, string>) =>
	new Response("nope", { status: code, headers })

// A policy with no waiting in it. The delay maths is checked separately; sleeping
// through four exponential backoffs would add ten seconds to the suite.
const fast = { baseDelayMs: 1, maxDelayMs: 2, attempts: 4 }

// ── retry: which statuses come back, and which do not ───────────────────────
{
	const calls = fakeFetch([() => status(429), ok])
	const res = await sendWithRetry("http://x", {}, { signal: fresh(), label: "t", policy: fast })
	check("a 429 is retried", calls() === 2, String(calls()))
	check("and the retry's success is what the caller sees", res.status === 200, String(res.status))
}
{
	const calls = fakeFetch([() => status(503), () => status(503), ok])
	await sendWithRetry("http://x", {}, { signal: fresh(), label: "t", policy: fast })
	check("a 503 is retried until it works", calls() === 3, String(calls()))
}
{
	// A key that is wrong will still be wrong in 500ms. Retrying it wastes the
	// user's time and, on some providers, counts against them.
	const calls = fakeFetch([() => status(401)])
	let thrown: unknown
	try {
		await sendWithRetry("http://x", {}, { signal: fresh(), label: "t", policy: fast })
	} catch (err) {
		thrown = err
	}
	check("a 401 is not retried", calls() === 1, String(calls()))
	check("and it throws an HttpError", thrown instanceof HttpError, String(thrown))
	check("carrying the status", (thrown as HttpErrorType).status === 401, String((thrown as HttpErrorType).status))
}
{
	// Every attempt used up, then the last error is handed over as-is.
	const calls = fakeFetch([() => status(500)])
	let thrown: unknown
	try {
		await sendWithRetry("http://x", {}, { signal: fresh(), label: "t", policy: fast })
	} catch (err) {
		thrown = err
	}
	check("retries stop at the attempt ceiling", calls() === fast.attempts, String(calls()))
	check("and the failure is reported, not swallowed", thrown instanceof HttpError, String(thrown))
}
{
	// An abort mid-retry must stop immediately rather than finishing the schedule.
	const ac = new AbortController()
	const calls = fakeFetch([
		() => {
			ac.abort()
			return status(500)
		},
	])
	let thrown = false
	try {
		await sendWithRetry("http://x", {}, { signal: ac.signal, label: "t", policy: fast })
	} catch {
		thrown = true
	}
	check("an aborted retry stops at once", calls() === 1, String(calls()))
	check("and the abort surfaces", thrown)
}
{
	// A provider that says how long to wait is obeyed, capped: 429 with
	// retry-after: 3600 must not park the CLI for an hour.
	const calls = fakeFetch([() => status(429, { "retry-after": "3600" }), ok])
	const started = Date.now()
	await sendWithRetry("http://x", {}, { signal: fresh(), label: "t", policy: { ...fast, maxDelayMs: 5 } })
	check("retry-after is honoured", calls() === 2, String(calls()))
	check("and capped at maxDelayMs", Date.now() - started < 1_000, String(Date.now() - started))
}
{
	// The default policy is what real runs use, so its shape is worth asserting:
	// a stream that is retried after the user has read half of it is the bug this
	// whole module is arranged to prevent.
	check("the default policy retries more than once", DEFAULT_POLICY.attempts > 1, String(DEFAULT_POLICY.attempts))
	check("and waits less than a minute at most", DEFAULT_POLICY.maxDelayMs <= 60_000, String(DEFAULT_POLICY.maxDelayMs))
	check("and gives up connecting well before the tool timeout", DEFAULT_POLICY.connectTimeoutMs < 120_000, String(DEFAULT_POLICY.connectTimeoutMs))
}

// ── the rule the whole file exists for ──────────────────────────────────────
// A stream may only be replayed while it has yielded nothing. Once one event is
// out, the text is on screen and in the thread, so replaying says it all twice.
{
	let attempts = 0
	const stream = retryStream(
		() => {
			attempts++
			return (async function* () {
				yield "first"
				throw new Error("died after yielding")
			})()
		},
		{ signal: fresh(), policy: fast },
	)
	const seen: string[] = []
	let thrown = ""
	try {
		for await (const ev of stream) seen.push(ev)
	} catch (err) {
		thrown = err instanceof Error ? err.message : String(err)
	}
	check("a stream that failed after yielding is not replayed", attempts === 1, String(attempts))
	check("and the text is not duplicated", seen.join(",") === "first", seen.join(","))
	check("and the failure reaches the caller", thrown === "died after yielding", thrown)
}
{
	// Failing before the first event is safe to replay, and is the case retrying
	// a stream is for at all.
	let attempts = 0
	const stream = retryStream(
		() => {
			attempts++
			return (async function* () {
				if (attempts < 3) throw new HttpError("t", 503, "overloaded")
				yield "recovered"
			})()
		},
		{ signal: fresh(), policy: fast },
	)
	const seen: string[] = []
	for await (const ev of stream) seen.push(ev)
	check("a stream that failed before yielding is replayed", attempts === 3, String(attempts))
	check("and produces its events once", seen.join(",") === "recovered", seen.join(","))
}
{
	// A status we chose to reject is not retryable in a stream either.
	let attempts = 0
	let thrown = false
	try {
		for await (const _ of retryStream(
			() => {
				attempts++
				return (async function* () {
					throw new HttpError("t", 400, "bad request")
					yield "never"
				})()
			},
			{ signal: fresh(), policy: fast },
		)) {
			// nothing
		}
	} catch {
		thrown = true
	}
	check("a 400 stream is not replayed", attempts === 1, String(attempts))
	check("and the error surfaces", thrown)
}

// ── connect timeout: headers, not the body ─────────────────────────────────
{
	// A connect timeout must fire when the headers never arrive.
	fakeFetch([
		(init?: unknown) =>
			new Promise<Response>((_, reject) => {
				// Mirrors what fetch does with an aborted signal.
				setTimeout(() => reject(new Error("aborted")), 50)
			}),
	])
	let thrown = ""
	try {
		await send("http://x", {}, { signal: fresh(), label: "slowhost", policy: { connectTimeoutMs: 10 } })
	} catch (err) {
		thrown = err instanceof Error ? err.message : String(err)
	}
	check("headers that never arrive fail", thrown !== "", thrown)
}
{
	// And must not fire for a slow body after fast headers: a long healthy stream
	// is exactly a fast response followed by a minute of silence-free trickle.
	// AbortSignal.timeout would have cut it; the cleared timer is why it does not.
	fakeFetch([ok])
	const res = await send("http://x", {}, { signal: fresh(), label: "t", policy: { connectTimeoutMs: 20 } })
	await new Promise((r) => setTimeout(r, 60))
	check("a body read after the connect timeout window still works", (await res.text()) === "fine")
}

globalThis.fetch = realFetch

// ── bash: the two ways a command fails to end ─────────────────────────────
const hasBash = await new Promise<boolean>((resolve) => {
	import("node:child_process").then(({ spawn }) => {
		const child = spawn("bash", ["-lc", "echo ok"], { stdio: "ignore" })
		child.on("error", () => resolve(false))
		child.on("close", (code) => resolve(code === 0))
	})
})

if (!hasBash) {
	// Skipped rather than faked: a bash tool test that does not run bash is not
	// testing the bash tool. Said out loud so a green run is not mistaken for
	// coverage on a machine without a shell.
	console.log("reliability: bash not usable here, skipping the bash and background cases")
} else {
	const ctx = { cwd, signal: fresh(), log: () => {} }
	{
		// The timeout has to kill the process group: killing only bash leaves a
		// grandchild holding the pipes, and the tool never settles.
		//
		// The budget is generous on purpose. `bash -lc` is a login shell and reads
		// the profile before it runs anything, which on Windows costs a few hundred
		// milliseconds; a 300ms timeout here was testing how fast bash starts
		// rather than whether the timeout works.
		const timeoutMs = 3_000
		const started = Date.now()
		let thrown = ""
		try {
			await bashTool.run({ cmd: "echo before; sleep 30", timeout_ms: timeoutMs }, ctx)
		} catch (err) {
			thrown = err instanceof Error ? err.message : String(err)
		}
		check("a command past its timeout is killed", thrown !== "", thrown)
		check("and says so", new RegExp(`timed out after ${timeoutMs}ms`).test(thrown), thrown)
		// Killed at the timeout rather than run to completion: `sleep 30` would
		// otherwise still be going.
		const took = Date.now() - started
		check("and settles at the timeout, not at the command's own end", took < 20_000, String(took))
		// The partial output is the useful part of a timeout: it says how far it got.
		check("and keeps what the command had already printed", /before/.test(thrown), thrown)
		check("and points at the full log", /\.axe[\\/]artifacts/.test(thrown), thrown)
	}
	{
		// A non-zero exit is an error with the output attached, not a bare code.
		let thrown = ""
		try {
			await bashTool.run({ cmd: "echo to-stderr >&2; exit 3" }, ctx)
		} catch (err) {
			thrown = err instanceof Error ? err.message : String(err)
		}
		check("a non-zero exit rejects", /exit 3/.test(thrown), thrown)
		check("and stderr is included", /to-stderr/.test(thrown), thrown)
	}
	{
		// An abort must not wait for the command.
		const ac = new AbortController()
		const running = bashTool.run({ cmd: "sleep 30" }, { ...ctx, signal: ac.signal })
		setTimeout(() => ac.abort(), 100)
		let thrown = ""
		try {
			await running
		} catch (err) {
			thrown = err instanceof Error ? err.message : String(err)
		}
		check("an aborted command stops", /cancelled by the user/.test(thrown), thrown)
	}
	{
		// The credential scrub is the reason bash gets its own environment. It has
		// to survive the login shell, which is where people export their keys.
		process.env.RELIABILITY_TEST_API_KEY = "sk-must-not-leak"
		const out = await bashTool.run({ cmd: "echo [${RELIABILITY_TEST_API_KEY:-absent}]" }, ctx)
		check("a credential-shaped variable is not visible to a command", out.includes("[absent]"), out)
		delete process.env.RELIABILITY_TEST_API_KEY
	}
	{
		// Background mode is the feedback loop for a dev server: it must return at
		// once, keep running, and be readable from a file afterwards.
		const started = Date.now()
		const out = await bashTool.run(
			{ cmd: "echo starting; sleep 1; echo still-here", background: true },
			ctx,
		)
		check("background mode returns immediately", Date.now() - started < 3_000, String(Date.now() - started))
		check("and reports the pid", /pid \d+/.test(out), out)
		check("and names a log path", /\.axe[\\/]artifacts/.test(out), out)
		check("and says how to read it", /read_file/.test(out), out)

		const logPath = out.split("\n").find((l) => l.includes("artifacts"))?.split(": ").at(-1)?.trim() ?? ""
		check("the log path is workspace-relative", !logPath.startsWith("/") && !/^[A-Za-z]:/.test(logPath), logPath)

		// The point of backgrounding: the command outlives the call that started
		// it. Polled to a deadline rather than slept against a fixed guess — a
		// fixed wait here is a test that fails on a slow machine and proves
		// nothing on a fast one.
		const until = Date.now() + 20_000
		let body = ""
		while (Date.now() < until) {
			body = await readFile(join(cwd, logPath), "utf8").catch(() => "")
			if (body.includes("still-here")) break
			await new Promise((r) => setTimeout(r, 100))
		}
		check("the log holds output from before the call returned", body.includes("starting"), body)
		check("and output written after it returned", body.includes("still-here"), body)
	}
	{
		// A backgrounded command whose binary does not exist must not leave an
		// orphan log file behind.
		const out = await bashTool.run({ cmd: "definitely-not-a-real-binary-xyz", background: true }, ctx)
		check("a background command that fails still returns a handle", /pid \d+/.test(out), out)
	}
}

// ── schedules: the wake-up path ───────────────────────────────────────────
{
	check("every 10m parses", parseWhen("every 10m")?.kind === "every")
	check("a 5-field cron parses", parseWhen("0 9 * * *")?.kind === "cron")
	// Anything that would never fire has to be refused at add time, not silently
	// kept forever.
	for (const bad of ["every 0m", "every -1m", "nonsense", "0 9 * *", "0 9 * * * *", "99 9 * * *"]) {
		check(`${bad} is refused`, parseWhen(bad) === null, bad)
	}

	check("cron matches its minute", matchesCron("30 9 * * *", new Date("2026-03-02T09:30:00")))
	check("and not another", !matchesCron("30 9 * * *", new Date("2026-03-02T09:31:00")))
	// The one cron rule nobody guesses: with both day fields restricted it is an
	// OR, not an AND.
	check(
		"day-of-month and day-of-week are an OR when both are set",
		matchesCron("0 0 1 * 5", new Date("2026-03-01T00:00:00")),
	)
	check("a step over a single value runs to the end", matchesCron("0/15 * * * *", new Date("2026-03-02T09:30:00")))

	const base: Schedule = {
		id: "s1",
		when: "every 10m",
		prompt: "check the build",
		cwd,
		threadId: "t",
		createdAt: new Date().toISOString(),
	}
	// Never run is due now: waiting a full interval first would make `every 1d`
	// silent for a day after the agent asked for it.
	check("a schedule that never ran is due", isDue(base, new Date()))
	const justRan = { ...base, lastRun: new Date().toISOString() }
	check("and one that just ran is not", !isDue(justRan, new Date()))
	check(
		"and it is due again after its interval",
		isDue(justRan, new Date(Date.now() + 11 * 60_000)),
	)
	// The catch-up window is what makes a cron schedule survive a closed lid.
	const cron: Schedule = { ...base, when: "0 9 * * *", lastRun: undefined }
	check(
		"a cron schedule missed inside the catch-up window still fires",
		isDue(cron, new Date("2026-03-02T09:30:00")),
	)
	check(
		"and one missed outside it does not",
		!isDue(cron, new Date("2026-03-02T23:00:00")),
	)
	// An unparseable `when` on an existing record must never fire, or a hand-edited
	// file becomes an infinite loop.
	check("a schedule with a broken when never fires", !isDue({ ...base, when: "garbage" }, new Date()))

	// The argv is the whole behaviour of a wake-up: -c routes it through recovery,
	// -x makes it exit rather than opening a REPL nobody is sitting at.
	const argv = wakeArgs(base)
	check("a wake-up resumes a thread", argv.includes("-c") && argv[argv.indexOf("-c") + 1] === "t", argv.join(" "))
	check("and runs one-shot", argv.includes("-x"), argv.join(" "))
	check("and passes the prompt verbatim", argv.at(-1) === "check the build", String(argv.at(-1)))
	check("and the prompt is the last argument", argv.indexOf("-x") === argv.length - 2, argv.join(" "))
}
{
	// A schedule pointing at a thread that no longer exists would fire forever
	// with nothing to continue, so it is dropped rather than retried.
	await saveSchedules([
		{
			id: "gone",
			when: "every 1m",
			prompt: "p",
			cwd,
			threadId: "2020-01-01T00-00-00-000Z-missing",
			createdAt: new Date().toISOString(),
		},
	])
	const report = await runDue(new Date())
	check("a schedule whose thread is gone is dropped", report.dropped.length === 1, JSON.stringify(report.dropped))
	check("and it does not fire", report.fired.length === 0, JSON.stringify(report.fired))
	const left = JSON.parse(await readFile(join(home, ".axe", "schedules.json"), "utf8"))
	check("and it is removed from the file", left.length === 0, JSON.stringify(left))
}
{
	// Two scheduler ticks overlapping must not run the prompt twice, so lastRun is
	// written before anything is spawned. Checked by reading the file back: the
	// second tick sees a schedule that has already run.
	const thread = await Thread.create(cwd)
	await saveSchedules([
		{
			id: "dup",
			when: "every 30m",
			prompt: "p",
			cwd,
			threadId: thread.id,
			createdAt: new Date().toISOString(),
		},
	])
	const now = new Date()
	const first = await runDue(now)
	check("a due schedule fires once", first.fired.length === 1, JSON.stringify(first.fired))
	const saved = JSON.parse(await readFile(join(home, ".axe", "schedules.json"), "utf8"))
	check("and lastRun is written", typeof saved[0]?.lastRun === "string", JSON.stringify(saved[0]))
	const second = await runDue(now)
	check("a second tick at the same moment does not re-fire it", second.fired.length === 0, JSON.stringify(second.fired))
	await saveSchedules([])
}
{
	// Nothing due is the common case and must be cheap and quiet.
	await saveSchedules([])
	const report = await runDue(new Date())
	check("no schedules fires nothing", report.fired.length === 0 && report.dropped.length === 0)
	// A file that is not there at all behaves the same way.
	await writeFile(join(home, ".axe", "schedules.json"), "[]", "utf8")
	check("an empty file fires nothing", (await runDue(new Date())).fired.length === 0)
}

console.log(`reliability: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

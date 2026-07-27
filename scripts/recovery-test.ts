/**
 * What survives a process that died in the middle of a turn.
 *
 * `Thread.recover()` is the one piece of axe whose entire job is to clean up
 * after a crash, which makes it the piece least likely to be exercised by
 * ordinary use and most likely to be wrong. The invariants it has to hold are
 * the loop's own — every `tool_use` gets a `tool_result`, in call order — except
 * that here they have to hold across a process boundary, with only the journal
 * to work from.
 *
 * The other half of the file is the state files. Three of them carry a comment
 * saying a broken one is not a reason to fail a session; none of the three had
 * anything checking that.
 *
 * No network, no provider, no API key. Journals are written by hand, because the
 * point is to write the ones a crash would leave behind.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Block, Message } from "../src/providers/types.ts"

const home = mkdtempSync(join(tmpdir(), "axe-recovery-home-"))
mkdirSync(join(home, ".axe"), { recursive: true })
process.env.AXE_HOME = join(home, ".axe")

const { Thread } = await import("../src/core/thread.ts")
const { loadConfig } = await import("../src/config.ts")
const { loadSchedules, saveSchedules } = await import("../src/core/schedules.ts")
const { readApprovals } = await import("../src/core/mcp.ts")
const { atomicWrite } = await import("../src/artifacts.ts")
const { debugLog, initDebugLog, resetDebugLog, debugRequested } = await import("../src/debuglog.ts")

const THREADS = join(home, ".axe", "threads")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

const cwd = mkdtempSync(join(tmpdir(), "axe-recovery-cwd-"))

/**
 * Writes a journal the way a crashed process would have left it: records up to
 * the point of death, and no `turn_finished`.
 */
function writeJournal(id: string, records: unknown[]): string {
	mkdirSync(THREADS, { recursive: true })
	const file = join(THREADS, `${id}.jsonl`)
	writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""))
	return file
}

function meta(id: string) {
	return { kind: "meta", id, cwd, startedAt: new Date().toISOString() }
}

function assistantWithCalls(calls: Array<{ id: string; name: string }>): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Working on it." },
			...calls.map((c): Block => ({ type: "tool_use", id: c.id, name: c.name, input: {} })),
		],
	}
}

function resultsOf(messages: Message[]): Array<Extract<Block, { type: "tool_result" }>> {
	return messages.flatMap((m) =>
		m.content.filter((b): b is Extract<Block, { type: "tool_result" }> => b.type === "tool_result"),
	)
}

// ── 1. a tool that finished before the crash keeps its real result ───────────
{
	const id = "2026-01-01T00-00-00-000Z-aaaaa"
	const turnId = "turn-finished"
	writeJournal(id, [
		meta(id),
		{ kind: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ kind: "turn_started", id: turnId, timestamp: new Date().toISOString() },
		{ kind: "message", message: assistantWithCalls([{ id: "call-1", name: "read_file" }]), turnId },
		{ kind: "tool_requested", turnId, id: "call-1", name: "read_file", timestamp: new Date().toISOString() },
		{ kind: "tool_executing", turnId, id: "call-1", name: "read_file", timestamp: new Date().toISOString() },
		{
			kind: "tool_finished",
			turnId,
			result: { type: "tool_result", id: "call-1", content: "file contents", isError: false },
			status: "completed",
		},
	])
	const report = await (await Thread.open(id)).recover()
	check("a finished tool is recovered", report.recovered)
	check("and its result is restored", report.restoredToolIds.includes("call-1"), JSON.stringify(report.restoredToolIds))
	check("and nothing is unknown", report.unknownToolIds.length === 0, JSON.stringify(report.unknownToolIds))
	const results = resultsOf(report.messages)
	check("and the real output survives", results.some((r) => r.content === "file contents"), JSON.stringify(results))
	check("and it is not marked as an error", results[0]?.isError !== true, JSON.stringify(results[0]))
}

// ── 2. a tool caught mid-execution is never replayed ────────────────────────
// This is the case the whole design turns on: bash may already have pushed a
// commit, so re-running it is worse than admitting the outcome is unknown.
{
	const id = "2026-01-01T00-00-00-000Z-bbbbb"
	const turnId = "turn-executing"
	writeJournal(id, [
		meta(id),
		{ kind: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ kind: "turn_started", id: turnId, timestamp: new Date().toISOString() },
		{ kind: "message", message: assistantWithCalls([{ id: "call-2", name: "bash" }]), turnId },
		{ kind: "tool_requested", turnId, id: "call-2", name: "bash", timestamp: new Date().toISOString() },
		{ kind: "tool_executing", turnId, id: "call-2", name: "bash", timestamp: new Date().toISOString() },
		{ kind: "file_changed", turnId, toolUseId: "call-2", path: "src/touched.ts" },
	])
	const report = await (await Thread.open(id)).recover()
	check("an interrupted tool is recovered", report.recovered)
	check("and its outcome is unknown", report.unknownToolIds.includes("call-2"), JSON.stringify(report.unknownToolIds))
	check("and it is not counted as restored", report.restoredToolIds.length === 0, JSON.stringify(report.restoredToolIds))
	const result = resultsOf(report.messages)[0]
	check("and the model is told it was not replayed", /not replayed/i.test(result?.content ?? ""), result?.content)
	check("and the result is an error", result?.isError === true, JSON.stringify(result))
	check("and the changed path is named", /src\/touched\.ts/.test(result?.content ?? ""), result?.content)
	check("and the report lists it too", report.changedPaths.includes("src/touched.ts"), JSON.stringify(report.changedPaths))
}

// ── 3. a tool that never began says so, which is different ──────────────────
{
	const id = "2026-01-01T00-00-00-000Z-ccccc"
	const turnId = "turn-requested"
	writeJournal(id, [
		meta(id),
		{ kind: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ kind: "turn_started", id: turnId, timestamp: new Date().toISOString() },
		{ kind: "message", message: assistantWithCalls([{ id: "call-3", name: "edit_file" }]), turnId },
		{ kind: "tool_requested", turnId, id: "call-3", name: "edit_file", timestamp: new Date().toISOString() },
	])
	const report = await (await Thread.open(id)).recover()
	check("a requested-only tool is reported separately", report.notExecutedToolIds.includes("call-3"), JSON.stringify(report.notExecutedToolIds))
	check("and not as unknown", report.unknownToolIds.length === 0, JSON.stringify(report.unknownToolIds))
	const result = resultsOf(report.messages)[0]
	check("and the wording is definite", /had not begun/i.test(result?.content ?? ""), result?.content)
}

// ── 4. invariants 1 and 2, across a process boundary ────────────────────────
// Six calls in three states. Every one must come back, in the order the model
// asked for them, or the next request is rejected for an unanswered tool_use.
{
	const id = "2026-01-01T00-00-00-000Z-ddddd"
	const turnId = "turn-mixed"
	const calls = [
		{ id: "m-1", name: "read_file" },
		{ id: "m-2", name: "bash" },
		{ id: "m-3", name: "grep" },
		{ id: "m-4", name: "edit_file" },
		{ id: "m-5", name: "glob" },
		{ id: "m-6", name: "web_fetch" },
	]
	writeJournal(id, [
		meta(id),
		{ kind: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ kind: "turn_started", id: turnId, timestamp: new Date().toISOString() },
		{ kind: "message", message: assistantWithCalls(calls), turnId },
		// m-1 and m-4 finished, m-2 and m-5 were executing, m-3 and m-6 never started.
		...["m-1", "m-2", "m-4", "m-5"].map((c) => ({
			kind: "tool_executing", turnId, id: c, name: "x", timestamp: new Date().toISOString(),
		})),
		{ kind: "tool_finished", turnId, result: { type: "tool_result", id: "m-1", content: "one", isError: false } },
		{ kind: "tool_finished", turnId, result: { type: "tool_result", id: "m-4", content: "four", isError: false } },
	])
	const report = await (await Thread.open(id)).recover()
	const results = resultsOf(report.messages)
	check("every call gets a result", results.length === calls.length, `${results.length} of ${calls.length}`)
	check(
		"and the order follows the tool_use order",
		results.map((r) => r.id).join(",") === calls.map((c) => c.id).join(","),
		results.map((r) => r.id).join(","),
	)
	check("the finished ones keep their content", results[0]?.content === "one" && results[3]?.content === "four", JSON.stringify(results.map((r) => r.content)))
	check("the executing ones are unknown", report.unknownToolIds.join(",") === "m-2,m-5", report.unknownToolIds.join(","))
	check("the untouched ones are not-executed", report.notExecutedToolIds.join(",") === "m-3,m-6", report.notExecutedToolIds.join(","))
	// The recovered message is a single user turn, so the results stay at its front.
	const recoveredMessage = report.messages.at(-1)!
	check("the results arrive as one user message", recoveredMessage.role === "user", recoveredMessage.role)
}

// ── 5. recovery is idempotent ──────────────────────────────────────────────
// A schedule fires `axe -c`, and a machine that reboots twice runs it twice.
// A second recovery must not append a second set of results.
{
	const id = "2026-01-01T00-00-00-000Z-eeeee"
	const turnId = "turn-twice"
	writeJournal(id, [
		meta(id),
		{ kind: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ kind: "turn_started", id: turnId, timestamp: new Date().toISOString() },
		{ kind: "message", message: assistantWithCalls([{ id: "call-x", name: "bash" }]), turnId },
		{ kind: "tool_executing", turnId, id: "call-x", name: "bash", timestamp: new Date().toISOString() },
	])
	const first = await (await Thread.open(id)).recover()
	const second = await (await Thread.open(id)).recover()
	check("the first run recovers", first.recovered)
	check("the second run finds nothing open", !second.recovered, JSON.stringify(second))
	check("and does not add a second result set", resultsOf(second.messages).length === 1, String(resultsOf(second.messages).length))
	// The turn was closed with the outcome that says what happened to it.
	const raw = readFileSync(join(THREADS, `${id}.jsonl`), "utf8")
	const finishes = raw.split("\n").filter((l) => l.includes('"turn_finished"'))
	check("the turn is closed exactly once", finishes.length === 1, String(finishes.length))
	check("and closed as recovered", finishes[0]?.includes('"recovered"') === true, finishes[0])
}

// ── 6. a partial write is the normal crash, not corruption ─────────────────
// Append-only means a crash tears the last line. That line is a message nobody
// finished writing, so dropping it is correct; anything else must be loud.
{
	const id = "2026-01-01T00-00-00-000Z-fffff"
	const file = writeJournal(id, [
		meta(id),
		{ kind: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
	])
	// A torn final line, exactly as an interrupted append leaves it.
	await writeFile(file, `${readFileSync(file, "utf8")}{"kind":"message","mess`, "utf8")
	const messages = await (await Thread.open(id)).load()
	check("a torn last line is dropped", messages.length === 1, String(messages.length))
	check("and the intact part is kept", messages[0]?.content[0]?.type === "text")

	// The same tear in the middle is not a torn write: it is a damaged file, and
	// silently skipping it would drop a turn out of the middle of the history.
	const id2 = "2026-01-01T00-00-00-000Z-ggggg"
	const file2 = writeJournal(id2, [meta(id2)])
	await writeFile(
		file2,
		`${readFileSync(file2, "utf8")}{"kind":"mess\n{"kind":"message","message":{"role":"user","content":[]}}\n`,
		"utf8",
	)
	let threw = ""
	try {
		await (await Thread.open(id2)).load()
	} catch (err) {
		threw = err instanceof Error ? err.message : String(err)
	}
	check("a torn line in the middle throws", threw !== "", threw)
	check("and names the thread and the line", /is corrupt at line 2/.test(threw), threw)
}

// A journal that does not exist at all is an empty history, not a crash: this is
// what `Thread.open` on a fresh id does before the first append.
{
	const missing = await Thread.open("2026-01-01T00-00-00-000Z-nofile")
	const report = await missing.recover()
	check("a missing journal recovers to nothing", !report.recovered && report.messages.length === 0, JSON.stringify(report))
}

// ── 7. corrupted local state files ────────────────────────────────────────
// Each of these has a comment promising it degrades. Nothing checked.
{
	const schedulesFile = join(home, ".axe", "schedules.json")
	await writeFile(schedulesFile, "{not json at all", "utf8")
	check("garbage schedules.json reads as empty", (await loadSchedules()).length === 0)

	// Valid JSON of the wrong shape is the more likely corruption: a hand edit.
	await writeFile(schedulesFile, '{"schedules":[]}', "utf8")
	check("schedules.json of the wrong shape reads as empty", (await loadSchedules()).length === 0)

	// Entries missing required fields are dropped one by one, not all at once.
	await writeFile(
		schedulesFile,
		JSON.stringify([
			{ id: "keep", when: "every 10m", prompt: "p", cwd, threadId: "t" },
			{ id: "drop-me", when: "every 10m" },
		]),
		"utf8",
	)
	const partial = await loadSchedules()
	check("a valid schedule survives beside a broken one", partial.length === 1, JSON.stringify(partial))
	check("and it is the valid one", partial[0]?.id === "keep", JSON.stringify(partial[0]))

	// And the file can still be written back afterwards.
	await saveSchedules([])
	check("the file recovers after a rewrite", (await loadSchedules()).length === 0)
}

{
	// The approvals file gates running programs a git clone asked for, so a
	// damaged one must fail closed: no approvals, never "everything approved".
	const approvalsFile = join(home, ".axe", "mcp-approved")
	await writeFile(approvalsFile, "\u0000\u0000garbage\n\n   \n", "utf8")
	const approvals = await readApprovals()
	check("a damaged approvals file yields no usable approval", !approvals.has(`${cwd}\tanything`), JSON.stringify([...approvals]))
	check("and blank lines are not approvals", !approvals.has(""), JSON.stringify([...approvals]))
}

{
	// A config file that is not TOML must leave the defaults standing, with a
	// notice, rather than taking the session down at startup.
	const badProject = mkdtempSync(join(tmpdir(), "axe-recovery-badcfg-"))
	mkdirSync(join(badProject, ".axe"), { recursive: true })
	writeFileSync(join(badProject, ".axe", "config.toml"), "this is not = = toml [[[\neffort = 42\n")
	const loaded = loadConfig(badProject)
	check("a broken config still loads", typeof loaded.config.effort === "string", JSON.stringify(loaded.config.effort))
	check("and falls back to the default effort", loaded.config.effort === "medium", loaded.config.effort)
	check("and says what it dropped", loaded.notices.some((n) => n.includes("effort")), JSON.stringify(loaded.notices))
}

// ── 8. atomicWrite leaves nothing behind ──────────────────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "axe-recovery-atomic-"))
	const target = join(dir, "state.json")
	await atomicWrite(target, '{"a":1}', 0o600, true)
	check("atomicWrite creates the file", (await readFile(target, "utf8")) === '{"a":1}')
	await atomicWrite(target, '{"a":2}', 0o600, false)
	check("and replaces it", (await readFile(target, "utf8")) === '{"a":2}')
	const { readdir } = await import("node:fs/promises")
	const left = (await readdir(dir)).filter((n) => n.startsWith(".axe-edit-"))
	check("and leaves no temp file", left.length === 0, left.join(","))

	// A write into a directory that does not exist must not leave a temp behind
	// either, since the temp is created in that same missing directory.
	let atomicThrew = false
	try {
		await atomicWrite(join(dir, "nope", "x.json"), "x", 0o600, true)
	} catch {
		atomicThrew = true
	}
	check("a write to a missing directory fails loudly", atomicThrew)
	check("and the original file is untouched", (await readFile(target, "utf8")) === '{"a":2}')
}

// ── the debug log, which is the other half of debugging a crash ────────────
{
	resetDebugLog()
	check("debug is off unless asked", !debugRequested(false, false, {}))
	check("the flag turns it on", debugRequested(true, false, {}))
	check("the config turns it on", debugRequested(false, true, {}))
	check("AXE_DEBUG=1 turns it on", debugRequested(false, false, { AXE_DEBUG: "1" }))
	// A shell that exports AXE_DEBUG=0 means off, and an empty value is not a yes.
	check("AXE_DEBUG=0 does not", !debugRequested(false, false, { AXE_DEBUG: "0" }))
	check("AXE_DEBUG=false does not", !debugRequested(false, false, { AXE_DEBUG: "false" }))
	check("an empty AXE_DEBUG does not", !debugRequested(false, false, { AXE_DEBUG: "" }))

	// Writing with no sink open must be a no-op rather than a throw: every call
	// site calls it unconditionally.
	debugLog({ kind: "turn", phase: "start" })
	check("logging while off does nothing", true)

	const path = initDebugLog("recovery-test-thread", join(home, ".axe"))
	check("the log names the thread", path?.includes("recovery-test-thread") === true, String(path))
	debugLog({ kind: "tool", phase: "requested", turnId: "t-1", toolUseId: "c-1", detail: { name: "bash" } })
	debugLog({ kind: "retry", phase: "scheduled", detail: { label: "anthropic", status: 429, delayMs: 500 } })
	const lines = readFileSync(path!, "utf8").trim().split("\n")
	check("every line is its own JSON object", lines.every((l) => {
		try {
			return typeof JSON.parse(l).kind === "string"
		} catch {
			return false
		}
	}), lines.join(" | "))
	const parsed = lines.map((l) => JSON.parse(l))
	check("a session start is recorded", parsed[0].kind === "session", JSON.stringify(parsed[0]))
	check("every line carries a timestamp", parsed.every((p) => typeof p.ts === "string"))
	const toolLine = parsed.find((p) => p.kind === "tool")
	check("the correlation ids are both there", toolLine.turnId === "t-1" && toolLine.toolUseId === "c-1", JSON.stringify(toolLine))
	const retryLine = parsed.find((p) => p.kind === "retry")
	check("a retry records its status and delay", retryLine.detail.status === 429 && retryLine.detail.delayMs === 500, JSON.stringify(retryLine))

	// The rule that makes this file safe to paste into an issue.
	const raw = readFileSync(path!, "utf8")
	check("no secret-shaped key is written", !/API_KEY|sk-[a-z0-9]/i.test(raw), raw)

	// A runaway string must not turn one line into a file.
	debugLog({ kind: "turn", phase: "error", detail: { error: "x".repeat(5_000) } })
	const longest = readFileSync(path!, "utf8").trim().split("\n").at(-1)!
	check("a long detail is trimmed", longest.length < 1_200, String(longest.length))

	resetDebugLog()
	debugLog({ kind: "turn", phase: "end" })
	const afterReset = readFileSync(path!, "utf8").trim().split("\n").length
	check("nothing is written after the sink is closed", afterReset === 4, String(afterReset))
}

// The recovery report is what the CLI prints, so it must survive a thread that
// was never interrupted at all: the common case, on every --continue.
{
	const clean = await Thread.create(cwd)
	await clean.append({ role: "user", content: [{ type: "text", text: "hi" }] })
	const turnId = "clean-turn"
	await clean.startTurn(turnId)
	await clean.append({ role: "assistant", content: [{ type: "text", text: "hello" }] }, turnId)
	await clean.finishTurn(turnId)
	const report = await clean.recover()
	check("a cleanly finished thread needs no recovery", !report.recovered, JSON.stringify(report))
	check("and its messages are intact", report.messages.length === 2, String(report.messages.length))
	await stat(join(THREADS, `${clean.id}.jsonl`))
}

console.log(`recovery: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

// Exercises the agent loop invariants against a scripted provider.
// No API key, no network.
import { mkdtempSync } from "node:fs"
import { appendFile, mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UI } from "../src/core/loop.ts"
import type { InputQueue as InputQueueType } from "../src/core/queue.ts"
import type {
	Block,
	Message,
	Provider,
	StopReason,
	StreamEvent,
	ToolDef,
} from "../src/providers/types.ts"

// AXE_HOME is read when thread.ts is loaded, so it has to be set before the
// first import that reaches it. A static import would have run first.
const home = mkdtempSync(join(tmpdir(), "axe-threads-"))
process.env.AXE_HOME = home

const { newSession, runTurn } = await import("../src/core/loop.ts")
const { InputQueue } = await import("../src/core/queue.ts")
const { ToolRegistry, execTool } = await import("../src/core/tools.ts")
const { jsonError, jsonResult, makeJsonUI } = await import("../src/ui/json.ts")

let failures = 0

function check(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `  ${detail}` : ""}`)
}

const noUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 }
const fresh = () => new AbortController().signal

/** Replays one assistant turn per step, repeating the last one forever. */
function scripted(turns: Block[][]): Provider {
	let i = 0
	return {
		name: "scripted",
		contextWindow: () => 100_000,
		countTokens: async () => 0,
		async *stream(): AsyncGenerator<StreamEvent> {
			const content = turns[Math.min(i++, turns.length - 1)]!
			const stop: StopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"
			// Real adapters announce a call before the done event.
			for (const b of content) {
				if (b.type === "tool_use") yield { type: "tool_start", id: b.id, name: b.name }
			}
			yield { type: "done", stop, message: { role: "assistant", content }, usage: noUsage }
		},
	}
}

const finished: string[] = []

function tool(name: string, delayMs: number, fail = false): ToolDef {
	return {
		name,
		description: name,
		schema: { type: "object", properties: {} },
		readOnly: true,
		run: async () => {
			await new Promise((r) => setTimeout(r, delayMs))
			finished.push(name)
			if (fail) throw new Error(`${name} exploded`)
			return `${name} done`
		},
	}
}

const notices: string[] = []
const finalText: string[] = []
const ui: UI = {
	text: () => {},
	textDone: (text) => finalText.push(text),
	thinking: () => {},
	toolStart: () => {},
	toolEnd: () => {},
	notice: (s) => notices.push(s),
}

function session(turns: Block[][], opts: { queue?: InputQueueType; maxSteps?: number } = {}) {
	const s = newSession({
		provider: scripted(turns),
		model: "scripted",
		system: "test",
		maxTokens: 1_000,
		tools: new ToolRegistry().register(tool("slow", 30), tool("fast", 0), tool("boom", 0, true)),
		cwd: process.cwd(),
		ui,
		queue: opts.queue,
	})
	if (opts.maxSteps) s.maxSteps = opts.maxSteps
	return s
}

const call = (id: string, name: string): Block => ({ type: "tool_use", id, name, input: {} })
const results = (m: Message) =>
	m.content.filter((b): b is Extract<Block, { type: "tool_result" }> => b.type === "tool_result")

/** Invariant 2: nothing the model asked for may go unanswered. */
function unanswered(messages: Message[]): string[] {
	const asked: string[] = []
	const answered = new Set<string>()
	for (const m of messages) {
		for (const b of m.content) {
			if (b.type === "tool_use") asked.push(b.id)
			if (b.type === "tool_result") answered.add(b.id)
		}
	}
	return asked.filter((id) => !answered.has(id))
}

// Display metadata is a UI projection, never model context. A legacy string
// result remains the only content stored in the tool_result.
{
	let seenDisplay: unknown
	const rich: ToolDef = {
		name: "rich",
		description: "rich",
		schema: { type: "object", properties: {} },
		readOnly: true,
		display: () => ({ summary: "UI ONLY", additions: 2 }),
		run: async () => "model content",
	}
	const richUi: UI = {
		...ui,
		toolEnd: (_name, _ok, _preview, _input, _id, display) => (seenDisplay = display),
	}
	const s = newSession({
		provider: scripted([[call("rich-1", "rich")], [{ type: "text", text: "done" }]]),
		model: "scripted",
		system: "test",
		maxTokens: 1_000,
		tools: new ToolRegistry().register(rich),
		cwd: process.cwd(),
		ui: richUi,
	})
	await runTurn(s, "go", fresh())
	const result = results(s.messages[2]!)[0]!
	check("display metadata reaches the UI", JSON.stringify(seenDisplay) === JSON.stringify({ summary: "UI ONLY", additions: 2 }))
	check("tool_result contains only model content", result.content === "model content" && !JSON.stringify(result).includes("UI ONLY"), JSON.stringify(result))
}

// Long tool output stays bounded in context while the complete value remains
// available through the existing file tools.
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-artifact-"))
	const large: ToolDef = {
		name: "large",
		description: "large",
		schema: { type: "object", properties: {} },
		readOnly: true,
		run: async () => `head-${"x".repeat(40_000)}-tail`,
	}
	const out = await execTool(new ToolRegistry().register(large), "large", {}, {
		cwd,
		id: "artifact-1",
		signal: fresh(),
		log: () => {},
	})
	const path = /full output: (\S+\.log)/.exec(out.content)?.[1] ?? ""
	check("long tool output is bounded", out.content.length < 31_000 && path.includes(".axe/artifacts/"), out.content.slice(-120))
	check("the artifact keeps the complete output", path !== "" && (await readFile(join(cwd, path), "utf8")).endsWith("-tail"), path)
}

// Invariant 1: results follow the order of the calls, not the order they finish.
{
	const s = session([
		[call("t1", "slow"), call("t2", "fast")],
		[{ type: "text", text: "done" }],
	])
	await runTurn(s, "go", fresh())
	check("tools finish out of order", finished.indexOf("fast") < finished.indexOf("slow"))
	check(
		"tool_result order follows tool_use order",
		JSON.stringify(results(s.messages[2]!).map((b) => b.id)) === JSON.stringify(["t1", "t2"]),
	)
	check("turn ends when the model stops calling tools", s.messages.length === 4)
	check("nothing left unanswered", unanswered(s.messages).length === 0)
	check("the UI receives authoritative final text", finalText.at(-1) === "done")
}

// Invariant 2: failures and unknown tools still produce a tool_result.
{
	const s = session([
		[call("t3", "boom"), call("t4", "no_such_tool")],
		[{ type: "text", text: "ok" }],
	])
	await runTurn(s, "go", fresh())
	const r = results(s.messages[2]!)
	check("failed tool still answered", r[0]!.isError === true && r[0]!.content.includes("exploded"))
	check(
		"unknown tool still answered",
		r[1]!.isError === true && r[1]!.content.includes("Unknown tool"),
	)
	check("nothing left unanswered after failures", unanswered(s.messages).length === 0)
}

// Steering must not break the pairing: the text lands after the results.
{
	const q = new InputQueue()
	q.push("also check b.ts")
	const s = session([[call("t5", "fast")], [{ type: "text", text: "ok" }]], { queue: q })
	await runTurn(s, "go", fresh())
	const kinds = s.messages[2]!.content.map((b) => b.type)
	check(
		"steering text lands after tool_result",
		JSON.stringify(kinds) === JSON.stringify(["tool_result", "text"]),
	)
	check(
		"steering text reaches the model",
		JSON.stringify(s.messages[2]).includes("also check b.ts"),
	)
	check("queue is emptied", q.size === 0)
}

// A model that never stops calling tools must still terminate.
{
	notices.length = 0
	const s = session([[call("t6", "fast")]], { maxSteps: 3 })
	await runTurn(s, "go", fresh())
	check("maxSteps caps the loop", s.messages.filter((m) => m.role === "assistant").length === 3)
	check("the cap is reported", notices.some((n) => n.includes("Stopped after 3 steps")))
}

// A reply cut off at the token cap must say so. A model that spends the whole
// budget reasoning returns no text at all, and silence there reads as an answer.
{
	notices.length = 0
	const s = session([[{ type: "thinking", text: "round and round" }]])
	s.provider = {
		name: "capped",
		contextWindow: () => 100_000,
		countTokens: async () => 0,
		async *stream(): AsyncGenerator<StreamEvent> {
			yield {
				type: "done",
				stop: "max_tokens",
				message: { role: "assistant", content: [{ type: "thinking", text: "round and round" }] },
				usage: noUsage,
			}
		},
	}
	await runTurn(s, "draw something", fresh())
	check("truncation is reported", notices.some((n) => n.includes("Cut off at the") && n.includes("token cap")))
}

// A turn that ends normally must not claim it was truncated.
{
	notices.length = 0
	const s = session([[{ type: "text", text: "done" }]])
	await runTurn(s, "go", fresh())
	check("no false truncation notice", !notices.some((n) => n.includes("Cut off")))
}

// An aborted turn still closes every open tool_use.
{
	const ac = new AbortController()
	ac.abort()
	const s = session([[call("t7", "fast")], [{ type: "text", text: "ok" }]])
	await runTurn(s, "go", ac.signal)
	const r = results(s.messages[2]!)
	check("cancelled tool still answered", r[0]!.isError === true && r[0]!.content.includes("cancelled"))
	check("abort stops the loop", s.messages.length === 3)
}

// Scheduling. A tool that is not readOnly may write files or run a command, so
// two of them must never overlap, and a read must not see a tree that is being
// written. Reads still overlap with each other, because that is the whole point
// of the flag.
{
	const order: string[] = []
	let liveReads = 0
	let maxLiveReads = 0
	let liveWrites = 0
	let maxLiveWrites = 0

	const timed = (name: string, readOnly: boolean, delayMs: number): ToolDef => ({
		name,
		description: name,
		schema: { type: "object", properties: {} },
		readOnly,
		run: async () => {
			if (readOnly) maxLiveReads = Math.max(maxLiveReads, ++liveReads)
			else maxLiveWrites = Math.max(maxLiveWrites, ++liveWrites)
			order.push(`start ${name}`)
			await new Promise((r) => setTimeout(r, delayMs))
			order.push(`end ${name}`)
			if (readOnly) liveReads--
			else liveWrites--
			return `${name} done`
		},
	})

	const s = newSession({
		provider: scripted([
			[
				call("r1", "read_a"),
				call("r2", "read_b"),
				call("w1", "write_a"),
				call("w2", "write_b"),
				call("r3", "read_a"),
			],
			[{ type: "text", text: "ok" }],
		]),
		model: "scripted",
		system: "test",
		maxTokens: 1_000,
		tools: new ToolRegistry().register(
			timed("read_a", true, 20),
			timed("read_b", true, 0),
			timed("write_a", false, 20),
			timed("write_b", false, 0),
		),
		cwd: process.cwd(),
		ui,
	})
	await runTurn(s, "go", fresh())

	check("consecutive reads overlap", maxLiveReads === 2)
	check("writes never overlap", maxLiveWrites === 1)
	check(
		"a write waits for the reads before it",
		order.indexOf("start write_a") > order.indexOf("end read_a"),
	)
	check(
		"writes run in tool_use order",
		order.indexOf("end write_a") < order.indexOf("start write_b"),
	)
	check(
		"a read after a write waits for it",
		order.lastIndexOf("start read_a") > order.indexOf("end write_b"),
	)
	check(
		"tool_result order survives the schedule",
		JSON.stringify(results(s.messages[2]!).map((b) => b.id)) ===
			JSON.stringify(["r1", "r2", "w1", "w2", "r3"]),
	)
	check("nothing left unanswered after scheduling", unanswered(s.messages).length === 0)
}

// An abort part-way through the writes stops the ones that follow, and still
// answers them.
{
	const ac = new AbortController()
	let secondRan = false
	const writer = (name: string, run: () => Promise<string>): ToolDef => ({
		name,
		description: name,
		readOnly: false,
		schema: { type: "object", properties: {} },
		run,
	})
	const s = newSession({
		provider: scripted([
			[call("w3", "write_then_abort"), call("w4", "never_runs")],
			[{ type: "text", text: "ok" }],
		]),
		model: "scripted",
		system: "test",
		maxTokens: 1_000,
		tools: new ToolRegistry().register(
			writer("write_then_abort", async () => {
				ac.abort()
				return "wrote, then the user pressed Esc Esc"
			}),
			writer("never_runs", async () => {
				secondRan = true
				return "should not happen"
			}),
		),
		cwd: process.cwd(),
		ui,
	})
	await runTurn(s, "go", ac.signal)
	const r = results(s.messages[2]!)
	check("the write before the abort still answers", r[0]!.isError === false)
	check("the write after the abort does not run", secondRan === false)
	check(
		"and is answered as cancelled",
		r[1]!.isError === true && r[1]!.content.includes("cancelled"),
	)
}

// The queue itself.
{
	const q = new InputQueue()
	check("empty queue drains to null", q.drain() === null)
	q.push("  a  ")
	q.push("   ")
	q.push("b")
	check("blank input is ignored", q.size === 2)
	check("queued lines join", q.drain() === "a\nb")
	check("draining empties the queue", q.size === 0 && q.drain() === null)
}

// The --stream-json surface. Everything a script consumes must be one JSON
// object per line, so a whole turn is driven through the JSON UI here.
{
	const lines: string[] = []
	const jsonUi = makeJsonUI((s) => lines.push(s))
	const s = session([[call("t8", "fast")], [{ type: "text", text: "ok" }]])
	s.ui = jsonUi
	await runTurn(s, "go", fresh())
	lines.push(jsonResult(s.usage, "th_test"))
	lines.push(jsonError("boom"))

	check(
		"stream-json: every line ends in a newline",
		lines.every((l) => l.endsWith("\n") && l.indexOf("\n") === l.length - 1),
	)
	const parsed = lines.map((l) => JSON.parse(l))
	check(
		"stream-json: every line is a tagged object",
		parsed.every((o) => typeof o.type === "string"),
	)
	check(
		"stream-json: tool lifecycle reported",
		parsed.some((o) => o.type === "tool_start" && o.name === "fast") &&
			parsed.some((o) => o.type === "tool_end" && o.ok === true),
	)
	const result = parsed.find((o) => o.type === "result")
	check(
		"stream-json: result carries usage and thread id",
		result?.threadId === "th_test" && typeof result.usage.costUsd === "number",
	)
	check(
		"stream-json: errors are a line, not a crash",
		parsed.at(-1)?.type === "error" && parsed.at(-1)?.message === "boom",
	)
}

// Tool input is model output, so it is not to be trusted. A tool that declares
// a field required must never be handed `undefined` for it: edit_file would
// write the string "undefined" into a real file before anything complained.
{
	let ran = 0
	const writer: ToolDef = {
		name: "write_note",
		description: "write_note",
		readOnly: false,
		schema: {
			type: "object",
			properties: { path: { type: "string" }, text: { type: "string" }, lines: { type: "integer" } },
			required: ["path", "text"],
		},
		run: async () => {
			ran++
			return "wrote"
		},
	}
	const reg = new ToolRegistry().register(writer)
	const ctx = { cwd: process.cwd(), signal: fresh(), log: () => {} }

	const missing = await execTool(reg, "write_note", { path: "a.txt" }, ctx)
	check("a missing required field is a tool error", missing.isError && missing.content.includes('"text"'))
	const wrongType = await execTool(reg, "write_note", { path: 1, text: "x" }, ctx)
	check("a wrongly typed field is a tool error", wrongType.isError && wrongType.content.includes("string"))
	const wrongInt = await execTool(reg, "write_note", { path: "a", text: "x", lines: 1.5 }, ctx)
	check("a fractional integer is a tool error", wrongInt.isError && wrongInt.content.includes("integer"))
	const notAnObject = await execTool(reg, "write_note", "path=a.txt", ctx)
	check("a non-object input is a tool error", notAnObject.isError)
	check("none of that reached the tool", ran === 0, `${ran}`)

	const good = await execTool(reg, "write_note", { path: "a.txt", text: "x" }, ctx)
	check("a valid call still runs", !good.isError && ran === 1)
	const extra = await execTool(reg, "write_note", { path: "a.txt", text: "x", note: "ignored" }, ctx)
	check("an unknown field is not fatal", !extra.isError && ran === 2)
}

// Compaction is a model call of its own. Its tokens are as real as the turn's,
// and a session that does not count them makes the cost limit a lie.
{
	notices.length = 0
	const summarizer: Provider = {
		name: "summarizer",
		contextWindow: () => 1_000,
		countTokens: async () => 950,
		async *stream(): AsyncGenerator<StreamEvent> {
			yield {
				type: "done",
				stop: "end_turn",
				message: { role: "assistant", content: [{ type: "text", text: "## Task\nsummary" }] },
				usage: { ...noUsage, costUsd: 0.25, outputTokens: 10 },
			}
		},
	}
	const s = newSession({
		provider: summarizer,
		model: "summarizer",
		system: "test",
		maxTokens: 1_000,
		tools: new ToolRegistry(),
		cwd: process.cwd(),
		ui,
		messages: [
			{ role: "user", content: [{ type: "text", text: "earlier" }] },
			{ role: "assistant", content: [call("c1", "fast")] },
			{ role: "user", content: [{ type: "tool_result", id: "c1", content: "fast done" }] },
			{ role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
		],
		compaction: {
			provider: summarizer,
			model: "summarizer",
			maxTokens: 500,
			at: 0.9,
			keepTail: 2,
		},
	})
	await runTurn(s, "go", fresh())
	check("the session was compacted", notices.some((n) => n.includes("Compacted")))
	check(
		"compaction usage lands in the session",
		s.usage.costUsd === 0.5 && s.usage.outputTokens === 20,
		`${s.usage.costUsd} / ${s.usage.outputTokens}`,
	)
}

// onTurnEnd is where per-turn state is dropped, so a throw is exactly the case
// it has to survive: that is the path that leaves state behind.
{
	const s = session([[{ type: "text", text: "fine" }]])
	let ends = 0
	s.onTurnEnd = () => ends++
	await runTurn(s, "hello", new AbortController().signal)
	check("onTurnEnd runs on a clean turn", ends === 1, `${ends}`)

	s.provider = {
		name: "boom",
		countTokens: async () => 0,
		contextWindow: () => 1_000,
		stream: async function* () {
			throw new Error("provider exploded")
		},
	}
	await runTurn(s, "again", new AbortController().signal).then(
		() => check("a provider throw propagates", false),
		(e: Error) => check("a provider throw propagates", e.message === "provider exploded", e.message),
	)
	check("onTurnEnd still runs after a throw", ends === 2, `${ends}`)
}

// The thread store. A transcript is nobody else's business, and a thread
// belongs to the directory it was started in.
{
	const { Thread } = await import("../src/core/thread.ts")

	const a = await Thread.create("/tmp/axe-project-a")
	await a.append({ role: "user", content: [{ type: "text", text: "a secret" }] })
	const dirMode = (await stat(join(home, "threads"))).mode
	const fileMode = (await stat(join(home, "threads", `${a.id}.jsonl`))).mode
	check("the thread directory is not world readable", (dirMode & 0o077) === 0, dirMode.toString(8))
	check("the thread file is not world readable", (fileMode & 0o077) === 0, fileMode.toString(8))

	const b = await Thread.create("/tmp/axe-project-b")
	await b.append({ role: "user", content: [{ type: "text", text: "b secret" }] })
	const resumed = await Thread.latest("/tmp/axe-project-a")
	check("--continue resumes this project, not the newest one", resumed?.id === a.id, `${resumed?.id}`)
	check("the newest thread is still found for its own project", (await Thread.latest("/tmp/axe-project-b"))?.id === b.id)
	check("a project with no thread has nothing to continue", (await Thread.latest("/tmp/axe-project-c")) === null)
	check(
		"a resumed thread loads its messages",
		JSON.stringify(await (await Thread.latest("/tmp/axe-project-a"))!.load()).includes("a secret"),
	)

	const journal = await Thread.create("/tmp/axe-project-journal")
	await journal.append({ role: "assistant", content: [call("recover-1", "fast")] })
	await journal.startTurn("turn-1")
	await journal.toolStarted("turn-1", "recover-1", "fast")
	await journal.toolFinished("turn-1", {
		type: "tool_result",
		id: "recover-1",
		content: "durable result",
		isError: false,
	})
	const recovered = await journal.recover()
	check("a durable tool result is recovered without replay", results(recovered.messages.at(-1)!)[0]?.content === "durable result")
	check("recovery reports restored tools", JSON.stringify(recovered.restoredToolIds) === JSON.stringify(["recover-1"]))
	check("turn metadata stays outside model messages", !JSON.stringify(recovered.messages).includes('"turnId":"turn-1"'))

	const interrupted = await Thread.create("/tmp/axe-project-interrupted")
	await interrupted.append({ role: "assistant", content: [call("recover-2", "fast")] })
	await interrupted.startTurn("turn-2")
	await interrupted.toolStarted("turn-2", "recover-2", "fast")
	const interruptedMessages = await interrupted.recover()
	check("an interrupted tool is not replayed", /outcome is unknown/.test(results(interruptedMessages.messages.at(-1)!)[0]?.content ?? ""))
	await interrupted.fileChanged("turn-2", "recover-2", "src/changed.ts")
	// The first recovery closed the turn, so subsequent recovery is a no-op.
	const recoveredTwice = await interrupted.recover()
	check("recovery is idempotent", !recoveredTwice.recovered && recoveredTwice.messages.length === interruptedMessages.messages.length)

	const changedRecovery = await Thread.create("/tmp/axe-project-changed-recovery")
	await changedRecovery.startTurn("turn-changed")
	await changedRecovery.append({ role: "assistant", content: [call("changed-id", "fast")] }, "turn-changed")
	await changedRecovery.toolExecuting("turn-changed", "changed-id", "fast")
	await changedRecovery.fileChanged("turn-changed", "changed-id", "src/changed.ts")
	const changedReport = await changedRecovery.recover()
	check("changed paths are included in unknown recovery", /src\/changed\.ts/.test(results(changedReport.messages.at(-1)!)[0]?.content ?? "") && changedReport.changedPaths[0] === "src/changed.ts")

	const duplicate = await Thread.create("/tmp/axe-project-duplicate-id")
	await duplicate.startTurn("old-turn")
	await duplicate.append({ role: "assistant", content: [call("same-id", "fast")] }, "old-turn")
	await duplicate.toolFinished("old-turn", { type: "tool_result", id: "same-id", content: "old result" })
	await duplicate.finishTurn("old-turn")
	await duplicate.startTurn("new-turn")
	await duplicate.append({ role: "assistant", content: [call("same-id", "fast")] }, "new-turn")
	await duplicate.toolRequested("new-turn", "same-id", "fast")
	const duplicateRecovery = await duplicate.recover()
	check("duplicate tool ids do not borrow results between turns", /definitely had not begun/.test(results(duplicateRecovery.messages.at(-1)!)[0]?.content ?? ""))
	check("recovery reports calls that never executed", JSON.stringify(duplicateRecovery.notExecutedToolIds) === JSON.stringify(["same-id"]))

	const emptyTurn = await Thread.create("/tmp/axe-project-empty-turn")
	await emptyTurn.startTurn("empty-turn")
	const emptyReport = await emptyTurn.recover()
	check("an open turn with no message is closed", emptyReport.recovered && !(await emptyTurn.recover()).recovered)

	const textTurn = await Thread.create("/tmp/axe-project-text-recovery")
	await textTurn.startTurn("text-turn")
	await textTurn.append({ role: "assistant", content: [{ type: "text", text: "already complete" }] }, "text-turn")
	const textBefore = (await textTurn.load()).length
	const textReport = await textTurn.recover()
	check("recovery does not invent an empty tool_result message", textReport.messages.length === textBefore)

	await journal.context({ version: 1, sources: [{ kind: "system" }] })
	await journal.contextSource({ kind: "subtree_guidance", path: "/tmp/AGENTS.md", scope: "project" })
	await journal.context({ version: 1, sources: [{ kind: "guidance", path: "/tmp/new/AGENTS.md", scope: "project" }] })
	await journal.fileChanged("turn-1", "recover-1", "src/a.ts")
	await journal.fileChanged("turn-1", "recover-1", "src/a.ts")
	const state = await journal.loadState()
	check("context provenance is unioned across resumed sessions", state.context?.sources.length === 3)
	check("context provenance stays outside messages", !JSON.stringify(state.messages).includes("subtree_guidance"))
	check("changed files are deduplicated per turn", JSON.stringify(state.changedFiles.get("turn-1")) === JSON.stringify(["src/a.ts"]))
	check("the latest turn is available to change inspection", state.latestTurnId === "turn-1")

	const torn = await Thread.create("/tmp/axe-project-torn")
	await torn.append({ role: "user", content: [{ type: "text", text: "safe" }] })
	await appendFile(join(home, "threads", `${torn.id}.jsonl`), '{"kind":"message"')
	check("a torn final record is ignored", (await torn.load()).length === 1)
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

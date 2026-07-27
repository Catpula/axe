// Verifies the compaction boundary rules with a fake provider. No API key needed.
import { compactMessages, splitIndex, type CompactionConfig } from "../src/core/compact.ts"
import type { Message, Provider, StreamEvent } from "../src/providers/types.ts"

const fake: Provider = {
	name: "fake",
	contextWindow: () => 1_000,
	countTokens: async () => 900,
	async *stream(): AsyncGenerator<StreamEvent> {
		yield {
			type: "done",
			stop: "end_turn",
			message: { role: "assistant", content: [{ type: "text", text: "## Task\nfake summary" }] },
			usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 40, costUsd: 0.02 },
		}
	},
}

const cfg: CompactionConfig = {
	provider: fake,
	model: "fake",
	maxTokens: 1_000,
	at: 0.9,
	keepTail: 4,
}

function cycle(n: number): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: `ask ${n}` }] },
		{
			role: "assistant",
			content: [{ type: "tool_use", id: `t${n}`, name: "read_file", input: { path: "a.ts" } }],
		},
		{ role: "user", content: [{ type: "tool_result", id: `t${n}`, content: "contents" }] },
		{ role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
	]
}

const signal = new AbortController().signal
let failures = 0

function check(label: string, ok: boolean) {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`)
}

/** No tool_result may be left without the tool_use that produced it. */
function orphans(messages: Message[]): string[] {
	const seen = new Set<string>()
	const bad: string[] = []
	for (const m of messages) {
		for (const b of m.content) {
			if (b.type === "tool_use") seen.add(b.id)
			if (b.type === "tool_result" && !seen.has(b.id)) bad.push(b.id)
		}
	}
	return bad
}

/** Invariant 5, stated as a property of the cut rather than of one message. */
function cutsACycle(messages: Message[], at: number): boolean {
	return orphans(messages.slice(at)).length > 0
}

function alternates(messages: Message[]): boolean {
	return messages.every((m, i) => (i % 2 === 0 ? m.role === "user" : m.role === "assistant"))
}

const history = [...cycle(1), ...cycle(2), ...cycle(3), ...cycle(4)]

// keepTail=2 would cut cycle 4 between its tool_use and its tool_result.
const naive = history.length - 2
check(
	"naive split lands mid tool cycle",
	history[naive]!.content.some((b) => b.type === "tool_result"),
)
const safe = splitIndex(history, 2)
check("splitIndex moves off the naive point", safe !== naive)
check("splitIndex never cuts a tool cycle", !cutsACycle(history, safe))

const result = await compactMessages(cfg, history, signal)
check("compaction produced a result", result.messages !== null)
if (result.messages) {
	const messages = result.messages
	check("no orphan tool_result after compaction", orphans(messages).length === 0)
	check("summary is first", messages[0]!.role === "user")
	check("summary text carried through", JSON.stringify(messages[0]).includes("fake summary"))
	check("tail preserved verbatim", JSON.stringify(messages.at(-1)) === JSON.stringify(history.at(-1)))
	check("roles alternate", alternates(messages))
	check("shorter than the original", messages.length < history.length)
}
check("compaction reports what it spent", result.usage.costUsd === 0.02)

// Nothing to summarise: the first message is already the split point.
const short = cycle(1)
check("short session is not compacted", (await compactMessages(cfg, short, signal)).messages === null)

// One long turn. Sixty tool calls and not one plain user turn after the first:
// this is the shape that used to defeat compaction completely, leaving the
// context to grow until the provider rejected the request.
function longTurn(steps: number): Message[] {
	const out: Message[] = [{ role: "user", content: [{ type: "text", text: "do the big thing" }] }]
	for (let n = 0; n < steps; n++) {
		out.push({
			role: "assistant",
			content: [{ type: "tool_use", id: `L${n}`, name: "read_file", input: { path: `f${n}.ts` } }],
		})
		out.push({ role: "user", content: [{ type: "tool_result", id: `L${n}`, content: `line ${n}` }] })
	}
	return out
}

const long = longTurn(60)
const plainUserTurns = long.filter(
	(m) => m.role === "user" && !m.content.some((b) => b.type === "tool_result"),
)
check("a long turn offers exactly one plain user turn", plainUserTurns.length === 1)

const longAt = splitIndex(long, 4)
check("splitIndex finds a cut inside a long turn", longAt > 0)
check("that cut does not split a tool cycle", !cutsACycle(long, longAt))

const longResult = await compactMessages(cfg, long, signal)
check("a long turn is actually compacted", longResult.messages !== null)
if (longResult.messages) {
	const messages = longResult.messages
	check("the long turn got much shorter", messages.length < long.length / 2)
	check("no orphan tool_result in the compacted long turn", orphans(messages).length === 0)
	check("roles still alternate after cutting inside a turn", alternates(messages))
	check("the tail is kept verbatim", JSON.stringify(messages.at(-1)) === JSON.stringify(long.at(-1)))
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

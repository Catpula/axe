// Live wire-format check. The only test here that talks to a real API.
//
// Every other test replays recorded bytes, which proves what the adapters do
// with a response but not that the response shape is still current. This one
// spends a few cents to find that out. It is not in `npm test`: run it after
// touching an adapter, or when a provider announces a change.
//
//   node --experimental-strip-types scripts/live-test.ts            # every provider with a key
//   node --experimental-strip-types scripts/live-test.ts anthropic  # just one
//
// A provider with no key is skipped, not failed: nobody holds all three.
import { loadConfig, KeyError } from "../src/config.ts"
import { makeProvider } from "../src/providers/make.ts"
import { routeFor, routeForRole } from "../src/router/route.ts"
import type { Provider, StreamEvent, ToolDef } from "../src/providers/types.ts"

const TIMEOUT_MS = 120_000

let failures = 0
let ran = 0

function check(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
}

const addTool: ToolDef = {
	name: "add",
	description: "Add two integers. Use this for any arithmetic; do not compute it yourself.",
	schema: {
		type: "object",
		properties: { a: { type: "integer" }, b: { type: "integer" } },
		required: ["a", "b"],
	},
	readOnly: true,
	run: async (input: { a: number; b: number }) => String(input.a + input.b),
}

async function drain(
	provider: Provider,
	model: string,
	maxTokens: number,
	system: string,
	messages: Parameters<Provider["stream"]>[0]["messages"],
	tools: ToolDef[],
) {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
	const events: StreamEvent[] = []
	try {
		for await (const ev of provider.stream({
			system,
			messages,
			tools,
			model,
			maxTokens,
			signal: ac.signal,
		})) {
			events.push(ev)
		}
	} finally {
		clearTimeout(timer)
	}
	return events
}

/**
 * One round trip that must produce text, and one that must produce a tool call.
 * Between them they cover every field the adapters read off the wire: deltas,
 * the terminal event, usage, and the tool-call accumulator.
 */
async function exercise(name: string, provider: Provider, model: string, maxTokens: number) {
	ran++
	console.log(`\n--- ${name}  ${model}`)

	const textEvents = await drain(
		provider,
		model,
		maxTokens,
		"You are terse. Answer with the single word and nothing else.",
		[{ role: "user", content: [{ type: "text", text: "What colour is a ripe banana?" }] }],
		[],
	)
	const done = textEvents.at(-1)
	check(`${name} text: terminal event is done`, done?.type === "done", done?.type ?? "none")
	if (done?.type !== "done") return

	check(`${name} text: streamed deltas`, textEvents.some((e) => e.type === "text_delta"))
	const said = done.message.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("")
	check(`${name} text: non-empty answer`, said.trim().length > 0, JSON.stringify(said.slice(0, 60)))
	check(`${name} text: stop is end_turn`, done.stop === "end_turn", done.stop)
	// A provider that stops reporting usage silently zeroes every cost readout,
	// which is exactly the drift a replayed test cannot catch.
	check(
		`${name} text: usage counted`,
		done.usage.inputTokens > 0 && done.usage.outputTokens > 0,
		`in=${done.usage.inputTokens} out=${done.usage.outputTokens}`,
	)

	const toolEvents = await drain(
		provider,
		model,
		maxTokens,
		"Use the add tool for arithmetic. Never do the arithmetic yourself.",
		[{ role: "user", content: [{ type: "text", text: "What is 1487 plus 2913?" }] }],
		[addTool],
	)
	const toolDone = toolEvents.at(-1)
	check(`${name} tool: terminal event is done`, toolDone?.type === "done", toolDone?.type ?? "none")
	if (toolDone?.type !== "done") return

	check(`${name} tool: stop is tool_use`, toolDone.stop === "tool_use", toolDone.stop)
	const call = toolDone.message.content.find((b) => b.type === "tool_use")
	check(`${name} tool: call present`, !!call)
	if (!call || call.type !== "tool_use") return
	check(`${name} tool: named add`, call.name === "add", call.name)
	// A parse error here means the argument fragments were reassembled wrong,
	// which is the single most likely place for a compatible server to differ.
	const input = call.input as Record<string, unknown>
	check(
		`${name} tool: arguments parsed`,
		typeof input?.a === "number" && typeof input?.b === "number",
		JSON.stringify(call.input),
	)
	check(`${name} tool: announced before done`, toolEvents.some((e) => e.type === "tool_start"))

	const counted = await provider.countTokens({
		system: "You are terse.",
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		tools: [],
		model,
	})
	check(`${name} countTokens positive`, counted > 0, String(counted))
	check(`${name} contextWindow positive`, provider.contextWindow(model) > 0)
}

const { config } = loadConfig(process.cwd())
const only = process.argv.slice(2)

// The route table is what a session actually uses, so testing the providers it
// names beats testing a hardcoded list that drifts away from models.toml.
const wanted = new Map<string, { model: string; maxTokens: number }>()
for (const effort of ["low", "medium", "high", "ultra"] as const) {
	const r = routeFor(effort, config)
	if (!wanted.has(r.provider)) wanted.set(r.provider, { model: r.model, maxTokens: r.maxTokens })
}
for (const role of ["compact", "search", "subagent", "oracle"] as const) {
	const r = routeForRole(role)
	if (!wanted.has(r.provider)) wanted.set(r.provider, { model: r.model, maxTokens: r.maxTokens })
}

for (const [name, { model, maxTokens }] of wanted) {
	if (only.length && !only.includes(name)) continue
	let provider: Provider
	try {
		provider = makeProvider(name, config)
	} catch (err) {
		if (err instanceof KeyError && err.kind === "missing") {
			console.log(`skip ${name}: no key`)
			continue
		}
		check(`${name} constructed`, false, err instanceof Error ? err.message : String(err))
		continue
	}
	try {
		await exercise(name, provider, model, Math.min(maxTokens, 1024))
	} catch (err) {
		check(`${name} completed`, false, err instanceof Error ? err.message : String(err))
	}
}

if (!ran && !failures) {
	console.log("\nNo provider had a key. Nothing was verified.")
	process.exit(1)
}
console.log(`\n${failures ? `${failures} failed` : `all ok across ${ran} provider(s)`}`)
process.exit(failures ? 1 : 0)

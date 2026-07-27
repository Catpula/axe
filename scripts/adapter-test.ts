// Contract tests for the provider adapters.
//
// Recorded SSE bytes are replayed through a fake global fetch, so these run
// with no API key and no network. They verify what the adapters do with a
// response, not that the response shape is still current. Only a live call can
// tell us that.
import { AnthropicProvider } from "../src/providers/anthropic.ts"
import { GoogleProvider } from "../src/providers/google.ts"
import { OpenAIProvider } from "../src/providers/openai.ts"
import type { Provider, StreamEvent, StreamOptions } from "../src/providers/types.ts"

let failures = 0

function check(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` \u2014 ${detail}`}`)
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

/**
 * Bytes are chopped into 7-byte pieces so that every test also exercises the
 * SSE reader's buffering across chunk boundaries.
 */
function rawStream(text: string, onCancel?: () => void): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text)
	return new ReadableStream({
		start(c) {
			for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
			c.close()
		},
		cancel() {
			onCancel?.()
		},
	})
}

function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
	return rawStream(
		frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n",
	)
}

type Req = { url: string; body: any; headers: Record<string, string> }

const realFetch = globalThis.fetch

function baseOpts(opts: Partial<StreamOptions> = {}): StreamOptions {
	return {
		system: "system prompt",
		messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
		tools: [],
		model: "claude-sonnet-4-5",
		maxTokens: 2_000,
		signal: new AbortController().signal,
		...opts,
	}
}

/** Replaces the boundary, never the adapter. Returns what each try asked for. */
async function withFetch<T>(
	responder: (call: { n: number; url: string; init: any }) => Response | Promise<Response>,
	fn: () => Promise<T>,
): Promise<{ value: T; reqs: Req[] }> {
	const reqs: Req[] = []
	globalThis.fetch = (async (url: any, init: any) => {
		reqs.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
		return responder({ n: reqs.length - 1, url: String(url), init })
	}) as any
	try {
		return { value: await fn(), reqs }
	} finally {
		globalThis.fetch = realFetch
	}
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = []
	for await (const e of stream) events.push(e)
	return events
}

async function run(
	provider: Provider,
	frames: unknown[],
	opts: Partial<StreamOptions> = {},
): Promise<{ events: StreamEvent[]; req: Req }> {
	const { value, reqs } = await withFetch(
		() => new Response(sseStream(frames), { status: 200 }),
		() => drain(provider.stream(baseOpts(opts))),
	)
	return { events: value, req: reqs.at(-1) as Req }
}

async function caught(fn: () => Promise<unknown>): Promise<Error> {
	try {
		await fn()
	} catch (err) {
		return err as Error
	}
	// Returned rather than thrown so a regression is a failed check, not a crash.
	return new Error("no error was thrown")
}

function doneOf(events: StreamEvent[]) {
	const d = events.find((e) => e.type === "done")
	if (!d || d.type !== "done") throw new Error("no done event")
	return d
}

// ---------------------------------------------------------------- anthropic

const anthropic = new AnthropicProvider("test-key")

const ANTHROPIC_FRAMES = [
	{
		type: "message_start",
		message: {
			usage: {
				input_tokens: 1_000,
				cache_read_input_tokens: 500,
				cache_creation_input_tokens: 200,
			},
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "look" } },
	{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } },
	{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
	{ type: "content_block_start", index: 1, content_block: { type: "text" } },
	{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading." } },
	{
		type: "content_block_start",
		index: 2,
		content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
	},
	{
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '{"path":' },
	},
	{
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
	},
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } },
]

{
	const { events, req } = await run(anthropic, ANTHROPIC_FRAMES)
	const done = doneOf(events)
	const blocks = done.message.content

	check(
		"anthropic: block order preserved",
		JSON.stringify(blocks.map((b) => b.type)) === JSON.stringify(["thinking", "text", "tool_use"]),
	)
	check(
		"anthropic: thinking text assembled",
		blocks[0]!.type === "thinking" && blocks[0]!.text === "let me look",
	)
	check(
		"anthropic: signature assembled from deltas",
		blocks[0]!.type === "thinking" && blocks[0]!.signature === "sig-abc",
	)
	check(
		"anthropic: tool input parsed from split json",
		blocks[2]!.type === "tool_use" &&
			JSON.stringify(blocks[2]!.input) === JSON.stringify({ path: "a.ts" }),
	)
	check("anthropic: stop reason mapped", done.stop === "tool_use")
	check(
		"anthropic: streamed deltas reach the caller",
		events.filter((e) => e.type === "text_delta").length === 1 &&
			events.filter((e) => e.type === "thinking_delta").length === 2 &&
			events.some((e) => e.type === "tool_start" && e.name === "read_file"),
	)
	// input_tokens excludes cache: 1000*3 + 500*0.3 + 200*3*1.25 + 100*15, per million.
	check(
		"anthropic: cost math prices cache writes at 1.25x",
		near(done.usage.costUsd, 0.0054),
		`got ${done.usage.costUsd}`,
	)
	check("anthropic: cached tokens counted", done.usage.cachedInputTokens === 700)
	check("anthropic: system prompt is cached", req.body.system[0].cache_control.type === "ephemeral")
	check(
		"anthropic: conversation prefix is cached",
		req.body.messages[0].content[0].cache_control?.type === "ephemeral",
	)
	check("anthropic: api version header sent", req.headers["anthropic-version"] === "2023-06-01")

	// Invariant 3: the signature must survive being sent back.
	const { req: second } = await run(anthropic, ANTHROPIC_FRAMES, {
		messages: [{ role: "user", content: [{ type: "text", text: "go" }] }, done.message],
	})
	check(
		"anthropic: signature round trips",
		second.body.messages[1].content[0].signature === "sig-abc",
	)
	check(
		"anthropic: cache breakpoint sits on the last block only",
		second.body.messages[1].content[2].cache_control?.type === "ephemeral" &&
			second.body.messages[0].content[0].cache_control === undefined,
	)
	check(
		"anthropic: a thinking block never carries cache_control",
		second.body.messages[1].content[0].cache_control === undefined,
	)
}

// A server tool runs inside the provider: there is no tool_use to answer, so
// what it did and what it found have to survive as text or the next step is
// blind to a search that already happened.
{
	const { events, req } = await run(
		anthropic,
		[
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"query":"mcp spec"}' },
			},
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_1",
					content: [{ type: "web_search_result", title: "Spec", url: "https://spec.test/" }],
				},
			},
			{ type: "content_block_start", index: 2, content_block: { type: "text" } },
			{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Found it." } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
		],
		{ serverTools: ["web_search"] },
	)
	check(
		"anthropic: web_search is declared when asked for",
		req.body.tools.some((t: any) => t.type === "web_search_20250305"),
	)
	const blocks = doneOf(events).message.content
	check(
		"anthropic: a server tool call and its results survive as text",
		blocks.length === 3 &&
			blocks[0]!.type === "text" &&
			blocks[0]!.text === "[web_search: mcp spec]" &&
			blocks[1]!.type === "text" &&
			blocks[1]!.text.includes("https://spec.test/") &&
			blocks[2]!.type === "text" &&
			blocks[2]!.text === "Found it.",
		JSON.stringify(blocks),
	)
	check(
		"anthropic: no tool_use is emitted for a call the provider ran",
		!blocks.some((b) => b.type === "tool_use") && !events.some((e) => e.type === "tool_start"),
	)
}

{
	const { req } = await run(new AnthropicProvider("k", "https://proxy.local/v1/"), [
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	])
	check("anthropic: base url override", req.url === "https://proxy.local/v1/messages")
}

// A frontier model rejects budget_tokens with a 400, so a thinking budget has
// to arrive as adaptive thinking plus an effort. Older models keep the budget.
{
	const END = [
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	]
	const { req: modern } = await run(anthropic, END, {
		model: "claude-opus-5",
		thinkingBudget: 32_000,
	})
	check(
		"anthropic: a frontier model gets adaptive thinking, never a budget",
		modern.body.thinking.type === "adaptive" &&
			modern.body.thinking.budget_tokens === undefined &&
			modern.body.output_config.effort === "high",
	)
	const { req: mid } = await run(anthropic, END, {
		model: "claude-sonnet-5",
		thinkingBudget: 16_000,
	})
	check("anthropic: the budget still picks the effort", mid.body.output_config.effort === "medium")
	const { req: legacy } = await run(anthropic, END, {
		model: "claude-sonnet-4-5",
		thinkingBudget: 16_000,
	})
	check(
		"anthropic: an older model keeps budget_tokens",
		legacy.body.thinking.type === "enabled" &&
			legacy.body.thinking.budget_tokens === 16_000 &&
			legacy.body.output_config === undefined,
	)
	const { req: none } = await run(anthropic, END, { model: "claude-opus-5" })
	check("anthropic: no budget means no thinking config", none.body.thinking === undefined)
}

check("anthropic: the wide window is the default", anthropic.contextWindow("claude-opus-5") === 1_000_000)
check("anthropic: haiku is still 200k", anthropic.contextWindow("claude-haiku-4-5") === 200_000)

// ------------------------------------------------------------------- openai

const openai = new OpenAIProvider("test-key", { name: "openai" })

const OPENAI_FRAMES = [
	{ choices: [{ delta: { content: "Hi" } }] },
	{ choices: [{ delta: { reasoning_content: "hmm" } }] },
	{
		choices: [
			{
				delta: {
					tool_calls: [
						{ index: 0, id: "call_a", function: { name: "read_file", arguments: '{"pa' } },
					],
				},
			},
		],
	},
	{
		choices: [
			{
				delta: {
					tool_calls: [{ index: 1, id: "call_b", function: { name: "grep", arguments: '{"q":"x"}' } }],
				},
			},
		],
	},
	{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
	// Some servers report "stop" even when they emitted tool calls.
	{ choices: [{ delta: {}, finish_reason: "stop" }] },
	{
		choices: [],
		usage: {
			prompt_tokens: 1_000,
			prompt_tokens_details: { cached_tokens: 400 },
			completion_tokens: 200,
		},
	},
]

{
	const { events, req } = await run(openai, OPENAI_FRAMES, { model: "gpt-5-mini" })
	const done = doneOf(events)
	const blocks = done.message.content

	check(
		"openai: reasoning becomes a thinking block",
		blocks[0]!.type === "thinking" && blocks[0]!.text === "hmm",
	)
	check("openai: text assembled", blocks[1]!.type === "text" && blocks[1]!.text === "Hi")
	check(
		"openai: tool calls accumulated by index",
		blocks[2]!.type === "tool_use" &&
			blocks[2]!.id === "call_a" &&
			JSON.stringify(blocks[2]!.input) === JSON.stringify({ path: "a.ts" }) &&
			blocks[3]!.type === "tool_use" &&
			blocks[3]!.id === "call_b",
	)
	check("openai: tool calls override a stop finish_reason", done.stop === "tool_use")
	// prompt_tokens includes cached: 600*0.25 + 400*0.025 + 200*2, per million.
	check("openai: cost excludes cached from the uncached rate", near(done.usage.costUsd, 0.00056), `got ${done.usage.costUsd}`)
	check("openai: reasoning_effort from thinking budget", req.body.reasoning_effort === undefined)
	check("openai: usage requested", req.body.stream_options?.include_usage === true)
	check("openai: max_completion_tokens used", req.body.max_completion_tokens === 2_000)
}

{
	const { events } = await run(openai, OPENAI_FRAMES, { model: "some-local-model" })
	check("openai: unknown model costs 0 rather than a wrong number", doneOf(events).usage.costUsd === 0)
}

{
	const { events } = await run(openai, [{ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }])
	check("openai: length maps to max_tokens", doneOf(events).stop === "max_tokens")
}

{
	const { req } = await run(openai, OPENAI_FRAMES, { thinkingBudget: 16_000 })
	check("openai: medium effort for a mid budget", req.body.reasoning_effort === "medium")
}

{
	const compatible = new OpenAIProvider("k", {
		name: "groq",
		baseUrl: "https://api.groq.com/openai/v1/",
		compatible: true,
		contextWindow: 131_072,
	})
	const { req } = await run(compatible, OPENAI_FRAMES, { thinkingBudget: 32_000 })
	check("compatible: url normalised", req.url === "https://api.groq.com/openai/v1/chat/completions")
	check("compatible: max_tokens instead of max_completion_tokens", req.body.max_tokens === 2_000 && req.body.max_completion_tokens === undefined)
	check("compatible: no stream_options", req.body.stream_options === undefined)
	check("compatible: no reasoning_effort", req.body.reasoning_effort === undefined)
	check("compatible: declared context window wins", compatible.contextWindow("whatever") === 131_072)
}

{
	// A full tool cycle on the way out: tool results become their own messages
	// and thinking is dropped, because there is nothing to round trip it with.
	const { req } = await run(openai, OPENAI_FRAMES, {
		messages: [
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "secret reasoning" },
					{ type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.ts" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", id: "call_a", content: "file body" }] },
		],
	})
	const msgs = req.body.messages
	check("openai: system goes first", msgs[0].role === "system")
	check("openai: tool_result becomes a tool message", msgs.at(-1).role === "tool" && msgs.at(-1).tool_call_id === "call_a")
	check("openai: assistant carries tool_calls", msgs[2].tool_calls[0].function.name === "read_file")
	check("openai: thinking is dropped", !JSON.stringify(msgs).includes("secret reasoning"))
}

// ------------------------------------------------------------------- google

const google = new GoogleProvider("test-key")

const GOOGLE_FRAMES = [
	{
		candidates: [
			{ content: { parts: [{ text: "weighing ", thought: true }] } },
		],
	},
	{
		candidates: [
			{ content: { parts: [{ text: "options", thought: true, thoughtSignature: "gsig" }] } },
		],
	},
	{ candidates: [{ content: { parts: [{ text: "Hello " }] } }] },
	{ candidates: [{ content: { parts: [{ text: "world" }] } }] },
	{
		candidates: [
			{
				content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }] },
				finishReason: "STOP",
			},
		],
		usageMetadata: {
			promptTokenCount: 1_000,
			cachedContentTokenCount: 400,
			candidatesTokenCount: 200,
			thoughtsTokenCount: 50,
		},
	},
]

{
	const { events, req } = await run(google, GOOGLE_FRAMES, { model: "gemini-2.5-flash" })
	const done = doneOf(events)
	const blocks = done.message.content

	check(
		"google: parts merge into blocks in order",
		JSON.stringify(blocks.map((b) => b.type)) === JSON.stringify(["thinking", "text", "tool_use"]),
	)
	check(
		"google: consecutive text parts merge",
		blocks[1]!.type === "text" && blocks[1]!.text === "Hello world",
	)
	check(
		"google: thought signature captured",
		blocks[0]!.type === "thinking" &&
			blocks[0]!.text === "weighing options" &&
			blocks[0]!.signature === "gsig",
	)
	const started = events.find((e) => e.type === "tool_start")
	check(
		"google: function call becomes tool_use with a synthetic id",
		blocks[2]!.type === "tool_use" &&
			started?.type === "tool_start" &&
			blocks[2]!.id === started.id &&
			blocks[2]!.id.startsWith("call_") &&
			JSON.stringify(blocks[2]!.input) === JSON.stringify({ path: "a.ts" }),
	)
	check("google: STOP with a function call still means tool_use", done.stop === "tool_use")
	check("google: thinking tokens billed as output", done.usage.outputTokens === 250)
	// 600*0.3 + 400*0.075 + 250*2.5, per million.
	check("google: cost math", near(done.usage.costUsd, 0.000835), `got ${done.usage.costUsd}`)
	check(
		"google: sse endpoint",
		req.url ===
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
	)
	check("google: api key header", req.headers["x-goog-api-key"] === "test-key")
	check("google: system instruction sent separately", req.body.systemInstruction.parts[0].text === "system prompt")
	check("google: no thinking config without a budget", req.body.generationConfig.thinkingConfig === undefined)
}

{
	const { req } = await run(google, GOOGLE_FRAMES, {
		model: "gemini-2.5-pro",
		thinkingBudget: 8_000,
		tools: [
			{
				name: "read_file",
				description: "read",
				readOnly: true,
				run: async () => "",
				schema: {
					$schema: "http://json-schema.org/draft-07/schema#",
					type: "object",
					additionalProperties: false,
					properties: { path: { type: "string", default: "x" } },
				},
			},
		],
	})
	const params = req.body.tools[0].functionDeclarations[0].parameters
	check(
		"google: schema keys gemini rejects are stripped, recursively",
		params.$schema === undefined &&
			params.additionalProperties === undefined &&
			params.properties.path.default === undefined &&
			params.properties.path.type === "string",
	)
	check(
		"google: thinking budget passed through",
		req.body.generationConfig.thinkingConfig.thinkingBudget === 8_000 &&
			req.body.generationConfig.thinkingConfig.includeThoughts === true,
	)
}

{
	const { events } = await run(
		google,
		[{ candidates: [{ content: { parts: [{ text: "cut off" }] }, finishReason: "MAX_TOKENS" }] }],
		{ model: "gemini-2.5-flash" },
	)
	check("google: MAX_TOKENS maps through", doneOf(events).stop === "max_tokens")
}

{
	const { req } = await run(google, GOOGLE_FRAMES, {
		model: "gemini-2.5-flash",
		messages: [
			{ role: "user", content: [{ type: "text", text: "go" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "unsigned reasoning" },
					{ type: "tool_use", id: "call_0", name: "read_file", input: { path: "a.ts" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", id: "call_0", content: "file body" }] },
		],
	})
	const c = req.body.contents
	check("google: assistant becomes model", c[1].role === "model")
	check(
		"google: unsigned thinking is dropped",
		!JSON.stringify(c).includes("unsigned reasoning"),
	)
	check(
		"google: tool_result is matched back to its tool name",
		c[2].parts[0].functionResponse.name === "read_file" &&
			c[2].parts[0].functionResponse.response.output === "file body",
	)
}

{
	// Unlike the OpenAI path, this number is real.
	let url = ""
	globalThis.fetch = (async (u: any) => {
		url = String(u)
		return new Response(JSON.stringify({ totalTokens: 4_321 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	}) as any
	try {
		const n = await google.countTokens({
			system: "system prompt",
			messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
			tools: [],
			model: "gemini-2.5-flash",
		})
		check("google: countTokens uses the real endpoint", url.endsWith(":countTokens"))
		check("google: countTokens returns the provider number", n === 4_321)
	} finally {
		globalThis.fetch = realFetch
	}
}

{
	// Two turns in a row: the ids of the second must not collide with the first,
	// or toContents matches a functionResponse to the wrong tool name.
	const idOf = (events: StreamEvent[]) => {
		const call = doneOf(events).message.content.find((b) => b.type === "tool_use")
		return call && call.type === "tool_use" ? call.id : ""
	}
	const first = await run(google, GOOGLE_FRAMES, { model: "gemini-2.5-flash" })
	const second = await run(google, GOOGLE_FRAMES, { model: "gemini-2.5-flash" })
	check("google: tool ids are unique across turns", idOf(first.events) !== idOf(second.events))
}

// ------------------------------------------------------- transport behaviour

const ANTHROPIC_CUT = [
	{ type: "message_start", message: { usage: { input_tokens: 10 } } },
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_9", name: "read_file" },
	},
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } },
]

{
	const started = Date.now()
	const { value, reqs } = await withFetch(
		({ n }) =>
			n === 0
				? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
				: new Response(sseStream(ANTHROPIC_FRAMES), { status: 200 }),
		() => drain(anthropic.stream(baseOpts())),
	)
	const waited = Date.now() - started
	const done = doneOf(value)
	check("http: 429 is retried instead of killing the turn", reqs.length === 2)
	check("http: retry-after is honoured", waited >= 900, `waited ${waited}ms`)
	check(
		"http: a replayed stream does not say everything twice",
		value.filter((e) => e.type === "text_delta").length === 1 &&
			done.message.content.filter((b) => b.type === "text").length === 1,
	)
}

{
	let tries = 0
	const err = await caught(() =>
		withFetch(
			() => {
				tries++
				return new Response("bad request", { status: 400 })
			},
			() => drain(anthropic.stream(baseOpts())),
		),
	)
	check("http: a status we caused is not retried", tries === 1)
	check("http: the status reaches the caller", err.message.includes("400"))
}

{
	// Nothing was yielded, so the cut stream is safe to ask for again.
	let tries = 0
	const { value } = await withFetch(
		({ n }) => {
			tries++
			return new Response(
				sseStream(n === 0 ? [{ type: "message_start", message: { usage: {} } }] : ANTHROPIC_FRAMES),
				{ status: 200 },
			)
		},
		() => drain(anthropic.stream(baseOpts())),
	)
	check("http: a stream cut before its first event is retried", tries === 2)
	check("http: the retry produced a whole turn", doneOf(value).stop === "tool_use")
}

{
	let tries = 0
	const err = await caught(() =>
		withFetch(
			() => {
				tries++
				return new Response(sseStream(ANTHROPIC_CUT), { status: 200 })
			},
			() => drain(anthropic.stream(baseOpts())),
		),
	)
	check("anthropic: a stream cut mid tool json is truncated, not saved", err.message.includes("truncated"))
	check("http: a stream that already yielded is never replayed", tries === 1)
}

{
	const err = await caught(() =>
		withFetch(
			() => new Response(rawStream(`data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`), { status: 200 }),
			() => drain(openai.stream(baseOpts({ model: "gpt-5-mini" }))),
		),
	)
	check("openai: no finish_reason and no [DONE] is truncated", err.message.includes("truncated"))
}

const SSE_BODY =
	`data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
	`data: {oops\n\n` +
	`: keep-alive\n\n` +
	`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n` +
	`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`

const textOf = (events: StreamEvent[]) =>
	events.filter((e) => e.type === "text_delta").map((e) => e.text).join("")

{
	const { value } = await withFetch(
		() => new Response(rawStream(SSE_BODY), { status: 200 }),
		() => drain(anthropic.stream(baseOpts())),
	)
	check("sse: a malformed frame is skipped rather than fatal", textOf(value) === "Hi")
}

{
	// A server that frames with CRLF used to look like a completely silent turn.
	const { value } = await withFetch(
		() => new Response(rawStream(SSE_BODY.replace(/\n/g, "\r\n")), { status: 200 }),
		() => drain(anthropic.stream(baseOpts())),
	)
	check("sse: CRLF frames are read like LF frames", textOf(value) === "Hi")
	check("sse: CRLF stream still reaches its stop reason", doneOf(value).stop === "end_turn")
}

{
	// Parsing CRLF at the end of the stream is not enough: the frames have to
	// come out while the connection is still open, or the turn is silent until
	// the server hangs up.
	const encoder = new TextEncoder()
	const slow = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(encoder.encode(SSE_BODY.replace(/\n/g, "\r\n")))
			setTimeout(() => c.close(), 250)
		},
	})
	const { value } = await withFetch(
		() => new Response(slow, { status: 200 }),
		async () => {
			const it = anthropic.stream(baseOpts())[Symbol.asyncIterator]()
			const started = Date.now()
			const first = await it.next()
			const waited = Date.now() - started
			await it.return?.()
			return { first: first.value, waited }
		},
	)
	check(
		"sse: a CRLF frame is delivered before the connection closes",
		value.first?.type === "text_delta" && value.waited < 200,
		`waited ${value.waited}ms`,
	)
}

{
	// A frame with no trailing blank line is still a frame.
	const { value } = await withFetch(
		() => new Response(rawStream(SSE_BODY.trimEnd()), { status: 200 }),
		() => drain(anthropic.stream(baseOpts())),
	)
	check("sse: the tail of the buffer is flushed", doneOf(value).stop === "end_turn")
}

{
	let cancelled = false
	const encoder = new TextEncoder()
	const live = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(
				encoder.encode(
					`data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
						`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
				),
			)
		},
		cancel() {
			cancelled = true
		},
	})
	const ac = new AbortController()
	globalThis.fetch = (async () => new Response(live, { status: 200 })) as any
	try {
		const it = anthropic.stream(baseOpts({ signal: ac.signal }))[Symbol.asyncIterator]()
		const first = await it.next()
		ac.abort()
		let extra = 0
		let failed: Error | undefined
		try {
			const next = await it.next()
			if (!next.done) extra++
		} catch (err) {
			failed = err as Error
		}
		await new Promise((r) => setTimeout(r, 0))
		check("abort: events before the abort still arrive", first.value?.type === "text_delta")
		check("abort: nothing is yielded after the abort", extra === 0)
		check("abort: the reader is cancelled so the socket closes", cancelled)
		check("abort: an aborted stream is not retried", failed?.name === "AbortError")
	} finally {
		globalThis.fetch = realFetch
	}
}

{
	// The estimate decides when to compact, so a megabyte of base64 must not
	// push every single step over the threshold.
	const image = "A".repeat(200_000)
	const withImage = await openai.countTokens({
		system: "system prompt",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", mime: "image/png", data: image },
				],
			},
		],
		tools: [],
		model: "gpt-5-mini",
	})
	check("openai: the token estimate ignores inlined image data", withImage < 1_000, `got ${withImage}`)
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

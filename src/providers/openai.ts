import { SSE_DONE, sseEvents } from "./sse.ts"
import { DEFAULT_POLICY, retryStream, send } from "./http.ts"
import type {
	Block,
	CountOptions,
	Message,
	Provider,
	StopReason,
	StreamEvent,
	StreamOptions,
	Usage,
} from "./types.ts"

const DEFAULT_BASE = "https://api.openai.com/v1"

export type OpenAIOptions = {
	/** Label shown in errors. Use the config key, e.g. "groq". */
	name?: string
	baseUrl?: string
	/**
	 * True for third-party servers. Sends the conservative field set:
	 * max_tokens instead of max_completion_tokens, no stream_options,
	 * no reasoning_effort.
	 */
	compatible?: boolean
	contextWindow?: number
}

/** USD per million tokens. Unknown models cost 0 rather than a wrong number. */
const PRICES: Array<[string, { in: number; cachedIn: number; out: number }]> = [
	["gpt-5-mini", { in: 0.25, cachedIn: 0.025, out: 2 }],
	["gpt-5", { in: 1.25, cachedIn: 0.125, out: 10 }],
	["gpt-4.1-mini", { in: 0.4, cachedIn: 0.1, out: 1.6 }],
	["gpt-4.1", { in: 2, cachedIn: 0.5, out: 8 }],
	["o4-mini", { in: 1.1, cachedIn: 0.275, out: 4.4 }],
]

function priceOf(model: string) {
	for (const [prefix, p] of PRICES) if (model.includes(prefix)) return p
	return { in: 0, cachedIn: 0, out: 0 }
}

const WINDOWS: Array<[string, number]> = [
	["gpt-5", 400_000],
	["gpt-4.1", 1_000_000],
	["o4-mini", 200_000],
	// Poolside serves every Laguna at the same window, and it is not the 128k
	// default: guessing low here would compact a session less than halfway in.
	["laguna", 262_144],
]

/**
 * Chat Completions shape. Tool results become separate `tool` messages, which
 * is why one of our messages can expand into several of theirs.
 */
function toApiMessages(messages: Message[]): unknown[] {
	const out: any[] = []
	for (const m of messages) {
		if (m.role === "user") {
			const parts: any[] = []
			for (const b of m.content) {
				if (b.type === "tool_result") {
					out.push({ role: "tool", tool_call_id: b.id, content: b.content })
				} else if (b.type === "text") {
					parts.push({ type: "text", text: b.text })
				} else if (b.type === "image") {
					parts.push({
						type: "image_url",
						image_url: { url: `data:${b.mime};base64,${b.data}` },
					})
				}
			}
			if (parts.length) out.push({ role: "user", content: parts })
		} else {
			const text = m.content
				.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("")
			const calls = m.content
				.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
				.map((b) => ({
					id: b.id,
					type: "function",
					function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
				}))
			// Thinking blocks are dropped: there is no round-trippable equivalent.
			const msg: any = { role: "assistant" }
			if (text) msg.content = text
			if (calls.length) msg.tool_calls = calls
			if (msg.content || msg.tool_calls) out.push(msg)
		}
	}
	return out
}

function toApiTools(tools: StreamOptions["tools"]): unknown[] {
	return tools.map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.schema },
	}))
}

type PartialCall = { id: string; name: string; args: string; announced: boolean }

export class OpenAIProvider implements Provider {
	readonly name: string

	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly compatible: boolean
	private readonly window: number | undefined

	constructor(apiKey: string, opts: OpenAIOptions = {}) {
		this.apiKey = apiKey
		this.name = opts.name ?? "openai"
		this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "")
		this.compatible = opts.compatible ?? false
		this.window = opts.contextWindow
	}

	contextWindow(model: string): number {
		if (this.window) return this.window
		for (const [prefix, n] of WINDOWS) if (model.includes(prefix)) return n
		return 128_000
	}

	/**
	 * Chat Completions has no token counting endpoint and compatible servers do
	 * not agree on tokenisers, so this is a deliberate over-estimate used only to
	 * decide when to compact. Never show it to the user as a token count.
	 */
	async countTokens(opts: CountOptions): Promise<number> {
		const payload = JSON.stringify([
			opts.system,
			toApiMessages(opts.messages),
			toApiTools(opts.tools),
		])
		// An inlined image is a few hundred characters of tokens and a megabyte
		// of base64. Measured raw it puts every turn over the threshold and the
		// session compacts on every step.
		const measured = payload.replace(/"data:[^"]*"/g, '""')
		return Math.ceil(measured.length / 3.5) + opts.messages.length * 4
	}

	async *stream(opts: StreamOptions): AsyncIterable<StreamEvent> {
		yield* retryStream(() => this.attempt(opts), { signal: opts.signal })
	}

	private async *attempt(opts: StreamOptions): AsyncGenerator<StreamEvent> {
		const body: Record<string, unknown> = {
			model: opts.model,
			messages: [{ role: "system", content: opts.system }, ...toApiMessages(opts.messages)],
			stream: true,
		}
		if (opts.tools.length) body.tools = toApiTools(opts.tools)
		if (this.compatible) {
			body.max_tokens = opts.maxTokens
		} else {
			body.max_completion_tokens = opts.maxTokens
			body.stream_options = { include_usage: true }
			if (opts.thinkingBudget && opts.thinkingBudget > 0) {
				body.reasoning_effort =
					opts.thinkingBudget >= 32_000 ? "high" : opts.thinkingBudget >= 8_000 ? "medium" : "low"
			}
		}

		const res = await send(
			`${this.baseUrl}/chat/completions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
			},
			{ signal: opts.signal, label: this.name },
		)
		if (!res.body) throw new Error(`${this.name}: response has no body`)

		const calls: PartialCall[] = []
		let text = ""
		let reasoning = ""
		let stop: StopReason = "end_turn"
		let terminal = false
		const usage: Usage = {
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
		}

		for await (const ev of sseEvents(res.body, {
			signal: opts.signal,
			idleMs: DEFAULT_POLICY.idleTimeoutMs,
			doneSentinel: true,
		})) {
			if (ev === SSE_DONE) {
				terminal = true
				continue
			}
			if (ev.error) throw new Error(`${this.name} stream error: ${JSON.stringify(ev.error)}`)
			if (ev.usage) {
				usage.inputTokens = ev.usage.prompt_tokens ?? usage.inputTokens
				usage.cachedInputTokens =
					ev.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedInputTokens
				usage.outputTokens = ev.usage.completion_tokens ?? usage.outputTokens
			}
			const choice = ev.choices?.[0]
			if (!choice) continue
			const d = choice.delta ?? {}

			if (typeof d.content === "string" && d.content) {
				text += d.content
				yield { type: "text_delta", text: d.content }
			}
			const r = d.reasoning_content ?? d.reasoning
			if (typeof r === "string" && r) {
				reasoning += r
				yield { type: "thinking_delta", text: r }
			}
			for (const tc of d.tool_calls ?? []) {
				const i: number = tc.index ?? 0
				let c = calls[i]
				if (!c) {
					c = { id: tc.id ?? `call_${i}`, name: "", args: "", announced: false }
					calls[i] = c
				}
				if (tc.id) c.id = tc.id
				if (tc.function?.name) c.name += tc.function.name
				if (c.name && !c.announced) {
					c.announced = true
					yield { type: "tool_start", id: c.id, name: c.name }
				}
				if (tc.function?.arguments) {
					c.args += tc.function.arguments
					yield { type: "tool_input_delta", id: c.id, json: tc.function.arguments }
				}
			}

			const reason = choice.finish_reason
			if (reason === "tool_calls") stop = "tool_use"
			else if (reason === "length") stop = "max_tokens"
			else if (reason) stop = "end_turn"
			if (reason) terminal = true
		}

		// Neither a finish_reason nor a [DONE] means the socket died mid answer.
		// Kept out of the thread, where it would read as a complete turn.
		if (!terminal) throw new Error(`${this.name} stream truncated: no finish_reason`)

		const content: Block[] = []
		if (reasoning) content.push({ type: "thinking", text: reasoning })
		if (text) content.push({ type: "text", text })
		for (const c of calls) {
			if (!c) continue
			let input: unknown = {}
			if (c.args.trim()) {
				try {
					input = JSON.parse(c.args)
				} catch {
					input = { __parse_error: c.args }
				}
			}
			content.push({ type: "tool_use", id: c.id, name: c.name, input })
		}
		// Some compatible servers only signal tool use through the payload.
		if (stop === "end_turn" && calls.length) stop = "tool_use"

		const price = priceOf(opts.model)
		// Unlike Anthropic, prompt_tokens already includes the cached tokens.
		const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
		usage.costUsd =
			(uncached * price.in) / 1e6 +
			(usage.cachedInputTokens * price.cachedIn) / 1e6 +
			(usage.outputTokens * price.out) / 1e6

		yield { type: "done", stop, message: { role: "assistant", content }, usage }
	}
}

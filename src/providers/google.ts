import { sseEvents } from "./sse.ts"
import { DEFAULT_POLICY, retryStream, send, sendWithRetry } from "./http.ts"
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

const DEFAULT_BASE =
	process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta"

export type GoogleOptions = {
	name?: string
	baseUrl?: string
	contextWindow?: number
}

/**
 * USD per million tokens, paid tier, prompts under 200k. Checked July 2026.
 * Longer prompts cost more on pro; we do not model that, so a very long turn is
 * under-reported. Unknown models cost 0 rather than a wrong number.
 * Order matters: flash-lite must be tested before flash.
 */
const PRICES: Array<[string, { in: number; cachedIn: number; out: number }]> = [
	["gemini-2.5-flash-lite", { in: 0.1, cachedIn: 0.025, out: 0.4 }],
	["gemini-2.5-flash", { in: 0.3, cachedIn: 0.075, out: 2.5 }],
	["gemini-2.5-pro", { in: 1.25, cachedIn: 0.31, out: 10 }],
]

function priceOf(model: string) {
	for (const [prefix, p] of PRICES) if (model.includes(prefix)) return p
	return { in: 0, cachedIn: 0, out: 0 }
}

/** Counting outside a turn still gets the timeouts. */
const NEVER = new AbortController().signal

/**
 * Call ids are handed out for the life of the process, not per stream. A second
 * turn that started again at call_0 would make the id to tool name map built in
 * toContents ambiguous, and the model would see its answers under a tool name
 * it never called.
 */
let callSeq = 0

/**
 * Gemini rejects a JSON Schema containing keys it does not know, and our tool
 * schemas carry a few that only matter to other providers.
 */
function cleanSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cleanSchema)
	if (!value || typeof value !== "object") return value
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (k === "$schema" || k === "additionalProperties" || k === "default") continue
		out[k] = cleanSchema(v)
	}
	return out
}

export function toApiTools(
	tools: StreamOptions["tools"],
	serverTools: StreamOptions["serverTools"] = [],
): unknown[] {
	const out: unknown[] = [
		{
			functionDeclarations: tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: cleanSchema(t.schema),
			})),
		},
	]
	// Gemini grounds the answer itself and returns prose, so there is nothing
	// for us to execute and nothing extra to parse out of the stream.
	if (serverTools.includes("web_search")) out.push({ google_search: {} })
	return out
}

/**
 * Gemini identifies a function response by tool name, not by call id, so the
 * name is recovered from the tool_use block that opened the cycle.
 */
function toContents(messages: Message[]): unknown[] {
	const names = new Map<string, string>()
	for (const m of messages) {
		for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name)
	}

	const out: any[] = []
	for (const m of messages) {
		const parts: any[] = []
		for (const b of m.content) {
			switch (b.type) {
				case "text":
					if (b.text) parts.push({ text: b.text })
					break
				case "thinking":
					// Only round trippable with the signature the server issued.
					if (b.signature) {
						parts.push({ text: b.text, thought: true, thoughtSignature: b.signature })
					}
					break
				case "tool_use":
					parts.push({ functionCall: { name: b.name, args: b.input ?? {} } })
					break
				case "tool_result":
					parts.push({
						functionResponse: {
							name: names.get(b.id) ?? b.id,
							response: b.isError ? { error: b.content } : { output: b.content },
						},
					})
					break
				case "image":
					parts.push({ inlineData: { mimeType: b.mime, data: b.data } })
					break
			}
		}
		if (parts.length) out.push({ role: m.role === "assistant" ? "model" : "user", parts })
	}
	return out
}

export class GoogleProvider implements Provider {
	readonly name: string

	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly window: number | undefined

	constructor(apiKey: string, opts: GoogleOptions = {}) {
		this.apiKey = apiKey
		this.name = opts.name ?? "google"
		this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "")
		this.window = opts.contextWindow
	}

	contextWindow(_model: string): number {
		return this.window ?? 1_048_576
	}

	private headers(): Record<string, string> {
		return { "content-type": "application/json", "x-goog-api-key": this.apiKey }
	}

	private payload(opts: CountOptions | StreamOptions): Record<string, unknown> {
		const body: Record<string, unknown> = { contents: toContents(opts.messages) }
		if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] }
		const serverTools = "serverTools" in opts ? opts.serverTools : undefined
		if (opts.tools.length) body.tools = toApiTools(opts.tools, serverTools)
		return body
	}

	/** Real count from the provider's own tokeniser, unlike the OpenAI path. */
	async countTokens(opts: CountOptions): Promise<number> {
		const res = await sendWithRetry(
			`${this.baseUrl}/models/${opts.model}:countTokens`,
			{ method: "POST", headers: this.headers(), body: JSON.stringify(this.payload(opts)) },
			{ signal: opts.signal ?? NEVER, label: `${this.name} countTokens` },
		)
		const json: any = await res.json()
		return json.totalTokens ?? 0
	}

	async *stream(opts: StreamOptions): AsyncIterable<StreamEvent> {
		yield* retryStream(() => this.attempt(opts), { signal: opts.signal })
	}

	private async *attempt(opts: StreamOptions): AsyncGenerator<StreamEvent> {
		const generationConfig: Record<string, unknown> = { maxOutputTokens: opts.maxTokens }
		if (opts.thinkingBudget && opts.thinkingBudget > 0) {
			generationConfig.thinkingConfig = {
				includeThoughts: true,
				thinkingBudget: opts.thinkingBudget,
			}
		}
		const body = { ...this.payload(opts), generationConfig }

		const res = await send(
			`${this.baseUrl}/models/${opts.model}:streamGenerateContent?alt=sse`,
			{ method: "POST", headers: this.headers(), body: JSON.stringify(body) },
			{ signal: opts.signal, label: this.name },
		)
		if (!res.body) throw new Error(`${this.name}: response has no body`)

		const content: Block[] = []
		let calls = 0
		let stop: StopReason = "end_turn"
		let terminal = false
		const usage: Usage = {
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
		}

		// Gemini streams a part at a time, so consecutive parts of the same kind
		// are merged back into one block.
		const addText = (text: string) => {
			const last = content.at(-1)
			if (last?.type === "text") last.text += text
			else content.push({ type: "text", text })
		}
		const addThought = (text: string, signature?: string) => {
			const last = content.at(-1)
			if (last?.type === "thinking") {
				last.text += text
				if (signature) last.signature = signature
			} else content.push({ type: "thinking", text, signature })
		}

		for await (const ev of sseEvents(res.body, {
			signal: opts.signal,
			idleMs: DEFAULT_POLICY.idleTimeoutMs,
		})) {
			if (ev.error) throw new Error(`${this.name} stream error: ${JSON.stringify(ev.error)}`)
			if (ev.usageMetadata) {
				const u = ev.usageMetadata
				usage.inputTokens = u.promptTokenCount ?? usage.inputTokens
				usage.cachedInputTokens = u.cachedContentTokenCount ?? usage.cachedInputTokens
				// Thinking tokens are billed at the output rate.
				usage.outputTokens =
					(u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || usage.outputTokens
			}

			const cand = ev.candidates?.[0]
			if (!cand) continue

			for (const p of cand.content?.parts ?? []) {
				if (p.functionCall) {
					calls++
					const id = `call_${callSeq++}`
					const name: string = p.functionCall.name ?? ""
					const input = p.functionCall.args ?? {}
					yield { type: "tool_start", id, name }
					yield { type: "tool_input_delta", id, json: JSON.stringify(input) }
					content.push({ type: "tool_use", id, name, input })
				} else if (typeof p.text === "string" && p.text) {
					if (p.thought) {
						addThought(p.text, p.thoughtSignature)
						yield { type: "thinking_delta", text: p.text }
					} else {
						addText(p.text)
						yield { type: "text_delta", text: p.text }
					}
				}
			}

			if (cand.finishReason === "MAX_TOKENS") stop = "max_tokens"
			else if (cand.finishReason) stop = "end_turn"
			if (cand.finishReason) terminal = true
		}

		// No finishReason means the stream stopped early, and a half answer must
		// not reach the thread looking like a whole one.
		if (!terminal) throw new Error(`${this.name} stream truncated: no finishReason`)

		// Gemini reports STOP even when the turn is a function call.
		if (stop === "end_turn" && calls > 0) stop = "tool_use"

		const price = priceOf(opts.model)
		// promptTokenCount already includes the cached tokens.
		const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
		usage.costUsd =
			(uncached * price.in) / 1e6 +
			(usage.cachedInputTokens * price.cachedIn) / 1e6 +
			(usage.outputTokens * price.out) / 1e6

		yield { type: "done", stop, message: { role: "assistant", content }, usage }
	}
}

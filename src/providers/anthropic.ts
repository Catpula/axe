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
import { sseEvents } from "./sse.ts"
import { DEFAULT_POLICY, retryStream, send, sendWithRetry } from "./http.ts"

const DEFAULT_BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"
const API_VERSION = "2023-06-01"

/** Callers that count tokens outside a turn still get the timeouts. */
const NEVER = new AbortController().signal

/** USD per million tokens. Unknown models cost 0 rather than a wrong number. */
const PRICES: Array<[string, { in: number; cachedIn: number; out: number }]> = [
	["claude-fable", { in: 10, cachedIn: 1, out: 50 }],
	["claude-opus", { in: 5, cachedIn: 0.5, out: 25 }],
	["claude-sonnet", { in: 3, cachedIn: 0.3, out: 15 }],
	["claude-haiku", { in: 1, cachedIn: 0.1, out: 5 }],
]

function priceOf(model: string) {
	for (const [prefix, p] of PRICES) if (model.includes(prefix)) return p
	return { in: 0, cachedIn: 0, out: 0 }
}

/**
 * Frontier models reject `budget_tokens` with a 400: the token budget was
 * replaced by adaptive thinking plus a coarse effort dial. Matching by name is
 * ugly, but the alternative is a 400 on every high-effort turn.
 */
const ADAPTIVE_THINKING = /claude-(opus|sonnet|fable)-5|claude-opus-4-[78]/

/** Only the 200K models are the exception now, so the wide window is the default. */
const SMALL_WINDOW = /claude-haiku/

function effortFor(budget: number): string {
	if (budget >= 32_000) return "high"
	if (budget >= 8_000) return "medium"
	return "low"
}

function toApiBlocks(blocks: Block[]): unknown[] {
	return blocks.map((b) => {
		switch (b.type) {
			case "text":
				return { type: "text", text: b.text }
			case "thinking":
				// The signature must survive the round trip or the API rejects the turn.
				return { type: "thinking", thinking: b.text, signature: b.signature }
			case "tool_use":
				return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }
			case "tool_result":
				return {
					type: "tool_result",
					tool_use_id: b.id,
					content: b.content,
					is_error: b.isError ?? false,
				}
			case "image":
				return {
					type: "image",
					source: { type: "base64", media_type: b.mime, data: b.data },
				}
		}
	})
}

function toApiMessages(messages: Message[]): unknown[] {
	return messages.map((m) => ({ role: m.role, content: toApiBlocks(m.content) }))
}

/**
 * The conversation only ever grows by appending, so a breakpoint on the last
 * block makes every request a cache hit on everything before this step. The
 * API rejects cache_control on thinking blocks, so walk past those.
 */
function markCacheBreakpoint(messages: unknown[]): void {
	for (let m = messages.length - 1; m >= 0; m--) {
		const content = (messages[m] as { content: Array<Record<string, unknown>> }).content
		for (let b = content.length - 1; b >= 0; b--) {
			const block = content[b]!
			if (block.type === "thinking") continue
			block.cache_control = { type: "ephemeral" }
			return
		}
	}
}

const MAX_SEARCHES = 5

export function toApiTools(
	tools: StreamOptions["tools"],
	serverTools: StreamOptions["serverTools"] = [],
): unknown[] {
	const out: unknown[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.schema,
	}))
	// A server tool has no schema of its own: the type name is the whole
	// declaration, and Anthropic runs it and folds the result into the stream.
	if (serverTools.includes("web_search")) {
		out.push({ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES })
	}
	return out
}

type Partial =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; signature?: string }
	| { kind: "tool_use"; id: string; name: string; json: string }
	| { kind: "server_tool"; name: string; json: string }
	| { kind: "server_result"; text: string }

/**
 * A server tool ran inside the provider, so there is no tool_use for us to
 * answer and no tool_result to send. Folding what it did into plain text is
 * what keeps the next step able to see it: the alternative is a block type
 * that every provider, the thread file and compaction would all have to learn.
 */
export function serverResultText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) {
		const err = content as { type?: string; error_code?: string } | null
		return err?.type === "web_search_tool_result_error"
			? `search failed: ${err.error_code ?? "unknown"}`
			: JSON.stringify(content)
	}
	const lines = content.map((r) => {
		const hit = r as { title?: string; url?: string }
		return hit.url ? `${hit.title ?? hit.url}\n${hit.url}` : JSON.stringify(r)
	})
	return lines.join("\n\n")
}

export class AnthropicProvider implements Provider {
	readonly name = "anthropic"

	private readonly apiKey: string
	private readonly baseUrl: string

	constructor(apiKey: string, baseUrl: string = DEFAULT_BASE) {
		this.apiKey = apiKey
		this.baseUrl = baseUrl.replace(/\/$/, "")
	}

	private headers(): Record<string, string> {
		return {
			"content-type": "application/json",
			"x-api-key": this.apiKey,
			"anthropic-version": API_VERSION,
		}
	}

	contextWindow(model: string): number {
		return SMALL_WINDOW.test(model) ? 200_000 : 1_000_000
	}

	async countTokens(opts: CountOptions): Promise<number> {
		const res = await sendWithRetry(
			`${this.baseUrl}/messages/count_tokens`,
			{
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({
					model: opts.model,
					system: opts.system,
					messages: toApiMessages(opts.messages),
					tools: toApiTools(opts.tools),
				}),
			},
			{ signal: opts.signal ?? NEVER, label: "count_tokens" },
		)
		const json = (await res.json()) as { input_tokens: number }
		return json.input_tokens
	}

	async *stream(opts: StreamOptions): AsyncIterable<StreamEvent> {
		yield* retryStream(() => this.attempt(opts), { signal: opts.signal })
	}

	private async *attempt(opts: StreamOptions): AsyncGenerator<StreamEvent> {
		const messages = toApiMessages(opts.messages)
		markCacheBreakpoint(messages)
		const body: Record<string, unknown> = {
			model: opts.model,
			max_tokens: opts.maxTokens,
			system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
			messages,
			tools: toApiTools(opts.tools, opts.serverTools),
			stream: true,
		}
		if (opts.thinkingBudget && opts.thinkingBudget > 0) {
			if (ADAPTIVE_THINKING.test(opts.model)) {
				body.thinking = { type: "adaptive" }
				body.output_config = { effort: effortFor(opts.thinkingBudget) }
			} else {
				body.thinking = { type: "enabled", budget_tokens: opts.thinkingBudget }
			}
		}

		const res = await send(
			`${this.baseUrl}/messages`,
			{ method: "POST", headers: this.headers(), body: JSON.stringify(body) },
			{ signal: opts.signal, label: this.name },
		)
		if (!res.body) throw new Error("anthropic: response has no body")

		const parts: Partial[] = []
		const price = priceOf(opts.model)
		const usage: Usage = {
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
		}
		let stop: StopReason = "end_turn"
		let terminal = false
		let cacheRead = 0
		let cacheWrite = 0

		for await (const ev of sseEvents(res.body, {
			signal: opts.signal,
			idleMs: DEFAULT_POLICY.idleTimeoutMs,
		})) {
			switch (ev.type) {
				case "message_start": {
					const u = ev.message?.usage ?? {}
					usage.inputTokens = u.input_tokens ?? 0
					cacheRead = u.cache_read_input_tokens ?? 0
					cacheWrite = u.cache_creation_input_tokens ?? 0
					usage.cachedInputTokens = cacheRead + cacheWrite
					break
				}
				case "content_block_start": {
					const cb = ev.content_block
					if (cb.type === "text") parts[ev.index] = { kind: "text", text: "" }
					else if (cb.type === "thinking") parts[ev.index] = { kind: "thinking", text: "" }
					else if (cb.type === "tool_use") {
						parts[ev.index] = { kind: "tool_use", id: cb.id, name: cb.name, json: "" }
						yield { type: "tool_start", id: cb.id, name: cb.name }
					} else if (cb.type === "server_tool_use") {
						parts[ev.index] = { kind: "server_tool", name: cb.name, json: "" }
					} else if (cb.type === "web_search_tool_result") {
						parts[ev.index] = { kind: "server_result", text: serverResultText(cb.content) }
					}
					break
				}
				case "content_block_delta": {
					const p = parts[ev.index]
					const d = ev.delta
					if (!p) break
					if (d.type === "text_delta" && p.kind === "text") {
						p.text += d.text
						yield { type: "text_delta", text: d.text }
					} else if (d.type === "thinking_delta" && p.kind === "thinking") {
						p.text += d.thinking
						yield { type: "thinking_delta", text: d.thinking }
					} else if (d.type === "signature_delta" && p.kind === "thinking") {
						p.signature = (p.signature ?? "") + d.signature
					} else if (d.type === "input_json_delta" && p.kind === "tool_use") {
						p.json += d.partial_json
						yield { type: "tool_input_delta", id: p.id, json: d.partial_json }
					} else if (d.type === "input_json_delta" && p.kind === "server_tool") {
						p.json += d.partial_json
					}
					break
				}
				case "message_delta": {
					const reason = ev.delta?.stop_reason
					if (reason === "tool_use") stop = "tool_use"
					else if (reason === "max_tokens") stop = "max_tokens"
					else if (reason) stop = "end_turn"
					if (reason) terminal = true
					usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens
					break
				}
				case "message_stop":
					terminal = true
					break
				case "error":
					throw new Error(`anthropic stream error: ${JSON.stringify(ev.error)}`)
			}
		}

		// A socket that closes early leaves a half sentence, or half a tool call.
		// Written to the thread it looks like a finished turn forever after.
		if (!terminal) throw new Error("anthropic stream truncated: no stop reason")

		const content: Block[] = []
		for (const p of parts) {
			if (!p) continue
			if (p.kind === "text") {
				if (p.text) content.push({ type: "text", text: p.text })
			} else if (p.kind === "thinking") {
				content.push({ type: "thinking", text: p.text, signature: p.signature })
			} else if (p.kind === "server_tool") {
				let what = p.json.trim()
				try {
					what = (JSON.parse(what) as { query?: string }).query ?? what
				} catch {
					// The raw JSON says enough.
				}
				content.push({ type: "text", text: `[${p.name}: ${what}]` })
			} else if (p.kind === "server_result") {
				if (p.text) content.push({ type: "text", text: p.text })
			} else {
				let input: unknown = {}
				if (p.json.trim()) {
					try {
						input = JSON.parse(p.json)
					} catch {
						input = { __parse_error: p.json }
					}
				}
				content.push({ type: "tool_use", id: p.id, name: p.name, input })
			}
		}

		// Writing to the cache bills at 1.25x the input rate, reading at 0.1x.
		// Lumping both under the read rate would understate every cold turn.
		const uncached = Math.max(0, usage.inputTokens)
		usage.costUsd =
			(uncached * price.in) / 1e6 +
			(cacheRead * price.cachedIn) / 1e6 +
			(cacheWrite * price.in * 1.25) / 1e6 +
			(usage.outputTokens * price.out) / 1e6

		yield { type: "done", stop, message: { role: "assistant", content }, usage }
	}
}

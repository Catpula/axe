// Core data contract. Every provider adapter converts to and from these types.
// Nothing else in the codebase may import a provider SDK type.

export type Role = "user" | "assistant"

export type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; signature?: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; id: string; content: string; isError?: boolean }
	| { type: "image"; mime: string; data: string }

export type Message = { role: Role; content: Block[] }

export type ToolCtx = {
	cwd: string
	signal: AbortSignal
	/** Provider tool-use id, when the call came through the agent loop. */
	id?: string
	/** Records a file mutation after its bytes are committed. */
	changed?: (path: string) => Promise<void>
	/** Durable gate called after approval and argument rewrites, immediately before execution. */
	beforeRun?: (effectiveInput: unknown) => Promise<void>
	/** Streams progress lines to the UI while a tool is still running. */
	log: (line: string) => void
}

/** Presentation metadata. It is never included in the model's tool_result. */
export type ToolDisplay = {
	summary?: string
	path?: string
	additions?: number
	deletions?: number
	exitCode?: number
}

export type ToolDef = {
	name: string
	/** Prompt engineering surface. Say when NOT to use the tool. */
	description: string
	schema: Record<string, unknown>
	/** Read-only tools may run in parallel and are safe for subagents. */
	readOnly: boolean
	/** UI-only metadata derived after a successful run. It never reaches the model. */
	display?: (input: any, content: string) => ToolDisplay | undefined
	run: (input: any, ctx: ToolCtx) => Promise<string>
}

export type Usage = {
	inputTokens: number
	cachedInputTokens: number
	outputTokens: number
	/**
	 * An estimate, always. No provider bills us over the wire, so this is the
	 * adapter's own price table applied to the reported tokens, and a model the
	 * table does not know is counted as free. Show it as a running estimate,
	 * never as an invoice.
	 */
	costUsd: number
}

export const emptyUsage = (): Usage => ({
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	costUsd: 0,
})

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		costUsd: a.costUsd + b.costUsd,
	}
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted"

export type StreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_start"; id: string; name: string }
	| { type: "tool_input_delta"; id: string; json: string }
	| { type: "done"; stop: StopReason; message: Message; usage: Usage }

export type StreamOptions = {
	system: string
	messages: Message[]
	tools: ToolDef[]
	model: string
	maxTokens: number
	/** Extended thinking budget in tokens. Omit to disable thinking. */
	thinkingBudget?: number
	/**
	 * Tools the provider runs itself. They are not ToolDefs: there is no `run` to
	 * call, and the result never comes back through execTool. A provider that
	 * does not offer one ignores it.
	 */
	serverTools?: ServerTool[]
	signal: AbortSignal
}

export type ServerTool = "web_search"

export type CountOptions = {
	system: string
	messages: Message[]
	tools: ToolDef[]
	model: string
	/** Counting runs inside a turn, so it must die with the turn. */
	signal?: AbortSignal
}

export interface Provider {
	readonly name: string
	stream(opts: StreamOptions): AsyncIterable<StreamEvent>
	/** Authoritative token count from the provider. Never estimate by characters. */
	countTokens(opts: CountOptions): Promise<number>
	contextWindow(model: string): number
}

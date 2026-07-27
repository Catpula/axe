import type { Block, Message, Provider, ToolDef, Usage } from "../providers/types.ts"
import { newSession, runTurn, type UI } from "./loop.ts"
import { ToolRegistry } from "./tools.ts"

/** The two built-in roles. A custom agent's name is also a valid role name. */
export type SubagentRole = string

/**
 * A subagent cannot ask a question and cannot be steered, so the brief has to
 * carry everything the role needs. Both briefs say the same three things in
 * different words: you get one shot, only your last message is read, and you
 * cannot change anything.
 */
const SEARCH_BRIEF = `You are a search subagent. Another agent delegated one question to you because answering it would fill its context with files it does not need to keep.

You cannot ask questions and you will not be given a second turn of instructions. Only your final message is returned to the agent that called you; everything else you do is discarded. Your tools are read-only, so do not attempt to change anything.

Find the answer, then write a report:
- Lead with the answer, not with how you looked for it.
- Cite exact paths and line numbers so the caller does not have to search again.
- Quote the few lines that matter. Do not paste whole files.
- If you could not find it, say so and list where you looked. A confident wrong answer is worse than an empty one.`

const ORACLE_BRIEF = `You are the oracle. A coding agent has hit something it cannot work out on its own and is paying for a slower, more careful opinion.

You cannot ask questions and you will not be given a second turn of instructions. Only your final message is returned; everything else is discarded. Your tools are read-only: you diagnose and advise, you do not edit.

Read enough of the code to be sure, then answer:
- State the cause, not the symptom.
- Give the smallest correct fix, concretely, with paths and code.
- Say what evidence you have for it, and say plainly which parts you are guessing at.
- If the premise of the question is wrong, say that first.`

export function briefFor(role: SubagentRole): string {
	return role === "oracle" ? ORACLE_BRIEF : SEARCH_BRIEF
}

export type SubagentConfig = {
	provider: Provider
	model: string
	maxTokens: number
	thinkingBudget?: number
	system: string
	/** Must be read-only tools. The caller decides; this is not enforced here. */
	tools: ToolDef[]
	cwd: string
	maxSteps: number
	/** Optional passthrough for notices, so a stuck subagent is still visible. */
	log?: (s: string) => void
	/**
	 * Where the subagent's own stream goes. Omit and it goes nowhere, which is
	 * the old behaviour and the right default for a caller with no display: a
	 * subagent's reads are not the user's business unless they asked to see them.
	 */
	ui?: UI
}

export type SubagentResult = { text: string; usage: Usage; steps: number }

/**
 * A subagent that dies half way through has still spent the tokens it spent.
 * The failure travels as an exception so the tool still reports an error, and
 * the usage travels with it so the parent can add it to the session either way.
 */
export class SubagentError extends Error {
	readonly usage: Usage
	readonly steps: number

	constructor(message: string, usage: Usage, steps: number, cause?: unknown) {
		super(message, { cause })
		this.name = "SubagentError"
		this.usage = usage
		this.steps = steps
	}
}

/**
 * Concurrency limiter. Subagents are spawned by a model, not by a human, so the
 * only thing standing between a bad plan and twenty parallel API calls is this.
 * No parameter properties: strip-only TypeScript does not support them.
 */
export class Gate {
	private readonly limit: number
	private readonly waiting: Array<() => void> = []
	private running = 0
	/** Highest concurrency actually reached. Used by the tests. */
	peak = 0

	constructor(limit: number) {
		this.limit = Math.max(1, limit)
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		// Re-checked in a loop, not once: waking a waiter takes a microtask, and a
		// job that arrives inside that gap takes the freed slot for itself. Taking
		// the slot is synchronous with the check, so the limit cannot be passed.
		while (this.running >= this.limit) {
			await new Promise<void>((res) => this.waiting.push(res))
		}
		this.running++
		if (this.running > this.peak) this.peak = this.running
		try {
			return await fn()
		} finally {
			this.running--
			this.waiting.shift()?.()
		}
	}
}

/** Silent: a subagent's stream is not the user's business. Notices still pass. */
function subUI(log?: (s: string) => void): UI {
	return {
		text: () => {},
		thinking: () => {},
		toolStart: () => {},
		toolEnd: () => {},
		notice: (s) => log?.(s),
	}
}

function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!
		if (m.role !== "assistant") continue
		const text = m.content
			.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("")
			.trim()
		if (text) return text
	}
	return ""
}

/**
 * Runs a whole agent loop in its own context and returns only the last thing it
 * said. The point is the discard: the subagent's reads, dead ends, and tool
 * output never enter the caller's context window. Usage is returned so the
 * caller can add it to the session total; if it does not, the cost limit lies.
 */
export async function runSubagent(
	cfg: SubagentConfig,
	prompt: string,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const s = newSession({
		provider: cfg.provider,
		model: cfg.model,
		system: cfg.system,
		maxTokens: cfg.maxTokens,
		thinkingBudget: cfg.thinkingBudget,
		tools: new ToolRegistry().register(...cfg.tools),
		cwd: cfg.cwd,
		ui: cfg.ui ?? subUI(cfg.log),
		maxSteps: cfg.maxSteps,
	})

	const steps = () => s.messages.filter((m) => m.role === "assistant").length

	try {
		await runTurn(s, prompt, signal)
	} catch (err) {
		throw new SubagentError(
			err instanceof Error ? err.message : String(err),
			s.usage,
			steps(),
			err,
		)
	}

	const text = finalText(s.messages)
	return {
		text: text || "The subagent finished without writing a report.",
		usage: s.usage,
		steps: steps(),
	}
}

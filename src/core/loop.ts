import { randomUUID } from "node:crypto"
import { debugLog, setDebugTurn } from "../debuglog.ts"
import type {
	Block,
	Message,
	Provider,
	ServerTool,
	StopReason,
	ToolCtx,
	ToolDisplay,
	Usage,
} from "../providers/types.ts"
import { addUsage, emptyUsage } from "../providers/types.ts"
import { compactMessages, type CompactionConfig, type CompactionResult } from "./compact.ts"
import type { InputQueue } from "./queue.ts"
import { execTool, type PermGate, type ToolRegistry } from "./tools.ts"
import type { Thread } from "./thread.ts"

type ToolUse = Extract<Block, { type: "tool_use" }>

export type UI = {
	text: (s: string) => void
	/** Final provider text for the step. A streaming UI may reconcile dropped deltas with it. */
	textDone?: (s: string) => void
	thinking: (s: string) => void
	toolStart: (name: string, id: string) => void
	/**
	 * The call is about to run and its arguments are complete. `toolStart` fires
	 * from the stream, before the input has finished arriving, so this is the
	 * only point at which a UI can start a clock against a subject.
	 */
	toolRunning?: (name: string, id: string, input: unknown) => void
	/** `input` is the raw tool arguments. Which part of it is worth showing is a formatting decision, so it stays in the UI. */
	toolEnd: (name: string, ok: boolean, preview: string, input?: unknown, id?: string, display?: ToolDisplay) => void
	notice: (s: string) => void
}

export type Session = {
	provider: Provider
	model: string
	system: string
	maxTokens: number
	thinkingBudget?: number
	tools: ToolRegistry
	messages: Message[]
	thread?: Thread
	cwd: string
	ui: UI
	usage: Usage
	/** Hard stop for runaway loops. */
	maxSteps: number
	/** Omit to disable automatic compaction. */
	compaction?: CompactionConfig
	/** Input typed while the turn is running. Drained at each step boundary. */
	queue?: InputQueue
	/** Omit to run every call unchecked, which is the default. */
	perm?: PermGate
	/** Tools the provider runs itself, so no ToolDef exists for them. */
	serverTools?: ServerTool[]
	/** The last token count the compaction check paid for. Unset until one has run. */
	lastTokens?: number
	/** Runs on every exit from runTurn, including a throw. For per-turn state. */
	onTurnEnd?: () => void
	/** Files changed by edit_file in the current or most recent turn. */
	changedFiles: Set<string>
	currentTurnId?: string
}

export function newSession(init: Omit<Session, "messages" | "usage" | "maxSteps" | "changedFiles"> & Partial<Pick<Session, "messages" | "usage" | "maxSteps" | "changedFiles">>): Session {
	return {
		messages: [],
		usage: emptyUsage(),
		maxSteps: 100,
		changedFiles: new Set(),
		...init,
	}
}

async function record(s: Session, m: Message): Promise<void> {
	await s.thread?.append(m, s.currentTurnId)
	s.messages.push(m)
}

/**
 * Checked before every request rather than once per turn: a single turn full of
 * large tool results can cross the threshold on its own. Neither a failed token
 * count nor a failed summary may abort the turn.
 */
async function maybeCompact(s: Session, signal: AbortSignal): Promise<void> {
	const cfg = s.compaction
	if (!cfg || s.messages.length < 4) return

	const window = s.provider.contextWindow(s.model)
	let used: number
	try {
		used = await s.provider.countTokens({
			system: s.system,
			messages: s.messages,
			tools: s.tools.all(),
			model: s.model,
		})
	} catch (err) {
		// Invariant 6: a failed count degrades to "no compaction". That silence is
		// correct and is also exactly what nobody can debug, so it is logged.
		debugLog({
			kind: "compact",
			phase: "count_failed",
			detail: { error: err instanceof Error ? err.message : String(err) },
		})
		return
	}
	// Already paid for, so the status bar quotes it rather than counting again.
	s.lastTokens = used
	if (used < window * cfg.at) return

	s.ui.notice(`Compacting at ${used.toLocaleString()} of ${window.toLocaleString()} tokens.`)
	debugLog({ kind: "compact", phase: "start", detail: { used, window, messages: s.messages.length } })
	let result: CompactionResult
	try {
		result = await compactMessages(cfg, s.messages, signal)
	} catch (err) {
		debugLog({
			kind: "compact",
			phase: "failed",
			detail: { error: err instanceof Error ? err.message : String(err) },
		})
		s.ui.notice(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`)
		return
	}
	// Charged before the result is inspected: a summary that came back empty was
	// still paid for.
	s.usage = addUsage(s.usage, result.usage)
	const compacted = result.messages
	if (!compacted) {
		// Paid for and got nothing: an empty summary, or no safe split point.
		debugLog({ kind: "compact", phase: "skipped", detail: { costUsd: result.usage.costUsd } })
		return
	}

	await s.thread?.compact(compacted)
	s.messages = compacted
	debugLog({
		kind: "compact",
		phase: "done",
		detail: { dropped: result.dropped, kept: compacted.length, costUsd: result.usage.costUsd },
	})
	s.ui.notice(`Compacted ${result.dropped} messages into a summary.`)
}

/**
 * Runs the tool calls of one step and returns their results in call order.
 *
 * Scheduling matters as much as ordering. A tool that is not declared readOnly
 * may write files or run a command, and two of those overlapping is a race the
 * model cannot see: two edits to one path, or a build reading a half-written
 * tree. So the calls are walked in the order the model asked for them,
 * consecutive readOnly calls run together as one batch, and everything else
 * drains the batch first and then runs alone.
 *
 * An unknown tool is treated as a write. It is about to fail anyway, and
 * guessing that a name we do not recognise is safe to overlap is the wrong
 * default.
 *
 * Results are assigned by index rather than pushed, so invariant 1 (tool_result
 * order follows tool_use order) holds no matter what the schedule was.
 */
async function runCalls(
	s: Session,
	calls: ToolUse[],
	signal: AbortSignal,
): Promise<Block[]> {
	const ctx: ToolCtx = { cwd: s.cwd, signal, log: s.ui.notice }

	const runOne = async (call: ToolUse): Promise<Block> => {
		if (signal.aborted) {
			debugLog({ kind: "tool", phase: "cancelled", toolUseId: call.id, detail: { name: call.name } })
			return {
				type: "tool_result",
				id: call.id,
				content: "Tool call cancelled by the user.",
				isError: true,
			}
		}
		const turnId = s.currentTurnId ?? "unknown-turn"
		// Names and ids only. A tool's arguments can hold a password or a whole
		// file, and a debug log is something people paste into an issue.
		debugLog({ kind: "tool", phase: "requested", turnId, toolUseId: call.id, detail: { name: call.name } })
		const startedAt = Date.now()
		try {
			await s.thread?.toolRequested(turnId, call.id, call.name, call.input)
		} catch (err) {
			debugLog({
				kind: "tool",
				phase: "journal_failed",
				turnId,
				toolUseId: call.id,
				detail: { name: call.name, at: "requested", error: err instanceof Error ? err.message : String(err) },
			})
			return {
				type: "tool_result",
				id: call.id,
				content: `Tool was not started because its execution journal could not be written: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			}
		}
		const out = await execTool(s.tools, call.name, call.input, {
			...ctx,
			id: call.id,
			beforeRun: async (effectiveInput) => {
				await s.thread?.toolExecuting(turnId, call.id, call.name, effectiveInput)
				debugLog({ kind: "tool", phase: "executing", turnId, toolUseId: call.id, detail: { name: call.name } })
				s.ui.toolRunning?.(call.name, call.id, call.input)
			},
			changed: async (path) => {
				await s.thread?.fileChanged(turnId, call.id, path)
				s.changedFiles.add(path)
			},
		}, s.perm)
		let result: Extract<Block, { type: "tool_result" }> = {
			type: "tool_result",
			id: call.id,
			content: out.content,
			isError: out.isError,
		}
		debugLog({
			kind: "tool",
			phase: out.isError ? "failed" : "finished",
			turnId,
			toolUseId: call.id,
			detail: { name: call.name, ms: Date.now() - startedAt, bytes: out.content.length },
		})
		try {
			await s.thread?.toolFinished(turnId, result)
			s.ui.toolEnd(call.name, !out.isError, out.content.slice(0, 120), call.input, call.id, out.display)
		} catch (err) {
			debugLog({
				kind: "tool",
				phase: "journal_failed",
				turnId,
				toolUseId: call.id,
				detail: { name: call.name, at: "finished", error: err instanceof Error ? err.message : String(err) },
			})
			result = {
				...result,
				content: `${result.content}\n\n[The tool completed, but its durable journal failed: ${err instanceof Error ? err.message : String(err)}]`,
				isError: true,
			}
		}
		return result
	}

	const results: Block[] = new Array(calls.length)
	let batch: Array<Promise<void>> = []
	const drain = async (): Promise<void> => {
		if (!batch.length) return
		const pending = batch
		batch = []
		await Promise.all(pending)
	}

	for (let i = 0; i < calls.length; i++) {
		const call = calls[i]!
		if (s.tools.get(call.name)?.readOnly) {
			batch.push(
				runOne(call).then((block) => {
					results[i] = block
				}),
			)
			continue
		}
		await drain()
		results[i] = await runOne(call)
	}
	await drain()

	return results
}

/**
 * One user turn. Runs until the model stops asking for tools.
 *
 * Invariants that are expensive to discover later:
 *  1. tool_result blocks must appear in the same order as their tool_use blocks.
 *  2. An aborted or failed tool still emits a tool_result.
 *  3. Every message is persisted immediately, not at the end of the turn.
 */
export async function runTurn(
	s: Session,
	userInput: string | Block[],
	signal: AbortSignal,
): Promise<void> {
	const turnId = randomUUID()
	s.currentTurnId = turnId
	s.changedFiles.clear()
	// Set on the logger rather than passed down, so a retry logged from inside
	// the provider adapter still names the turn it belongs to without the
	// adapter having to know that turns exist.
	setDebugTurn(turnId)
	const startedAt = Date.now()
	await s.thread?.startTurn(turnId)
	debugLog({ kind: "turn", phase: "start", detail: { model: s.model, messages: s.messages.length } })
	let outcome: "completed" | "aborted" | "failed" = "completed"
	try {
		await turn(s, userInput, signal)
		if (signal.aborted) outcome = "aborted"
	} catch (err) {
		outcome = signal.aborted ? "aborted" : "failed"
		debugLog({
			kind: "turn",
			phase: "error",
			detail: { error: err instanceof Error ? err.message : String(err) },
		})
		throw err
	} finally {
		debugLog({
			kind: "turn",
			phase: "end",
			detail: { outcome, ms: Date.now() - startedAt, messages: s.messages.length, costUsd: s.usage.costUsd },
		})
		try {
			await s.thread?.finishTurn(turnId, outcome)
		} finally {
			s.currentTurnId = undefined
			setDebugTurn(undefined)
			s.onTurnEnd?.()
		}
	}
}

async function turn(s: Session, userInput: string | Block[], signal: AbortSignal): Promise<void> {
	const content: Block[] =
		typeof userInput === "string" ? [{ type: "text", text: userInput }] : userInput
	await record(s, { role: "user", content })

	for (let step = 0; step < s.maxSteps; step++) {
		await maybeCompact(s, signal)

		let assistant: Message | null = null
		let stop: StopReason | null = null
		// Time to first token separates "the provider is thinking" from "the
		// connection is dead", which look identical from the outside.
		const streamStart = Date.now()
		let firstToken = 0
		debugLog({ kind: "stream", phase: "start", detail: { step, model: s.model, messages: s.messages.length } })

		for await (const ev of s.provider.stream({
			system: s.system,
			messages: s.messages,
			tools: s.tools.all(),
			model: s.model,
			maxTokens: s.maxTokens,
			thinkingBudget: s.thinkingBudget,
			serverTools: s.serverTools,
			signal,
		})) {
			if (!firstToken && (ev.type === "text_delta" || ev.type === "thinking_delta")) {
				firstToken = Date.now() - streamStart
				debugLog({ kind: "stream", phase: "first_token", detail: { ms: firstToken } })
			}
			switch (ev.type) {
				case "text_delta":
					s.ui.text(ev.text)
					break
				case "thinking_delta":
					s.ui.thinking(ev.text)
					break
				case "tool_start":
					s.ui.toolStart(ev.name, ev.id)
					break
				case "done":
					assistant = ev.message
					stop = ev.stop
					s.usage = addUsage(s.usage, ev.usage)
					debugLog({
						kind: "stream",
						phase: "done",
						detail: {
							stop: ev.stop,
							ms: Date.now() - streamStart,
							firstTokenMs: firstToken || undefined,
							inputTokens: ev.usage.inputTokens,
							cachedInputTokens: ev.usage.cachedInputTokens,
							outputTokens: ev.usage.outputTokens,
						},
					})
					break
			}
		}

		if (!assistant) {
			debugLog({ kind: "stream", phase: "no_done_event", detail: { ms: Date.now() - streamStart } })
			throw new Error("stream ended without a done event")
		}
		s.ui.textDone?.(
			assistant.content
				.filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join(""),
		)
		await record(s, assistant)

		// A reply cut off at the cap looks the same as a finished one, and a model
		// that spent the whole budget reasoning leaves no text at all. Say so,
		// because the alternative is the user reading a truncation as an answer.
		if (stop === "max_tokens") {
			s.ui.notice(
				`Cut off at the ${s.maxTokens.toLocaleString()} token cap. The reply is incomplete.`,
			)
		}

		const calls = assistant.content.filter(
			(b): b is ToolUse => b.type === "tool_use",
		)
		if (calls.length === 0) return

		const results = await runCalls(s, calls, signal)

		// Steering. A step boundary is the only safe place to inject user input,
		// and tool_result blocks must stay at the front of the message, so the
		// interruption is appended after them rather than sent on its own.
		const steer = s.queue?.drain()
		if (steer) {
			results.push({ type: "text", text: `The user interrupted with: ${steer}` })
			s.ui.notice("Steering with queued input.")
		}

		await record(s, { role: "user", content: results })

		if (signal.aborted) {
			s.ui.notice("Aborted.")
			return
		}
	}

	s.ui.notice(`Stopped after ${s.maxSteps} steps.`)
}

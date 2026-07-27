/**
 * A file that says what happened, for the failures a transcript cannot show.
 *
 * The thread file already records everything the model saw. What it does not
 * record is the machinery: that a turn took forty seconds because the provider
 * was retried three times, that a stream produced its first token after nine
 * seconds and then stalled, that a tool was journalled as executing and never
 * finished. All of that is invisible today, and all of it is the difference
 * between "axe is slow" and a bug report somebody can act on.
 *
 * Off unless asked for, and asked for in three places: `--debug`, `AXE_DEBUG=1`,
 * or `debug = true` in a trusted config. Never project-settable — a cloned repo
 * that could turn this on would be writing files under ~/.axe on the next run.
 *
 * It is a module singleton rather than a field on `Session` or `ToolCtx`, and
 * that is a deliberate exception to the rule that state travels explicitly.
 * Threading a logger through `ToolCtx` would change a type every tool and every
 * test constructs; threading it through `StreamOptions` would change the
 * `Provider` interface, which is the one contract that must stay narrow. A sink
 * that is off by default, invisible to the model, and initialised from exactly
 * one call site in `cli.ts` is the honest place to break the rule.
 *
 * Nothing written here is a secret. Names, ids, counts, durations, status codes.
 * No prompt text, no tool arguments, no keys — a tool argument can hold a
 * password, and a debug file is the sort of thing people paste into an issue.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { AXE_HOME } from "./core/thread.ts"

/** Which part of the machine is speaking. */
export type DebugKind =
	| "session"
	| "turn"
	| "stream"
	| "tool"
	| "retry"
	| "compact"
	| "recovery"
	| "plugin"
	| "mcp"

export type DebugEvent = {
	kind: DebugKind
	/** "start", "done", "failed", … Free-form per kind, stable per call site. */
	phase: string
	/**
	 * Correlation ids. Both already exist and are already durable: the turn id is
	 * the uuid `runTurn` writes to the journal, and the tool id is the provider's
	 * own tool_use id. Reusing them means a debug line can be lined up against a
	 * thread record without inventing a third numbering.
	 */
	turnId?: string
	toolUseId?: string
	detail?: Record<string, unknown>
}

type State = {
	path: string
	/** Turn id set by the loop, so a layer that cannot know it still correlates. */
	turnId?: string
	/** A sink that has failed once stops trying: a log is never worth a crash. */
	broken: boolean
}

let state: State | null = null

/** Longest a single detail string may be. A log line is not a place for a page. */
const MAX_DETAIL = 500

/**
 * Whether debugging was asked for, in precedence order. The config value is read
 * from a trusted layer only, which the caller enforces by passing the merged
 * config's own field: `scopeLocal` has already dropped a project's attempt.
 */
export function debugRequested(flag: boolean, fromConfig: boolean, env = process.env): boolean {
	if (flag) return true
	const raw = env.AXE_DEBUG
	if (raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false") return true
	return fromConfig
}

/**
 * Opens the sink. Called once, from `cli.ts`, after the thread id is known so
 * the file can be named after it: a debug file nobody can match to a transcript
 * is half a diagnostic. Returns the path so the caller can print it — nothing
 * axe writes should be a surprise.
 */
export function initDebugLog(threadId: string, home = AXE_HOME): string | null {
	try {
		const dir = join(home, "logs")
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		const path = join(dir, `${threadId}.jsonl`)
		state = { path, broken: false }
		debugLog({ kind: "session", phase: "start", detail: { pid: process.pid } })
		return path
	} catch {
		// A home directory that cannot be written to is not a reason to refuse to
		// run. The user asked for a log and does not get one.
		state = null
		return null
	}
}

/** Null when logging is off, which is also how a caller tests for it. */
export function debugLogPath(): string | null {
	return state && !state.broken ? state.path : null
}

export function debugEnabled(): boolean {
	return state !== null && !state.broken
}

/**
 * The turn id, held here so the layers that cannot see it still correlate.
 * `retryStream` in the provider adapter has no idea which turn it is serving and
 * should not learn: the alternative is a parameter on `StreamOptions`.
 */
export function setDebugTurn(turnId: string | undefined): void {
	if (state) state.turnId = turnId
}

/**
 * Writes one line. Never throws, never awaits.
 *
 * Synchronous on purpose. The events worth having are the ones written by a
 * process that is about to die — a crash, a kill, an abort — and an async append
 * scheduled just before that loses exactly those. The cost is a small write per
 * event on a path that is off by default.
 */
export function debugLog(ev: DebugEvent): void {
	if (!state || state.broken) return
	const line = {
		ts: new Date().toISOString(),
		kind: ev.kind,
		phase: ev.phase,
		...(ev.turnId ?? state.turnId ? { turnId: ev.turnId ?? state.turnId } : {}),
		...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}),
		...(ev.detail ? { detail: trim(ev.detail) } : {}),
	}
	try {
		appendFileSync(state.path, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 })
	} catch {
		// One failure is enough. A disk that is full will not un-fill itself
		// during the turn, and retrying every event would slow the turn down to
		// the speed of the failing write.
		state.broken = true
	}
}

/** Keeps one runaway string from turning a log line into a log file. */
function trim(detail: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(detail)) {
		if (value === undefined) continue
		out[key] = typeof value === "string" && value.length > MAX_DETAIL
			? `${value.slice(0, MAX_DETAIL)}…`
			: value
	}
	return out
}

/** Test seam: forgets the sink so a second init in one process starts clean. */
export function resetDebugLog(): void {
	state = null
}

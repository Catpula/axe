import type { UI } from "../core/loop.ts"
import type { Diagnosis } from "../errors.ts"
import type { Usage } from "../providers/types.ts"

/**
 * Newline-delimited JSON output for scripts and CI. One event per line, written
 * as it happens, so a caller can stream it. Text is emitted in the same chunks
 * the provider sent, not reassembled, because waiting for the whole turn would
 * defeat the point.
 *
 * Every line has a `type`. Unknown types must be ignored by consumers rather
 * than treated as an error, so that adding an event is not a breaking change.
 */
export function makeJsonUI(write: (line: string) => void, includeThinking = false): UI {
	const emit = (o: Record<string, unknown>) => write(`${JSON.stringify(o)}\n`)
	return {
		text: (text) => emit({ type: "text", text }),
		thinking: (text) => {
			if (includeThinking) emit({ type: "thinking", text })
		},
		toolStart: (name, id) => emit({ type: "tool_start", name, id }),
		toolEnd: (name, ok, preview) => emit({ type: "tool_end", name, ok, preview }),
		notice: (text) => emit({ type: "notice", text }),
	}
}

export function jsonResult(usage: Usage, threadId: string): string {
	return `${JSON.stringify({ type: "result", threadId, usage })}\n`
}

/**
 * Additive only, per invariant 9: `message` still says what it always said, and
 * `surface`, `code` and `next` are new fields a consumer may ignore. A script
 * that wants to branch on the kind of failure reads `code`, which is stable;
 * `message` is prose and is not.
 */
export function jsonError(message: string, extra?: Partial<Diagnosis>): string {
	return `${JSON.stringify({
		type: "error",
		message,
		...(extra?.surface ? { surface: extra.surface } : {}),
		...(extra?.code ? { code: extra.code } : {}),
		...(extra?.next ? { next: extra.next } : {}),
	})}\n`
}

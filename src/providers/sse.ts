/**
 * Shared Server-Sent Events reader. Yields each parsed JSON payload.
 * Malformed frames and keep-alives are skipped rather than throwing, because a
 * dropped heartbeat should never kill a turn.
 */

/** Stands in for the "[DONE]" line when the caller asks to see it. */
export const SSE_DONE = Symbol("sse-done")

export type SseOptions = {
	/** Give up when the server sends nothing at all for this long. */
	idleMs?: number
	signal?: AbortSignal
	/** Yield SSE_DONE so the caller can tell a finished stream from a cut one. */
	doneSentinel?: boolean
}

const DEFAULT_IDLE_MS = 60_000

export async function* sseEvents(
	body: ReadableStream<Uint8Array>,
	opts: SseOptions = {},
): AsyncGenerator<any> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
	let buf = ""
	try {
		for (;;) {
			const { done, value } = await read(reader, idleMs, opts.signal)
			if (done) break
			// A server that frames with CRLF is otherwise a silent turn: nothing
			// ever matches the blank line the split looks for.
			buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n?/g, "\n")
			let idx: number
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				const chunk = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* frame(chunk, opts)
			}
		}
		// A last frame with no trailing blank line is still a frame.
		yield* frame(buf, opts)
	} finally {
		// The socket stays open until the reader is released, on every exit path
		// including an abort or a throw out of the consumer.
		reader.cancel().catch(() => {})
	}
}

function* frame(chunk: string, opts: SseOptions): Generator<any> {
	for (const line of chunk.split("\n")) {
		if (!line.startsWith("data:")) continue
		const payload = line.slice(5).trim()
		if (!payload) continue
		if (payload === "[DONE]") {
			if (opts.doneSentinel) yield SSE_DONE
			continue
		}
		try {
			yield JSON.parse(payload)
		} catch {
			// Ignore frames that are not JSON.
		}
	}
}

type Reader = ReadableStreamDefaultReader<Uint8Array>
type ReadResult = Awaited<ReturnType<Reader["read"]>>

async function read(
	reader: Reader,
	idleMs: number,
	signal: AbortSignal | undefined,
): Promise<ReadResult> {
	if (signal?.aborted) throw signal.reason
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	try {
		return await new Promise<ReadResult>((resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`stream stalled: no data for ${idleMs}ms`)),
				idleMs,
			)
			if (signal) {
				onAbort = () => reject(signal.reason)
				signal.addEventListener("abort", onAbort, { once: true })
			}
			reader.read().then(resolve, reject)
		})
	} finally {
		clearTimeout(timer)
		if (signal && onAbort) signal.removeEventListener("abort", onAbort)
	}
}

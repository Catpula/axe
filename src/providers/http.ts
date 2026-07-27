/**
 * Shared HTTP plumbing for the adapters: a connect timeout, retry with
 * exponential backoff, and the single rule that makes retrying a stream safe.
 * A stream may only be replayed while it has yielded nothing. Once the first
 * event is out, the text is already on screen and in the thread, so a replay
 * would say everything twice.
 */

import { debugLog } from "../debuglog.ts"

export type RetryPolicy = {
	/** Total tries, first one included. */
	attempts: number
	baseDelayMs: number
	maxDelayMs: number
	/** Wait for the response headers, not for the whole stream. */
	connectTimeoutMs: number
	/** Longest silence tolerated between two stream chunks. */
	idleTimeoutMs: number
}

export const DEFAULT_POLICY: RetryPolicy = {
	attempts: 4,
	baseDelayMs: 500,
	maxDelayMs: 8_000,
	connectTimeoutMs: 30_000,
	idleTimeoutMs: 60_000,
}

/** Overload, rate limit and gateway codes. Everything else is our own fault. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529])

export type SendOptions = {
	signal: AbortSignal
	/** Provider label used in error messages, e.g. "anthropic". */
	label: string
	policy?: Partial<RetryPolicy>
}

export class HttpError extends Error {
	readonly status: number
	readonly retryAfterMs: number | undefined

	constructor(label: string, status: number, body: string, retryAfterMs?: number) {
		super(`${label} ${status}: ${body}`)
		this.name = "HttpError"
		this.status = status
		this.retryAfterMs = retryAfterMs
	}
}

/** One try. Throws HttpError on a non-2xx so the caller can judge the status. */
export async function send(
	url: string,
	init: RequestInit,
	opts: SendOptions,
): Promise<Response> {
	const policy = { ...DEFAULT_POLICY, ...opts.policy }
	// A plain AbortSignal.timeout would keep counting after the headers land and
	// cut a long but healthy stream, so the timer is cleared once fetch resolves.
	const connect = new AbortController()
	const timer = setTimeout(
		() => connect.abort(new Error(`${opts.label}: no response within ${policy.connectTimeoutMs}ms`)),
		policy.connectTimeoutMs,
	)
	let res: Response
	try {
		res = await fetch(url, { ...init, signal: AbortSignal.any([opts.signal, connect.signal]) })
	} finally {
		clearTimeout(timer)
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new HttpError(opts.label, res.status, body, retryAfterMs(res))
	}
	return res
}

/** For one-shot requests, where nothing has been shown to the user yet. */
export async function sendWithRetry(
	url: string,
	init: RequestInit,
	opts: SendOptions,
): Promise<Response> {
	const policy = { ...DEFAULT_POLICY, ...opts.policy }
	for (let i = 0; ; i++) {
		try {
			return await send(url, init, { ...opts, policy })
		} catch (err) {
			if (opts.signal.aborted || i + 1 >= policy.attempts || !retryable(err)) {
				logGiveUp(opts.label, i, policy, err, opts.signal.aborted)
				throw err
			}
			const delay = delayFor(policy, i, err)
			logRetry(opts.label, i, policy, err, delay)
			await sleep(delay, opts.signal)
		}
	}
}

/**
 * A turn that took forty seconds because it was retried three times looks
 * exactly like a slow one, and there is nothing anywhere that says which it was.
 * The turn id comes from the debug log's own state: `retryStream` has no idea
 * which turn it is serving, and putting one on `StreamOptions` would widen the
 * `Provider` contract for a diagnostic.
 */
function logRetry(
	label: string,
	attempt: number,
	policy: RetryPolicy,
	err: unknown,
	delayMs: number,
): void {
	debugLog({
		kind: "retry",
		phase: "scheduled",
		detail: {
			label,
			attempt: attempt + 1,
			of: policy.attempts,
			delayMs: Math.round(delayMs),
			status: err instanceof HttpError ? err.status : undefined,
			reason: err instanceof Error ? err.message : String(err),
		},
	})
}

function logGiveUp(
	label: string,
	attempt: number,
	policy: RetryPolicy,
	err: unknown,
	aborted: boolean,
): void {
	debugLog({
		kind: "retry",
		phase: aborted ? "aborted" : attempt + 1 >= policy.attempts ? "exhausted" : "not_retryable",
		detail: {
			label,
			attempts: attempt + 1,
			of: policy.attempts,
			status: err instanceof HttpError ? err.status : undefined,
			reason: err instanceof Error ? err.message : String(err),
		},
	})
}

/**
 * Runs `attempt` again on a retryable failure, but only while the attempt has
 * yielded nothing. A failure after the first event is handed straight to the
 * caller: replaying it would duplicate text, which is worse than the error.
 */
export async function* retryStream<T>(
	attempt: () => AsyncIterable<T>,
	opts: { signal: AbortSignal; policy?: Partial<RetryPolicy> },
): AsyncGenerator<T> {
	const policy = { ...DEFAULT_POLICY, ...opts.policy }
	for (let i = 0; ; i++) {
		let yielded = false
		try {
			for await (const ev of attempt()) {
				yielded = true
				yield ev
			}
			return
		} catch (err) {
			if (yielded || opts.signal.aborted) {
				// Not retryable by rule, not by status: the text is already on screen.
				debugLog({
					kind: "retry",
					phase: yielded ? "already_yielded" : "aborted",
					detail: {
						attempt: i + 1,
						status: err instanceof HttpError ? err.status : undefined,
						reason: err instanceof Error ? err.message : String(err),
					},
				})
				throw err
			}
			if (i + 1 >= policy.attempts || !retryable(err)) {
				logGiveUp("stream", i, policy, err, false)
				throw err
			}
			const delay = delayFor(policy, i, err)
			logRetry("stream", i, policy, err, delay)
			await sleep(delay, opts.signal)
		}
	}
}

/**
 * A refused connection, a stalled stream and a stream that stopped before its
 * terminal frame are all worth another try. A status we chose to reject is not.
 */
function retryable(err: unknown): boolean {
	if (err instanceof HttpError) return RETRYABLE_STATUS.has(err.status)
	return true
}

function delayFor(policy: RetryPolicy, attempt: number, err: unknown): number {
	const asked = err instanceof HttpError ? err.retryAfterMs : undefined
	if (asked !== undefined) return Math.min(asked, policy.maxDelayMs)
	const window = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs)
	// Jitter, so a fleet of clients does not come back in step.
	return window / 2 + Math.random() * (window / 2)
}

function retryAfterMs(res: Response): number | undefined {
	const raw = res.headers.get("retry-after")
	if (!raw) return undefined
	const seconds = Number(raw)
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
	const at = Date.parse(raw)
	return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason)
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		signal.addEventListener("abort", onAbort, { once: true })
	})
}

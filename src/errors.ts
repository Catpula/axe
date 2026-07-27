/**
 * One shape for everything that goes wrong, applied where errors are printed
 * rather than where they are thrown.
 *
 * Every layer already produces a readable message: `HttpError` says
 * "anthropic 401: ...", `KeyError` says which variable to set, the MCP client
 * prefixes its server's name. What none of them says is which layer failed and
 * what the user should do next, and those are the two things a person reading a
 * red line actually needs.
 *
 * So this is a classifier, not a base class. Making every throw site construct
 * an `AxeError` would mean editing forty of them across five provider adapters
 * for no change in behaviour, and would put a type between the adapters and
 * `Error` that every recorded adapter test would have to learn. Reading the
 * errors that already exist costs one file and no edits to the throw sites.
 *
 * The one rule that matters: an error we do not recognise keeps its message
 * verbatim and gets no next step. A wrong suggestion is worse than none,
 * because the user follows it.
 */

/** Which layer failed. Not a severity, and not a component list — a reader's question. */
export type Surface = "provider" | "config" | "tool" | "plugin" | "mcp" | "thread" | "ui"

export type Diagnosis = {
	surface: Surface
	/** Stable and greppable, e.g. "provider.unauthorized". Scripts may match on it. */
	code: string
	/** One clause. No stack, no JSON body, no second sentence. */
	message: string
	/** Imperative and concrete, or empty when there is genuinely nothing to do. */
	next: string
}

/** Longest a quoted provider body may be before it stops being a message. */
const MAX_MESSAGE = 300

function text(err: unknown): string {
	if (err instanceof Error) return err.message
	if (typeof err === "string") return err
	return String(err)
}

/**
 * A provider's error body is JSON as often as not, and the useful part of it is
 * one field deep. Pulled out rather than printed whole, because the alternative
 * is a red line of braces that the eye slides off.
 */
function providerDetail(raw: string): string {
	const brace = raw.indexOf("{")
	if (brace === -1) return raw.slice(0, MAX_MESSAGE)
	const head = raw.slice(0, brace).trim()
	let body: unknown
	try {
		body = JSON.parse(raw.slice(brace))
	} catch {
		return raw.slice(0, MAX_MESSAGE)
	}
	const found = findMessage(body)
	return `${head} ${found ?? raw.slice(brace)}`.trim().slice(0, MAX_MESSAGE)
}

/** The `message` a provider buried somewhere in its error object. */
function findMessage(body: unknown, depth = 0): string | null {
	if (depth > 4 || !body || typeof body !== "object") return null
	const record = body as Record<string, unknown>
	const own = record.message
	if (typeof own === "string" && own.trim()) return own.trim()
	for (const value of Object.values(record)) {
		const found = findMessage(value, depth + 1)
		if (found) return found
	}
	return null
}

type Rule = { code: string; surface: Surface; next: string }

/**
 * HTTP status buckets. The status is the only part of a provider failure that
 * means the same thing across providers, so it is the only part worth mapping.
 */
function forStatus(status: number): Rule {
	if (status === 401 || status === 403) {
		return {
			code: "provider.unauthorized",
			surface: "provider",
			next: "Check the key with `axe auth`, then `axe doctor`.",
		}
	}
	if (status === 429) {
		return {
			code: "provider.rate_limited",
			surface: "provider",
			// axe retries 429 already, so reaching the user means the retries ran out.
			next: "Retries were exhausted. Wait, or lower `--effort`.",
		}
	}
	if (status === 404) {
		return {
			code: "provider.no_such_model",
			surface: "provider",
			next: "Check the model name and `baseUrl` in ~/.axe/config.toml.",
		}
	}
	if (status === 413 || status === 422) {
		return {
			code: "provider.request_too_large",
			surface: "provider",
			next: "Compact the session, or start a new thread.",
		}
	}
	if (status >= 500 || status === 408) {
		return {
			code: "provider.unavailable",
			surface: "provider",
			next: "The provider is down or overloaded. Retry.",
		}
	}
	if (status >= 400) {
		return {
			code: "provider.rejected",
			surface: "provider",
			// A 400 is our own request being wrong, which the user cannot fix.
			next: "The request was malformed, which is an axe bug. Please report it.",
		}
	}
	return { code: "provider.http_error", surface: "provider", next: "" }
}

/**
 * The failures the adapters throw by hand, matched on the wording they are
 * thrown with. A shape match is fragile in general; here it is checked by
 * `errors-test`, which asserts against those exact strings.
 */
const MESSAGE_RULES: Array<{ test: RegExp; rule: Rule }> = [
	{
		test: /stream stalled: no data/i,
		rule: {
			code: "provider.stream_stalled",
			surface: "provider",
			next: "The turn is resumable with `axe --continue`.",
		},
	},
	{
		test: /stream truncated|stream ended without a done event|stream error/i,
		rule: {
			code: "provider.stream_interrupted",
			surface: "provider",
			next: "The turn is resumable with `axe --continue`.",
		},
	},
	{
		test: /no response within \d+ms/i,
		rule: {
			code: "provider.connect_timeout",
			surface: "provider",
			next: "Check the network, or `baseUrl` if the provider is self-hosted.",
		},
	},
	{
		// What undici says when it cannot reach the host at all, and the single
		// most common failure there is: no network, a proxy, or a `baseUrl`
		// pointing at nothing. Two words with no next step is the least useful
		// error axe can print, and it was printing it.
		test: /^fetch failed$|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|ETIMEDOUT|self.signed certificate|unable to verify the first certificate/i,
		rule: {
			code: "provider.unreachable",
			surface: "provider",
			next: "The host could not be reached. Check the network, a proxy, or `baseUrl`.",
		},
	},
	{
		test: /^Thread .* is corrupt at line/i,
		rule: {
			code: "thread.corrupt",
			surface: "thread",
			next: "Start a fresh thread; the file is listed by `axe threads`.",
		},
	},
	{
		test: /^No thread /i,
		rule: {
			code: "thread.not_found",
			surface: "thread",
			next: "`axe threads` lists the ids that exist.",
		},
	},
]

/** `mcp <name>: <reason>` is the client's own prefix, so the name comes back out. */
function forMcp(raw: string): Diagnosis | null {
	const match = /^mcp ([^:]+): (.*)$/s.exec(raw)
	if (!match) return null
	const [, name, reason] = match as unknown as [string, string, string]
	const timedOut = /timed out after/i.test(reason)
	const gone = /exited|could not start|closed/i.test(reason)
	return {
		surface: "mcp",
		code: timedOut ? "mcp.timeout" : gone ? "mcp.server_down" : "mcp.call_failed",
		message: `${name}: ${reason.trim()}`.slice(0, MAX_MESSAGE),
		next: `Check the server with \`axe doctor\`, or drop it from mcp.json.`,
	}
}

/**
 * Reads whatever the layers already throw and says which layer it was and what
 * to do about it. `fallback` names the layer the caller knows it is catching
 * for, since an unrecognised error from `loadPlugins` is still a plugin problem.
 */
export function classify(err: unknown, fallback: Surface = "ui"): Diagnosis {
	const raw = text(err).trim()

	// A duck-typed status rather than `instanceof HttpError`: this module is
	// imported by the UI and by `doctor`, and neither should have to pull in the
	// provider layer to print a sentence.
	const status = (err as { status?: unknown })?.status
	if (err instanceof Error && typeof status === "number" && status > 0) {
		const rule = forStatus(status)
		return { ...rule, message: providerDetail(raw) }
	}

	const name = err instanceof Error ? err.name : ""
	if (name === "KeyError") {
		const kind = (err as { kind?: unknown }).kind
		return kind === "error"
			? {
					surface: "config",
					code: "config.key_source_failed",
					message: raw.slice(0, MAX_MESSAGE),
					next: "Run the keySource command yourself to see what it prints.",
				}
			: {
					surface: "config",
					code: "config.key_missing",
					message: raw.slice(0, MAX_MESSAGE),
					next: "`axe auth` lists every provider and which key it wants.",
				}
	}
	if (name === "SubagentError") {
		return {
			surface: "tool",
			code: "tool.subagent_failed",
			message: raw.slice(0, MAX_MESSAGE),
			// A subagent failure is almost always the failure underneath it, and
			// that one already has its own diagnosis in the log.
			next: "The cause is the line above; `AXE_DEBUG=1` records the subagent's own steps.",
		}
	}

	const mcp = forMcp(raw)
	if (mcp) return mcp

	for (const { test, rule } of MESSAGE_RULES) {
		if (test.test(raw)) return { ...rule, message: raw.slice(0, MAX_MESSAGE) }
	}

	// Deliberately last and deliberately bare. Inventing a next step for an
	// error nothing here recognises is how a diagnostic starts lying.
	return {
		surface: fallback,
		code: `${fallback}.unknown`,
		message: raw.slice(0, MAX_MESSAGE) || "Unknown error.",
		next: "",
	}
}

/**
 * `provider · unauthorized — <message>. <next>`
 *
 * The surface leads because it is the word that tells the user whether this is
 * theirs to fix. The code's prefix is dropped: it repeats the surface, and this
 * line is read by people. Scripts read `code` off the JSON event instead.
 */
export function formatDiagnosis(d: Diagnosis): string {
	const short = d.code.startsWith(`${d.surface}.`) ? d.code.slice(d.surface.length + 1) : d.code
	const head = `${d.surface} \u00b7 ${short.replace(/_/g, " ")}`
	return [`${head} \u2014 ${d.message}`, d.next].filter(Boolean).join(" ")
}

/** The one-line form used by anything that catches and reports in one breath. */
export function describeError(err: unknown, fallback: Surface = "ui"): string {
	return formatDiagnosis(classify(err, fallback))
}

/**
 * The error classifier, against the errors the code really throws.
 *
 * The point of this file is the drift check. `classify` recognises three of the
 * provider failures by their wording, which is only safe as long as something
 * asserts that the wording is still what the adapters write. So the strings
 * here are built the same way the throw sites build them, and two of the cases
 * construct the real `HttpError` and `KeyError` rather than a stand-in.
 */
import { KeyError } from "../src/config.ts"
import { classify, describeError, formatDiagnosis, type Surface } from "../src/errors.ts"
import { DEFAULT_POLICY, HttpError } from "../src/providers/http.ts"
import { SubagentError } from "../src/core/subagent.ts"
import { emptyUsage } from "../src/providers/types.ts"

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

function expect(
	name: string,
	err: unknown,
	want: { surface: Surface; code: string; hasNext?: boolean },
	fallback?: Surface,
): void {
	const d = classify(err, fallback)
	check(`${name}: surface`, d.surface === want.surface, `got ${d.surface}`)
	check(`${name}: code`, d.code === want.code, `got ${d.code}`)
	if (want.hasNext !== undefined) {
		check(`${name}: next`, Boolean(d.next) === want.hasNext, JSON.stringify(d.next))
	}
	check(`${name}: message is not empty`, d.message.length > 0)
	check(`${name}: message fits one line`, !d.message.includes("\n") || d.message.length < 400)
}

// ── provider, by status ──────────────────────────────────────────────────────
// Real HttpError, built the way `send` builds it, body included.
expect("401", new HttpError("anthropic", 401, '{"error":{"message":"invalid x-api-key"}}'), {
	surface: "provider",
	code: "provider.unauthorized",
	hasNext: true,
})
expect("403", new HttpError("openai", 403, "forbidden"), {
	surface: "provider",
	code: "provider.unauthorized",
})
expect("429", new HttpError("anthropic", 429, "slow down", 2_000), {
	surface: "provider",
	code: "provider.rate_limited",
	hasNext: true,
})
expect("404", new HttpError("openai", 404, "no such model"), {
	surface: "provider",
	code: "provider.no_such_model",
})
expect("413", new HttpError("google", 413, "too big"), {
	surface: "provider",
	code: "provider.request_too_large",
})
expect("500", new HttpError("anthropic", 500, "boom"), {
	surface: "provider",
	code: "provider.unavailable",
	hasNext: true,
})
expect("529", new HttpError("anthropic", 529, "overloaded"), {
	surface: "provider",
	code: "provider.unavailable",
})
expect("400", new HttpError("openai", 400, "bad request"), {
	surface: "provider",
	code: "provider.rejected",
	hasNext: true,
})

// A 400 is our bug, not the user's, and the next step has to say so rather than
// sending them to look at their key.
const rejected = classify(new HttpError("openai", 400, "bad request"))
check("a 400 blames axe, not the key", /axe bug/i.test(rejected.next), rejected.next)
check("and does not send the user to axe auth", !/axe auth/.test(rejected.next), rejected.next)

// The body is JSON far more often than not, and printing it whole is what makes
// a red line unreadable.
const buried = classify(
	new HttpError("anthropic", 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
)
check("the provider's own message is lifted out", buried.message.includes("invalid x-api-key"), buried.message)
check("and the JSON braces are dropped", !buried.message.includes("{"), buried.message)
check("and the label survives", buried.message.includes("anthropic"), buried.message)

// A body that is not JSON must survive untouched rather than being swallowed.
const plainBody = classify(new HttpError("local", 500, "upstream connect error"))
check("a non-JSON body is kept", plainBody.message.includes("upstream connect error"), plainBody.message)

// ── provider, by wording ────────────────────────────────────────────────────
// Built the way the throw sites build them, so a reworded throw fails here.
const idleMs = DEFAULT_POLICY.idleTimeoutMs
expect("stalled stream", new Error(`stream stalled: no data for ${idleMs}ms`), {
	surface: "provider",
	code: "provider.stream_stalled",
	hasNext: true,
})
for (const [label, message] of [
	["anthropic", "anthropic stream truncated: no stop reason"],
	["google", "google stream truncated: no finishReason"],
	["openai", 'openai stream error: {"message":"upstream"}'],
	["loop", "stream ended without a done event"],
] as const) {
	expect(`truncated ${label}`, new Error(message), {
		surface: "provider",
		code: "provider.stream_interrupted",
		hasNext: true,
	})
}
// A resumable failure must say it is resumable: this is the one case where the
// user's next move is free and they will not guess it.
const stalled = classify(new Error(`stream stalled: no data for ${idleMs}ms`))
check("a stalled stream points at --continue", stalled.next.includes("--continue"), stalled.next)

expect(
	"connect timeout",
	new Error(`anthropic: no response within ${DEFAULT_POLICY.connectTimeoutMs}ms`),
	{ surface: "provider", code: "provider.connect_timeout", hasNext: true },
)

// `fetch failed` is undici's whole message when the host cannot be reached, and
// it is the most common failure there is: no network, a proxy, or a baseUrl
// pointing at nothing. Two words on their own is the least useful line axe can
// print, so it must not fall through to the unknown case.
for (const message of [
	"fetch failed",
	"getaddrinfo ENOTFOUND api.anthropic.com",
	"connect ECONNREFUSED 127.0.0.1:11434",
	"self signed certificate in certificate chain",
]) {
	expect(`unreachable: ${message}`, new Error(message), {
		surface: "provider",
		code: "provider.unreachable",
		hasNext: true,
	})
}
const unreachable = classify(new Error("fetch failed"))
check("an unreachable host is not reported as a ui problem", unreachable.surface === "provider", unreachable.surface)
check("and names something to check", /network|proxy|baseUrl/.test(unreachable.next), unreachable.next)

// ── config ──────────────────────────────────────────────────────────────────
expect("missing key", new KeyError("missing", "No API key for anthropic. Set ANTHROPIC_API_KEY."), {
	surface: "config",
	code: "config.key_missing",
	hasNext: true,
})
expect("broken keySource", new KeyError("error", "keySource for anthropic failed: exit 4"), {
	surface: "config",
	code: "config.key_source_failed",
	hasNext: true,
})
// The two are different problems and must not collapse into one code: a key
// that was never set is normal, a keySource that ran and failed is broken.
const missing = classify(new KeyError("missing", "No API key for openai."))
const broken = classify(new KeyError("error", "keySource for openai failed: exit 1"))
check("missing and broken keys differ", missing.code !== broken.code, `${missing.code} ${broken.code}`)

// ── mcp ─────────────────────────────────────────────────────────────────────
expect("mcp timeout", new Error("mcp github: tools/list timed out after 10000ms"), {
	surface: "mcp",
	code: "mcp.timeout",
	hasNext: true,
})
expect("mcp down", new Error("mcp github: exited 1: command not found"), {
	surface: "mcp",
	code: "mcp.server_down",
})
expect("mcp start failure", new Error("mcp local: could not start: ENOENT"), {
	surface: "mcp",
	code: "mcp.server_down",
})
expect("mcp call failure", new Error("mcp github: rate limited by upstream"), {
	surface: "mcp",
	code: "mcp.call_failed",
})
// The server's name is the whole reason the client prefixes it, so it has to
// survive: "an MCP server failed" is useless with four of them configured.
const mcpNamed = classify(new Error("mcp github: tools/list timed out after 10000ms"))
check("the server name survives", mcpNamed.message.startsWith("github:"), mcpNamed.message)
check("and the prefix is not repeated", !mcpNamed.message.startsWith("mcp "), mcpNamed.message)

// ── thread ──────────────────────────────────────────────────────────────────
expect("corrupt thread", new Error("Thread 2026-01-01T00-00-00-000Z-abcde is corrupt at line 12."), {
	surface: "thread",
	code: "thread.corrupt",
	hasNext: true,
})
expect("missing thread", new Error("No thread 2020-01-01T00-00-00-000Z-none. `axe threads` lists them."), {
	surface: "thread",
	code: "thread.not_found",
})

// ── subagent ────────────────────────────────────────────────────────────────
expect("subagent", new SubagentError("anthropic 500: boom", emptyUsage(), 3), {
	surface: "tool",
	code: "tool.subagent_failed",
	hasNext: true,
})

// ── the unknown case, which is the one that must not lie ─────────────────────
const unknown = classify(new Error("something nobody mapped"))
check("an unmapped error keeps its message", unknown.message === "something nobody mapped", unknown.message)
check("and invents no next step", unknown.next === "", unknown.next)
check("and lands on the ui surface by default", unknown.surface === "ui", unknown.surface)
check("and its code names the surface", unknown.code === "ui.unknown", unknown.code)

// A caller that knows which layer it is catching for keeps that layer.
expect("unknown plugin failure", new Error("Unexpected token"), {
	surface: "plugin",
	code: "plugin.unknown",
	hasNext: false,
}, "plugin")

// A recognised error is recognised regardless of the fallback the caller passed.
const recognised = classify(new HttpError("anthropic", 401, "nope"), "plugin")
check("a fallback never overrides a match", recognised.surface === "provider", recognised.surface)

// Anything at all may be thrown in JavaScript.
for (const [label, thrown] of [
	["a string", "just a string"],
	["a number", 42],
	["null", null],
	["undefined", undefined],
	["an object", { nope: true }],
] as const) {
	const d = classify(thrown)
	check(`${label} does not crash the classifier`, d.code === "ui.unknown", d.code)
	check(`${label} still produces a message`, d.message.length > 0, d.message)
}

// ── formatting ──────────────────────────────────────────────────────────────
const line = formatDiagnosis(classify(new HttpError("anthropic", 401, "nope")))
check("the surface leads the line", line.startsWith("provider \u00b7 "), line)
check("the code is not repeated as a prefix", !line.includes("provider.unauthorized"), line)
check("underscores are spaced out for reading", line.includes("unauthorized"), line)
check("the next step is on the same line", line.includes("axe auth"), line)
check("one line only", !line.includes("\n"), line)

const bare = formatDiagnosis(classify(new Error("nothing mapped")))
check("no next step leaves no trailing separator", bare.trimEnd() === bare, JSON.stringify(bare))
check("describeError is the same line", describeError(new Error("nothing mapped")) === bare, bare)

// Every code a rule can produce must be prefixed with its own surface, or the
// prefix-stripping in formatDiagnosis silently stops working.
for (const err of [
	new HttpError("a", 401, ""),
	new HttpError("a", 429, ""),
	new HttpError("a", 404, ""),
	new HttpError("a", 413, ""),
	new HttpError("a", 500, ""),
	new HttpError("a", 400, ""),
	new KeyError("missing", "x"),
	new KeyError("error", "x"),
	new Error("mcp s: timed out after 1ms"),
	new Error("stream stalled: no data for 1ms"),
	new Error("Thread x is corrupt at line 1."),
	new SubagentError("x", emptyUsage(), 0),
]) {
	const d = classify(err)
	check(`${d.code} is namespaced by its surface`, d.code.startsWith(`${d.surface}.`), d.code)
}

console.log(`errors: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

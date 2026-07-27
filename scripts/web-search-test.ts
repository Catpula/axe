// No network: fetch is replaced, per the testing rule.
import assert from "node:assert/strict"
import { toApiTools, serverResultText } from "../src/providers/anthropic.ts"
import { toApiTools as googleTools } from "../src/providers/google.ts"
import { htmlToText, parseDuckDuckGo, webSearchTool } from "../src/tools/web.ts"
import type { ToolCtx, ToolDef } from "../src/providers/types.ts"

const ctx: ToolCtx = { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} }

const RESULTS = `
<html><body>
<div class="result">
	<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fspec.example%2Fmcp&amp;rut=x">Streamable <b>HTTP</b></a>
	<a class="result__snippet">The transport replaces HTTP+SSE.</a>
</div>
<div class="result">
	<a rel="nofollow" class="result__a" href="https://blog.example/post">Second &amp; last</a>
	<a class="result__snippet">A note about it.</a>
</div>
<div class="result">
	<a rel="nofollow" class="result__a" href="javascript:alert(1)">Bad scheme</a>
</div>
</body></html>
`

{
	const hits = parseDuckDuckGo(RESULTS, new URL("https://html.duckduckgo.com/html/"))
	assert.equal(hits.length, 2, "a non-http result is dropped, not offered")
	assert.deepEqual(hits[0], {
		title: "Streamable HTTP",
		url: "https://spec.example/mcp",
		snippet: "The transport replaces HTTP+SSE.",
	})
	assert.equal(hits[1]!.title, "Second & last")
	assert.equal(hits[1]!.url, "https://blog.example/post")
}

{
	assert.deepEqual(parseDuckDuckGo("<html><body>nothing</body></html>", new URL("https://x.test/")), [])
}

{
	// web_fetch's own parsing is untouched by the split.
	const text = htmlToText(
		'<p>See <a href="https://a.test/x">the doc</a>.</p>',
		new URL("https://base.test/"),
	)
	assert.ok(text.includes("the doc (https://a.test/x)"), text)
}

{
	const calls: string[] = []
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: any) => {
		calls.push(String(input))
		return new Response(RESULTS, { status: 200, headers: { "content-type": "text/html" } })
	}) as typeof fetch
	try {
		const out = await (webSearchTool as ToolDef).run({ query: "mcp streamable http" }, ctx)
		assert.ok(calls[0]!.includes("html.duckduckgo.com"), calls[0])
		assert.ok(calls[0]!.includes("mcp+streamable+http"), calls[0])
		assert.ok(out.includes("https://spec.example/mcp"), out)
		assert.ok(out.includes("The transport replaces HTTP+SSE."), out)
		assert.ok(!out.includes("javascript:"), out)

		// An empty page says the scraper broke rather than that nothing exists.
		globalThis.fetch = (async () =>
			new Response("<html></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			})) as typeof fetch
		const none = await (webSearchTool as ToolDef).run({ query: "zzz" }, ctx)
		assert.ok(none.includes("markup has changed"), none)

		globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch
		await assert.rejects(() => (webSearchTool as ToolDef).run({ query: "zzz" }, ctx), /503/)

		await assert.rejects(() => (webSearchTool as ToolDef).run({ query: "  " }, ctx), /empty/)
	} finally {
		globalThis.fetch = realFetch
	}
}

{
	const tools = [{ name: "read_file", description: "d", schema: {}, readOnly: true, run: async () => "" }]
	const off = toApiTools(tools as ToolDef[])
	assert.equal(off.length, 1, "no server tool unless it was asked for")
	const on = toApiTools(tools as ToolDef[], ["web_search"])
	assert.equal(on.length, 2)
	assert.deepEqual(on[1], {
		type: "web_search_20250305",
		name: "web_search",
		max_uses: 5,
	})

	const gOff = googleTools(tools as ToolDef[])
	assert.equal(gOff.length, 1)
	const gOn = googleTools(tools as ToolDef[], ["web_search"])
	assert.deepEqual(gOn[1], { google_search: {} })
}

{
	// A provider-run search has no tool_result to answer, so it folds into text.
	const text = serverResultText([
		{ type: "web_search_result", title: "A page", url: "https://a.test/" },
		{ type: "web_search_result", title: "Another", url: "https://b.test/" },
	])
	assert.equal(text, "A page\nhttps://a.test/\n\nAnother\nhttps://b.test/")
	assert.ok(
		serverResultText({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }).includes(
			"max_uses_exceeded",
		),
	)
}

console.log("web-search-test ok")

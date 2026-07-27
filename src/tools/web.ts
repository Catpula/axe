import type { ToolDef } from "../providers/types.ts"

const MAX_BODY_BYTES = 2_000_000
const MAX_OUTPUT = 20_000
const TIMEOUT_MS = 30_000

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
}

function decodeEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
		if (name[0] === "#") {
			const hex = name[1] === "x" || name[1] === "X"
			const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
		}
		return ENTITIES[name.toLowerCase()] ?? m
	})
}

/**
 * Search engines wrap result links in a redirect. Unwrapping DuckDuckGo's here
 * is what turns "fetch the search page" into a usable web search: the model
 * gets the real destination instead of a tracking hop it cannot follow.
 */
function resolveHref(href: string, base: URL): string | null {
	let url: URL
	try {
		url = new URL(decodeEntities(href), base)
	} catch {
		return null
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null
	if (url.hostname.endsWith("duckduckgo.com")) {
		const target = url.searchParams.get("uddg")
		if (target) return target
	}
	return url.href
}

const STRIP = /<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi
const BLOCK =
	/<\/?(p|div|br|ul|ol|tr|table|h[1-6]|section|article|header|footer|blockquote|pre|form)\b[^>]*>/gi

export function htmlToText(html: string, base: URL): string {
	let s = html.replace(/<!--[\s\S]*?-->/g, "")
	s = s.replace(STRIP, " ")
	s = s.replace(
		/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
		(_m, _q, d, sq, bare, inner) => {
			const text = decodeEntities(String(inner).replace(/<[^>]+>/g, " "))
				.replace(/\s+/g, " ")
				.trim()
			if (!text) return " "
			const url = resolveHref(d ?? sq ?? bare ?? "", base)
			return url ? ` ${text} (${url}) ` : ` ${text} `
		},
	)
	s = s.replace(/<li\b[^>]*>/gi, "\n- ")
	s = s.replace(/<\/li\s*>/gi, "")
	s = s.replace(BLOCK, "\n")
	s = s.replace(/<[^>]+>/g, " ")
	s = decodeEntities(s)
	s = s
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
	return s.replace(/\n{3,}/g, "\n\n").trim()
}

async function readBody(res: Response): Promise<{ text: string; truncated: boolean }> {
	const reader = res.body?.getReader()
	if (!reader) return { text: "", truncated: false }
	const chunks: Uint8Array[] = []
	let total = 0
	let truncated = false
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		total += value.byteLength
		if (total >= MAX_BODY_BYTES) {
			truncated = true
			await reader.cancel()
			break
		}
	}
	const joined = new Uint8Array(total)
	let offset = 0
	for (const c of chunks) {
		joined.set(c, offset)
		offset += c.byteLength
	}
	return { text: new TextDecoder("utf-8", { fatal: false }).decode(joined), truncated }
}

/**
 * A DuckDuckGo result row. The heading link carries the destination and the
 * title; the snippet is the sentence underneath it.
 */
const DDG_RESULT =
	/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi
const DDG_SNIPPET = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a\s*>/gi

function plain(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim()
}

export type SearchHit = { title: string; url: string; snippet?: string }

/**
 * Pulls the result rows out of DuckDuckGo's HTML endpoint.
 *
 * Snippets are matched separately and paired by position rather than by parsing
 * each row as a unit: the row markup changes far more often than the two class
 * names do, and a missing snippet should cost a sentence, not the whole result.
 */
export function parseDuckDuckGo(html: string, base: URL): SearchHit[] {
	const snippets: string[] = []
	for (const m of html.matchAll(DDG_SNIPPET)) snippets.push(plain(m[1] ?? ""))
	const hits: SearchHit[] = []
	for (const m of html.matchAll(DDG_RESULT)) {
		const url = resolveHref(m[2] ?? m[3] ?? "", base)
		const title = plain(m[4] ?? "")
		if (!url || !title) continue
		hits.push({ title, url, snippet: snippets[hits.length] || undefined })
	}
	return hits
}

const MAX_HITS = 10

export const webSearchTool: ToolDef = {
	name: "web_search",
	description:
		"Search the web and return the top results as title, url and snippet. Use this to find pages worth reading, then read them with web_fetch. The snippets are one sentence each and are not an answer on their own.",
	readOnly: true,
	schema: {
		type: "object",
		properties: {
			query: { type: "string", description: "What to search for, in plain words." },
		},
		required: ["query"],
	},
	async run(input: { query: string }, ctx) {
		const query = (input.query ?? "").trim()
		if (!query) throw new Error("web_search: query is empty.")
		const url = new URL("https://html.duckduckgo.com/html/")
		url.searchParams.set("q", query)
		ctx.log(`searching for ${query}`)
		let res: Response
		try {
			res = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
				headers: { "user-agent": "axe-cli", accept: "text/html" },
			})
		} catch (err) {
			if (ctx.signal.aborted) throw new Error("web_search: cancelled")
			const why =
				err instanceof Error
					? err.cause instanceof Error
						? err.cause.message
						: err.message
					: String(err)
			throw new Error(`web_search: ${why}`)
		}
		if (!res.ok) {
			await res.body?.cancel()
			throw new Error(`web_search: DuckDuckGo returned ${res.status}.`)
		}
		const { text } = await readBody(res)
		const hits = parseDuckDuckGo(text, new URL(res.url || url.href)).slice(0, MAX_HITS)
		// Scraping breaks when the markup moves, and an empty list would read as
		// "nothing exists" rather than "this stopped working".
		if (!hits.length) {
			return `No results for ${query}. If this repeats for every query, the search page markup has changed; fetch ${url.href} with web_fetch instead.`
		}
		return hits
			.map((h) => `${h.title}\n${h.url}${h.snippet ? `\n${h.snippet}` : ""}`)
			.join("\n\n")
	},
}

export const webFetchTool: ToolDef = {
	name: "web_fetch",
	description:
		'Fetch a URL over http or https and return the page as readable text. HTML is stripped to prose with links shown as "text (url)". Use it on a URL you already have, from web_search or from the conversation. Do not use it for files in this repository; use read_file. Do not use it to download binaries; it returns text only.',
	readOnly: true,
	schema: {
		type: "object",
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
		},
		required: ["url"],
	},
	async run(input: { url: string }, ctx) {
		const raw = (input.url ?? "").trim()
		let url: URL
		try {
			url = new URL(raw)
		} catch {
			throw new Error(`web_fetch: not an absolute URL: ${raw}`)
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`web_fetch: only http and https, got ${url.protocol}`)
		}
		ctx.log(`fetching ${url.href}`)
		let res: Response
		try {
			res = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
				headers: {
					"user-agent": "axe-cli",
					accept: "text/html,application/json;q=0.9,text/*;q=0.8,*/*;q=0.1",
				},
			})
		} catch (err) {
			if (ctx.signal.aborted) throw new Error("web_fetch: cancelled")
			const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
			throw new Error(`web_fetch: ${url.href}: ${why}`)
		}
		const type = (res.headers.get("content-type") ?? "").toLowerCase()
		const textual =
			type.includes("html") ||
			type.includes("json") ||
			type.includes("xml") ||
			type.startsWith("text/") ||
			type === ""
		if (!textual) {
			await res.body?.cancel()
			throw new Error(`web_fetch: unsupported content type ${type}; this tool returns text only.`)
		}
		const { text, truncated } = await readBody(res)
		const finalUrl = res.url || url.href
		let body: string
		if (type.includes("html")) {
			body = htmlToText(text, new URL(finalUrl))
		} else if (type.includes("json")) {
			try {
				body = JSON.stringify(JSON.parse(text), null, 2)
			} catch {
				body = text
			}
		} else {
			body = text
		}
		const notes: string[] = []
		if (truncated) notes.push(`response body capped at ${MAX_BODY_BYTES} bytes`)
		if (body.length > MAX_OUTPUT) {
			body = body.slice(0, MAX_OUTPUT)
			notes.push(`text cut at ${MAX_OUTPUT} characters`)
		}
		const note = notes.length ? `\n[${notes.join("; ")}]` : ""
		return `${finalUrl} [${res.status}]\n\n${body || "(empty body)"}${note}`
	},
}

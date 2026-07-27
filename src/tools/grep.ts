import { spawn } from "node:child_process"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { ToolDef } from "../providers/types.ts"

const MAX_MATCHES = 50
const CONTEXT_LINES = 2
// The fallback runs the model's regex on the main thread, where a pattern that
// backtracks has no interrupt short of this budget.
const FALLBACK_BUDGET_MS = 10_000
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "target", "__pycache__"])

function hasRipgrep(signal: AbortSignal): Promise<boolean> {
	return new Promise((res) => {
		const p = spawn("rg", ["--version"], { stdio: "ignore", signal })
		p.on("error", () => res(false))
		p.on("close", (code) => res(code === 0))
	})
}

function runRipgrep(
	pattern: string,
	glob: string | undefined,
	cwd: string,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((res, rej) => {
		const args = [
			"--line-number",
			"--with-filename",
			"--color=never",
			`--context=${CONTEXT_LINES}`,
			`--max-count=${MAX_MATCHES}`,
		]
		if (glob) args.push("--glob", glob)
		args.push("--regexp", pattern, ".")
		const p = spawn("rg", args, { cwd, signal })
		let out = ""
		let err = ""
		p.stdout.on("data", (d) => {
			out += d.toString()
		})
		p.stderr.on("data", (d) => {
			err += d.toString()
		})
		p.on("error", rej)
		p.on("close", (code) => {
			if (code === 0 || code === 1) res(out)
			else rej(new Error(err || `ripgrep exited ${code}`))
		})
	})
}

async function* files(root: string, dir: string): AsyncGenerator<string> {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || SKIP.has(e.name)) continue
		const abs = join(dir, e.name)
		if (e.isDirectory()) yield* files(root, abs)
		else if (e.isFile()) yield abs
	}
}

async function fallbackGrep(pattern: string, root: string, signal: AbortSignal): Promise<string> {
	let re: RegExp
	try {
		re = new RegExp(pattern)
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err)
		throw new Error(`Invalid regular expression /${pattern}/: ${why}`)
	}
	const deadline = Date.now() + FALLBACK_BUDGET_MS
	const stopReason = () =>
		signal.aborted
			? "search cancelled"
			: Date.now() > deadline
				? `search gave up after ${FALLBACK_BUDGET_MS}ms`
				: ""
	const chunks: string[] = []
	let stopped = ""
	let count = 0
	for await (const abs of files(root, root)) {
		if (count >= MAX_MATCHES) break
		stopped = stopReason()
		if (stopped) break
		try {
			if ((await stat(abs)).size > 2_000_000) continue
			const lines = (await readFile(abs, "utf8")).split("\n")
			for (let i = 0; i < lines.length && count < MAX_MATCHES; i++) {
				stopped = stopReason()
				if (stopped) break
				if (!re.test(lines[i]!)) continue
				count++
				const from = Math.max(0, i - CONTEXT_LINES)
				const to = Math.min(lines.length - 1, i + CONTEXT_LINES)
				const body = lines
					.slice(from, to + 1)
					.map((l, k) => `${from + k + 1}${from + k === i ? ":" : "-"}${l}`)
					.join("\n")
				// Forward slashes, like ripgrep's output and like every path the model
				// is asked to hand back. `relative` uses the platform separator.
				chunks.push(`${relative(root, abs).replaceAll(sep, "/")}\n${body}`)
			}
		} catch {
			// Binary or unreadable file.
		}
	}
	const note = stopped ? `[${stopped}; these results are partial]` : ""
	return [...chunks, note].filter(Boolean).join("\n--\n")
}

export const grepTool: ToolDef = {
	name: "grep",
	description:
		"Search file contents with a regular expression and return matches with two lines of context. Use this first when you know a symbol or string but not the file. Do not use it to list files by name; use glob.",
	readOnly: true,
	schema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regular expression." },
			glob: { type: "string", description: 'Optional file filter such as "*.ts".' },
		},
		required: ["pattern"],
	},
	async run(input: { pattern: string; glob?: string }, ctx) {
		const out = (await hasRipgrep(ctx.signal))
			? await runRipgrep(input.pattern, input.glob, ctx.cwd, ctx.signal)
			: await fallbackGrep(input.pattern, ctx.cwd, ctx.signal)
		return out.trim() || `No matches for /${input.pattern}/.`
	},
}

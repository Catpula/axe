import { spawn } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Gate, runSubagent } from "./core/subagent.ts"
import type { Provider, Usage } from "./providers/types.ts"
import { addUsage, emptyUsage } from "./providers/types.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { coreTools } from "./tools/index.ts"

const MAX_DIFF = 80_000
const SEVERITIES = ["low", "medium", "high", "critical"]

export type ReviewCheck = { name: string; severity: string; body: string }

/**
 * A check is a document, like a skill: markdown with an optional frontmatter
 * severity, read from `.axe/checks/<name>.md`. The body is the instruction a
 * reviewer gets, so it should say what to look for and what counts as a
 * violation, not restate what a review is.
 */
export function parseCheck(name: string, src: string): ReviewCheck {
	let severity = "medium"
	let body = src.trim()
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(body)
	if (m) {
		body = body.slice(m[0].length).trim()
		const sev = /^severity:\s*(\S+)/m.exec(m[1]!)?.[1]?.toLowerCase()
		if (sev && SEVERITIES.includes(sev)) severity = sev
	}
	return { name, severity, body }
}

export async function discoverChecks(cwd: string): Promise<ReviewCheck[]> {
	const dir = join(cwd, ".axe", "checks")
	let names: string[]
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort()
	} catch {
		return []
	}
	const checks: ReviewCheck[] = []
	for (const n of names) {
		try {
			checks.push(parseCheck(n.replace(/\.md$/, ""), await readFile(join(dir, n), "utf8")))
		} catch {
			// An unreadable check reviews nothing.
		}
	}
	return checks.filter((c) => c.body)
}

function git(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		let err = ""
		p.stdout.on("data", (d) => (out += d.toString()))
		p.stderr.on("data", (d) => (err += d.toString()))
		p.on("error", reject)
		p.on("close", (code) => {
			if (code === 0) resolve(out)
			else reject(new Error(err.trim() || `git ${args[0]} exited ${code}`))
		})
	})
}

export function clampDiff(diff: string): string {
	if (diff.length <= MAX_DIFF) return diff
	const half = MAX_DIFF / 2
	return `${diff.slice(0, half)}\n[... ${diff.length - MAX_DIFF} characters of diff omitted; read the files for the rest ...]\n${diff.slice(-half)}`
}

/** Uncommitted work plus a list of files git does not know about yet. */
async function workingDiff(cwd: string, paths: string[] = []): Promise<string> {
	const suffix = paths.length ? ["--", ...paths] : []
	const diff = await git(["--literal-pathspecs", "diff", "HEAD", ...suffix], cwd)
	const untracked = (await git(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", ...suffix], cwd)).trim()
	const note = untracked
		? `\n\nUntracked files, not shown in the diff; read the ones that matter:\n${untracked}`
		: ""
	return clampDiff(diff) + note
}

/** Current working-tree diff restricted to files attributed to one agent turn. */
export function workingDiffForFiles(cwd: string, paths: string[]): Promise<string> {
	return paths.length ? workingDiff(cwd, paths) : Promise.resolve("")
}

export const REVIEW_BRIEF = `You are a review subagent. You are given one check to apply to one diff, and nothing else is your business: do not report problems outside this check, however real.

You cannot ask questions and only your final message is returned. Your tools are read-only; read the surrounding code whenever the diff alone cannot convict.

Write the report:
- If the diff passes the check, the entire first line must be exactly: OK
- Otherwise list each violation with the file, the line, the offending code, and one sentence on why it violates this check.
- Report only what you can point at in the diff or the files. A hunch is not a finding.`

export function reviewPrompt(check: ReviewCheck, diff: string): string {
	return `The check to apply, verbatim from ${check.name}.md (severity ${check.severity}):\n\n${check.body}\n\nThe diff under review:\n\n${diff}`
}

export type ReviewResult = { failed: number; usage: Usage }

export async function runReview(opts: {
	cwd: string
	provider: Provider
	model: string
	maxTokens: number
	thinkingBudget?: number
	limit: number
	write: (s: string) => void
}): Promise<ReviewResult> {
	const checks = await discoverChecks(opts.cwd)
	if (!checks.length) {
		opts.write("No checks. Add one at .axe/checks/<name>.md\n")
		return { failed: 0, usage: emptyUsage() }
	}
	const diff = await workingDiff(opts.cwd)
	if (!diff.trim()) {
		opts.write("Nothing to review: the working tree matches HEAD.\n")
		return { failed: 0, usage: emptyUsage() }
	}
	const system = await buildSystemPrompt(opts.cwd, REVIEW_BRIEF)
	const gate = new Gate(opts.limit)
	const signal = new AbortController().signal
	let usage = emptyUsage()
	let failed = 0
	// One subagent per check, all through the gate, reported in check order so
	// two runs of the same review read the same way.
	const reports = await Promise.all(
		checks.map((check) =>
			gate.run(async () => {
				try {
					const out = await runSubagent(
						{
							provider: opts.provider,
							model: opts.model,
							maxTokens: opts.maxTokens,
							thinkingBudget: opts.thinkingBudget,
							system,
							tools: coreTools().readOnly(),
							cwd: opts.cwd,
							maxSteps: 20,
						},
						reviewPrompt(check, diff),
						signal,
					)
					return { check, text: out.text, usage: out.usage, crashed: false }
				} catch (err) {
					return {
						check,
						text: err instanceof Error ? err.message : String(err),
						usage: emptyUsage(),
						crashed: true,
					}
				}
			}),
		),
	)
	for (const r of reports) {
		usage = addUsage(usage, r.usage)
		const ok = !r.crashed && r.text.split("\n")[0]!.trim() === "OK"
		if (!ok) failed++
		const verdict = r.crashed ? "error" : ok ? "ok" : "findings"
		opts.write(`\n== ${r.check.name} (${r.check.severity}) · ${verdict}\n`)
		if (!ok) opts.write(`${r.text.trim()}\n`)
	}
	opts.write(`\n${checks.length - failed}/${checks.length} checks passed · $${usage.costUsd.toFixed(4)}\n`)
	return { failed, usage }
}

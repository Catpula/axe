import { readFile, stat } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { dirname, join, parse } from "node:path"
import { AXE_HOME, type ContextSource } from "./core/thread.ts"

const IDENTITY = `You are axe, a coding agent running in a terminal on the user's machine.

Be concise. The user reads your output in a terminal, not a browser.
Do not restate the plan before acting and do not summarise what you just did unless asked.

Work like an engineer with commit access:
- Read before you write: grep and glob to find the code, read_file to read it, edit_file to change it.
- Delegate a search to task when finding the answer would cost you many file reads. Only its report comes back, so your own context stays on the task.
- Match the surrounding style. Do not introduce a new dependency, abstraction, or file layout without being asked.
- Make the smallest change that fully solves the problem.
- Run the project's own build, typecheck, or tests to verify your work when they exist. Do not claim something works if you did not run it.
- Use bash with background for a command that does not end on its own, such as a dev server or a watcher. Waiting on one in the foreground only ends at the timeout.
- Read-only calls in one step run in parallel, so ask for the reads you need together rather than one per step.
- If a task is ambiguous in a way that changes the code you would write, ask one question. Otherwise proceed.

When you finish, state what changed in one or two lines. Do not add a summary section, a bullet list of files, or next-step suggestions unless the user asks.`

export async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8")
	} catch {
		return null
	}
}

/** cwd, then each parent, then the personal file. Nearest file is most specific. */
async function guidance(cwd: string): Promise<{ text: string; sources: ContextSource[] }> {
	const chunks: string[] = []
	const sources: ContextSource[] = []
	const seen = new Set<string>()
	let dir = cwd
	const root = parse(cwd).root
	for (;;) {
		for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
			const path = join(dir, name)
			if (seen.has(path)) continue
			seen.add(path)
			const body = await readIfExists(path)
			if (body) {
				chunks.push(`<guidance path="${path}">\n${body.trim()}\n</guidance>`)
				sources.push({ kind: "guidance", path, scope: "project" })
				break
			}
		}
		if (dir === root) break
		dir = dirname(dir)
	}
	// Two locations, and only one of them is where the rest of axe already lives.
	// AXE_HOME is the home for config.toml, plugins, agents and threads, so
	// personal guidance belongs there too; ~/.config/axe was the original path and
	// is still read, second, because a file somebody already wrote must not stop
	// working. The AXE_HOME copy wins, and neither is read twice when the two
	// resolve to the same file.
	for (const personalPath of [join(AXE_HOME, "AGENTS.md"), join(homedir(), ".config", "axe", "AGENTS.md")]) {
		if (seen.has(personalPath)) continue
		seen.add(personalPath)
		const personal = await readIfExists(personalPath)
		if (!personal) continue
		chunks.push(`<guidance scope="personal" path="${personalPath}">\n${personal.trim()}\n</guidance>`)
		sources.push({ kind: "guidance", path: personalPath, scope: "personal" })
		// The nearer file is the more specific one, exactly as with the project
		// chain above: finding one stops the search.
		break
	}
	return { text: chunks.reverse().join("\n\n"), sources: sources.reverse() }
}

/**
 * Whether the workspace is a git repository, by looking rather than by asking:
 * the model would otherwise spend a whole step on `git status` to find out
 * whether it may commit. A worktree's `.git` is a file, not a directory, so the
 * existence of the entry is the test.
 */
async function isGitRepo(cwd: string): Promise<boolean> {
	let dir = cwd
	const root = parse(cwd).root
	for (;;) {
		try {
			await stat(join(dir, ".git"))
			return true
		} catch {
			if (dir === root) return false
			dir = dirname(dir)
		}
	}
}

export type PromptFacts = {
	/** The project's own check, already run after every successful edit_file. */
	editCheck?: string
}

export async function buildPromptContext(
	cwd: string,
	extra?: string,
	facts: PromptFacts = {},
): Promise<{ prompt: string; sources: ContextSource[] }> {
	const env = [
		`<environment>`,
		`cwd: ${cwd}`,
		`platform: ${platform()}`,
		`date: ${new Date().toISOString().slice(0, 10)}`,
		`git repository: ${(await isGitRepo(cwd)) ? "yes" : "no"}`,
		// Stated because it changes what the model should do rather than what it
		// should know: the check has already run by the time a failure is visible,
		// so running it again by hand is a wasted step.
		...(facts.editCheck
			? [`edit check: ${facts.editCheck} runs after every successful edit_file; its failures come back with the edit`]
			: []),
		`</environment>`,
	].join("\n")

	const g = await guidance(cwd)
	return {
		prompt: [IDENTITY, env, g.text, extra].filter(Boolean).join("\n\n"),
		sources: [{ kind: "system" }, ...g.sources],
	}
}

export async function buildSystemPrompt(
	cwd: string,
	extra?: string,
	facts?: PromptFacts,
): Promise<string> {
	return (await buildPromptContext(cwd, extra, facts)).prompt
}

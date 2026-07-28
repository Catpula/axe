import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseFrontmatter, slug } from "./skills.ts"

export type CommandScope = "project" | "personal"

export type CustomCommand = {
	name: string
	description: string
	path: string
	scope: CommandScope
	/** The body below the frontmatter, placeholders unexpanded. */
	template: string
}

/**
 * A slash command is a prompt someone got tired of retyping.
 *
 * `/<name> <args>` reads .agents/commands/<name>.md, expands its placeholders,
 * and sends the result as the user's turn. Nothing else: no new tool, no new
 * runtime, and nothing the user could not have typed by hand. That keeps the
 * feature honest about what the model sees — the expanded text and no marker
 * saying it came from a file.
 *
 * Skills point the model at a document it may choose to read. Commands are the
 * other direction: the user chooses, and the file becomes the prompt.
 */

/** Everything after the first pair of `---`, or the whole file when there is none. */
export function stripFrontmatter(src: string): string {
	const lines = src.split("\n")
	if ((lines[0] ?? "").trim() !== "---") return src
	const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
	return close === -1 ? src : lines.slice(close + 1).join("\n")
}

/**
 * `$ARGUMENTS` is everything the user typed; `$1`..`$9` are the words of it.
 * A template with neither takes the arguments appended, so a command written
 * without placeholders still accepts a subject.
 *
 * Substitution is a single pass, so an argument that itself contains `$2` is
 * text and not a second placeholder.
 */
export function expandCommand(template: string, args: string): string {
	const body = template.trim()
	const rest = args.trim()
	if (!/\$ARGUMENTS(?![A-Za-z0-9_])|\$[1-9](?!\d)/.test(body)) return rest ? `${body}\n\n${rest}` : body
	// ponytail: whitespace split, so quoted arguments are separate words.
	// Add a quote-aware splitter when a command needs `$1` to hold a sentence.
	const words = rest ? rest.split(/\s+/) : []
	return body.replace(/\$ARGUMENTS(?![A-Za-z0-9_])|\$([1-9])(?!\d)/g, (whole, digit: string | undefined) =>
		digit === undefined ? rest : (words[Number(digit) - 1] ?? ""),
	)
}

/**
 * Splits `/deploy staging` into its name and the rest. Returns null for anything
 * else, including `/usr/bin/env` and `//`: a path pasted into the prompt is a
 * path, and swallowing it as an unknown command loses what the user meant.
 */
export function parseCommandLine(input: string): { name: string; args: string } | null {
	const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(input.trim())
	if (!match) return null
	return { name: slug(match[1]!), args: (match[2] ?? "").trim() }
}

async function readCommand(
	path: string,
	scope: CommandScope,
	fallbackName: string,
): Promise<CustomCommand | null> {
	let src: string
	try {
		src = await readFile(path, "utf8")
	} catch {
		return null
	}
	const fm = parseFrontmatter(src)
	const name = slug(fm.name || fallbackName)
	const template = stripFrontmatter(src).trim()
	// An empty file would send an empty turn, which reads as a hung session.
	if (!name || !template) return null
	return { name, description: (fm.description ?? "").trim(), path, scope, template }
}

async function fromRoot(root: string, scope: CommandScope): Promise<CustomCommand[]> {
	let entries: { name: string; isDirectory(): boolean }[]
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch {
		return []
	}
	const found: CustomCommand[] = []
	// By filename, because two files can slug to one name — `Deploy.md` and
	// `deploy.md`, or a frontmatter `name:` that lands on a neighbour's. readdir
	// order is the filesystem's business and differs between them, so without
	// this the winner differs between two machines holding the same checkout.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	for (const e of entries) {
		if (e.isDirectory()) continue
		if (!e.name.endsWith(".md") || e.name === "README.md") continue
		const c = await readCommand(join(root, e.name), scope, e.name.replace(/\.md$/, ""))
		if (c) found.push(c)
	}
	return found
}

/** Personal first, project second, so the project wins a name collision. */
export async function discoverCommands(cwd: string): Promise<CustomCommand[]> {
	const personal = await fromRoot(join(homedir(), ".agents", "commands"), "personal")
	const project = await fromRoot(join(cwd, ".agents", "commands"), "project")
	const byName = new Map<string, CustomCommand>()
	for (const c of [...personal, ...project]) byName.set(c.name, c)
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

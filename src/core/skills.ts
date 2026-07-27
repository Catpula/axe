import { access, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type SkillScope = "project" | "personal"

export type Skill = {
	name: string
	description: string
	path: string
	scope: SkillScope
	/** Set when an mcp.json sits next to this skill's file. Not read here. */
	mcpConfigPath?: string
	/** `includeTools: a_*, b_*` in frontmatter. Undefined means no filter. */
	includeTools?: string[]
}

/**
 * A skill is a markdown file. Only its name and description are put in the
 * system prompt; the body is read with read_file when the task calls for it.
 * That is the whole design: a skill costs one line of context until it is used,
 * so a project can carry fifty of them without paying for any.
 *
 * It also means skills need no new tool and no runtime. A skill is a document.
 */

/** Frontmatter only: `key: value` lines between the first pair of `---`. */
export function parseFrontmatter(src: string): Record<string, string> {
	const out: Record<string, string> = {}
	const lines = src.split("\n")
	if ((lines[0] ?? "").trim() !== "---") return out
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!
		if (line.trim() === "---") break
		const colon = line.indexOf(":")
		if (colon === -1) continue
		const key = line.slice(0, colon).trim()
		let value = line.slice(colon + 1).trim()
		const quoted =
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		if (quoted && value.length >= 2) value = value.slice(1, -1)
		if (key) out[key] = value
	}
	return out
}

export function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

async function readSkill(
	path: string,
	scope: SkillScope,
	fallbackName: string,
): Promise<Skill | null> {
	let src: string
	try {
		src = await readFile(path, "utf8")
	} catch {
		return null
	}
	const fm = parseFrontmatter(src)
	const description = (fm.description ?? "").trim()
	// No description means the model has no way to know when to reach for it,
	// so it would only ever be dead weight in the prompt. Skip it silently.
	if (!description) return null
	const name = slug(fm.name || fallbackName)
	if (!name) return null
	const mcpPath = join(dirname(path), "mcp.json")
	const mcpConfigPath = await access(mcpPath)
		.then(() => mcpPath)
		.catch(() => undefined)
	const includeTools = fm.includeTools
		? fm.includeTools.split(",").map((s) => s.trim()).filter(Boolean)
		: undefined
	return { name, description, path, scope, mcpConfigPath, includeTools }
}

async function fromRoot(root: string, scope: SkillScope): Promise<Skill[]> {
	let entries: { name: string; isDirectory(): boolean }[]
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch {
		return []
	}
	const found: Skill[] = []
	for (const e of entries) {
		if (e.isDirectory()) {
			const s = await readSkill(join(root, e.name, "SKILL.md"), scope, e.name)
			if (s) found.push(s)
		} else if (e.name.endsWith(".md") && e.name !== "README.md") {
			const s = await readSkill(join(root, e.name), scope, e.name.replace(/\.md$/, ""))
			if (s) found.push(s)
		}
	}
	return found
}

/** Personal first, project second, so the project wins a name collision. */
export async function discoverSkills(cwd: string): Promise<Skill[]> {
	const personal = await fromRoot(join(homedir(), ".agents", "skills"), "personal")
	const project = await fromRoot(join(cwd, ".agents", "skills"), "project")
	const byName = new Map<string, Skill>()
	for (const s of [...personal, ...project]) byName.set(s.name, s)
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function attr(s: string): string {
	return s.replace(/"/g, "'").replace(/\s+/g, " ").trim()
}

export function skillsSection(skills: Skill[]): string {
	if (!skills.length) return ""
	return [
		"<skills>",
		"Playbooks written for this machine or this project. Each one is a markdown file. When a task matches a description below, read that file with read_file and follow it. Do not read them speculatively, and do not mention a skill you did not read.",
		...skills.map((s) => `<skill name="${attr(s.name)}" path="${attr(s.path)}">${attr(s.description)}</skill>`),
		"</skills>",
	].join("\n")
}

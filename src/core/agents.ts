import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseFrontmatter, slug } from "./skills.ts"
import { AXE_HOME } from "./thread.ts"

/**
 * A custom subagent is a document, for the same reason a skill is: the two
 * built-in roles are a system prompt and a route, and neither of those needs
 * code to write down. `.axe/agents/<name>.md` is a body that becomes the
 * brief, plus a description that tells the model when to pick it.
 *
 * The built-in roles stay in code because the loop depends on them existing.
 */
export type CustomAgent = {
	name: string
	description: string
	/** Which internal route to run it on. Nothing else is settable. */
	role: "search" | "subagent" | "oracle"
	brief: string
}

const ROLES = new Set(["search", "subagent", "oracle"])

/** Reserved: shadowing a built-in would make `task` ambiguous. */
const BUILTIN = new Set(["search", "oracle"])

function parseAgent(fallbackName: string, src: string): CustomAgent | null {
	const fm = parseFrontmatter(src)
	const description = (fm.description ?? "").trim()
	if (!description) return null
	const name = slug(fm.name || fallbackName)
	if (!name || BUILTIN.has(name)) return null
	const body = src.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()
	if (!body) return null
	const role = ROLES.has(fm.role ?? "") ? (fm.role as CustomAgent["role"]) : "subagent"
	return { name, description, role, brief: body }
}

async function fromRoot(root: string): Promise<CustomAgent[]> {
	let names: string[]
	try {
		names = (await readdir(root)).filter((n) => n.endsWith(".md") && n !== "README.md").sort()
	} catch {
		return []
	}
	const found: CustomAgent[] = []
	for (const n of names) {
		try {
			const a = parseAgent(n.replace(/\.md$/, ""), await readFile(join(root, n), "utf8"))
			if (a) found.push(a)
		} catch {
			// An unreadable agent is one the model simply cannot pick.
		}
	}
	return found
}

/** Personal first, project second, so the project wins a name collision. */
export async function discoverAgents(cwd: string): Promise<CustomAgent[]> {
	const personal = await fromRoot(join(AXE_HOME, "agents"))
	const project = await fromRoot(join(cwd, ".axe", "agents"))
	const byName = new Map<string, CustomAgent>()
	for (const a of [...personal, ...project]) byName.set(a.name, a)
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

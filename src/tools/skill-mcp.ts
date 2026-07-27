import { resolve } from "node:path"
import { approvalKey, loadMcpServersFromFile, readApprovals } from "../core/mcp.ts"
import type { Skill } from "../core/skills.ts"
import type { ToolRegistry } from "../core/tools.ts"
import type { ToolDef } from "../providers/types.ts"
import { globToRegExp } from "./fs.ts"

/**
 * A skill's mcp.json sits next to its SKILL.md, unread and its server unspawned,
 * until the model actually reads that file: that is the whole point of a
 * skill, one line of context until it is used. So the spawn happens inside
 * read_file's own run, the moment its path matches, and `reg.register` is
 * enough to make the new tools visible: ToolRegistry is a mutable map and the
 * next turn's `tools.all()` picks them up with no loop to change.
 *
 * A project skill can arrive by `git clone`, so it goes through the same
 * approval file as a project .axe/mcp.json: reading a skill's instructions is
 * not consent to run whatever program its mcp.json points at.
 */
export function withSkillMcp(
	base: ToolDef,
	skills: Skill[],
	reg: ToolRegistry,
	cwd: string,
	onDown?: (note: string) => void,
): ToolDef {
	const loaded = new Set<string>()
	return {
		...base,
		async run(input: { path: string }, ctx) {
			const result = await base.run(input, ctx)
			const abs = resolve(cwd, input.path)
			const skill = skills.find((s) => s.mcpConfigPath && s.path === abs)
			if (!skill?.mcpConfigPath || loaded.has(skill.name)) return result
			loaded.add(skill.name)
			if (skill.scope === "project") {
				const approved = await readApprovals()
				if (!approved.has(approvalKey(cwd, `skill:${skill.name}`))) {
					return `${result}\n\n[MCP server for skill "${skill.name}" not approved. Run \`axe mcp approve skill:${skill.name}\` first.]`
				}
			}
			const taken = new Set(reg.all().map((t) => t.name))
			const loadedMcp = await loadMcpServersFromFile(skill.mcpConfigPath, taken, onDown)
			const filters = skill.includeTools?.map(globToRegExp)
			const tools = filters
				? loadedMcp.tools.filter((t) => filters.some((re) => re.test(t.name)))
				: loadedMcp.tools
			if (tools.length) reg.register(...tools)
			const notes = loadedMcp.notes.length ? `\n[${loadedMcp.notes.join(" ")}]` : ""
			const names = tools.length ? `\n[MCP tools available: ${tools.map((t) => t.name).join(", ")}]` : ""
			return result + names + notes
		},
	}
}

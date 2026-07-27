import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { readIfExists } from "../prompt.ts"
import type { ContextSource } from "../core/thread.ts"
import type { ToolDef } from "../providers/types.ts"

/**
 * `guidance()` in prompt.ts only walks from cwd to the filesystem root once, at
 * startup, so a directory below cwd never gets its own AGENTS.md read into the
 * system prompt. Instead this rides along on read_file: the first time a file
 * under some subtree is read, that subtree's AGENTS.md (if any) is appended to
 * the tool_result, once per directory per session.
 */
export function withSubtreeGuidance(base: ToolDef, cwd: string, record?: (source: ContextSource) => Promise<void>): ToolDef {
	const seen = new Set<string>()
	return {
		...base,
		async run(input: { path: string }, ctx) {
			const result = await base.run(input, ctx)
			const abs = resolve(cwd, input.path)
			const dir = dirname(abs)
			const rel = relative(cwd, dir)
			// The directory holding cwd's own AGENTS.md is cwd itself; that file is
			// already in the system prompt and does not belong here too.
			if (rel === "" || rel === "..") return result
			if (isAbsolute(rel) || rel.startsWith(`..${sep}`)) return result
			if (seen.has(dir)) return result
			const body = await readIfExists(join(dir, "AGENTS.md"))
			if (!body) return result
			seen.add(dir)
			await record?.({ kind: "subtree_guidance", path: join(dir, "AGENTS.md"), scope: "project" })
			return `${result}\n\n[Note: ${dir}/AGENTS.md applies here]\n${body.trim()}`
		},
	}
}

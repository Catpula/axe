import type { CustomAgent } from "../core/agents.ts"
import type { SubagentRole } from "../core/subagent.ts"
import type { ToolCtx, ToolDef } from "../providers/types.ts"

export type Spawn = (
	prompt: string,
	role: SubagentRole,
	ctx: ToolCtx,
) => Promise<string>

/**
 * The seventh tool, and the only one that is not a thin wrapper over the file
 * system. It earns its place because what it adds is a second context window:
 * a search that would cost the main thread twenty file reads costs it one
 * paragraph instead. Nothing else in the tool set can buy that.
 *
 * It is marked read-only because a subagent can only read. That also means a
 * subagent could hold this tool, so the caller must build the sub-registry from
 * a fresh core tool set rather than from its own.
 */
export function taskTool(spawn: Spawn, custom: CustomAgent[] = []): ToolDef {
	const roles = ["search", "oracle", ...custom.map((a) => a.name)]
	const extra = custom.map((a) => ` Role "${a.name}": ${a.description}`).join("")
	return {
		name: "task",
		description:
			"Delegate a self-contained question to a subagent with its own context. Only the subagent's final report comes back; its file reads and tool output never enter this conversation. Use role \"search\" to find something in a codebase you would otherwise have to read your way through, and role \"oracle\" to get a slower, more careful second opinion on a bug or a design you are stuck on. The subagent cannot edit files, cannot ask you anything, and cannot see this conversation, so put everything it needs in the prompt." +
			extra,
		readOnly: true,
		schema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"The full task. State the question, the paths worth starting from, and what the report should contain.",
				},
				role: {
					type: "string",
					enum: roles,
					description: 'Defaults to "search".',
				},
			},
			required: ["prompt"],
		},
		async run(input: { prompt?: string; role?: string }, ctx) {
			const prompt = (input.prompt ?? "").trim()
			if (!prompt) throw new Error("task: prompt is required.")
			const role = input.role ?? "search"
			if (!roles.includes(role)) {
				throw new Error(`task: unknown role ${role}. Use one of ${roles.join(", ")}.`)
			}
			return spawn(prompt, role, ctx)
		},
	}
}

/**
 * A copyable plugin. Move this directory to `.axe/plugins/notes/` in a project,
 * or to `~/.axe/plugins/notes/` to have it everywhere.
 *
 * A plugin exports tools. That is the whole contract. It runs with your full
 * privileges, in the same process as axe, so treat installing one exactly like
 * running a script from the same directory.
 */
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"

type Ctx = { cwd: string; signal: AbortSignal; log: (s: string) => void }

const FILE = "NOTES.md"

export default {
	name: "notes",
	tools: [
		{
			name: "note_read",
			description: "Read the project's NOTES.md scratch file.",
			// Read-only tools may run in parallel and are safe for subagents.
			// Only claim it if it is true.
			readOnly: true,
			schema: { type: "object", properties: {} },
			async run(_input: unknown, ctx: Ctx) {
				try {
					return await readFile(join(ctx.cwd, FILE), "utf8")
				} catch {
					return `No ${FILE} yet.`
				}
			},
		},
		{
			name: "note_add",
			description: "Append a line to the project's NOTES.md scratch file.",
			readOnly: false,
			schema: {
				type: "object",
				properties: {
					text: { type: "string", description: "The line to append." },
				},
				required: ["text"],
			},
			async run(input: { text?: string }, ctx: Ctx) {
				const text = (input.text ?? "").trim()
				// Throwing is the way to fail. The loop turns it into a tool error
				// the model can read and recover from; it never crashes the turn.
				if (!text) throw new Error("note_add: text is required.")
				await appendFile(join(ctx.cwd, FILE), `- ${text}\n`)
				return `Added to ${FILE}.`
			},
		},
	],
}

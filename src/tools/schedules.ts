import { addSchedule, loadSchedules, removeSchedule } from "../core/schedules.ts"
import type { ToolDef } from "../providers/types.ts"

const ACTIONS = ["add", "list", "cancel"]

/**
 * How the agent asks to be woken later.
 *
 * A schedule defaults to this thread, so the wake-up is a continuation rather
 * than a new conversation: the saved prompt arrives on top of the transcript
 * that asked for it. That is the whole feature, and it is why the tool needs
 * the session's thread id rather than being a plain export.
 */
export function scheduleTool(threadId: () => string, cwd: string): ToolDef {
	return {
		name: "schedule",
		description:
			'Ask to be woken later with a prompt, in this same thread and with this history. Use it when work has to wait on something outside this turn: a build that takes an hour, a deploy to check on tomorrow, a daily report. Actions: "add" (needs when and prompt), "list", "cancel" (needs id). Do not use it to defer work you could do now, and do not use it to poll something you can simply wait for inside one turn.',
		readOnly: false,
		schema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ACTIONS, description: 'Defaults to "list".' },
				when: {
					type: "string",
					description:
						'A 5-field cron expression in local time, e.g. "0 9 * * 1-5", or a plain interval, e.g. "every 10m" (m, h, d).',
				},
				prompt: {
					type: "string",
					description:
						"What to send when it fires. Write it for a future reader who has the transcript but not this moment's train of thought.",
				},
				id: { type: "string", description: 'The schedule to cancel, from "list".' },
			},
			required: [],
		},
		async run(input: { action?: string; when?: string; prompt?: string; id?: string }) {
			const action = input.action ?? "list"
			// `enum` in a schema is documentation the model may ignore; validateInput
			// only enforces `required` and `type`.
			if (!ACTIONS.includes(action)) {
				throw new Error(`schedule: unknown action ${action}. Use one of ${ACTIONS.join(", ")}.`)
			}
			if (action === "add") {
				if (!input.when?.trim()) throw new Error("schedule: when is required to add one.")
				if (!input.prompt?.trim()) throw new Error("schedule: prompt is required to add one.")
				const s = await addSchedule({
					when: input.when.trim(),
					prompt: input.prompt.trim(),
					cwd,
					threadId: threadId(),
				})
				return `Scheduled ${s.id}: ${s.when}. It will resume this thread.`
			}
			if (action === "cancel") {
				if (!input.id?.trim()) throw new Error("schedule: id is required to cancel one.")
				return (await removeSchedule(input.id.trim()))
					? `Cancelled ${input.id.trim()}.`
					: `No schedule ${input.id.trim()}.`
			}
			const list = await loadSchedules()
			if (!list.length) return "No schedules."
			return list
				.map((s) => `${s.id}  ${s.when}  ${s.threadId === threadId() ? "this thread" : s.threadId}  ${s.prompt}`)
				.join("\n")
		},
	}
}

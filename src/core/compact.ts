import type { Block, Message, Provider, Usage } from "../providers/types.ts"
import { addUsage, emptyUsage } from "../providers/types.ts"

export type CompactionConfig = {
	provider: Provider
	model: string
	maxTokens: number
	/** Fraction of the context window that triggers compaction. */
	at: number
	/** Messages at the tail that are never summarised. */
	keepTail: number
}

const SUMMARY_PROMPT = `You are compacting a coding session transcript so the agent can keep working with a smaller context.

Write a summary using these sections, omitting any that do not apply:

## Task
What the user asked for, in their own terms. Include the exact file paths, identifiers, and constraints they gave.

## What was done
Changes actually made, file by file. Use exact file and symbol names.

## What was learned
Facts about the codebase discovered by reading it: layout, conventions, how the build and tests are run, gotchas. These are expensive to rediscover.

## Current state
What works, what is broken, and what was verified by running a command versus only assumed.

## Next step
The immediate next action, plus anything the user already rejected.

Rules:
- Preserve exact strings: paths, symbols, commands, error messages. Do not paraphrase them.
- Do not reproduce tool output. State the conclusion drawn from it.
- Do not invent progress. If something was attempted and failed, say so.
- No preamble. Start with the first heading.`

const MAX_TOOL_RESULT_CHARS = 2_000

/**
 * A tail may never begin with a tool_result whose tool_use was left behind in
 * the summarised half: the next request would be rejected. Every point where no
 * call is still open is safe, which matters because one turn of sixty tool
 * calls contains no plain user turn at all, and demanding one there means never
 * compacting until the provider refuses the request. Search forward from the
 * desired point first, then backward, so we always land on a boundary.
 */
export function splitIndex(messages: Message[], keepTail: number): number {
	const safe = safePoints(messages)
	const desired = Math.max(0, messages.length - keepTail)
	let i = desired
	while (i < messages.length && !safe[i]) i++
	if (i < messages.length) return i
	i = desired
	while (i > 0 && !safe[i]) i--
	return i
}

/** safe[i] is true when nothing in messages[0..i) is waiting for a result. */
function safePoints(messages: Message[]): boolean[] {
	const open = new Set<string>()
	const safe: boolean[] = []
	for (const m of messages) {
		safe.push(open.size === 0)
		for (const b of m.content) {
			if (b.type === "tool_use") open.add(b.id)
			if (b.type === "tool_result") open.delete(b.id)
		}
	}
	return safe
}

function renderBlock(b: Block): string {
	switch (b.type) {
		case "text":
			return b.text
		case "thinking":
			return ""
		case "tool_use":
			return `[tool ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 500)}]`
		case "tool_result": {
			const body =
				b.content.length > MAX_TOOL_RESULT_CHARS
					? `${b.content.slice(0, MAX_TOOL_RESULT_CHARS)}\n[...truncated]`
					: b.content
			return `[result${b.isError ? " error" : ""}]\n${body}`
		}
		case "image":
			return "[image]"
	}
}

function renderTranscript(messages: Message[]): string {
	return messages
		.map((m) => {
			const body = m.content.map(renderBlock).filter(Boolean).join("\n")
			return body ? `<${m.role}>\n${body}\n</${m.role}>` : ""
		})
		.filter(Boolean)
		.join("\n\n")
}

async function summarize(
	cfg: CompactionConfig,
	head: Message[],
	signal: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
	let text = ""
	let usage = emptyUsage()
	for await (const ev of cfg.provider.stream({
		system: SUMMARY_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: renderTranscript(head) }] }],
		tools: [],
		model: cfg.model,
		maxTokens: cfg.maxTokens,
		signal,
	})) {
		if (ev.type === "done") {
			text = ev.message.content
				.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("")
			usage = addUsage(usage, ev.usage)
		}
	}
	return { text, usage }
}

export type CompactionResult = {
	/** Null when there was nothing safe to summarise, or the summary came back empty. */
	messages: Message[] | null
	summary: string
	dropped: number
	/** Writing the summary costs tokens. Unbilled, the cost limit lies. */
	usage: Usage
}

/**
 * Summarises everything before a safe split point and keeps the tail verbatim.
 * A null `messages` means "no compaction happened": the caller must carry on
 * rather than fail the turn, and must still bill the usage.
 */
export async function compactMessages(
	cfg: CompactionConfig,
	messages: Message[],
	signal: AbortSignal,
): Promise<CompactionResult> {
	const at = splitIndex(messages, cfg.keepTail)
	if (at <= 0) return { messages: null, summary: "", dropped: 0, usage: emptyUsage() }
	const head = messages.slice(0, at)
	const tail = messages.slice(at)

	const { text, usage } = await summarize(cfg, head, signal)
	const summary = text.trim()
	if (!summary) return { messages: null, summary: "", dropped: 0, usage }

	const bridge: Message[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `The earlier part of this session was compacted. Treat this summary as fact.\n\n<session_summary>\n${summary}\n</session_summary>`,
				},
			],
		},
	]
	// A cut inside a long turn leaves an assistant message at the head of the
	// tail, and the acknowledgement would then be the second assistant message
	// in a row. It exists to keep the roles alternating, so it only belongs in
	// front of a tail that opens with a user turn.
	if (tail[0]!.role === "user") {
		bridge.push({
			role: "assistant",
			content: [{ type: "text", text: "Understood. Continuing from the summary." }],
		})
	}

	return { messages: [...bridge, ...tail], summary, dropped: head.length, usage }
}

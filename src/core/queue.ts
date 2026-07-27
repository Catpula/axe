/**
 * Input typed while a turn is running.
 *
 * The loop drains this at each step boundary, which is the only point where a
 * new user message can be inserted without breaking the tool_use/tool_result
 * pairing. Nothing here talks to the terminal: the CLI decides what counts as
 * queued input.
 */
export class InputQueue {
	private items: string[] = []

	push(text: string): void {
		const t = text.trim()
		if (t) this.items.push(t)
	}

	get size(): number {
		return this.items.length
	}

	/** Returns everything pending as one block, or null when nothing is queued. */
	drain(): string | null {
		if (this.items.length === 0) return null
		const out = this.items.join("\n")
		this.items = []
		return out
	}
}

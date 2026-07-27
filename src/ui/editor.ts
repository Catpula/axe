/**
 * The line editor: a buffer, a cursor, and the key-to-edit mapping. Pure — it
 * never draws and never reads stdin, so every binding here is checked by
 * calling `handle` rather than by driving a terminal.
 */
import { segment } from "./cells.ts"
import type { Key } from "./keys.ts"

export type EditorEvent =
	| { type: "none" }
	| { type: "submit"; line: string }
	| { type: "interrupt" }
	| { type: "abort" }
	| { type: "eof" }
	| { type: "redraw" }
	| { type: "palette" }

function previousBoundary(text: string, cursor: number): number {
	let previous = 0
	for (const part of segment(text)) {
		if (part.index >= cursor) break
		previous = part.index
	}
	return previous
}

function nextBoundary(text: string, cursor: number): number {
	for (const part of segment(text)) {
		if (part.index > cursor) return part.index
	}
	return text.length
}

/**
 * Where Ctrl+W cuts back to: the word before the cursor and the whitespace in
 * front of it, so killing a word twice does not leave a trail of spaces.
 */
export function killWordStart(text: string, cursor: number): number {
	const head = text.slice(0, cursor)
	const trimmed = head.replace(/\s+$/u, "")
	// Standing on whitespace, that whitespace and the word before it go, and the
	// space in front of them stays: Ctrl+W after a space is otherwise a dead key,
	// and eating both spaces would weld the two surrounding words together.
	if (trimmed.length < head.length) return trimmed.replace(/\S+$/u, "").length
	return head.replace(/\s*\S+$/u, "").length
}

/**
 * Where Alt+B lands: the first character of the word before the cursor. That is
 * one character to the left of the kill boundary, and the difference is visible
 * every time someone moves back a word to fix a typo at its start.
 */
export function wordLeft(text: string, cursor: number): number {
	return text.slice(0, cursor).replace(/\s+$/u, "").replace(/\S+$/u, "").length
}

/** Where Alt+F lands: the end of the word after the cursor. */
export function wordRight(text: string, cursor: number): number {
	const match = /^\s*\S+/u.exec(text.slice(cursor))
	return match ? cursor + match[0].length : text.length
}

/** Line editing and history. No terminal, no side effects, fully testable. */
export class Editor {
	buffer = ""
	cursor = 0
	private readonly history: string[] = []
	private index = -1
	private draft = ""
	private lastEscape = 0
	/** What the last kill removed, so Ctrl+Y can put it back. */
	private killed = ""
	private readonly doubleEscapeMs: number

	constructor(doubleEscapeMs = 500) {
		this.doubleEscapeMs = doubleEscapeMs
	}

	private kill(from: number, to: number): void {
		const cut = this.buffer.slice(from, to)
		if (!cut) return
		this.killed = cut
		this.buffer = this.buffer.slice(0, from) + this.buffer.slice(to)
		this.cursor = from
		this.index = -1
		this.draft = ""
	}

	private insert(text: string): void {
		this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)
		this.cursor += text.length
		this.index = -1
		this.draft = ""
	}

	/** Replaces the line wholesale, as a completion does. Leaves history alone. */
	setLine(buffer: string, cursor: number): void {
		this.buffer = buffer
		this.cursor = Math.max(0, Math.min(cursor, buffer.length))
		this.index = -1
		this.draft = ""
	}

	/**
	 * Replaces the whole buffer, cursor at the end. Used when the buffer was
	 * composed somewhere else, which today means $EDITOR.
	 */
	setBuffer(text: string): void {
		this.setLine(text, text.length)
	}

	handle(key: Key, now: number = Date.now()): EditorEvent {
		if (key.name !== "escape") this.lastEscape = 0
		switch (key.name) {
			case "char":
				this.insert(key.text ?? "")
				return { type: "none" }
			case "paste":
				// Newlines are kept. A pasted block is one prompt, not one turn per
				// line, so this never submits however many lines it carries.
				this.insert(key.text ?? "")
				return { type: "none" }
			case "newline":
				this.insert("\n")
				return { type: "none" }
			case "backspace":
				if (this.cursor > 0) {
					const previous = previousBoundary(this.buffer, this.cursor)
					this.buffer = this.buffer.slice(0, previous) + this.buffer.slice(this.cursor)
					this.cursor = previous
					this.index = -1
					this.draft = ""
				}
				return { type: "none" }
			case "delete": {
				const next = nextBoundary(this.buffer, this.cursor)
				this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(next)
				this.index = -1
				this.draft = ""
				return { type: "none" }
			}
			case "kill-line":
				this.kill(0, this.cursor)
				return { type: "none" }
			case "kill-tail":
				this.kill(this.cursor, this.buffer.length)
				return { type: "none" }
			case "kill-word":
				this.kill(killWordStart(this.buffer, this.cursor), this.cursor)
				return { type: "none" }
			case "yank":
				if (this.killed) this.insert(this.killed)
				return { type: "none" }
			case "left":
				if (this.cursor > 0) this.cursor = previousBoundary(this.buffer, this.cursor)
				return { type: "none" }
			case "right":
				if (this.cursor < this.buffer.length) this.cursor = nextBoundary(this.buffer, this.cursor)
				return { type: "none" }
			case "word-left":
				this.cursor = wordLeft(this.buffer, this.cursor)
				return { type: "none" }
			case "word-right":
				this.cursor = wordRight(this.buffer, this.cursor)
				return { type: "none" }
			case "home":
				this.cursor = 0
				return { type: "none" }
			case "end":
				this.cursor = this.buffer.length
				return { type: "none" }
			case "up":
				if (this.history.length) {
					if (this.index < 0) this.draft = this.buffer
					this.index = this.index < 0 ? this.history.length - 1 : Math.max(0, this.index - 1)
					this.buffer = this.history[this.index] ?? ""
					this.cursor = this.buffer.length
				}
				return { type: "none" }
			case "down":
				if (this.index >= 0) {
					this.index++
					if (this.index >= this.history.length) {
						this.index = -1
						this.buffer = this.draft
						this.draft = ""
					} else {
						this.buffer = this.history[this.index] ?? ""
					}
					this.cursor = this.buffer.length
				}
				return { type: "none" }
			case "enter": {
				const line = this.buffer.trim()
				this.buffer = ""
				this.cursor = 0
				this.index = -1
				this.draft = ""
				if (line && this.history[this.history.length - 1] !== line) this.history.push(line)
				return { type: "submit", line }
			}
			case "escape": {
				// Esc Esc aborts. A single Esc does nothing, because a stray escape
				// byte from a terminal should never cancel a turn.
				if (this.lastEscape && now - this.lastEscape <= this.doubleEscapeMs) {
					this.lastEscape = 0
					return { type: "abort" }
				}
				this.lastEscape = now
				return { type: "none" }
			}
			case "interrupt":
				return { type: "interrupt" }
			case "eof":
				// Only an empty line exits, as in every shell. With text in the
				// buffer it is the forward delete it is everywhere else.
				if (!this.buffer) return { type: "eof" }
				return this.handle({ name: "delete" }, now)
			case "redraw":
				return { type: "redraw" }
			case "palette":
				return { type: "palette" }
			default:
				return { type: "none" }
		}
	}
}
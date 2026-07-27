/**
 * stdin, decoded. Escape sequences, bracketed paste, and the key names the
 * editor switches on — no terminal writes, no state beyond what a split chunk
 * forces `Decoder` to hold.
 *
 * Its own file because AGENTS.md asks for exactly this: escape codes can only
 * be verified by looking at them, but decoding them is a pure function, and
 * that is where the bugs live. `tui-test` calls everything here directly.
 */
import { StringDecoder } from "node:string_decoder"

/** Bracketed paste. Without it every pasted newline reads as Enter. */
export const PASTE_ON = "\x1b[?2004h"
export const PASTE_OFF = "\x1b[?2004l"
const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"

/**
 * A paste that never closes must not swallow the session's input forever, so a
 * pending payload past this size is handed over as-is.
 */
const MAX_PENDING_PASTE = 1 << 20

export type Key = {
	name:
		| "char"
		| "paste"
		| "enter"
		| "newline"
		| "backspace"
		| "delete"
		| "left"
		| "right"
		| "word-left"
		| "word-right"
		| "up"
		| "down"
		| "home"
		| "end"
		| "page-up"
		| "page-down"
		| "escape"
		| "interrupt"
		| "eof"
		| "kill-line"
		| "kill-tail"
		| "kill-word"
		| "yank"
		| "tab"
		| "redraw"
		| "palette"
		| "paste-image"
		| "external-editor"
		| "unknown"
	text?: string
}

const CSI_FINAL: Record<string, Key["name"]> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
}

const CSI_TILDE: Record<string, Key["name"]> = {
	"1": "home",
	"3": "delete",
	"4": "end",
	"5": "page-up",
	"6": "page-down",
	"7": "home",
	"8": "end",
}

/**
 * Names one CSI sequence from its parameters and its final byte.
 *
 * The parameter half is what makes Ctrl+Left different from Left: terminals
 * encode the modifier as `1;<1+bitmask>`, bit 1 shift, bit 2 alt, bit 4 ctrl.
 * Either of alt or ctrl on a horizontal arrow means word motion, which is what
 * every other line editor does with those keys. Pure, so the tests can drive it.
 */
export function csiKey(params: string, final: string): Key["name"] {
	const fields = params.split(";")
	// Modern terminals use CSI u; xterm's modifyOtherKeys uses CSI ~. Both
	// preserve Shift+Enter as distinct from Enter, which gives the composer a
	// newline without changing the send key.
	if (
		(final === "u" && fields[0] === "13" && fields[1] === "2") ||
		(final === "~" && fields[0] === "27" && fields[1] === "2" && fields[2] === "13")
	) return "newline"
	const modifier = Math.max(0, (Number(fields[1]) || 1) - 1)
	const wordwise = (modifier & 0b110) !== 0
	if (final === "~") return CSI_TILDE[fields[0] ?? ""] ?? "unknown"
	const name = CSI_FINAL[final]
	if (!name) return "unknown"
	if (wordwise && name === "left") return "word-left"
	if (wordwise && name === "right") return "word-right"
	return name
}

/** Alt+key, sent as an escape prefix. Only the motions worth having are claimed. */
const META: Record<string, Key["name"]> = {
	b: "word-left",
	B: "word-left",
	f: "word-right",
	F: "word-right",
	"\x7f": "kill-word",
	"\b": "kill-word",
}

/**
 * Decodes a raw-mode chunk into keys, returning whatever could not be decoded
 * yet. The only thing ever held back is an unterminated paste: its payload can
 * be any size and arrives across several stdin chunks, and a paste cut in half
 * would otherwise decode as keystrokes. Pure, so the tests can drive it.
 */
export function decodeChunk(chunk: string): { keys: Key[]; rest: string } {
	const keys: Key[] = []
	for (let i = 0; i < chunk.length; i++) {
		const c = chunk[i]!
		if (c === "\x1b") {
			if (chunk.startsWith(PASTE_START, i)) {
				const from = i + PASTE_START.length
				const end = chunk.indexOf(PASTE_END, from)
				if (end === -1) return { keys, rest: chunk.slice(i) }
				keys.push({ name: "paste", text: chunk.slice(from, end) })
				i = end + PASTE_END.length - 1
				continue
			}
			const next = chunk[i + 1]
			if (next === "[" || next === "O") {
				let j = i + 2
				while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j]!)) j++
				// An arrow key split across two stdin chunks would otherwise decode
				// as an escape and a bracket, which reads as Esc plus a typed "[".
				if (j >= chunk.length) return { keys, rest: chunk.slice(i) }
				keys.push({ name: csiKey(chunk.slice(i + 2, j), chunk[j]!) })
				i = j
				continue
			}
			// Esc Esc must stay two escapes, so a second escape is never a meta key.
			if (next !== undefined && next !== "\x1b" && META[next]) {
				keys.push({ name: META[next]! })
				i++
				continue
			}
			keys.push({ name: "escape" })
			continue
		}
		if (c === "\r" || c === "\n") keys.push({ name: "enter" })
		else if (c === "\x7f" || c === "\b") keys.push({ name: "backspace" })
		else if (c === "\x03") keys.push({ name: "interrupt" })
		else if (c === "\x04") keys.push({ name: "eof" })
		else if (c === "\x0f") keys.push({ name: "palette" })
		else if (c === "\x15") keys.push({ name: "kill-line" })
		else if (c === "\x0b") keys.push({ name: "kill-tail" })
		else if (c === "\x17") keys.push({ name: "kill-word" })
		else if (c === "\x19") keys.push({ name: "yank" })
		else if (c === "\x16") keys.push({ name: "paste-image" })
		else if (c === "\x18") keys.push({ name: "external-editor" })
		else if (c === "\t") keys.push({ name: "tab" })
		else if (c === "\x01") keys.push({ name: "home" })
		else if (c === "\x05") keys.push({ name: "end" })
		else if (c === "\x02") keys.push({ name: "left" })
		else if (c === "\x06") keys.push({ name: "right" })
		else if (c === "\x10") keys.push({ name: "up" })
		else if (c === "\x0e") keys.push({ name: "down" })
		else if (c === "\x0c") keys.push({ name: "redraw" })
		else if (c >= " ") {
			const point = chunk.codePointAt(i)
			if (point === undefined) continue
			const text = String.fromCodePoint(point)
			keys.push({ name: "char", text })
			i += text.length - 1
		}
	}
	return { keys, rest: "" }
}

/** Decodes a self-contained chunk. An unterminated paste yields no keys. */
export function decode(chunk: string): Key[] {
	return decodeChunk(chunk).keys
}

/** Carries an unterminated paste from one stdin chunk to the next. */
export class Decoder {
	private rest = ""
	private readonly utf8 = new StringDecoder("utf8")

	push(chunk: Buffer | string): Key[] {
		const text = typeof chunk === "string" ? chunk : this.utf8.write(chunk)
		const { keys, rest } = decodeChunk(this.rest + text)
		// Only a paste can be held back at any size. An unterminated escape
		// sequence is a few bytes; treating one as a paste payload would type it.
		if (rest.startsWith(PASTE_START) && rest.length > MAX_PENDING_PASTE) {
			this.rest = ""
			keys.push({ name: "paste", text: rest.slice(PASTE_START.length) })
			return keys
		}
		this.rest = rest
		return keys
	}
}
/**
 * Characters that occupy no cell and reorder or hide the ones around them:
 * bidi marks, embeddings, overrides and isolates, zero-width spaces and
 * joiners, and the byte order mark. They are not control bytes, so a terminal
 * renders them happily, which is the problem: a line of code carrying them
 * reads as one thing and executes as another.
 */
function deceptive(point: number): boolean {
	return (
		point === 0x061c ||
		point === 0xfeff ||
		(point >= 0x200b && point <= 0x200f) ||
		(point >= 0x202a && point <= 0x202e) ||
		(point >= 0x2060 && point <= 0x2064) ||
		(point >= 0x2066 && point <= 0x2069)
	)
}

/**
 * Makes untrusted text inert before it is written to an interactive terminal.
 *
 * Model output, tool previews, plugin notices, and pasted input can all contain
 * control bytes. Writing those bytes verbatim would let content move the
 * cursor, clear the screen, or change terminal modes. Newlines remain layout;
 * tabs become stable indentation; every other control is made visible, and so
 * is anything invisible that would make the text lie about its own bytes.
 */
export function safeTerminalText(text: string): string {
	let out = ""
	for (const ch of text) {
		const point = ch.codePointAt(0)!
		if (ch === "\n") out += ch
		else if (ch === "\t") out += "    "
		else if (point < 0x20) out += String.fromCodePoint(0x2400 + point)
		else if (point === 0x7f) out += "\u2421"
		else if (point >= 0x80 && point <= 0x9f) out += `\\x${point.toString(16).padStart(2, "0")}`
		else if (deceptive(point)) out += `\\u${point.toString(16).padStart(4, "0")}`
		else out += ch
	}
	return out
}

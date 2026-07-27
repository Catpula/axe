/**
 * Terminal-cell arithmetic. Split out of the renderer so that anything which
 * needs to fit text into a row can have it without importing the renderer, and
 * so the renderer and the activity panel do not import each other.
 */

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function segment(text: string): Intl.Segments {
	return graphemes.segment(text)
}

/**
 * Control bytes pasted from a log must not reach the terminal as escapes, so
 * every one of them becomes a printable glyph of the same width.
 */
export function visibleInput(s: string): string {
	let out = ""
	for (const ch of s) {
		const point = ch.codePointAt(0)!
		if (ch === "\n") out += "⏎"
		else if (ch === "\r") out += "␍"
		else if (ch === "\t") out += "⇥"
		else if (point < 0x20) out += String.fromCodePoint(0x2400 + point)
		else if (point === 0x7f) out += "␡"
		else if (point >= 0x80 && point <= 0x9f) out += `\\x${point.toString(16).padStart(2, "0")}`
		else out += ch
	}
	return out
}

function isWide(point: number): boolean {
	return (
		point >= 0x1100 &&
		(point <= 0x115f ||
			point === 0x2329 ||
			point === 0x232a ||
			(point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
			(point >= 0xac00 && point <= 0xd7a3) ||
			(point >= 0xf900 && point <= 0xfaff) ||
			(point >= 0xfe10 && point <= 0xfe19) ||
			(point >= 0xfe30 && point <= 0xfe6f) ||
			(point >= 0xff00 && point <= 0xff60) ||
			(point >= 0xffe0 && point <= 0xffe6) ||
			(point >= 0x1f1e6 && point <= 0x1f1ff) ||
			(point >= 0x1f300 && point <= 0x1faff) ||
			(point >= 0x20000 && point <= 0x3fffd))
	)
}

/** Terminal-cell width, by grapheme rather than UTF-16 code unit. */
export function displayWidth(text: string): number {
	let width = 0
	for (const part of graphemes.segment(text)) {
		const point = part.segment.codePointAt(0)!
		if (/^[\p{Mark}\p{Format}]+$/u.test(part.segment)) continue
		width += /\p{Extended_Pictographic}/u.test(part.segment) || isWide(point) ? 2 : 1
	}
	return width
}

/** Clamps and pads to exactly `width` cells, never splitting a grapheme. */
export function fitCells(text: string, width: number): string {
	let fitted = ""
	let used = 0
	for (const part of graphemes.segment(visibleInput(text))) {
		const next = displayWidth(part.segment)
		if (used + next > width) break
		fitted += part.segment
		used += next
	}
	return fitted + " ".repeat(Math.max(0, width - used))
}

/**
 * Puts `right` against the right edge when there is room for it, and drops it
 * rather than the title when there is not.
 */
export function padBetween(left: string, right: string, width: number): string {
	const room = width - displayWidth(left) - displayWidth(right)
	return fitCells(right && room >= 1 ? `${left}${" ".repeat(room)}${right}` : left, width)
}

/** Compact elapsed time for a one-row indicator. */
export function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds))
	if (total < 60) return `${total}s`
	if (total < 3_600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
	return `${Math.floor(total / 3_600)}h ${String(Math.floor((total % 3_600) / 60)).padStart(2, "0")}m ${String(total % 60).padStart(2, "0")}s`
}

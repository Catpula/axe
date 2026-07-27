/**
 * Small streaming Markdown renderer for the terminal.
 *
 * This is deliberately not a CommonMark parser. It covers the structures a
 * coding agent emits most often while preserving the source as readable text
 * when syntax is incomplete. Tables are the one construct buffered across
 * lines, because their column widths cannot be known from a single row.
 */

import { BOLD, CYAN, DIM, ITALIC, RESET, UNDERLINE } from "./color.ts"
import { highlightCode } from "./syntax.ts"
import { safeTerminalText } from "./terminal.ts"

type Align = "left" | "center" | "right"
type Measure = (text: string) => number

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** One marker per nesting level, so a sublist is distinguishable at a glance. */
const BULLETS = ["•", "◦", "▪"]

/** Two spaces per level is the common convention; four is the other one. */
function nestDepth(indent: string): number {
	const width = indent.replace(/\t/g, "  ").length
	return Math.min(BULLETS.length - 1, Math.floor(width / 2))
}

function tableCells(line: string): string[] | null {
	const trimmed = line.trim()
	if (!trimmed.includes("|")) return null
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "")
	const cells: string[] = []
	let cell = ""
	let escaped = false
	let code = false
	for (const ch of inner) {
		if (escaped) {
			cell += ch
			escaped = false
			continue
		}
		if (ch === "\\") {
			escaped = true
			cell += ch
			continue
		}
		if (ch === "`") code = !code
		if (ch === "|" && !code) {
			cells.push(cell.trim())
			cell = ""
		} else {
			cell += ch
		}
	}
	cells.push(cell.trim())
	return cells.length > 1 ? cells : null
}

function tableAlignments(line: string, columns: number): Align[] | null {
	const cells = tableCells(line)
	if (!cells || cells.length !== columns) return null
	const out: Align[] = []
	for (const cell of cells) {
		if (!/^:?-{3,}:?$/.test(cell.replace(/\s/g, ""))) return null
		const left = cell.trim().startsWith(":")
		const right = cell.trim().endsWith(":")
		out.push(left && right ? "center" : right ? "right" : "left")
	}
	return out
}

function plainInline(text: string): string {
	return safeTerminalText(text)
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/\\([\\`*_[\]{}()#+.!|>-])/g, "$1")
}

/** ANSI styling for the inline Markdown used most often in model responses. */
export function renderInlineMarkdown(text: string): string {
	const code: string[] = []
	let out = safeTerminalText(text).replace(/`([^`]+)`/g, (_, body: string) => {
		const token = `\u0000${code.length}\u0000`
		code.push(`${CYAN}${body}${RESET}`)
		return token
	})
	out = out
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${RESET}${DIM} ($2)${RESET}`)
		// <https://…> is the one link form with nothing to label it, so the URL
		// is the text; the angle brackets are markup and go.
		.replace(/<((?:https?|mailto):[^>\s]+)>/g, `${UNDERLINE}$1${RESET}`)
		.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
		.replace(/__([^_]+)__/g, `${BOLD}$1${RESET}`)
		.replace(/~~([^~]+)~~/g, `${DIM}$1${RESET}`)
		.replace(/\*([^*]+)\*/g, `${ITALIC}$1${RESET}`)
		.replace(/\\([\\`*_[\]{}()#+.!|>-])/g, "$1")
	return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)] ?? "")
}

function wrapCell(text: string, width: number, measure: Measure): string[] {
	const parts = [...graphemes.segment(text)].map((part) => ({
		text: part.segment,
		width: measure(part.segment),
		space: /^\s+$/u.test(part.segment),
	}))
	const out: string[] = []
	let from = 0
	while (from < parts.length) {
		while (parts[from]?.space) from++
		if (from >= parts.length) break
		let used = 0
		let end = from
		let wordCut = -1
		while (end < parts.length && used + parts[end]!.width <= width) {
			used += parts[end]!.width
			if (parts[end]!.space) wordCut = end
			end++
		}
		if (end === parts.length) {
			out.push(parts.slice(from).map((part) => part.text).join("").trimEnd())
			break
		}
		const cut = wordCut > from ? wordCut : Math.max(from + 1, end)
		out.push(parts.slice(from, cut).map((part) => part.text).join("").trimEnd())
		from = cut
	}
	return out.length ? out : [""]
}

/** Hard-wraps code without eating indentation or aligning it like prose. */
function wrapLiteral(text: string, width: number, measure: Measure): string[] {
	const out: string[] = []
	let line = ""
	let used = 0
	for (const part of graphemes.segment(text)) {
		const next = measure(part.segment)
		if (line && used + next > width) {
			out.push(line)
			line = ""
			used = 0
		}
		line += part.segment
		used += next
	}
	out.push(line)
	return out
}

function alignCell(text: string, width: number, align: Align, measure: Measure): string {
	const room = Math.max(0, width - measure(text))
	if (align === "right") return `${" ".repeat(room)}${text}`
	if (align === "center") {
		const left = Math.floor(room / 2)
		return `${" ".repeat(left)}${text}${" ".repeat(room - left)}`
	}
	return `${text}${" ".repeat(room)}`
}

/** Renders a complete Markdown table no wider than the current terminal. */
export function renderMarkdownTable(
	header: string[],
	rows: string[][],
	alignments: Align[],
	columns: number,
	measure: Measure,
): string[] {
	const count = header.length
	if (!count) return []
	const clean = [header, ...rows].map((row) =>
		Array.from({ length: count }, (_, i) => plainInline(row[i] ?? "")),
	)
	const minWidths = Array.from({ length: count }, (_, i) =>
		Math.max(1, ...clean.flatMap((row) =>
			[...graphemes.segment(row[i] ?? "")].map((part) => measure(part.segment)),
		)),
	)
	if (columns < count * 3 + 1 + minWidths.reduce((sum, width) => sum + width, 0)) {
		const records = clean.slice(1)
		if (!records.length) return wrapCell(clean[0]!.join(" | "), Math.max(1, columns), measure)
		return records.flatMap((record, rowIndex) => [
			...(rowIndex ? [`${DIM}${"─".repeat(Math.max(1, columns))}${RESET}`] : []),
			...record.flatMap((cell, i) =>
				wrapCell(`${clean[0]![i]}: ${cell}`, Math.max(1, columns), measure),
			),
		])
	}
	const widths = Array.from({ length: count }, (_, i) =>
		Math.max(minWidths[i]!, ...clean.map((row) => measure(row[i] ?? ""))),
	)
	const available = Math.max(count, columns - (count * 3 + 1))
	while (widths.reduce((sum, width) => sum + width, 0) > available) {
		let widest = -1
		for (let i = 0; i < widths.length; i++) {
			if (widths[i]! <= minWidths[i]!) continue
			if (widest === -1 || widths[i]! > widths[widest]!) widest = i
		}
		if (widest === -1) break
		widths[widest] = widths[widest]! - 1
	}

	const border = (left: string, middle: string, right: string, fill: string) =>
		`${left}${widths.map((width) => fill.repeat(width + 2)).join(middle)}${right}`
	const row = (cells: string[], headerRow = false) => {
		const wrapped = cells.map((cell, i) => wrapCell(cell, widths[i]!, measure))
		const height = Math.max(...wrapped.map((cell) => cell.length))
		return Array.from({ length: height }, (_, line) => {
			const body = wrapped.map((cell, i) => {
				const fitted = alignCell(cell[line] ?? "", widths[i]!, alignments[i] ?? "left", measure)
				return headerRow ? `${BOLD}${fitted}${RESET}` : fitted
			})
			return `│ ${body.join(" │ ")} │`
		})
	}

	return [
		border("┌", "┬", "┐", "─"),
		...row(clean[0]!, true),
		border("├", "┼", "┤", "─"),
		...clean.slice(1).flatMap((cells) => row(cells)),
		border("└", "┴", "┘", "─"),
	]
}

/** Incrementally formats assistant text while retaining at most one table. */
export class MarkdownRenderer {
	private pending = ""
	private candidate: string | null = null
	private table: { header: string[]; rows: string[][]; alignments: Align[] } | null = null
	/** The open fence, so that ``` inside a ~~~ block stays content. */
	private fence: { char: string; length: number; indent: number; lang: string } | null = null
	private indented = false
	/** Whether an indented block may start here: only after a blank, never under a list. */
	private blankBefore = true
	private listBefore = false
	private readonly measure: Measure

	constructor(measure: Measure) {
		this.measure = measure
	}

	private get inCode(): boolean {
		return this.fence !== null || this.indented
	}

	private codeLines(text: string, columns: number, lang = ""): string[] {
		// Highlighting runs after the wrap: the wrap measures raw text, and the
		// highlighter only ever adds SGR runs, so the widths still agree.
		return wrapLiteral(text, Math.max(1, columns - 2), this.measure).map(
			(part) => `${DIM}│${RESET} ${highlightCode(part, lang)}`,
		)
	}

	private regular(line: string, columns: number): string[] {
		// A fence closes only on its own marker, so a ``` example inside a ~~~
		// block is content rather than the end of the block.
		const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/)
		if (this.fence) {
			const open = this.fence
			if (
				fence &&
				fence[2]![0] === open.char &&
				fence[2]!.length >= open.length &&
				!fence[3]
			) {
				const indent = " ".repeat(open.indent)
				this.fence = null
				return [`${indent}${DIM}└─${RESET}`]
			}
			const body = line.slice(Math.min(open.indent, line.length - line.trimStart().length))
			return this.codeLines(body, Math.max(1, columns - open.indent), open.lang).map(
				(row) => `${" ".repeat(open.indent)}${row}`,
			)
		}
		if (fence) {
			this.fence = { char: fence[2]![0]!, length: fence[2]!.length, indent: fence[1]!.length, lang: fence[3] ?? "" }
			return [`${fence[1]}${DIM}┌─${fence[3] ? ` ${fence[3]}` : ""}${RESET}`]
		}

		// Four spaces after a blank line is a code block, but the same indentation
		// under a list is a continuation paragraph, so the list guard comes first.
		if (this.indented) {
			if (!line.trim()) return [`${DIM}│${RESET}`]
			if (/^\s{4,}/.test(line)) return this.codeLines(line.slice(4), columns)
			this.indented = false
		} else if (this.blankBefore && !this.listBefore && /^\s{4,}\S/.test(line)) {
			this.indented = true
			return this.codeLines(line.slice(4), columns)
		}

		const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/)
		// Every level used to render identically, which flattened the outline of a
		// long answer into one undifferentiated pile of bold cyan. Depth is carried
		// by weight and hue rather than by an extra rule line, so one source line
		// still leaves as one rendered line and the renderer stays streaming.
		if (heading) {
			const depth = heading[1]!.length
			const style = depth === 1 ? `${BOLD}${CYAN}${UNDERLINE}` : depth === 2 ? `${BOLD}${CYAN}` : BOLD
			return [`${style}${renderInlineMarkdown(heading[2]!)}${RESET}`]
		}
		if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return [`${DIM}────────────────${RESET}`]

		// One bar per level, so a reply quoted inside a quote is visibly deeper.
		const quote = line.match(/^(\s*)((?:>\s?)+)(.*)$/)
		if (quote) {
			const depth = (quote[2]!.match(/>/g) ?? []).length
			const bars = `${DIM}${"│".repeat(depth).split("").join(" ")}${RESET}`
			return [`${quote[1]}${bars} ${renderInlineMarkdown(quote[3]!)}`]
		}
		const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/)
		if (task) return [`${task[1]}${task[2]!.toLowerCase() === "x" ? "☑" : "☐"} ${renderInlineMarkdown(task[3]!)}`]
		const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
		if (bullet) return [`${bullet[1]}${BULLETS[nestDepth(bullet[1]!)]} ${renderInlineMarkdown(bullet[2]!)}`]
		const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/)
		if (ordered) return [`${ordered[1]}${BOLD}${ordered[2]}${RESET} ${renderInlineMarkdown(ordered[3]!)}`]
		return [renderInlineMarkdown(line)]
	}

	private finishTable(columns: number): string[] {
		if (!this.table) return []
		const { header, rows, alignments } = this.table
		this.table = null
		return renderMarkdownTable(header, rows, alignments, columns, this.measure)
	}

	private line(line: string, columns: number): string[] {
		line = safeTerminalText(line)
		// Two trailing spaces are a hard break, and the break is all they are:
		// keeping them would only pad the line they end.
		if (!this.inCode) line = line.replace(/[ \t]+$/, "")
		if (this.table) {
			const cells = tableCells(line)
			if (cells && cells.length === this.table.header.length) {
				this.table.rows.push(cells)
				return []
			}
			return [...this.finishTable(columns), ...this.line(line, columns)]
		}

		if (this.candidate !== null) {
			const header = tableCells(this.candidate)!
			const alignments = tableAlignments(line, header.length)
			if (alignments) {
				this.table = { header, rows: [], alignments }
				this.candidate = null
				return []
			}
			const previous = this.candidate
			this.candidate = null
			return [...this.regular(previous, columns), ...this.line(line, columns)]
		}

		if (!this.inCode && tableCells(line)) {
			this.candidate = line
			return []
		}
		const out = this.regular(line, columns)
		// Recorded after the line is classified, because whether an indented
		// block may open depends on what came before it, not on this line.
		if (!this.inCode) {
			this.blankBefore = !line.trim()
			if (line.trim()) this.listBefore = /^\s*(?:[-*+]|\d+[.)])\s/.test(line)
		}
		return out
	}

	private render(lines: string[]): string {
		return lines.map((line) => `${line}\n`).join("")
	}

	push(chunk: string, columns: number): string {
		this.pending += chunk
		const out: string[] = []
		let newline = this.pending.indexOf("\n")
		while (newline !== -1) {
			out.push(...this.line(this.pending.slice(0, newline).replace(/\r$/, ""), columns))
			this.pending = this.pending.slice(newline + 1)
			newline = this.pending.indexOf("\n")
		}
		return this.render(out)
	}

	flush(columns: number): string {
		const out: string[] = []
		if (this.pending) out.push(...this.line(this.pending, columns))
		this.pending = ""
		if (this.candidate !== null) {
			out.push(...this.regular(this.candidate, columns))
			this.candidate = null
		}
		out.push(...this.finishTable(columns))
		// An unterminated fence still gets its closing rule: the text ended, and
		// leaving the block visually open would read as more output to come.
		if (this.inCode) {
			out.push(`${" ".repeat(this.fence?.indent ?? 0)}${DIM}└─${RESET}`)
		}
		this.fence = null
		this.indented = false
		return this.render(out)
	}
}

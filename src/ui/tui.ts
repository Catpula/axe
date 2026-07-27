import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { stdin, stdout } from "node:process"
import { readClipboardImage } from "../clipboard.ts"
import type { UI } from "../core/loop.ts"
import type { ApprovalDecision } from "../core/tools.ts"
import type { ToolDisplay } from "../providers/types.ts"
import {
	type Activity,
	type ActivityStart,
	ActivityTracker,
	activityRow,
	formatDuration,
	spinnerFrame,
} from "./activity.ts"
import { displayWidth, fitCells, formatElapsed, padBetween, segment, visibleInput } from "./cells.ts"
import {
	BOLD,
	BRIGHT_BLUE,
	CYAN,
	DIM,
	GREEN,
	MAGENTA,
	RED,
	RESET,
	REVERSE,
	YELLOW,
} from "./color.ts"
import { Editor, killWordStart, wordLeft, wordRight, type EditorEvent } from "./editor.ts"
import { Decoder, PASTE_OFF, PASTE_ON, csiKey, decode, decodeChunk, type Key } from "./keys.ts"
import {
	applyMention,
	fuzzyScore,
	matchFiles,
	mentionAt,
	quotePath,
	type Mention,
} from "./complete.ts"
import { moveIndex, scrollOffset } from "./list.ts"
import { MarkdownRenderer } from "./markdown.ts"
import { runEditor, type EditResult } from "./external-editor.ts"
import { safeTerminalText } from "./terminal.ts"

export { displayWidth, fitCells, formatElapsed } from "./cells.ts"
export { Decoder, csiKey, decode, decodeChunk, type Key } from "./keys.ts"
export { Editor, killWordStart, wordLeft, wordRight, type EditorEvent } from "./editor.ts"

/**
 * A terminal UI with no dependencies and no full-screen takeover.
 *
 * The problem it solves is narrow: streamed output and a live prompt cannot
 * share one cursor. The fix is a DECSTBM scroll region over the top of the
 * screen, with the bottom rows held back for the status bar and the composer.
 * Output scrolls above; typing stays put below. Scrollback survives,
 * because the alternate screen buffer would throw away the transcript the user
 * came for.
 *
 * Everything here that can be tested without a terminal (key decoding, line
 * editing, history, fuzzy matching, palette selection) is a pure function or a
 * plain class. The rest is escape codes, and escape codes are verified by
 * looking at them.
 */

/**
 * Colour by what a tool does, not by which tool it is. Reading is cheap and
 * reversible, writing is neither, and running a command is neither plus it can
 * reach the network. Someone scanning a transcript should be able to find the
 * writes without reading the names.
 */
const TOOL_COLOR: Record<string, string> = {
	read_file: CYAN,
	glob: CYAN,
	grep: CYAN,
	web_fetch: CYAN,
	write_file: YELLOW,
	edit_file: YELLOW,
	bash: MAGENTA,
	task: BRIGHT_BLUE,
}

/** A subagent row is a delegation whatever its role is called. */
export function toolColor(name: string, kind: "tool" | "agent" = "tool"): string {
	if (kind === "agent") return BRIGHT_BLUE
	return TOOL_COLOR[name] ?? DIM
}

/**
 * Reads the owning agent out of an activity id.
 *
 * A subagent's calls arrive as `<agent row id>/<provider tool id>`, because a
 * provider id is only unique within one conversation and two subagents can
 * hand up the same one. Splitting it back out is also how the panel knows to
 * indent the row, and how the transcript knows to stay quiet about it.
 */
export function parentOf(id: string): string | undefined {
	const cut = id.lastIndexOf("/")
	return cut > 0 ? id.slice(0, cut) : undefined
}


/**
 * The prompt is one row, and a pasted buffer can hold newlines. Drawing them
 * raw would scroll the bars off the screen, so each newline is shown as a
 * glyph. One glyph per newline, which keeps the cursor arithmetic honest.
 */
export function inlineNewlines(s: string): string {
	return s.replace(/\n/g, "\u23ce")
}

/**
 * The subject of an approval prompt, wrapped across rows.
 *
 * One row was a bug with consequences: a command longer than the terminal was
 * cut off silently, so `y` approved text nobody had read. Past `maxRows` the
 * last row says how many rows it is hiding, because a prompt that trails off
 * into an ellipsis reads as "nothing important follows".
 */
export function confirmSubjectLines(subject: string, width: number, maxRows = 5): string[] {
	const rows = Math.max(1, maxRows)
	const lines = wrap(inlineNewlines(subject) || "(no arguments)", Math.max(1, width))
	if (lines.length <= rows) return lines
	const kept = lines.slice(0, rows - 1)
	const hidden = lines.length - kept.length
	kept.push(`\u2026 +${hidden} row${hidden === 1 ? "" : "s"} not shown`)
	return kept
}

export type ComposerView = {
	lines: string[]
	row: number
	column: number
}

/**
 * Wraps a composer buffer without changing its contents and returns the cursor
 * inside the visible window. Hard wrapping is deliberate: unlike transcript
 * prose, leading spaces and the exact cursor position are editor state.
 */
export function composerView(
	buffer: string,
	cursor: number,
	width: number,
	maxRows = 5,
): ComposerView {
	const limit = Math.max(1, width)
	const rows = Math.max(1, maxRows)
	const at = Math.max(0, Math.min(cursor, buffer.length))
	const lines: string[] = [""]
	const widths: number[] = [0]
	let cursorRow = 0
	let cursorColumn = 0
	let foundCursor = false

	const nextLine = () => {
		lines.push("")
		widths.push(0)
	}
	const placeCursor = (index: number) => {
		if (foundCursor || index < at) return
		if (widths[widths.length - 1]! >= limit) nextLine()
		cursorRow = lines.length - 1
		cursorColumn = widths[widths.length - 1]!
		foundCursor = true
	}

	for (const part of segment(buffer)) {
		placeCursor(part.index)
		if (part.segment === "\n") {
			nextLine()
			continue
		}
		const text = visibleInput(part.segment)
		const cells = displayWidth(text)
		if (widths[widths.length - 1]! > 0 && widths[widths.length - 1]! + cells > limit) nextLine()
		lines[lines.length - 1] += text
		widths[widths.length - 1] = widths[widths.length - 1]! + cells
	}
	placeCursor(buffer.length)

	const from = Math.max(0, Math.min(cursorRow, lines.length - rows))
	return {
		lines: lines.slice(from, from + rows),
		row: cursorRow - from,
		column: cursorColumn,
	}
}

/**
 * Keeps command hints aligned when there is room, and prioritises the title when
 * there is not.
 *
 * `marker` owns the first cell. Selection used to be reverse video, which
 * inverts the background and so lands as a black slab on a light theme and a
 * white one on a dark theme — unpredictable in exactly the place the eye is
 * meant to rest. A glyph in the gutter plus weight reads the same everywhere,
 * and it survives NO_COLOR, where reverse video was the only cue left.
 */
export function paletteRow(
	title: string,
	hint: string | undefined,
	width: number,
	marker = " ",
): string {
	return padBetween(`${marker}${title}`, hint ? `${hint} ` : "", width)
}

type PromptPart = { to: number; text: string; width: number }

/**
 * Makes a one-row, control-safe prompt window and keeps the editing cursor in
 * view. The returned column is zero-based within text.
 */
export function promptView(buffer: string, cursor: number, width: number): { text: string; column: number } {
	const limit = Math.max(1, width)
	const parts: PromptPart[] = [...segment(buffer)].map((part) => {
		const text = visibleInput(part.segment)
		return { to: part.index + part.segment.length, text, width: displayWidth(text) }
	})
	const at = Math.max(0, Math.min(cursor, buffer.length))
	const cursorIndex = parts.findIndex((part) => part.to > at)
	const before = cursorIndex === -1 ? parts.length : cursorIndex
	const total = parts.reduce((sum, part) => sum + part.width, 0)
	const cursorWidth = parts.slice(0, before).reduce((sum, part) => sum + part.width, 0)
	if (total <= limit && cursorWidth < limit) {
		return { text: parts.map((part) => part.text).join(""), column: cursorWidth }
	}

	let start = 0
	if (cursorWidth >= limit - 1) {
		let used = 0
		start = before
		const room = Math.max(1, limit - 2)
		while (start > 0 && used + parts[start - 1]!.width <= room) {
			start--
			used += parts[start]!.width
		}
	}

	const left = start > 0
	let available = Math.max(0, limit - (left ? 1 : 0) - 1)
	let used = 0
	let end = start
	while (end < parts.length && used + parts[end]!.width <= available) {
		used += parts[end]!.width
		end++
	}
	const right = end < parts.length
	if (!right) available++
	while (end < parts.length && used + parts[end]!.width <= available) {
		used += parts[end]!.width
		end++
	}

	const text = `${left ? "\u2039" : ""}${parts.slice(start, end).map((part) => part.text).join("")}${right ? "\u203a" : ""}`
	const column = (left ? 1 : 0) + parts.slice(start, Math.min(before, end)).reduce((sum, part) => sum + part.width, 0)
	return { text, column: Math.min(column, displayWidth(text)) }
}

/**
 * The command palette, and the two ways in.
 *
 * Ctrl+O opens it, and so does typing `/` on an empty prompt — the muscle
 * memory slash menus built, without the second command language: the palette
 * runs entries without editing the prompt, and Esc leaves the prompt as it was.
 *
 * The palette is a UI affordance only. Nothing here is visible to the model,
 * and no palette entry may do something the user could not do by typing.
 */
export type PaletteItem = {
	id: string
	title: string
	hint?: string
	group?: string
	run: () => void | Promise<void>
}

export class Palette {
	open = false
	query = ""
	index = 0
	/** When set, only items with this group are shown. */
	groupFilter: string | null = null
	private items: PaletteItem[] = []

	/**
	 * Replaces the list, keeping the selection on the same command.
	 *
	 * The caller rebuilds this on a timer so the hints stay true, and `index` is a
	 * position rather than an identity. Without the re-anchor a list that grew or
	 * reordered while the palette was open moved a different command under the
	 * cursor, and Enter ran it.
	 */
	setItems(items: PaletteItem[]): void {
		const selected = this.open ? this.selected()?.id : undefined
		this.items = items
		if (selected === undefined) return
		const at = this.matches().findIndex((item) => item.id === selected)
		this.index = at === -1 ? 0 : at
	}

	show(group?: string): void {
		this.open = true
		this.query = ""
		this.index = 0
		this.groupFilter = group ?? null
	}

	hide(): void {
		this.open = false
		this.query = ""
		this.index = 0
		this.groupFilter = null
	}

	matches(): PaletteItem[] {
		let filtered = this.items
		if (this.groupFilter) {
			filtered = filtered.filter((item) => item.group === this.groupFilter)
		} else {
			filtered = filtered.filter((item) => !item.group)
		}
		if (!this.query.trim()) return filtered
		return filtered
			.map((item) => ({ item, score: fuzzyScore(this.query, `${item.title} ${item.hint ?? ""}`) }))
			.filter((x) => x.score >= 0)
			.sort((a, b) => a.score - b.score)
			.map((x) => x.item)
	}

	selected(): PaletteItem | null {
		return this.matches()[this.index] ?? null
	}

	move(delta: number): void {
		this.index = moveIndex(this.index, delta, this.matches().length)
	}

	/** Home and End jump the list rather than the query, which is one row long. */
	first(): void {
		this.index = 0
	}

	last(): void {
		this.index = Math.max(0, this.matches().length - 1)
	}

	type(text: string): void {
		this.query += text
		this.index = 0
	}

	backspace(): void {
		this.query = this.query.slice(0, -1)
		this.index = 0
	}

	killWord(): void {
		this.query = this.query.replace(/\s*\S+$/u, "")
		this.index = 0
	}

	clear(): void {
		this.query = ""
		this.index = 0
	}
}

/** Wraps output by terminal cells, ignoring ANSI escapes and keeping graphemes whole. */
export function wrap(text: string, width: number): string[] {
	if (width < 4) return [text]
	type Part = { text: string; width: number; space: boolean }
	const parts: Part[] = []
	const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/y
	let at = 0
	while (at < text.length) {
		ansi.lastIndex = at
		const escape = ansi.exec(text)
		if (escape) {
			parts.push({ text: escape[0], width: 0, space: false })
			at += escape[0].length
			continue
		}
		const nextEscape = text.indexOf("\x1b", at + 1)
		const end = nextEscape === -1 ? text.length : nextEscape
		for (const part of segment(text.slice(at, end))) {
			parts.push({
				text: part.segment,
				width: displayWidth(part.segment),
				space: /^\s+$/u.test(part.segment),
			})
		}
		at = end
	}

	const out: string[] = []
	let from = 0
	while (parts.slice(from).reduce((sum, part) => sum + part.width, 0) > width) {
		let used = 0
		let hardCut = from
		let wordCut = -1
		for (let i = from; i < parts.length; i++) {
			const part = parts[i]!
			if (part.width === 0) {
				hardCut = i + 1
				continue
			}
			if (used + part.width > width) {
				if (part.space && used > 0) wordCut = i
				break
			}
			if (part.space && used > 0) wordCut = i
			used += part.width
			hardCut = i + 1
		}
		const cut = wordCut >= from ? wordCut : hardCut
		out.push(parts.slice(from, cut).map((part) => part.text).join(""))
		from = cut
		while (parts[from]?.space) from++
	}
	out.push(parts.slice(from).map((part) => part.text).join(""))
	return out
}

/** The one field per tool that says what the call was actually about. */
const SUBJECT = ["path", "cmd", "pattern", "url", "prompt", "old_str"]

/**
 * A transcript of seven identical `read_file` lines says nothing. The argument
 * is what makes a tool call readable, so one field of it is shown next to the
 * name, clamped short enough that a pasted file never takes the row.
 */
export function toolSummary(input: unknown, width = 48): string {
	if (!input || typeof input !== "object") return ""
	const bag = input as Record<string, unknown>
	const key = SUBJECT.find((k) => typeof bag[k] === "string" && bag[k] !== "")
	if (!key) return ""
	let value = (bag[key] as string).replace(/\s+/g, " ").trim()
	// Tool calls often use absolute workspace paths. They add no information in
	// a transcript and force every read onto two lines, so display them relative
	// while leaving paths outside the workspace untouched.
	if (key === "path" && isAbsolute(value)) {
		const local = relative(process.cwd(), value)
		if (local && local !== ".." && !local.startsWith(`..${sep}`)) value = local
	}
	if (value.length <= width) return value
	return `${value.slice(0, width - 1)}…`
}

function displayPath(path: string): string {
	if (!isAbsolute(path)) return path
	const local = relative(process.cwd(), path)
	return local && local !== ".." && !local.startsWith(`..${sep}`) ? local : path
}

/** Compact UI projection of metadata that is deliberately absent from tool_result. */
export function toolDisplaySummary(display: ToolDisplay | undefined): string {
	if (!display) return ""
	const parts: string[] = []
	if (display.path) parts.push(displayPath(display.path))
	if (display.additions !== undefined) parts.push(`+${display.additions}`)
	if (display.deletions !== undefined) parts.push(`−${display.deletions}`)
	if (display.exitCode !== undefined) parts.push(`exit ${display.exitCode}`)
	if (display.summary) parts.push(display.summary)
	return parts.join(" ")
}

/**
 * What the turn is spending its time on. The distinction is worth a word
 * because the two wait very differently: a model call is one long silence, and
 * a tool phase is several short ones that the panel is already itemising.
 */
export type Phase = "model" | "tools"

/** Keeps progress and its interrupt affordance ahead of lower-priority metadata. */
export function workingStatus(
	base: string,
	seconds: number,
	frame: number,
	phase: Phase = "model",
	running = 0,
	queued = 0,
): string {
	const what = phase === "tools" ? (running > 1 ? `Running ${running} tools` : "Running") : "Thinking"
	const waiting = queued > 0 ? ` · ${queued} queued` : ""
	return `${spinnerFrame(frame)} ${what} ${formatElapsed(seconds)}${waiting} · Ctrl+C · ${base}`
}

/**
 * Colours the one field on the status bar that asks for a reaction.
 *
 * The bar is a single dim run of five fields joined by `·`, which is fine for
 * four of them and wrong for the fifth: a context window at 94% is the only
 * number there that changes what the user should do next, and dim grey is how
 * you say "ignore me". Applied after `fitCells`, because that runs
 * `visibleInput` and would turn an escape into a `␛` glyph.
 *
 * The trailing `DIM` re-opens the run that `RESET` had to close, so the fields
 * after it stay dim rather than inheriting the terminal's default weight.
 */
export function highlightStatus(bar: string): string {
	return bar.replace(/ctx (\d+)%/, (whole, digits: string) => {
		const percent = Number(digits)
		if (percent < 80) return whole
		return `${RESET}${percent >= 90 ? RED : YELLOW}${whole}${RESET}${DIM}`
	})
}

export type Tui = {
	ui: UI
	onLine: (fn: (line: string) => void) => void
	onInterrupt: (fn: () => void) => void
	onAbort: (fn: () => void) => void
	setStatus: (s: string) => void
	setWorking: (working: boolean) => void
	setCommands: (items: PaletteItem[]) => void
	/**
	 * Blocks the prompt until the user answers. Denies if the session ends first,
	 * because a question nobody answered is not consent.
	 */
	confirm: (request: ConfirmRequest) => Promise<ApprovalDecision>
	/**
	 * Writes the clipboard image to a temp file and inserts its path, exactly as
	 * Ctrl+V does. Exposed because most terminals keep Ctrl+V for their own paste,
	 * which left the feature unreachable in the ones that do.
	 */
	pasteImage: () => Promise<void>
	/** Adds a row to the activity panel. Ends with `activityEnd` on the same id. */
	activityStart: (a: ActivityStart) => void
	activityEnd: (id: string, ok: boolean) => void
	close: () => void
	/** Resolves when the user leaves: Ctrl+D, or close() from anywhere. */
	closed: Promise<void>
}

export type ConfirmRequest = {
	id: string
	tool: string
	subject: string
	cwd: string
	rule?: string
	reason?: string
}

const PALETTE_ROWS = 7
const MENTION_ROWS = 6
const ACTIVITY_ROWS = 6
const COMPOSER_ROWS = 5
/** Rows an approval prompt may spend on the thing being approved. */
const CONFIRM_SUBJECT_ROWS = 5
/** How long Esc stays armed on the status bar. Matches the editor's own window. */
const ESCAPE_HINT_MS = 500
/**
 * How long an idle Ctrl+C stays armed to exit. Longer than the abort hint,
 * because leaving is a bigger decision than cancelling a turn and a stray
 * repeat should not make it.
 */
const EXIT_HINT_MS = 2_000

/** How stale a file list may be before `@` reloads it. */
const FILES_TTL_MS = 5_000

export type TuiOptions = {
	/**
	 * Paths offered by `@`, newest first. Absent means no file completion, which
	 * is what a caller with no workspace wants.
	 */
	files?: () => Promise<string[]>
	/** Live input count, read while drawing so draining at a step boundary is immediate. */
	queued?: () => number
}

type TranscriptCell =
	| { type: "assistant"; source: string }
	| { type: "stream"; text: string; owner: number }
	| { type: "tool" | "notice" | "line"; text: string }

function renderTranscriptCell(cell: TranscriptCell, columns: number): string[] {
	if (cell.type !== "assistant") return wrap(cell.text, columns)
	const renderer = new MarkdownRenderer(displayWidth)
	const rendered = renderer.push(cell.source, columns) + renderer.flush(columns)
	return rendered
		.split("\n")
		.slice(0, -1)
		.flatMap((line) => wrap(line, columns))
}

export function makeTui(status: string, opts: TuiOptions = {}): Tui {
	let statusText = status
	let pending = ""
	let pendingOwner: number | undefined
	let pendingKind: "tool" | "notice" | "line" = "line"
	/** True while the last thing written was a thinking delta with no newline yet. */
	let thinkingOpen = false
	let done = false
	/** True while $EDITOR owns the terminal, so nothing here draws into it. */
	let suspended = false
	let onLine: (line: string) => void = () => {}
	let onInterrupt: () => void = () => {}
	let onAbort: () => void = () => {}
	let workingSince: number | null = null
	let workingFrame = 0
	let workingTimer: ReturnType<typeof setInterval> | null = null
	let resolveClosed: () => void = () => {}
	const closed = new Promise<void>((r) => {
		resolveClosed = r
	})
	const editor = new Editor()
	const palette = new Palette()
	const decoder = new Decoder()
	const markdown = new MarkdownRenderer(displayWidth)
	const tracker = new ActivityTracker()
	/** Recomputed once per draw, so every row of one frame agrees on the time. */
	let liveRows: Activity[] = []
	/** True between the first resize event of a drag and the reconcile that ends it. */
	let resizePending = false
	/**
	 * Recent transcript cells, newest last. Completed assistant cells keep their
	 * Markdown source, so a resize can render for the new width instead of wrapping
	 * old ANSI output. Only a screenful is worth keeping:
	 * anything above that is scrollback, which the terminal owns.
	 */
	const history: TranscriptCell[] = []
	const remember = (text: string, owner?: number, kind: "tool" | "notice" | "line" = "line") => {
		history.push(owner === undefined ? { type: kind, text } : { type: "stream", text, owner })
		if (history.length > 400) history.splice(0, history.length - 400)
	}
	let nextAssistant = 0
	let assistant: { id: number; source: string } | null = null

	type ConfirmEntry = { request: ConfirmRequest; resolve: (decision: ApprovalDecision) => void }
	// Read-only tools may request approval concurrently. One request owns the
	// keyboard while the rest wait in FIFO order.
	let confirming: ConfirmEntry | null = null
	const confirmQueue: ConfirmEntry[] = []
	const reasonEditor = new Editor()
	let enteringReason = false

	/**
	 * When the first Esc of a possible Esc Esc arrived, or 0.
	 *
	 * The editor arms the pair silently, which leaves the user with no way to know
	 * whether the key registered. This is the same window, mirrored onto the
	 * status bar, and it is display state only: the abort decision stays in the
	 * editor, which is where it can be tested.
	 */
	let escapeArmedAt = 0
	/**
	 * When an idle Ctrl+C armed the exit. Idle only: with a turn running Ctrl+C
	 * means abort and nothing else, so a session is never dropped out from under
	 * work the user is trying to stop.
	 */
	let interruptArmedAt = 0

	// The `@` picker. `mention` is non-null exactly while it is on screen, and
	// only ever with hits to show: an empty list would steal rows to say nothing.
	let mention: Mention | null = null
	let mentionHits: string[] = []
	let mentionIndex = 0
	let files: string[] = []
	let filesLoadedAt = 0
	let loadingFiles = false
	// Where a dismissed reference started. Esc means "not this one", not "never
	// again": typing a new @ elsewhere still opens the picker.
	let dismissedFrom: number | null = null

	const rows = () => stdout.rows ?? 24
	const cols = () => stdout.columns ?? 80
	const w = (s: string) => stdout.write(s)
	const at = (row: number, col: number) => `\x1b[${row};${col}H`

	let composerCache: { buffer: string; cursor: number; width: number; view: ComposerView } | null = null
	const currentComposer = () => {
		const width = Math.max(1, cols() - 2)
		if (composerCache?.buffer === editor.buffer && composerCache.cursor === editor.cursor && composerCache.width === width)
			return composerCache.view
		const view = composerView(editor.buffer, editor.cursor, width, COMPOSER_ROWS)
		composerCache = { buffer: editor.buffer, cursor: editor.cursor, width, view }
		return view
	}
	/**
	 * The subject rows of the live approval prompt, wrapped for this terminal.
	 *
	 * The height is derived from the text rather than fixed, because the whole
	 * point is that the user sees all of what they are approving. It is still
	 * capped: an approval prompt that fills the screen has stopped being a prompt.
	 */
	const confirmSubject = () => {
		if (!confirming) return []
		const room = Math.max(1, Math.min(CONFIRM_SUBJECT_ROWS, rows() - 4))
		return confirmSubjectLines(confirming.request.subject, Math.max(1, cols() - 1), room)
	}
	const baseHeight = () => confirming || palette.open ? 2 : 1 + currentComposer().lines.length
	const paletteHeight = () => Math.max(1, Math.min(PALETTE_ROWS, rows() - 4))
	const mentionHeight = () =>
		mention ? Math.max(1, Math.min(MENTION_ROWS, rows() - baseHeight() - 2, mentionHits.length)) : 0
	const activityHeight = () => Math.min(ACTIVITY_ROWS, Math.max(0, rows() - baseHeight() - 2), liveRows.length)
	/**
	 * One list owns the rows above the bars at a time. The order is by who asked
	 * for them: the palette and the `@` picker are things the user just opened,
	 * and the panel is something the agent is doing in the background.
	 */
	const listHeight = () =>
		confirming
			? 1 + confirmSubject().length
			: palette.open
			? paletteHeight()
			: mention
			? mentionHeight()
			: activityHeight()
	const reservedHeight = () => baseHeight() + listHeight()
	const regionBottom = () => Math.max(1, rows() - reservedHeight())

	/** The geometry the screen was last drawn in, so a resize event that changed nothing costs nothing. */
	let lastRows = rows()
	let lastCols = cols()
	/** Total rows currently held back for lists, status and composer. */
	let drawnHeight = 0

	const setRegion = () => w(`\x1b[1;${regionBottom()}r`)

	/**
	 * Hands rows back to the scroll region after a list shrank or closed.
	 *
	 * The clearing has to happen before `setRegion`, and by the *old* height: the
	 * rows a list has just released are still holding its last frame, and the
	 * next line of output would scroll that frame up the screen as if it were
	 * transcript.
	 */
	const resizeRegion = (before: number) => {
		const after = reservedHeight()
		if (after < before) {
			for (let row = rows() - before + 1; row <= rows() - after; row++) w(`${at(row, 1)}\x1b[2K`)
		}
		setRegion()
	}
	const reconcileRegion = () => {
		const height = reservedHeight()
		if (height === drawnHeight) return
		resizeRegion(drawnHeight)
		drawnHeight = height
	}

	const drawPalette = () => {
		const h = paletteHeight()
		const width = cols()
		const all = palette.matches()
		// Keep the selection on screen when the list is longer than the window.
		const offset = scrollOffset(palette.index, h, all.length)
		for (let i = 0; i < h; i++) {
			const item = all[offset + i]
			const row = rows() - 1 - h + i
			if (!item) {
				w(`${at(row, 1)}\x1b[2K`)
				continue
			}
			const selected = offset + i === palette.index
			const title = palette.groupFilter ? item.title : `/${item.id}`
			const label = paletteRow(title, item.hint, width, selected ? "\u203a " : "  ")
			w(`${at(row, 1)}\x1b[2K${selected ? `${BOLD}${CYAN}` : DIM}${label}${RESET}`)
		}
		const empty = all.length === 0
		const bar = fitCells(
			` ${empty ? "no match" : `${all.length} command${all.length === 1 ? "" : "s"}`} \u00b7 enter runs \u00b7 esc closes`,
			width,
		)
		w(`${at(rows() - 1, 1)}\x1b[2K${DIM}${bar}${RESET}`)
		const prompt = "\u2318 "
		const view = promptView(palette.query, palette.query.length, width - displayWidth(prompt))
		w(`${at(rows(), 1)}\x1b[2K${prompt}${view.text}`)
		w(at(rows(), displayWidth(prompt) + view.column + 1))
	}

	/** The `@` list sits above the bars and leaves the real prompt where it is. */
	const drawMention = () => {
		const h = mentionHeight()
		const width = cols()
		const offset = scrollOffset(mentionIndex, h, mentionHits.length)
		for (let i = 0; i < h; i++) {
			const path = mentionHits[offset + i]
			const row = rows() - baseHeight() - h + 1 + i
			if (path === undefined) {
				w(`${at(row, 1)}\x1b[2K`)
				continue
			}
			const selected = offset + i === mentionIndex
			// The last visible row says how many more matched, so a short list is
			// never mistaken for the whole answer.
			const hidden = mentionHits.length - offset - h
			const label = paletteRow(
				path,
				i === h - 1 && hidden > 0 ? `+${hidden}` : undefined,
				width,
				selected ? "› " : "  ",
			)
			w(`${at(row, 1)}\x1b[2K${selected ? `${BOLD}${CYAN}` : DIM}${label}${RESET}`)
		}
	}

	/**
	 * What the agent is doing, one row per concurrent thing, directly above the
	 * status bar. Rows are dim once finished so the eye lands on what is still
	 * running rather than on what already worked.
	 */
	const drawActivity = (now: number) => {
		const h = activityHeight()
		const width = cols()
		// The overflow row goes last, so it displaces a row rather than hiding
		// behind one: a panel that silently truncates is a panel that lies.
		const hidden = liveRows.length - h
		for (let i = 0; i < h; i++) {
			const row = rows() - baseHeight() - h + 1 + i
			if (hidden > 0 && i === h - 1) {
				w(`${at(row, 1)}\x1b[2K${DIM}${fitCells(`   +${hidden} more`, width)}${RESET}`)
				continue
			}
			const item = liveRows[i]!
			const running = item.endedAt === undefined
			const colour = running
				? toolColor(item.name, item.kind)
				: item.ok === false
				? RED
				: GREEN
			const text = activityRow(item, now, workingFrame, width)
			w(`${at(row, 1)}\x1b[2K${running ? colour : DIM}${text}${RESET}`)
		}
	}

	/**
	 * Draws one frame with the cursor parked.
	 *
	 * Every frame repaints several rows and walks the cursor across all of them,
	 * and the spinner makes that happen twelve times a second. Without the park
	 * the cursor is visibly dragged through the bars on any link with latency.
	 */
	const drawBars = () => {
		// While $EDITOR owns the terminal, drawing would land in its window.
		if (done || suspended) return
		// Mid-drag the region still belongs to the old geometry, so drawing now
		// puts a copy of the bars wherever the old bottom was and the next size
		// strands it. The pending reconcile draws them once, in one place.
		if (resizePending) return
		w("\x1b[?25l")
		try {
			paintBars()
		} finally {
			w("\x1b[?25h")
		}
	}

	const paintBars = () => {
		const now = Date.now()
		liveRows = tracker.live(now)
		// The panel grows and shrinks on its own as work starts and finishes, so
		// the region is reconciled here rather than at every call site that could
		// have changed it.
		reconcileRegion()
		if (confirming) {
			const width = cols()
			const request = confirming.request
			const subject = confirmSubject()
			// The question and what it is about stay on screen while the reason is
			// typed. Asking someone to justify a denial they can no longer see is how
			// a reason ends up describing the wrong call.
			const top = rows() - subject.length - 2
			const waiting = confirmQueue.length ? ` · ${confirmQueue.length} waiting` : ""
			w(`${at(top, 1)}\x1b[2K${YELLOW}${fitCells(` Allow ${request.tool}?${waiting}`, width)}${RESET}`)
			for (let i = 0; i < subject.length; i++) {
				w(`${at(top + 1 + i, 1)}\x1b[2K${fitCells(` ${subject[i]}`, width)}`)
			}
			if (enteringReason) {
				const prompt = " Deny reason: "
				const view = promptView(reasonEditor.buffer, reasonEditor.cursor, width - displayWidth(prompt))
				w(`${at(rows() - 1, 1)}\x1b[2K${YELLOW}${prompt}${RESET}${view.text}`)
				w(`${at(rows(), 1)}\x1b[2K${REVERSE}${fitCells(" Enter deny · Esc cancel reason", width)}${RESET}`)
				w(at(rows() - 1, displayWidth(prompt) + view.column + 1))
				return
			}
			const context = [request.cwd, request.rule, request.reason].filter(Boolean).join(" · ")
			w(`${at(rows() - 1, 1)}\x1b[2K${DIM}${fitCells(` ${context} · #${request.id}`, width)}${RESET}`)
			const bar = fitCells(" y allow once · n / esc deny · d add reason", width)
			w(`${at(rows(), 1)}\x1b[2K${REVERSE}${bar}${RESET}`)
			w(at(rows(), 1))
			return
		}
		if (palette.open) {
			drawPalette()
			return
		}
		if (mention) drawMention()
		else drawActivity(now)
		const width = cols()
		const running = liveRows.filter((a) => a.endedAt === undefined).length
		const status = mention
			? `${mentionHits.length} file${mentionHits.length === 1 ? "" : "s"} · tab inserts · esc closes`
			// One Esc does nothing on purpose, and silence made it read as a dead
			// key. The bar says the pair is armed for exactly as long as it is.
			: escapeArmedAt !== 0 && now - escapeArmedAt <= ESCAPE_HINT_MS
			? "Esc again to abort the turn"
			: interruptArmedAt !== 0 && now - interruptArmedAt <= EXIT_HINT_MS
			? "Ctrl+C again to exit"
			: workingSince === null
			? statusText
			: workingStatus(
					statusText,
					(now - workingSince) / 1_000,
					workingFrame,
					running > 0 ? "tools" : "model",
					running,
					opts.queued?.() ?? 0,
				)
		const view = currentComposer()
		const statusRow = rows() - view.lines.length
		const bar = highlightStatus(fitCells(` \u2500 ${status}`, width))
		w(`${at(statusRow, 1)}\x1b[2K${DIM}${bar}${RESET}`)
		const placeholder = workingSince === null ? "Message axe\u2026" : "Type to steer the running turn\u2026"
		for (let i = 0; i < view.lines.length; i++) {
			const marker = i === 0 ? `${BOLD}${CYAN}\u203a${RESET}` : `${DIM}${CYAN}\u2502${RESET}`
			const content = view.lines[i] || (i === 0 ? `${DIM}${placeholder}${RESET}` : "")
			w(`${at(statusRow + 1 + i, 1)}\x1b[2K${marker} ${content}`)
		}
		w(at(statusRow + 1 + view.row, 3 + view.column))
	}

	const redraw = () => {
		w("\x1b[r\x1b[2J\x1b[H")
		// The screen is blank, so there is nothing to clear and every height is a
		// change. -1 says exactly that to the reconcile in drawBars.
		drawnHeight = -1
		drawBars()
	}

	/** Writes into the scroll region, leaving the cursor back on the input line. */
	const emit = (
		text: string,
		owner?: number,
		kind: "tool" | "notice" | "line" = "line",
	) => {
		reconcileRegion()
		const region = regionBottom()
		if (pending && (pendingOwner !== owner || pendingKind !== kind)) {
			remember(pending, pendingOwner, pendingKind)
			w(`${at(region, 1)}\x1b[2K${pending}\n`)
			pending = ""
		}
		const parts = (pending + text).split("\n")
		pending = parts.pop() ?? ""
		for (const line of parts) {
			remember(line, owner, kind)
			for (const piece of wrap(line, cols())) {
				w(`${at(region, 1)}\x1b[2K${piece}\n`)
			}
		}
		pendingOwner = pending ? owner : undefined
		pendingKind = kind
		// A partial line is redrawn in place until its newline arrives.
		if (pending) {
			const wrapped = wrap(pending, cols())
			while (wrapped.length > 1) {
				w(`${at(region, 1)}\x1b[2K${wrapped.shift()}\n`)
			}
			pending = wrapped[0] ?? ""
			w(`${at(region, 1)}\x1b[2K${pending}`)
		}
		drawBars()
	}

	const line = (s: string, kind: "tool" | "notice" | "line" = "line") =>
		emit(pending ? `\n${s}\n` : `${s}\n`, undefined, kind)
	// Thinking deltas arrive without a trailing newline, so the reply that follows
	// would start on the same line and read as part of the reasoning.
	const endThinking = () => {
		if (!thinkingOpen) return
		thinkingOpen = false
		emit("\n")
	}
	const flushMarkdown = () => {
		const text = markdown.flush(cols())
		if (text) emit(text, assistant?.id)
	}
	const finishAssistant = (source: string) => {
		if (!assistant && !source) return
		if (!assistant) assistant = { id: ++nextAssistant, source: "" }
		const current = assistant
		flushMarkdown()
		let first = history.findIndex((cell) => cell.type === "stream" && cell.owner === current.id)
		if (first === -1) first = history.length
		for (let i = history.length - 1; i >= 0; i--) {
			const cell = history[i]!
			if (cell.type === "stream" && cell.owner === current.id) history.splice(i, 1)
		}
		history.splice(first, 0, { type: "assistant", source })
		if (history.length > 400) history.splice(0, history.length - 400)
		assistant = null
		if (source !== current.source) applyResize()
	}

	// Opening and closing a list only changes what listHeight() answers; the
	// rows and the scroll region are reconciled by the next drawBars.
	const openPalette = (group?: string) => {
		palette.show(group)
		drawBars()
	}

	const closePalette = () => {
		palette.hide()
		drawBars()
	}

	const closeMention = () => {
		if (!mention) return
		mention = null
		mentionHits = []
		mentionIndex = 0
		drawBars()
	}

	/** Reloads in the background. A stale list is better than a stalled keystroke. */
	const loadFiles = () => {
		if (!opts.files || loadingFiles || Date.now() - filesLoadedAt < FILES_TTL_MS) return
		loadingFiles = true
		void opts
			.files()
			.then((found) => {
				files = found
				filesLoadedAt = Date.now()
				loadingFiles = false
				if (!done && !palette.open) syncMention()
			})
			.catch(() => {
				loadingFiles = false
			})
	}

	function syncMention(): void {
		if (!opts.files) return
		const next = mentionAt(editor.buffer, editor.cursor)
		if (!next) {
			dismissedFrom = null
			closeMention()
			return
		}
		if (dismissedFrom === next.from) return
		dismissedFrom = null
		loadFiles()
		const hits = matchFiles(next.query, files, 50)
		if (!hits.length) {
			closeMention()
			return
		}
		const opening = mention === null
		mention = next
		mentionHits = hits
		mentionIndex = opening ? 0 : Math.min(mentionIndex, hits.length - 1)
		drawBars()
	}

	const acceptMention = () => {
		const hit = mentionHits[mentionIndex]
		if (!mention || !hit) return
		const next = applyMention(editor.buffer, editor.cursor, mention, hit)
		editor.setLine(next.buffer, next.cursor)
		closeMention()
	}

	/** True when the picker consumed the key and the editor must not see it. */
	const handleMentionKey = (key: Key): boolean => {
		switch (key.name) {
			case "up":
				mentionIndex = moveIndex(mentionIndex, -1, mentionHits.length)
				drawBars()
				return true
			case "down":
				mentionIndex = moveIndex(mentionIndex, 1, mentionHits.length)
				drawBars()
				return true
			case "tab":
			case "enter":
				acceptMention()
				return true
			case "escape":
				// Not passed to the editor, so this Esc never counts towards Esc Esc:
				// dismissing a list is not asking to abort a turn.
				dismissedFrom = mention?.from ?? null
				closeMention()
				return true
			case "interrupt":
				// Dismissed like Esc, then handed on: without the dismissal the sync
				// at the end of the key loop reopens the list and Ctrl+C looks dead.
				dismissedFrom = mention?.from ?? null
				closeMention()
				return false
			default:
				return false
		}
	}

	const ui: UI = {
		text: (s) => {
			endThinking()
			assistant ??= { id: ++nextAssistant, source: "" }
			assistant.source += s
			const text = markdown.push(s, cols())
			if (text) emit(text, assistant.id)
		},
		textDone: finishAssistant,
		thinking: (s) => {
			flushMarkdown()
			thinkingOpen = true
			emit(`${DIM}${safeTerminalText(s)}${RESET}`)
		},
		// A tool that has been announced but has no arguments yet says nothing the
		// panel will not say a moment later with its subject attached, so the
		// transcript stays quiet until the call is over.
		toolStart: () => {},
		toolRunning: (name, id, input) => {
			tracker.start({ id, kind: "tool", name, subject: toolSummary(input, 64), parent: parentOf(id) })
			drawBars()
		},
		toolEnd: (name, ok, preview, input, id, display) => {
			endThinking()
			const started = id === undefined ? undefined : tracker.get(id)?.startedAt
			if (id !== undefined) tracker.finish(id, ok)
			// A subagent's tool calls live in the panel and nowhere else. Its whole
			// purpose is to keep its file reads out of the transcript, and printing
			// them here would put them straight back in.
			if (id !== undefined && parentOf(id) !== undefined) {
				drawBars()
				return
			}
			flushMarkdown()
			const safeName = safeTerminalText(name).replace(/\n/g, "\u23ce")
			const metadata = safeTerminalText(toolDisplaySummary(display)).replace(/\n/g, "\u23ce")
			const subject = metadata || safeTerminalText(toolSummary(input)).replace(/\n/g, "\u23ce")
			const took = started === undefined ? "" : ` ${formatDuration(Date.now() - started)}`
			const head = safeTerminalText(preview.split("\n")[0] ?? "")
			const colour = toolColor(name)
			line(ok
				? `${DIM}  ${RESET}${GREEN}\u2713${RESET} ${colour}${safeName}${RESET}${subject ? `${DIM} ${subject}${RESET}` : ""}${took ? `${DIM} \u00b7${took}${RESET}` : ""}`
				: `${RED}  \u2717 ${safeName}${subject ? ` ${subject}` : ""}${head ? ` \u00b7 ${head}` : ""}${RESET}`, "tool")
		},
		notice: (s) => {
			endThinking()
			flushMarkdown()
			const text = safeTerminalText(s).replace(/\n/g, "\n  ")
			line(`${DIM}\u2022 ${text}${RESET}`, "notice")
		},
	}

	let restored = false
	const restore = () => {
		if (restored) return
		restored = true
		try {
			const height = Math.max(1, Math.min(rows(), drawnHeight > 0 ? drawnHeight : baseHeight()))
			w(`${PASTE_OFF}\x1b[r`)
			for (let i = 0; i < height; i++) w(`${at(rows() - i, 1)}\x1b[2K`)
			w(at(Math.max(1, rows() - height + 1), 1))
		} finally {
			if (stdin.isTTY) stdin.setRawMode(false)
		}
	}

	const close = () => {
		if (done) return
		endThinking()
		flushMarkdown()
		// Hand the list rows back before the scroll region is reset, or they stay
		// on screen as a frozen menu after axe exits.
		tracker.clear()
		// A close mid-drag still has to draw, or the panel it is clearing stays up.
		resizePending = false
		// A question still on screen has an execTool waiting on it. Leaving it
		// unresolved would hang the turn instead of ending it.
		denyAll()
		closeMention()
		if (palette.open) closePalette()
		else drawBars()
		done = true
		if (workingTimer) clearInterval(workingTimer)
		if (resizeTimer) clearTimeout(resizeTimer)
		if (pending) w("\n")
		// Bracketed paste is a mode set on the user's terminal, not on axe, so it
		// has to come back off on every exit path.
		stdin.off("data", onData)
		stdout.off("resize", onResize)
		process.off("exit", restore)
		restore()
		stdin.pause()
		resolveClosed()
	}

	/**
	 * Hands the terminal over whole, and takes it back whole. The scroll region,
	 * the bracketed-paste mode and the stdin listener all go together: leaving
	 * the region in place confines the editor to the top of the screen, and
	 * leaving the listener attached means axe eats the keystrokes meant for it.
	 */
	const suspend = () => {
		suspended = true
		if (pending) {
			w("\n")
			pending = ""
		}
		const before = reservedHeight()
		w(`${PASTE_OFF}\x1b[r`)
		for (let i = 0; i < before; i++) w(`${at(Math.max(1, rows() - i), 1)}\x1b[2K`)
		w(at(Math.max(1, rows() - before + 1), 1))
		stdin.off("data", onData)
		if (stdin.isTTY) stdin.setRawMode(false)
		stdin.pause()
	}

	const resume = () => {
		if (done) return
		suspended = false
		// The other program left the cursor somewhere unknown. Make enough room
		// for the restored draft before drawing, so a multiline composer cannot
		// land on its output.
		w("\n".repeat(baseHeight()))
		w(PASTE_ON)
		setRegion()
		if (stdin.isTTY) stdin.setRawMode(true)
		stdin.resume()
		stdin.on("data", onData)
		drawBars()
	}

	/**
	 * Ctrl+X: compose in $EDITOR.
	 *
	 * The composer is one row, which is a sentence. Past that the answer is not
	 * a taller composer but the editor the user already knows. What comes back
	 * replaces the buffer and is not submitted: saving a file is not the same
	 * decision as sending a turn.
	 */
	const editPrompt = () => {
		if (suspended || done) return
		const seed = editor.buffer
		suspend()
		void runEditor(seed)
			.catch((err): EditResult => ({ notice: err instanceof Error ? err.message : String(err) }))
			.then((result) => {
				if (result.text !== undefined) editor.setBuffer(result.text)
				resume()
				// After resume, so the message is drawn into a screen that exists.
				if (result.notice) ui.notice(result.notice)
			})
	}

	const handlePaletteKey = (key: Key): void => {
		switch (key.name) {
			case "escape":
			case "palette":
				closePalette()
				return
			case "interrupt":
				closePalette()
				onInterrupt()
				return
			case "redraw":
				redraw()
				return
			case "enter": {
				const item = palette.selected()
				const isSlashPicker = !palette.groupFilter
				closePalette()
				if (item) {
					if (isSlashPicker) {
						const text = safeTerminalText(`/${item.id}`).replace(/\n/g, "\n  ")
						line(`${CYAN}\u203a ${text}${RESET}`)
					}
					void item.run()
				}
				return
			}
			case "up":
				palette.move(-1)
				return
			case "down":
				palette.move(1)
				return
			case "page-up":
				palette.move(-paletteHeight())
				return
			case "page-down":
				palette.move(paletteHeight())
				return
			case "home":
				palette.first()
				return
			case "end":
				palette.last()
				return
			case "backspace":
				palette.backspace()
				return
			case "kill-word":
				palette.killWord()
				return
			case "kill-line":
			case "kill-tail":
				palette.clear()
				return
			case "char":
				palette.type(key.text ?? "")
				return
			case "paste":
				// A filter is one line. Newlines in a pasted query would match nothing.
				palette.type((key.text ?? "").replace(/\s+/g, " ").trim())
				return
			default:
				return
		}
	}

	const answer = (decision: ApprovalDecision) => {
		const pendingConfirm = confirming
		confirming = confirmQueue.shift() ?? null
		enteringReason = false
		reasonEditor.setBuffer("")
		pendingConfirm?.resolve(decision)
	}

	const denyAll = () => {
		const pendingConfirm = confirming
		confirming = null
		enteringReason = false
		reasonEditor.setBuffer("")
		pendingConfirm?.resolve({ action: "deny" })
		for (const entry of confirmQueue.splice(0)) entry.resolve({ action: "deny" })
	}

	/**
	 * No default on Enter. A prompt that took a stray keystroke
	 * as consent would be worse than no prompt at all.
	 */
	const handleConfirmKey = (key: Key): void => {
		if (enteringReason) {
			if (key.name === "escape") {
				enteringReason = false
				reasonEditor.setBuffer("")
				drawBars()
				return
			}
			if (key.name === "interrupt") {
				denyAll()
				onInterrupt()
				return
			}
			const event = reasonEditor.handle(key)
			if (event.type === "submit") answer({ action: "deny", ...(event.line ? { reason: event.line } : {}) })
			else if (event.type === "eof") close()
			else drawBars()
			return
		}
		if (key.name === "escape") {
			answer({ action: "deny" })
			return
		}
		if (key.name === "interrupt") {
			denyAll()
			onInterrupt()
			return
		}
		if (key.name === "eof") {
			close()
			return
		}
		if (key.name === "redraw") {
			redraw()
			return
		}
		if (key.name !== "char") return
		const c = (key.text ?? "").toLowerCase()
		if (c === "y") answer({ action: "allow-once" })
		else if (c === "n") answer({ action: "deny" })
		else if (c === "d") {
			enteringReason = true
			drawBars()
		}
	}

	/**
	 * Ctrl+V cannot paste pixels into a terminal, so the clipboard image is
	 * written to disk and its path inserted exactly as `@` or a typed path
	 * would be: imageBlocks() in images.ts is the only place that turns a path
	 * into an attachment, and this keeps that the single mechanism.
	 */
	const pasteImage = async () => {
		let image: Awaited<ReturnType<typeof readClipboardImage>>
		try {
			image = await readClipboardImage()
		} catch {
			image = null
		}
		if (!image) {
			ui.notice("No image found on the clipboard (needs wl-paste, xclip, or pngpaste).")
			return
		}
		const path = join(tmpdir(), `axe-paste-${randomBytes(6).toString("hex")}.png`)
		try {
			await writeFile(path, image.data)
		} catch {
			ui.notice(`Could not write clipboard image to ${path}.`)
			return
		}
		const next = `${editor.buffer.slice(0, editor.cursor)}${quotePath(path)} ${editor.buffer.slice(editor.cursor)}`
		editor.setLine(next, editor.cursor + quotePath(path).length + 1)
		syncMention()
		drawBars()
	}

	const onData = (chunk: Buffer | string) => {
		for (const key of decoder.push(chunk)) {
			if (confirming) {
				handleConfirmKey(key)
				continue
			}
			if (palette.open) {
				if (key.name === "external-editor") {
					// The palette is a filter, not a document. Ctrl+X in it means the
					// prompt underneath, so close first and hand that over.
					closePalette()
					editPrompt()
					return
				}
				handlePaletteKey(key)
				continue
			}
			if (mention && handleMentionKey(key)) continue
			// Ctrl+O opens the settings palette; `/` opens the command picker.
			if (key.name === "palette") {
				openPalette("settings")
				continue
			}
			// Typing `/` on an empty prompt opens the palette — the muscle memory
			// slash menus built, without a second command system behind it. The
			// character is never typed, so Esc leaves the prompt exactly as it
			// was; a pasted path is a paste event and sails through untouched.
			if (key.name === "char" && key.text === "/" && !editor.buffer) {
				openPalette()
				continue
			}
			if (key.name === "paste-image") {
				void pasteImage()
				continue
			}
			if (key.name === "external-editor") {
				// Returns, because the terminal now belongs to the editor and anything
				// left in this chunk was typed before that was true.
				editPrompt()
				return
			}
			const ev = editor.handle(key)
			if (ev.type === "submit") {
				if (ev.line) {
					const text = safeTerminalText(ev.line).replace(/\n/g, "\n  ")
					line(`${CYAN}\u203a ${text}${RESET}`)
					onLine(ev.line)
				}
			} else if (ev.type === "palette") {
				closeMention()
				openPalette()
			} else if (ev.type === "interrupt") {
				// Ctrl+C aborts a turn. With nothing to abort and nothing typed it used
				// to do nothing at all, which reads as a hung session, so the second one
				// leaves — the same two-press contract as every shell.
				if (workingSince === null && !editor.buffer) {
					if (interruptArmedAt !== 0 && Date.now() - interruptArmedAt <= EXIT_HINT_MS) {
						close()
						return
					}
					interruptArmedAt = Date.now()
				}
				onInterrupt()
			} else if (ev.type === "abort") {
				onAbort()
			} else if (ev.type === "redraw") {
				redraw()
			} else if (ev.type === "eof") {
				close()
				return
			}
			// Esc arms the abort pair; the status bar says so for as long as it holds.
			// Anything else disarms both hints, matching what the editor just did to
			// its own escape timer.
			if (key.name === "escape") escapeArmedAt = ev.type === "abort" ? 0 : Date.now()
			else {
				escapeArmedAt = 0
				if (key.name !== "interrupt") interruptArmedAt = 0
			}
			// Enter is consumed by the picker when it is open, so a submit here
			// always means it was already closed.
			if (ev.type !== "palette") syncMention()
		}
		drawBars()
	}
	// Dragging a window edge fires a burst of resize events; reconciling on each
	// one makes the bars flicker for the whole drag.
	let resizeTimer: ReturnType<typeof setTimeout> | null = null
	const applyResize = () => {
		// A resize strands the bars: they were drawn against the old geometry, and
		// the terminal re-wraps and shifts them like any other output, so they end
		// up somewhere in the middle of the screen reading as transcript. Working
		// out where by arithmetic cannot be made reliable — the terminal reflows on
		// its own schedule, and a stale guess either leaves a ghost row or eats a
		// line of the conversation. So the viewport is repainted from the lines we
		// know were said, which is exact by construction.
		resizePending = false
		w("\x1b[r\x1b[2J")
		drawnHeight = -1
		const bottom = regionBottom()
		setRegion()
		// Fill the region bottom-up, so the newest line lands just above the bars
		// and older ones are dropped rather than the other way round. A partial
		// line still streaming in is part of the transcript too: dropping it would
		// lose text the model has already sent.
		const painted: string[] = []
		if (pending) painted.push(...wrap(pending, cols()))
		for (let i = history.length - 1; i >= 0 && painted.length < bottom; i--) {
			const piece = renderTranscriptCell(history[i]!, cols())
			painted.unshift(...piece)
		}
		const visible = painted.slice(Math.max(0, painted.length - bottom))
		for (let i = 0; i < visible.length; i++) {
			w(`${at(bottom - visible.length + 1 + i, 1)}\x1b[2K${visible[i]}`)
		}
		w(at(bottom, 1))
		drawBars()
	}
	const onResize = () => {
		// The editor repaints itself; axe repainting under it would fight for the
		// same rows. `resume` sets the region back up from the new geometry.
		if (suspended) return
		const changed = rows() !== lastRows || cols() !== lastCols
		lastRows = rows()
		lastCols = cols()
		if (!changed) {
			setRegion()
			drawBars()
			return
		}
		resizePending = true
		if (resizeTimer) clearTimeout(resizeTimer)
		resizeTimer = setTimeout(() => {
			resizeTimer = null
			applyResize()
		}, 160)
		resizeTimer.unref?.()
	}

	// Two blank lines first, so the bars do not land on top of existing output.
	w("\n\n")
	w(PASTE_ON)
	setRegion()
	drawBars()
	process.once("exit", restore)
	if (stdin.isTTY) stdin.setRawMode(true)
	stdin.resume()
	stdin.on("data", onData)
	stdout.on("resize", onResize)

	return {
		ui,
		onLine: (fn) => {
			onLine = fn
		},
		onInterrupt: (fn) => {
			onInterrupt = fn
		},
		onAbort: (fn) => {
			onAbort = fn
		},
		setStatus: (s) => {
			if (done) return
			statusText = s
			drawBars()
		},
		setWorking: (working) => {
			if (done) return
			if (working === (workingSince !== null)) return
			if (working) {
				workingSince = Date.now()
				workingFrame = 0
				workingTimer = setInterval(() => {
					workingFrame++
					if (!done && !palette.open) drawBars()
				}, 80)
				workingTimer.unref?.()
			} else {
				if (assistant) finishAssistant(assistant.source)
				else flushMarkdown()
				workingSince = null
				if (workingTimer) clearInterval(workingTimer)
				workingTimer = null
				// The turn is over, so nothing in the panel is still running and its
				// tick marks are already in the transcript. Keeping them would leave a
				// frozen panel above an idle prompt.
				tracker.clear()
			}
			drawBars()
		},
		// Ignored while a picker is on screen. The caller refreshes on a timer to
		// keep the hints true, and the index is a position in the filtered list: a
		// rebuild that changes the item count moves the selection out from under
		// the user, so Enter runs a command they were not looking at.
		setCommands: (items) => {
			if (!palette.open) palette.setItems(items)
		},
		confirm: (request) => {
			if (done) return Promise.resolve({ action: "deny" })
			closeMention()
			if (palette.open) closePalette()
			return new Promise<ApprovalDecision>((resolve) => {
				const oneLine = (text: string) => safeTerminalText(text).replace(/\n/g, "\u23ce")
				const entry: ConfirmEntry = {
					request: {
						id: oneLine(request.id),
						tool: oneLine(request.tool),
						subject: safeTerminalText(request.subject).replace(/\s+/g, " ").slice(0, 300),
						cwd: oneLine(request.cwd),
						rule: request.rule ? oneLine(request.rule) : undefined,
						reason: request.reason ? oneLine(request.reason) : undefined,
					},
					resolve,
				}
				if (confirming) confirmQueue.push(entry)
				else confirming = entry
				drawBars()
			})
		},
		activityStart: (a) => {
			if (done) return
			tracker.start({ ...a, parent: a.parent ?? parentOf(a.id) })
			drawBars()
		},
		activityEnd: (id, ok) => {
			if (done) return
			tracker.finish(id, ok)
			drawBars()
		},
		pasteImage: () => {
			if (done || suspended) return Promise.resolve()
			return pasteImage()
		},
		close,
		closed,
	}
}

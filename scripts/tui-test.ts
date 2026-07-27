/**
 * The testable half of the TUI: key decoding, line editing, history, wrapping,
 * fuzzy matching, and palette selection. The escape codes themselves are
 * verified by looking at a terminal, which is why everything that could be
 * pulled out of the renderer was pulled out.
 */
import {
	Decoder,
	Editor,
	Palette,
	composerView,
	confirmSubjectLines,
	csiKey,
	decode,
	displayWidth,
	formatElapsed,
	highlightStatus,
	inlineNewlines,
	paletteRow,
	killWordStart,
	promptView,
	wordLeft,
	wordRight,
	wrap,
	workingStatus,
	parentOf,
	toolColor,
	toolDisplaySummary,
	toolSummary,
	type Key,
	type PaletteItem,
} from "../src/ui/tui.ts"
import {
	ActivityTracker,
	activityRow,
	formatDuration,
	LINGER_MS,
	slideBar,
} from "../src/ui/activity.ts"
import {
	applyMention,
	fuzzyScore,
	matchFiles,
	mentionAt,
	quotePath,
} from "../src/ui/complete.ts"
import { moveIndex, scrollOffset } from "../src/ui/list.ts"
import { highlightCode, highlightDiffLine } from "../src/ui/syntax.ts"
import { CYAN, DIM, GREEN, MAGENTA, RED, RESET } from "../src/ui/color.ts"
import {
	MarkdownRenderer,
	renderInlineMarkdown,
	renderMarkdownTable,
} from "../src/ui/markdown.ts"
import { safeTerminalText } from "../src/ui/terminal.ts"
import { join } from "node:path"

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

const names = (s: string) => decode(s).map((k) => k.name).join(",")

// Decoding.
check("plain text", names("hi") === "char,char")
check("text survives", decode("hi").map((k) => k.text).join("") === "hi")
check("an emoji is one key", decode("🙂").length === 1 && decode("🙂")[0]?.text === "🙂")
check("enter", names("\r") === "enter")
check("shift enter inserts a newline", names("\x1b[13;2u") === "newline")
check("xterm shift enter inserts a newline", names("\x1b[27;2;13~") === "newline")
check("backspace", names("\x7f") === "backspace")
check("ctrl c", names("\x03") === "interrupt")
check("ctrl d", names("\x04") === "eof")
check("ctrl o opens the palette", names("\x0f") === "palette")
check("arrows", names("\x1b[A\x1b[B\x1b[C\x1b[D") === "up,down,right,left")
check("ss3 arrows", names("\x1bOA\x1bOD") === "up,left")
check("delete key", names("\x1b[3~") === "delete")
check("bare escape", names("\x1b") === "escape")
check("unknown csi is swallowed whole", names("\x1b[Zx") === "unknown,char")
check("a typed line decodes in order", names("ab\r") === "char,char,enter")

// Word motion and the readline keys people reach for without thinking.
check("ctrl arrows move by word", names("\x1b[1;5C\x1b[1;5D") === "word-right,word-left")
check("alt arrows move by word", names("\x1b[1;3C") === "word-right")
check("shift arrows stay plain arrows", names("\x1b[1;2C") === "right")
check("alt b and alt f move by word", names("\x1bb\x1bf") === "word-left,word-right")
check("alt backspace kills a word", names("\x1b\x7f") === "kill-word")
check("esc esc is still two escapes", names("\x1b\x1b") === "escape,escape")
check("home and end keys", names("\x1b[H\x1b[F\x1b[1~\x1b[4~") === "home,end,home,end")
check("page keys", names("\x1b[5~\x1b[6~") === "page-up,page-down")
check("ctrl k kills to the end", names("\x0b") === "kill-tail")
check("ctrl y yanks", names("\x19") === "yank")
check("ctrl b and ctrl f move a character", names("\x02\x06") === "left,right")
check("ctrl p and ctrl n walk history", names("\x10\x0e") === "up,down")
check("csi naming is pure", csiKey("1;5", "D") === "word-left" && csiKey("", "A") === "up")
check("an unknown final byte is unknown", csiKey("1", "q") === "unknown")

// An escape sequence split across two stdin chunks is held back, or an arrow
// key arrives as Esc followed by a typed "[".
const split = new Decoder()
check("a split escape sequence is held back", split.push("\x1b[").length === 0)
check("and completes on the next chunk", split.push("A").map((k) => k.name).join(",") === "up")
const splitMod = new Decoder()
splitMod.push("\x1b[1;")
check("a split modifier is held back too", splitMod.push("5C")[0]?.name === "word-right")

// Bracketed paste. Without it every newline in a pasted block reads as Enter,
// and Enter submits, so one paste became one turn per line.
const P0 = "\x1b[200~"
const P1 = "\x1b[201~"
check("a paste is a single key", names(`${P0}a\nb${P1}`) === "paste")
check("a paste keeps its newlines", decode(`${P0}a\nb${P1}`)[0]?.text === "a\nb")
check("an empty paste is still one key", names(`${P0}${P1}`) === "paste")
check("keys around a paste still decode", names(`x${P0}y${P1}\r`) === "char,paste,enter")
check("two pastes in one chunk", names(`${P0}a${P1}${P0}b${P1}`) === "paste,paste")
check("an unterminated paste yields no keys yet", names(`${P0}a\nb`) === "")
check(
	"text that looks like an end marker does not end the paste",
	decode(`${P0}a\\x1b[201~b${P1}`)[0]?.text === "a\\x1b[201~b",
)

// A paste larger than one stdin chunk arrives in pieces.
const dec = new Decoder()
check("a split paste is held back", dec.push(`${P0}line one\nline`).length === 0)
const late = dec.push(` two${P1}\r`)
check("and completes on the next chunk", late.length === 2 && late[0]!.name === "paste")
check("with the whole payload", late[0]!.text === "line one\nline two")
check("and the keys after it", late[1]!.name === "enter")
const dec2 = new Decoder()
dec2.push("ab")
check("a decoder without a pending paste is stateless", dec2.push("\r").length === 1)
const dec3 = new Decoder()
const smile = Buffer.from("🙂")
check("split utf8 is held back", dec3.push(smile.subarray(0, 2)).length === 0)
check("split utf8 is decoded whole", dec3.push(smile.subarray(2))[0]?.text === "🙂")

// Editing.
const ed = new Editor(500)
const type = (s: string) => {
	for (const k of decode(s)) ed.handle(k)
}
type("hello world")
check("buffer fills", ed.buffer === "hello world")
ed.handle({ name: "home" })
check("home", ed.cursor === 0)
ed.handle({ name: "right" })
ed.handle({ name: "delete" })
check("delete removes forward", ed.buffer === "hllo world", ed.buffer)
ed.handle({ name: "end" })
ed.handle({ name: "backspace" })
check("backspace removes back", ed.buffer === "hllo worl", ed.buffer)
ed.handle({ name: "kill-word" })
check("kill word", ed.buffer === "hllo", ed.buffer)
ed.handle({ name: "kill-line" })
check("kill line", ed.buffer === "" && ed.cursor === 0)

// Word motion and the kill ring.
check("moving back lands on the first letter", wordLeft("one two three", 13) === 8)
check("moving back from inside a word lands on its start", wordLeft("one two", 5) === 4)
check("moving back at the beginning stays put", wordLeft("one", 0) === 0)
check("moving forward crosses the next word", wordRight("one two", 3) === 7)
check("moving forward at the end stays put", wordRight("one", 3) === 3)
check("killing a word takes the space in front of it", killWordStart("one two", 7) === 3)
check("killing after a space still removes the word", killWordStart("one two ", 8) === 4)
check("killing at the beginning removes nothing", killWordStart("one", 0) === 0)
check("killing whitespace alone removes it", killWordStart("   ", 3) === 0)

const spaced = new Editor(500)
for (const k of decode("axe update ")) spaced.handle(k)
spaced.handle({ name: "kill-word" })
check("ctrl w after a space is not a dead key", spaced.buffer === "axe ", spaced.buffer)
spaced.handle({ name: "kill-word" })
check("ctrl w again empties the line", spaced.buffer === "", spaced.buffer)

// Killing mid-line must not weld the surrounding words together.
const midline = new Editor(500)
for (const k of decode("hello there world")) midline.handle(k)
midline.handle({ name: "word-left" })
midline.handle({ name: "kill-word" })
check("kill word mid-line keeps one space", midline.buffer === "hello world", midline.buffer)

const words = new Editor(500)
for (const k of decode("alpha beta gamma")) words.handle(k)
words.handle({ name: "word-left" })
check("word left lands on the last word", words.cursor === 11, String(words.cursor))
words.handle({ name: "word-left" })
check("word left keeps going", words.cursor === 6, String(words.cursor))
words.handle({ name: "word-right" })
check("word right returns", words.cursor === 10, String(words.cursor))
words.handle({ name: "home" })
words.handle({ name: "word-left" })
check("word left at the start is not an error", words.cursor === 0)
words.handle({ name: "end" })
words.handle({ name: "word-right" })
check("word right at the end is not an error", words.cursor === words.buffer.length)

const ring = new Editor(500)
for (const k of decode("keep this tail")) ring.handle(k)
ring.handle({ name: "word-left" })
ring.handle({ name: "kill-tail" })
check("kill tail cuts from the cursor", ring.buffer === "keep this ", ring.buffer)
ring.handle({ name: "yank" })
check("yank puts it back", ring.buffer === "keep this tail", ring.buffer)
ring.handle({ name: "home" })
ring.handle({ name: "yank" })
check("yank inserts at the cursor", ring.buffer === "tailkeep this tail", ring.buffer)
ring.handle({ name: "home" })
ring.handle({ name: "kill-line" })
check("kill line from the start cuts nothing", ring.buffer === "tailkeep this tail", ring.buffer)
const emptyRing = new Editor(500)
check("yank with an empty ring does nothing", emptyRing.handle({ name: "yank" }).type === "none")
check("and types nothing", emptyRing.buffer === "")
emptyRing.handle({ name: "char", text: "x" })
emptyRing.handle({ name: "kill-word" })
emptyRing.handle({ name: "yank" })
check("ctrl w feeds the ring", emptyRing.buffer === "x", emptyRing.buffer)

// Insertion at the cursor, not at the end.
type("ac")
ed.handle({ name: "left" })
ed.handle({ name: "char", text: "b" })
check("inserts at the cursor", ed.buffer === "abc", ed.buffer)

// Cursor movement and deletion follow graphemes, not UTF-16 code units.
const unicode = new Editor()
unicode.handle({ name: "char", text: "🙂" })
unicode.handle({ name: "left" })
check("left crosses a whole emoji", unicode.cursor === 0)
unicode.handle({ name: "delete" })
check("delete removes a whole emoji", unicode.buffer === "")
unicode.handle({ name: "char", text: "e\u0301" })
unicode.handle({ name: "left" })
check("left crosses a combining grapheme", unicode.cursor === 0)
unicode.handle({ name: "right" })
unicode.handle({ name: "backspace" })
check("backspace removes a combining grapheme", unicode.buffer === "")

// Submitting and history.
const submitted = ed.handle({ name: "enter" })
check("submit returns the line", submitted.type === "submit" && submitted.line === "abc")
check("submit clears the buffer", ed.buffer === "" && ed.cursor === 0)
ed.handle({ name: "enter" })
type("second")
ed.handle({ name: "enter" })
ed.handle({ name: "up" })
check("history goes back", ed.buffer === "second", ed.buffer)
ed.handle({ name: "up" })
check("history keeps going back", ed.buffer === "abc", ed.buffer)
ed.handle({ name: "down" })
check("history comes forward", ed.buffer === "second", ed.buffer)
ed.handle({ name: "down" })
check("past the end of history is empty", ed.buffer === "", ed.buffer)
type("draft")
ed.handle({ name: "up" })
ed.handle({ name: "down" })
check("history restores the current draft", ed.buffer === "draft", ed.buffer)
ed.handle({ name: "kill-line" })
type("second")
ed.handle({ name: "enter" })
ed.handle({ name: "up" })
ed.handle({ name: "up" })
check("no consecutive duplicate in history", ed.buffer === "abc", ed.buffer)

// A paste is composed, never sent. Losing a pasted stack trace to three turns
// is the bug this pair of checks exists for.
const pasteEd = new Editor(500)
pasteEd.handle({ name: "char", text: "x" })
check("a paste does not submit", pasteEd.handle({ name: "paste", text: "a\nb" }).type === "none")
check("a paste lands in the buffer whole", pasteEd.buffer === "xa\nb", JSON.stringify(pasteEd.buffer))
check("the cursor follows the paste", pasteEd.cursor === 4)
pasteEd.handle({ name: "left" })
pasteEd.handle({ name: "paste", text: "-" })
check("a paste inserts at the cursor", pasteEd.buffer === "xa\n-b", JSON.stringify(pasteEd.buffer))
const sent = pasteEd.handle({ name: "enter" })
check("enter still submits", sent.type === "submit" && sent.line === "xa\n-b")

const multiline = new Editor()
multiline.handle({ name: "char", text: "first" })
check("shift enter does not submit", multiline.handle({ name: "newline" }).type === "none")
multiline.handle({ name: "char", text: "second" })
check("shift enter composes multiple lines", multiline.buffer === "first\nsecond", JSON.stringify(multiline.buffer))
const multilineSent = multiline.handle({ name: "enter" })
check("enter sends the multiline prompt", multilineSent.type === "submit" && multilineSent.line === "first\nsecond")

// An empty submit is not a turn.
const blank = new Editor(500).handle({ name: "enter" })
check("an empty line submits as empty", blank.type === "submit" && blank.line === "")

// The palette key reaches the editor as an event, not as text.
const pal = new Editor(500)
check("ctrl o is an event", pal.handle({ name: "palette" }).type === "palette")
check("ctrl o does not type anything", pal.buffer === "")

// Esc Esc.
const esc = new Editor(500)
const escKey: Key = { name: "escape" }
check("one escape does nothing", esc.handle(escKey, 1_000).type === "none")
check("two quick escapes abort", esc.handle(escKey, 1_200).type === "abort")
check("a slow second escape does not abort", esc.handle(escKey, 5_000).type === "none")
check("and the one after it does", esc.handle(escKey, 5_100).type === "abort")
esc.handle(escKey, 6_000)
esc.handle({ name: "char", text: "x" }, 6_050)
check("typing between escapes cancels the pair", esc.handle(escKey, 6_100).type === "none")
esc.handle(escKey, 7_000)
esc.handle({ name: "paste", text: "x" }, 7_050)
check("a paste between escapes cancels the pair", esc.handle(escKey, 7_100).type === "none")

// Ctrl+D exits only on an empty line, and is the forward delete otherwise, so
// it never drops a session out from under a half-typed prompt.
const eof = new Editor(500)
for (const k of decode("axe")) eof.handle(k)
eof.handle({ name: "home" })
check("ctrl d with a buffer does not exit", eof.handle({ name: "eof" }).type === "none")
check("ctrl d deletes forward instead", eof.buffer === "xe", eof.buffer)
eof.handle({ name: "end" })
check("ctrl d at the end of a line does nothing", eof.handle({ name: "eof" }).type === "none")
check("and keeps the buffer", eof.buffer === "xe", eof.buffer)
eof.handle({ name: "kill-line" })
check("ctrl d on an empty line exits", eof.handle({ name: "eof" }).type === "eof")

// Fuzzy matching.
check("an exact prefix scores best", fuzzyScore("cost", "Cost so far") < fuzzyScore("cost", "Compact the transcript"))
check("a miss is -1", fuzzyScore("zzz", "Show cost") === -1)
check("an empty query matches everything", fuzzyScore("", "anything") === 0)
check("case does not matter", fuzzyScore("COST", "cost") === fuzzyScore("cost", "cost"))
check("spaces in the query are ignored", fuzzyScore("e u", "Effort: ultra") >= 0)
check("order matters", fuzzyScore("tsoc", "cost") === -1)

// `@` file references. A typing aid: what it leaves behind is a path the user
// could have typed, so the model sees nothing new and no tool is involved.
check("at the start of a line opens a reference", mentionAt("@cli", 4)?.query === "cli")
check("after a space opens a reference", mentionAt("look at @src/cl", 15)?.query === "src/cl")
check("a bare @ is a reference with an empty query", mentionAt("@", 1)?.query === "")
check("an email address is not a reference", mentionAt("me@example.com", 14) === null)
check("a handle mid-word is not a reference", mentionAt("x@y", 3) === null)
check("a space ends the reference", mentionAt("@src/cli.ts and then", 20) === null)
check("no @ is not a reference", mentionAt("plain text", 10) === null)
check("the reference is the one under the cursor", mentionAt("@one @two", 9)?.query === "two")
check("text after the cursor is ignored", mentionAt("@cl rest", 3)?.query === "cl")
check("the reference remembers where it starts", mentionAt("read @src", 9)?.from === 5)

const paths = [
	"src/cli.ts",
	"src/ui/tui.ts",
	"src/ui/complete.ts",
	"src/core/loop.ts",
	"scripts/tui-test.ts",
	"README.md",
]
check("an empty query offers everything in order", matchFiles("", paths, 3).join(",") === "src/cli.ts,src/ui/tui.ts,src/ui/complete.ts")
check("a basename hit beats a path hit", matchFiles("cli", paths)[0] === "src/cli.ts", matchFiles("cli", paths).join(","))
check("a directory-only match still appears", matchFiles("uicomp", paths)[0] === "src/ui/complete.ts", matchFiles("uicomp", paths).join(","))
check("a miss returns nothing", matchFiles("zzzz", paths).length === 0)
check("the limit is honoured", matchFiles("t", paths, 2).length === 2)
check("matching is case-insensitive", matchFiles("README", paths)[0] === "README.md")

const withMention = applyMention("look at @src/cl", 15, { from: 8, query: "src/cl" }, "src/cli.ts")
check("accepting replaces the query", withMention.buffer === "look at src/cli.ts ", withMention.buffer)
check("accepting leaves a trailing space", withMention.cursor === withMention.buffer.length)
// The picker offers files whose names contain spaces, so it has to write one
// the prompt can carry: unquoted, "with space.ts" reads as two words.
check("an ordinary path is left alone", quotePath("src/cli.ts") === "src/cli.ts")
check("a path with a space is quoted", quotePath("with space.ts") === '"with space.ts"')
check("a quote inside a path is escaped", quotePath('a "b".ts') === '"a \\"b\\".ts"')
check("a backslash is escaped", quotePath("a b\\c.ts") === '"a b\\\\c.ts"')
const spacedMention = applyMention("read @wi", 8, { from: 5, query: "wi" }, "with space.ts")
check("accepting a spaced path quotes it", spacedMention.buffer === 'read "with space.ts" ', spacedMention.buffer)
check("the cursor still lands after it", spacedMention.cursor === spacedMention.buffer.length)

const midLine = applyMention("@cl and more", 3, { from: 0, query: "cl" }, "src/cli.ts")
check("accepting keeps the rest of the line", midLine.buffer === "src/cli.ts  and more", midLine.buffer)
check("the cursor lands after the inserted path", midLine.cursor === 11, String(midLine.cursor))

// Shared list arithmetic: every picker wraps and scrolls the same way.
check("the selection wraps forward", moveIndex(2, 1, 3) === 0)
check("the selection wraps backward", moveIndex(0, -1, 3) === 2)
check("an empty list pins at zero", moveIndex(0, 1, 0) === 0)
check("scrolling keeps the selection visible", scrollOffset(5, 3, 10) === 3)
check("scrolling stops at the last page", scrollOffset(9, 3, 10) === 7)
check("a list that fits does not scroll", scrollOffset(2, 5, 4) === 0)

// The palette.
let ran: string[] = []
const item = (id: string, title: string, hint?: string): PaletteItem => ({
	id,
	title,
	hint,
	run: () => {
		ran.push(id)
	},
})
const p = new Palette()
p.setItems([
	item("abort", "Abort the current turn", "Esc Esc"),
	item("cost", "Show cost so far"),
	item("effort-low", "Effort: low"),
	item("effort-ultra", "Effort: ultra"),
	item("exit", "Exit", "Ctrl+D"),
])

check("closed by default", p.open === false)
p.show()
check("opens empty", p.open && p.query === "" && p.index === 0)
check("shows everything with no query", p.matches().length === 5)
p.type("cost")
check("filters", p.matches()[0]?.id === "cost", p.matches().map((m) => m.id).join(","))
p.backspace()
p.backspace()
p.backspace()
p.backspace()
check("backspace restores the list", p.matches().length === 5)
p.type("effort")
check("filters to a group", p.matches().length === 2)
p.move(1)
check("moves down", p.index === 1)
p.move(1)
check("wraps around", p.index === 0)
p.move(-1)
check("wraps backwards", p.index === 1)
const selected = p.selected()
check("selects within the filtered list", selected?.id.startsWith("effort-") === true)
void selected?.run()
check("runs the selection", ran.length === 1)
p.type("zzzz")
check("no match is not a crash", p.matches().length === 0 && p.selected() === null)
p.move(1)
check("moving with no match stays put", p.index === 0)
p.hide()
check("hiding clears the query", !p.open && p.query === "" && p.index === 0)

// Editing the filter, and jumping the list.
p.show()
p.type("effort ultra")
p.killWord()
check("kill word trims the filter", p.query === "effort", p.query)
p.clear()
check("kill line clears the filter", p.query === "" && p.matches().length === 5)
p.last()
check("end selects the last row", p.index === 4)
p.first()
check("home selects the first row", p.index === 0)
p.move(3)
p.type("e")
check("typing after a jump still resets the cursor", p.index === 0)
p.type("zzz")
p.last()
check("end with no match stays put", p.index === 0)
p.clear()

const alignedPalette = paletteRow("Show cost", "type: cost", 30)
check("palette hints align right", alignedPalette === " Show cost         type: cost ", JSON.stringify(alignedPalette))
check("palette rows fit wide glyphs", displayWidth(paletteRow("界", "current", 14)) === 14)
check("palette hides hints before titles", paletteRow("A useful command", "Ctrl+O", 12).trim() === "A useful co")

// Typing resets the selection, so Enter never runs the wrong row.
p.show()
p.move(2)
p.type("e")
check("typing resets the cursor", p.index === 0)

// Syntax highlighting adds SGR runs and never changes a character.
const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
check("highlighting preserves the characters", stripSgr(highlightCode("const x = 'hi' // done", "ts")) === "const x = 'hi' // done")
check("keywords go magenta", highlightCode("return", "ts") === `${MAGENTA}return${RESET}`)
check("strings go green", highlightCode("'hi'", "py") === `${GREEN}'hi'${RESET}`)
check("comments run to the end of the line", highlightCode("x # note", "py") === `x ${DIM}# note${RESET}`)
check("numbers go cyan", highlightCode("42", "go") === `${CYAN}42${RESET}`)
check("an unknown language is left alone", highlightCode("const x = 1", "brainfuck") === "const x = 1")
check("diff additions go green", highlightDiffLine("+one") === `${GREEN}+one${RESET}`)
check("diff removals go red", highlightDiffLine("-one") === `${RED}-one${RESET}`)
check("diff hunk headers go cyan", highlightDiffLine("@@ -1 +1 @@") === `${CYAN}@@ -1 +1 @@${RESET}`)
check("diff file headers dim", highlightDiffLine("--- a/x") === `${DIM}--- a/x${RESET}`)
check("diff context stays plain", highlightDiffLine(" unchanged") === " unchanged")
check("a diff fence routes to the diff colours", highlightCode("+added", "diff") === `${GREEN}+added${RESET}`)

// Wrapping.
check("wraps at a word boundary", wrap("aaa bbb ccc", 7).join("|") === "aaa bbb|ccc")
check("hard cuts a long word", wrap("aaaaaaaaaa", 4).join("|") === "aaaa|aaaa|aa")
check("short text is untouched", wrap("hi", 80).join("|") === "hi")
check("a silly width is passed through", wrap("hello", 3).join("|") === "hello")
check("wrap counts wide glyphs as two cells", wrap("界界界", 4).join("|") === "界界|界")
check(
	"wrap keeps graphemes whole",
	wrap("e\u0301e\u0301e\u0301e\u0301e\u0301", 4).join("|") === "e\u0301e\u0301e\u0301e\u0301|e\u0301",
)
check(
	"wrap ignores ANSI escape width",
	wrap("\x1b[2m界界界\x1b[0m", 4).join("|") === "\x1b[2m界界|界\x1b[0m",
)

// Untrusted output cannot take control of the terminal it is rendered in.
check("terminal escapes become visible", safeTerminalText("a\x1b[2Jb") === "a\u241b[2Jb")
check("terminal newlines remain layout", safeTerminalText("a\nb") === "a\nb")
check("terminal tabs become stable indentation", safeTerminalText("\tcode") === "    code")
check("terminal C1 controls become text", safeTerminalText("\u009b2J") === "\\x9b2J")
check("terminal delete becomes visible", safeTerminalText("a\x7fb") === "a\u2421b")

// Text that renders differently from the bytes it is made of. A right-to-left
// override or a zero-width joiner hides an edit inside a line of code that
// still looks harmless on screen.
check("terminal bidi overrides become visible", safeTerminalText("a\u202eb") === "a\\u202eb")
check("terminal bidi isolates become visible", safeTerminalText("\u2066x\u2069") === "\\u2066x\\u2069")
check("terminal bidi marks become visible", safeTerminalText("a\u200fb\u061c") === "a\\u200fb\\u061c")
check("terminal zero-width characters become visible", safeTerminalText("rm\u200b -rf") === "rm\\u200b -rf")
check("terminal zero-width joiners become visible", safeTerminalText("a\u200db") === "a\\u200db")
check("terminal byte order marks become visible", safeTerminalText("\ufeffx") === "\\ufeffx")
check("ordinary text keeps its shape", safeTerminalText("界 é ok") === "界 é ok")

// Markdown output stays streaming for ordinary lines and buffers only tables,
// whose widths depend on all rows.
const ansi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
const md = new MarkdownRenderer(displayWidth)
check("markdown styles headings", ansi(md.push("## Result\n", 80)) === "Result\n")
check("markdown renders bullets", ansi(md.push("- one\n", 80)) === "• one\n")
check("markdown renders ordered lists", ansi(md.push("  12. twelve\n", 80)) === "  12. twelve\n")
check("markdown renders tasks", ansi(md.push("- [x] shipped\n", 80)) === "☑ shipped\n")
check("markdown renders quotes", ansi(md.push("> note\n", 80)) === "│ note\n")
check("markdown opens code fences", ansi(md.push("```ts\nconst x = 1\n```\n", 80)) === "┌─ ts\n│ const x = 1\n└─\n")
const highlightedFence = new MarkdownRenderer(displayWidth)
check(
	"code fences highlight by language",
	highlightedFence.push("```ts\nreturn\n```\n", 80).includes(`${MAGENTA}return${RESET}`),
)
const wrappedCode = new MarkdownRenderer(displayWidth)
check(
	"markdown keeps a gutter on wrapped code",
	ansi(wrappedCode.push("```\nabcdefghij\n```\n", 8)) === "┌─\n│ abcdef\n│ ghij\n└─\n",
)
const indentedCode = new MarkdownRenderer(displayWidth)
check(
	"markdown preserves code indentation",
	ansi(indentedCode.push("```\n  return true\n```\n", 80)) === "┌─\n│   return true\n└─\n",
)
check("inline markdown removes delimiters", ansi(renderInlineMarkdown("**bold** and `code`")) === "bold and code")
check("inline markdown keeps link targets", ansi(renderInlineMarkdown("[docs](https://example.com)")) === "docs (https://example.com)")
check("inline markdown neutralizes terminal escapes", ansi(renderInlineMarkdown("safe\x1b[2J")) === "safe\u241b[2J")
const splitMarkdown = new MarkdownRenderer(displayWidth)
check("split markdown waits for the complete line", splitMarkdown.push("**bo", 80) === "")
check("split markdown keeps its styling", ansi(splitMarkdown.push("ld**\n", 80)) === "bold\n")

const table = new MarkdownRenderer(displayWidth)
check("table header waits for its separator", table.push("| Name | State |\n", 40) === "")
check("table separator waits for rows", table.push("| --- | :---: |\n", 40) === "")
check("table rows are buffered", table.push("| axe | ready |\n", 40) === "")
const renderedTable = ansi(table.flush(40))
check("markdown table uses a box", renderedTable.includes("┌") && renderedTable.includes("┼") && renderedTable.includes("┘"), renderedTable)
check("markdown table keeps cells", renderedTable.includes("Name") && renderedTable.includes("axe") && renderedTable.includes("ready"), renderedTable)
check("markdown table fits the terminal", renderedTable.trimEnd().split("\n").every((line) => displayWidth(line) <= 40), renderedTable)

const hostileMarkdown = new MarkdownRenderer(displayWidth)
check(
	"streamed markdown neutralizes terminal escapes",
	ansi(hostileMarkdown.push("before\x1b[2Jafter\n", 80)) === "before\u241b[2Jafter\n",
)

const unicodeTable = renderMarkdownTable(
	["字", "Ok"],
	[["界", "✅"]],
	["left", "center"],
	13,
	displayWidth,
)
check("unicode tables fit by terminal cells", unicodeTable.every((line) => displayWidth(ansi(line)) <= 13), unicodeTable.join("\n"))

const wordTable = renderMarkdownTable(
	["Item", "Status", "Detail"],
	[["Unicode 界", "✅", "a long value wraps without losing text"]],
	["left", "center", "left"],
	40,
	displayWidth,
)
check("table cells prefer word boundaries", wordTable.some((line) => line.includes("wraps without")), wordTable.join("\n"))

const narrowTable = renderMarkdownTable(
	["Long heading", "State"],
	[["a value too long for the terminal", "ready"]],
	["left", "right"],
	24,
	displayWidth,
)
check("narrow tables wrap without losing text", !narrowTable.some((line) => line.includes("…")))
check("narrow table rows stay aligned", narrowTable.every((line) => displayWidth(ansi(line)) <= 24), narrowTable.join("\n"))

const stackedTable = renderMarkdownTable(
	["A", "B", "C"],
	[["one", "two", "three"]],
	["left", "left", "left"],
	10,
	displayWidth,
)
check("very narrow tables become stacked records", stackedTable.join("\n") === "A: one\nB: two\nC: three")
check("stacked records fit the terminal", stackedTable.every((line) => displayWidth(ansi(line)) <= 10))

const tilde = new MarkdownRenderer(displayWidth)
check(
	"a ``` inside a ~~~ fence is content",
	ansi(tilde.push("~~~\n```\n~~~\n", 80)) === "┌─\n│ ```\n└─\n",
)
const nestedFence = new MarkdownRenderer(displayWidth)
check(
	"a fence inside a list keeps its indentation",
	ansi(nestedFence.push("- item\n\n  ```\n  code\n  ```\n", 80)) ===
		"• item\n\n  ┌─\n  │ code\n  └─\n",
)
const indentedBlock = new MarkdownRenderer(displayWidth)
check(
	"four spaces after a blank line is a code block",
	ansi(indentedBlock.push("\n    const x = 1\ntext\n", 80)) === "\n│ const x = 1\ntext\n",
)
const listContinuation = new MarkdownRenderer(displayWidth)
check(
	"four spaces under a list is not a code block",
	ansi(listContinuation.push("- item\n\n    more\n", 80)) === "• item\n\n    more\n",
)
const nested = new MarkdownRenderer(displayWidth)
check("nested bullets change marker", ansi(nested.push("- a\n  - b\n    - c\n", 80)) === "• a\n  ◦ b\n    ▪ c\n")
const deepQuote = new MarkdownRenderer(displayWidth)
check("nested quotes show one bar per level", ansi(deepQuote.push("> > deep\n", 80)) === "│ │ deep\n")
check(
	"inline markdown expands autolinks",
	ansi(renderInlineMarkdown("see <https://example.com> now")) === "see https://example.com now",
)
const hardBreak = new MarkdownRenderer(displayWidth)
check("a hard break drops its trailing spaces", ansi(hardBreak.push("line  \n", 80)) === "line\n")

// A mermaid fence is a code fence like any other: the source is what the model
// wrote, and it is more useful than a picture a character grid cannot carry.
const embedded = new MarkdownRenderer(displayWidth)
const fenced = ansi(embedded.push("```mermaid\ngraph TD\nA[One] --> B[Two]\n```\n", 80))
check("a mermaid fence keeps its source", fenced.includes("graph TD") && fenced.includes("A[One]"), fenced)

const notTable = new MarkdownRenderer(displayWidth)
check("a prose pipe waits one line", notTable.push("use a | b here\n", 80) === "")
check("a prose pipe is preserved", ansi(notTable.push("next\n", 80)) === "use a | b here\nnext\n")

// Working feedback follows Codex's useful parts without taking over the screen.
check("elapsed seconds are compact", formatElapsed(59) === "59s")
check("elapsed minutes are padded", formatElapsed(65) === "1m 05s")
check("elapsed hours are padded", formatElapsed(3_661) === "1h 01m 01s")
check(
	"working status keeps the interrupt hint before metadata",
	workingStatus("model · medium", 5, 0) === "⠋ Thinking 5s · Ctrl+C · model · medium",
)
check("working spinner advances", workingStatus("axe", 0, 1).startsWith("⠙ Thinking"))
// The phase is the difference between one long silence and several short ones,
// and the panel is only itemising the second kind.
check(
	"the tool phase says so, and counts",
	workingStatus("axe", 3, 0, "tools", 3) === "⠋ Running 3 tools 3s · Ctrl+C · axe",
)
check(
	"one tool is not pluralised",
	workingStatus("axe", 3, 0, "tools", 1).startsWith("⠋ Running 3s"),
)
check(
	"the interrupt hint survives both phases",
	workingStatus("axe", 1, 0, "tools", 2).includes("Ctrl+C"),
)
check(
	"working status shows queued input",
	workingStatus("axe", 1, 0, "tools", 2, 3).startsWith("⠋ Running 2 tools 1s · 3 queued"),
)

// The context figure is the only number on the bar that changes what the user
// should do next, so it is the only one allowed to leave the dim run. Applied
// after fitCells, so the check is that the text is untouched and only the
// styling around it moved.
const colouring = Boolean(process.env.NO_COLOR) === false
check("a roomy context window stays dim", highlightStatus(" ─ m · ctx 42% · $0.00") === " ─ m · ctx 42% · $0.00")
check(
	"a filling context window is warned about",
	!colouring || highlightStatus("ctx 84%").includes("\x1b[33m"),
)
check(
	"a nearly full context window is escalated",
	!colouring || highlightStatus("ctx 94%").includes("\x1b[31m"),
)
check(
	"the boundary counts as filling",
	!colouring || highlightStatus("ctx 80%").includes("\x1b[33m"),
)
// The fields after it are still part of one dim run: closing the colour without
// re-opening DIM would leave the cost and the hint at full weight.
check(
	"the dim run reopens after the warning",
	!colouring || highlightStatus("ctx 94% · $1.00").endsWith("\x1b[2m · $1.00"),
)
check(
	"the figure itself is not rewritten",
	highlightStatus("ctx 94%").replace(/\x1b\[[0-9;]*m/g, "") === "ctx 94%",
)

// The prompt is one row, so a pasted newline is drawn as a glyph rather than
// scrolling the bars off the screen.
check("newlines are shown as a glyph", inlineNewlines("a\nb") === "a\u23ceb")
check("the glyph keeps the cursor arithmetic honest", inlineNewlines("a\nb").length === 3)
check("text without newlines is untouched", inlineNewlines("abc") === "abc")

// A prompt is always one terminal row, even for wide glyphs, long input, and
// control bytes pasted from logs.
check("wide glyphs use two cells", displayWidth("界🙂") === 4)
check("combining marks stay in one cell", displayWidth("e\u0301") === 1)
const leftView = promptView("abcdefghij", 0, 6)
check("a long prompt shows the hidden right edge", leftView.text === "abcde\u203a" && leftView.column === 0)
const rightView = promptView("abcdefghij", 10, 6)
check("a long prompt keeps the cursor visible", rightView.text === "\u2039ghij" && rightView.column === 5)
const fullView = promptView("abcdef", 6, 6)
check("the cursor never lands past the last column", fullView.text === "\u2039cdef" && fullView.column === 5)
const safeView = promptView("x\x1b[31m\ny", 8, 20)
check("pasted controls render as glyphs", safeView.text === "x\u241b[31m\u23cey", safeView.text)
check("pasted C1 controls render as text", promptView("x\u009b2J", 4, 20).text === "x\\x9b2J")
check("prompt views fit their terminal width", displayWidth(leftView.text) === 6 && displayWidth(rightView.text) <= 6)

// The real composer wraps into a small viewport while the palette keeps its
// compact one-row filter above.
const wrappedComposer = composerView("abcdefghij", 10, 4)
check("the composer wraps long input", wrappedComposer.lines.join("|") === "abcd|efgh|ij")
check("the composer cursor follows wrapping", wrappedComposer.row === 2 && wrappedComposer.column === 2)
const multilineComposer = composerView("first\nsecond", 8, 20)
check("explicit composer newlines get their own row", multilineComposer.lines.join("|") === "first|second")
check("the composer cursor follows explicit newlines", multilineComposer.row === 1 && multilineComposer.column === 2)
const clippedComposer = composerView("1\n2\n3\n4\n5\n6", 11, 20, 5)
check("the composer caps its height", clippedComposer.lines.join("|") === "2|3|4|5|6")
check("the composer keeps the cursor in its viewport", clippedComposer.row === 4)
const safeComposer = composerView("x\x1b[2J", 5, 20)
check("composer controls stay inert", safeComposer.lines[0] === "x\u241b[2J", safeComposer.lines[0])

// A tool row without its argument is seven identical lines saying "read_file".
check("a path is the subject", toolSummary({ path: "src/cli.ts" }) === "src/cli.ts")
// join, not a slash: on Windows `relative` answers with backslashes, and the
// check is that the workspace prefix is gone, not which separator survived it.
check("a workspace path is relative", toolSummary({ path: join(process.cwd(), "src/cli.ts") }) === join("src", "cli.ts"))
check("a command is the subject", toolSummary({ cmd: "npm test" }) === "npm test")
check("the first matching field wins", toolSummary({ pattern: "x", path: "p.ts" }) === "p.ts")
check("newlines collapse", toolSummary({ cmd: "a\n  b" }) === "a b")
check("a long argument is clamped", toolSummary({ cmd: "x".repeat(80) }).length === 48)
check("nothing recognisable is nothing", toolSummary({ depth: 3 }) === "")
check("a non-object is nothing", toolSummary("hi") === "" && toolSummary(undefined) === "")

// The activity panel. A turn is a tree of concurrent work, and the panel is
// the only place that says so, which makes its arithmetic worth pinning down.
const T0 = 1_000_000

{
	const t = new ActivityTracker()
	t.start({ id: "a", kind: "agent", name: "search", subject: "find it" }, T0)
	t.start({ id: "root", kind: "tool", name: "bash", subject: "npm test" }, T0 + 1)
	t.start({ id: "a/x", kind: "tool", name: "grep", subject: "foo", parent: "a" }, T0 + 2)
	const ids = t.live(T0 + 3).map((a) => a.id)
	check("a child follows its parent, not the clock", ids.join(",") === "a,a/x,root", ids.join(","))

	t.finish("root", true, T0 + 4)
	check("a finished row lingers so the tick is seen", t.live(T0 + 5).length === 3)
	check("and then it goes", t.live(T0 + 4 + LINGER_MS).map((a) => a.id).join(",") === "a,a/x")

	// A tool that outlives its parent must not vanish with it: it is still
	// running, and a row that disappears reads as a row that finished.
	t.finish("a", true, T0 + 10)
	const orphaned = t.live(T0 + 10 + LINGER_MS).map((a) => a.id)
	check("an orphaned child is promoted to a root", orphaned.join(",") === "a/x", orphaned.join(","))

	t.finish("nope", true, T0 + 20)
	check("finishing something unknown is a no-op", t.live(T0 + 21).length === 1)
	t.finish("a/x", false, T0 + 21)
	t.finish("a/x", true, T0 + 22)
	check("a second finish does not move the clock", t.get("a/x")?.endedAt === T0 + 21)
	t.clear()
	check("clear empties it", t.live(T0 + 30).length === 0)
}

{
	const t = new ActivityTracker()
	t.start({ id: "task-1", kind: "tool", name: "task", subject: "find it" }, T0)
	t.start({ id: "task-1", kind: "agent", name: "search", subject: "find it" }, T0 + 10)
	const rows = t.live(T0 + 20)
	check("a task becomes one agent row instead of two", rows.length === 1 && rows[0]?.name === "search")
	check("changing the row role keeps its original clock", rows[0]?.startedAt === T0)
}

// Indeterminate on purpose: nothing tells us how far along a tool is, so the
// bar slides rather than filling. What it must never do is change width.
check("a slide bar is exactly its width", displayWidth(slideBar(12, 0)) === 12)
check("and stays so at every frame", [0, 1, 5, 9, 17, 40].every((f) => displayWidth(slideBar(12, f)) === 12))
check("it actually moves", slideBar(12, 0) !== slideBar(12, 3))
check("it comes back", slideBar(12, 0) === slideBar(12, 18))
check("a negative frame does not crash it", displayWidth(slideBar(12, -3)) === 12)
check("too narrow to slide is still the right width", displayWidth(slideBar(2, 4)) === 2)

// Sub-second work is real work, and "0s" makes it look like nothing happened.
check("sub-second work is not zero", formatDuration(340) === "0.3s")
check("seconds keep one decimal", formatDuration(4_120) === "4.1s")
check("long work drops the decimal", formatDuration(65_000) === "1m 05s")
check("a negative duration is clamped", formatDuration(-5) === "0.0s")

// Every panel row is one terminal row. A wide glyph or a pasted newline in a
// tool argument must not push the bars off the screen.
const running = { id: "x", kind: "tool" as const, name: "read_file", subject: "src/cli.ts", startedAt: T0 }
check("a panel row fills its width", displayWidth(activityRow(running, T0 + 500, 0, 60)) === 60)
check("a narrow row still fits", displayWidth(activityRow(running, T0 + 500, 0, 24)) === 24)
check(
	"a wide subject does not overflow",
	displayWidth(activityRow({ ...running, subject: "界".repeat(80) }, T0 + 500, 0, 50)) === 50,
)
check(
	"a newline in a subject stays one row",
	displayWidth(activityRow({ ...running, subject: "a\nb\nc" }, T0 + 500, 0, 50)) === 50,
)
check("a running row spins", activityRow(running, T0, 0, 60).trimStart().startsWith("⠋"))
check("a finished row ticks", activityRow({ ...running, endedAt: T0 + 1, ok: true }, T0 + 1, 0, 60).includes("✓"))
check("a failed row crosses", activityRow({ ...running, endedAt: T0 + 1, ok: false }, T0 + 1, 0, 60).includes("✗"))
check("a child row is indented past its parent", activityRow({ ...running, parent: "a" }, T0, 0, 60).startsWith("   "))
check("a finished row shows no bar", !activityRow({ ...running, endedAt: T0 + 1, ok: true }, T0 + 1, 0, 60).includes("━"))

// Panel rows and transcript rows are the same id space, and the separator is
// what tells the renderer to indent one and stay quiet about it.
check("a namespaced id names its agent", parentOf("agent-2/toolu_01") === "agent-2")
check("a plain id has no parent", parentOf("toolu_01") === undefined)
check("a leading slash is not a parent", parentOf("/x") === undefined)
check("only the last slash splits", parentOf("agent-1/a/b") === "agent-1/a")

// Colour by what a tool does, so the writes are findable without reading names.
const noColor = Boolean(process.env.NO_COLOR)
check("reads and writes differ unless colour is disabled", noColor || toolColor("read_file") !== toolColor("write_file"))
check("a command is its own colour unless colour is disabled", noColor || toolColor("bash") !== toolColor("read_file"))
check("an agent is a delegation whatever it is called", toolColor("my-agent", "agent") === toolColor("task"))
check("an unknown tool is dim, not blank", toolColor("mcp__x__y") === toolColor("nope"))
check("tool metadata renders a compact diff", toolDisplaySummary({ path: "src/a.ts", additions: 3, deletions: 1 }) === "src/a.ts +3 −1")
check("tool metadata renders an exit code", toolDisplaySummary({ exitCode: 0 }) === "exit 0")

console.log(`tui: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

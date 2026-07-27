/**
 * The testable half of the $EDITOR handoff: parsing a command line, picking
 * which variable to read, and deciding what a saved file means. Spawning an
 * editor is not testable without an editor, so it is not tested here.
 */
import { editedText, resolveEditor, splitCommand } from "../src/ui/external-editor.ts"
import { Editor, decode } from "../src/ui/tui.ts"

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

const split = (s: string) => splitCommand(s)?.join("|")

// $EDITOR is a command line, not a program name. Both halves of that matter.
check("a bare editor is one word", split("vim") === "vim")
check("flags come through", split("code --wait") === "code|--wait")
check("extra spaces collapse", split("  nvim   -u  NONE ") === "nvim|-u|NONE")
check("a quoted path stays whole", split('"/Applications/My App/bin/ed" -w') === "/Applications/My App/bin/ed|-w")
check("single quotes work too", split("'/opt/my ed' -w") === "/opt/my ed|-w")
check("an escaped space is not a split", split("/opt/my\\ ed") === "/opt/my ed")
check("an escape inside double quotes", split('"a\\"b"') === 'a"b')
check("a backslash inside single quotes is literal", split("'a\\b'") === "a\\b")
check("an empty quoted token survives", splitCommand("''")?.length === 1)
check("an unterminated quote is a refusal", splitCommand('vim "unclosed') === null)
check("an empty string is no tokens", splitCommand("")?.length === 0)

// Which variable wins.
check("visual beats editor", (resolveEditor({ VISUAL: "nvim", EDITOR: "ed" }) as { cmd: string }).cmd === "nvim")
check("editor is the fallback", (resolveEditor({ EDITOR: "ed" }) as { cmd: string }).cmd === "ed")
check("neither set is an error", "error" in resolveEditor({}))
check("an empty variable counts as unset", (resolveEditor({ EDITOR: "   " }) as { error: string }).error === "missing")
check("an unparsable variable is its own error", (resolveEditor({ EDITOR: 'vim "x' }) as { error: string }).error === "unparsed")
const withFlags = resolveEditor({ EDITOR: "code --wait --new-window" }) as { cmd: string; args: string[] }
check("flags are kept in order", withFlags.args.join("|") === "--wait|--new-window")

// What a saved file means. One trailing newline is the editor's, not the user's.
check("the trailing newline is dropped", editedText("hello\n") === "hello")
check("only one is dropped", editedText("hello\n\n") === "hello\n")
check("interior blank lines are kept", editedText("a\n\nb\n") === "a\n\nb")
check("crlf is normalised", editedText("a\r\nb\r\n") === "a\nb")
check("a file with no newline is unchanged", editedText("hello") === "hello")
check("an empty file is an empty prompt", editedText("") === "")
check("a file the user emptied is an empty prompt", editedText("\n") === "")

// The key, and the buffer it comes back to.
check("ctrl x asks for the editor", decode("\x18").map((k) => k.name).join(",") === "external-editor")
const ed = new Editor(500)
check("ctrl x is not text", ed.handle({ name: "external-editor" }).type === "none" && ed.buffer === "")
ed.handle({ name: "char", text: "a" })
ed.setBuffer("from the editor\nsecond line")
check("the edited text replaces the buffer", ed.buffer === "from the editor\nsecond line")
check("the cursor lands at the end", ed.cursor === ed.buffer.length)
const sent = ed.handle({ name: "enter" })
check("and enter submits every line of it", sent.type === "submit" && sent.line === "from the editor\nsecond line")
ed.setBuffer("typed")
ed.handle({ name: "up" })
check("history still works after an edit", ed.buffer === "from the editor\nsecond line")

console.log(`editor: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

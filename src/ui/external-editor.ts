import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Handing the prompt to $EDITOR and taking it back.
 *
 * The composer grows to six rows, which covers a paragraph and not a spec. Past
 * that the right answer is not a bigger composer: it is the editor the user
 * already knows, with their own keybindings, undo, and syntax highlighting.
 *
 * The parsing and the read-back are separate from the spawn so they can be
 * tested. Spawning an editor cannot be tested without an editor.
 */

export type EditorCommand = { cmd: string; args: string[] }

/** What went wrong before anything was spawned. */
export type EditorError = "missing" | "unparsed"

/** A new buffer, a message for the user, or neither. Never both. */
export type EditResult = { text?: string; notice?: string }

/**
 * Splits a command line the way a shell would, without running one.
 *
 * $EDITOR is routinely a command with flags (`code --wait`, `emacsclient -nw`),
 * so it cannot be spawned as a single argv[0]. It is equally routinely a path
 * with a space in it, so it cannot be split on whitespace either. Quotes and
 * backslashes are honoured; returns null for an unterminated quote rather than
 * guessing where it was meant to close.
 */
export function splitCommand(s: string): string[] | null {
	const out: string[] = []
	let cur = ""
	// Tracks a token that exists but is empty, as in EDITOR="''".
	let started = false
	let quote: '"' | "'" | null = null
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!
		if (quote) {
			if (c === quote) {
				quote = null
				continue
			}
			// Only double quotes take escapes, as in a POSIX shell.
			if (quote === '"' && c === "\\" && i + 1 < s.length) {
				cur += s[++i]
				continue
			}
			cur += c
			continue
		}
		if (c === '"' || c === "'") {
			quote = c
			started = true
			continue
		}
		if (c === "\\" && i + 1 < s.length) {
			cur += s[++i]
			started = true
			continue
		}
		if (/\s/.test(c)) {
			if (started) {
				out.push(cur)
				cur = ""
				started = false
			}
			continue
		}
		cur += c
		started = true
	}
	if (quote) return null
	if (started) out.push(cur)
	return out
}

/**
 * $VISUAL before $EDITOR, which is the older convention and the right one here:
 * $EDITOR may well be a line editor, and axe is asking for a full-screen one.
 */
export function resolveEditor(
	env: Record<string, string | undefined>,
): EditorCommand | { error: EditorError } {
	const raw = (env.VISUAL ?? env.EDITOR ?? "").trim()
	if (!raw) return { error: "missing" }
	const parts = splitCommand(raw)
	if (!parts || !parts.length || !parts[0]) return { error: "unparsed" }
	const [cmd, ...args] = parts
	return { cmd: cmd!, args }
}

/**
 * The buffer a saved file means.
 *
 * Every editor ends a file with a newline, and that newline is the editor's
 * convention rather than the user's text, so exactly one is dropped. Interior
 * blank lines are the user's, and are kept. CRLF is normalised because a file
 * touched on Windows should not arrive with carriage returns in the prompt.
 */
export function editedText(raw: string): string {
	return raw.replace(/\r\n/g, "\n").replace(/\n$/, "")
}

/**
 * Seeds a temp file with the current buffer, runs the editor on it, and returns
 * what was saved.
 *
 * `stdio: "inherit"` and a synchronous spawn on purpose: a full-screen editor
 * needs the real terminal, and it needs to be the only thing reading it. The
 * caller is responsible for leaving raw mode first.
 */
export async function runEditor(
	seed: string,
	env: Record<string, string | undefined> = process.env,
): Promise<EditResult> {
	const resolved = resolveEditor(env)
	if ("error" in resolved) {
		if (resolved.error === "missing") {
			return { notice: "Set $VISUAL or $EDITOR to compose in an editor." }
		}
		return { notice: `Cannot read $VISUAL/$EDITOR: ${(env.VISUAL ?? env.EDITOR ?? "").trim()}` }
	}
	const dir = await mkdtemp(join(tmpdir(), "axe-prompt-"))
	// .md so the editor turns on the mode a prompt is usually written in.
	const file = join(dir, "prompt.md")
	try {
		await writeFile(file, seed, "utf8")
		const out = spawnSync(resolved.cmd, [...resolved.args, file], { stdio: "inherit" })
		if (out.error) return { notice: `Cannot run ${resolved.cmd}: ${out.error.message}` }
		// A non-zero exit is how :cq says "forget it", so the buffer is left alone.
		if (out.status !== 0) {
			return { notice: `${resolved.cmd} exited with ${out.status ?? "a signal"}. Prompt unchanged.` }
		}
		return { text: editedText(await readFile(file, "utf8")) }
	} catch (err) {
		return { notice: err instanceof Error ? err.message : String(err) }
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

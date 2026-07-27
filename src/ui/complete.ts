/**
 * Fuzzy matching, and the `@` file reference it powers.
 *
 * `@` is a typing aid, not a command. What it leaves in the prompt is a path
 * the user could have typed by hand, the model sees nothing it would not have
 * seen anyway, and no tool is added: the agent still reads the file with
 * `read_file`. That is the same bargain the palette makes, which is why this
 * does not reopen the question of slash commands.
 *
 * All of it is pure, because a completion that picks the wrong file or eats the
 * wrong characters is a bug you can only find by testing it.
 */

/** Subsequence match. Lower is better; -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
	const q = query.toLowerCase().replace(/\s+/g, "")
	const t = text.toLowerCase()
	if (!q) return 0
	let score = 0
	let from = 0
	let last = -2
	for (const ch of q) {
		const at = t.indexOf(ch, from)
		if (at === -1) return -1
		score += at - from
		if (at === last + 1) score -= 1
		if (at === 0) score -= 2
		last = at
		from = at + 1
	}
	// Keep every successful score non-negative: -1 is reserved for a miss.
	return score + q.length + 1
}

export type Mention = { from: number; query: string }

/**
 * The `@` reference being typed at the cursor, if there is one.
 *
 * An `@` only opens the picker at the start of the line or after whitespace, so
 * an email address and a handle in the middle of a sentence stay ordinary text.
 * The query ends at the first space, because a path with a space in it is rarer
 * than a sentence that carries on after a reference.
 */
export function mentionAt(buffer: string, cursor: number): Mention | null {
	const head = buffer.slice(0, Math.max(0, Math.min(cursor, buffer.length)))
	const at = head.lastIndexOf("@")
	if (at === -1) return null
	const before = at === 0 ? "" : head[at - 1]!
	if (before && !/\s/u.test(before)) return null
	const query = head.slice(at + 1)
	if (/\s/u.test(query)) return null
	return { from: at, query }
}

/**
 * Ranks paths for a query. A basename hit always beats a hit that only matched
 * somewhere in the directory part, because "cli" should offer `src/cli.ts`
 * before every file that happens to live under a `cli/` directory.
 */
export function matchFiles(query: string, files: readonly string[], limit = 50): string[] {
	if (!query) return files.slice(0, limit)
	const scored: Array<{ path: string; score: number }> = []
	for (const path of files) {
		const base = path.slice(path.lastIndexOf("/") + 1)
		const onBase = fuzzyScore(query, base)
		const onPath = fuzzyScore(query, path)
		if (onBase < 0 && onPath < 0) continue
		scored.push({ path, score: onBase >= 0 ? onBase : onPath + 1_000 })
	}
	scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
	return scored.slice(0, limit).map((s) => s.path)
}

/**
 * How a path is written into the prompt. A path with a space in it is quoted,
 * because the picker offers such files and an unquoted one reads as two words
 * to everything downstream, including the model.
 */
export function quotePath(path: string): string {
	if (!/\s/u.test(path)) return path
	return `"${path.replace(/(["\\])/g, "\\$1")}"`
}

/**
 * Replaces the `@query` under the cursor with the chosen path and a trailing
 * space, so the next word can be typed without reopening the picker.
 */
export function applyMention(
	buffer: string,
	cursor: number,
	mention: Mention,
	path: string,
): { buffer: string; cursor: number } {
	const at = Math.max(0, Math.min(cursor, buffer.length))
	const insert = `${quotePath(path)} `
	return {
		buffer: buffer.slice(0, mention.from) + insert + buffer.slice(at),
		cursor: mention.from + insert.length,
	}
}

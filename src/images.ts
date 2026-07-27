import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import type { Block } from "./providers/types.ts"

const MAX_IMAGE_BYTES = 5_000_000
const MAX_IMAGES = 4

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
}

export const PATH_RE = /(?:~\/|\.{0,2}\/|\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(png|jpe?g|gif|webp)\b/gi

/**
 * A terminal cannot paste pixels, so the way an image enters a prompt is as a
 * path, and any typed path to an image file is attached as an image block. The
 * `@` picker stays a typing aid: it inserts the same path this function would
 * have found had the user typed it by hand. The text keeps the path, so the
 * model knows which attachment is which.
 *
 * Only the user's own message is expanded, never a subagent prompt or steering
 * text a model wrote: a screenshot is something a person points at.
 */
export async function imageBlocks(
	input: string,
	cwd: string,
): Promise<{ blocks: Block[]; notes: string[] }> {
	const blocks: Block[] = []
	const notes: string[] = []
	const seen = new Set<string>()
	for (const match of input.matchAll(PATH_RE)) {
		const raw = match[0]!
		const path = raw.startsWith("~/")
			? resolve(homedir(), raw.slice(2))
			: isAbsolute(raw)
				? raw
				: resolve(cwd, raw)
		if (seen.has(path)) continue
		seen.add(path)
		let size: number
		try {
			const s = await stat(path)
			if (!s.isFile()) continue
			size = s.size
		} catch {
			// A word that merely looks like a path is part of the sentence.
			continue
		}
		if (blocks.length >= MAX_IMAGES) {
			notes.push(`Skipped ${raw}: at most ${MAX_IMAGES} images per message.`)
			continue
		}
		if (size > MAX_IMAGE_BYTES) {
			notes.push(`Skipped ${raw}: ${size} bytes is over the ${MAX_IMAGE_BYTES} byte limit.`)
			continue
		}
		const ext = raw.slice(raw.lastIndexOf(".") + 1).toLowerCase()
		const mime = MIME[ext]
		if (!mime) continue
		try {
			const data = (await readFile(path)).toString("base64")
			blocks.push({ type: "image", mime, data })
			notes.push(`Attached ${raw} (${mime}, ${size} bytes).`)
		} catch {
			notes.push(`Could not read ${raw}.`)
		}
	}
	return { blocks, notes }
}

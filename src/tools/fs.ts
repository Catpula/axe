import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { atomicWrite } from "../artifacts.ts"
import type { ToolCtx, ToolDef } from "../providers/types.ts"

const ALWAYS_SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"target",
	"__pycache__",
	".venv",
])

const MAX_READ_LINES = 2000
const MAX_LIST_ENTRIES = 1000
const MAX_GLOB_RESULTS = 200

/**
 * Resolves as far as the path exists, then appends the parts that do not. A
 * file about to be created has no real path of its own, but the directory it
 * lands in does, and that is what decides whether it is inside the workspace.
 */
async function realOrParent(p: string): Promise<string> {
	try {
		return await realpath(p)
	} catch {
		const parent = dirname(p)
		if (parent === p) return p
		return join(await realOrParent(parent), basename(p))
	}
}

/**
 * Comparing the strings alone is not containment: a symlink inside the
 * workspace is a path that starts with the root and ends anywhere on the disk,
 * so both sides are resolved through the link chain before they are compared.
 */
async function safePath(ctx: ToolCtx, p: string): Promise<{ absolute: string; relative: string }> {
	const root = await realOrParent(ctx.cwd)
	const abs = await realOrParent(resolve(ctx.cwd, p))
	const rel = relative(root, abs)
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Path escapes the workspace root: ${p}`)
	}
	return { absolute: abs, relative: rel || "." }
}

export function globToRegExp(glob: string): RegExp {
	let re = ""
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?"
					i += 2
				} else {
					re += ".*"
					i += 1
				}
			} else {
				re += "[^/]*"
			}
		} else if (c === "?") {
			re += "[^/]"
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		}
	}
	return new RegExp(`^${re}$`)
}

async function walk(
	root: string,
	dir: string,
	depth: number,
	out: Array<{ path: string; mtime: number; dir: boolean }>,
): Promise<void> {
	if (out.length >= 20_000 || depth < 0) return
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		if (e.name.startsWith(".") && e.name !== ".github") continue
		if (ALWAYS_SKIP.has(e.name)) continue
		const abs = join(dir, e.name)
		// Always forward slashes. `relative` uses the platform separator, so on
		// Windows every path came back as `scripts\tui-test.ts` while the patterns
		// it is matched against are written `scripts/*.ts` — glob found nothing
		// below the root, and the `@` picker offered paths no tool would accept.
		const rel = relative(root, abs).replaceAll(sep, "/")
		if (e.isDirectory()) {
			out.push({ path: rel, mtime: 0, dir: true })
			await walk(root, abs, depth - 1, out)
		} else if (e.isFile()) {
			let mtime = 0
			try {
				mtime = (await stat(abs)).mtimeMs
			} catch {
				// Broken symlink; keep going.
			}
			out.push({ path: rel, mtime, dir: false })
		}
	}
}

/**
 * Every file under the workspace, newest first. The `@` picker in the TUI uses
 * this so that what it offers and what `glob` finds are the same set: one skip
 * list, not two that drift.
 */
export async function workspaceFiles(root: string, limit = 20_000): Promise<string[]> {
	const found: Array<{ path: string; mtime: number; dir: boolean }> = []
	await walk(root, root, 32, found)
	return found
		.filter((f) => !f.dir)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map((f) => f.path)
}

export const readFileTool: ToolDef = {
	name: "read_file",
	description:
		"Read a file from the workspace with 1-based line numbers. Use offset and limit to page through files longer than 2000 lines. Do not use this to search for a string across many files; use grep instead.",
	readOnly: true,
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path relative to the workspace root." },
			offset: { type: "integer", description: "1-based first line to return." },
			limit: { type: "integer", description: "Number of lines to return (max 2000)." },
			char_offset: { type: "integer", description: "0-based character offset within the selected lines." },
			char_limit: { type: "integer", description: "Maximum characters to return, for paging a long line." },
		},
		required: ["path"],
	},
	async run(input: { path: string; offset?: number; limit?: number; char_offset?: number; char_limit?: number }, ctx) {
		if (input.char_offset !== undefined && input.char_offset < 0) throw new Error("char_offset must be non-negative.")
		if (input.char_limit !== undefined && input.char_limit < 0) throw new Error("char_limit must be non-negative.")
		const { absolute: abs } = await safePath(ctx, input.path)
		const raw = await readFile(abs, "utf8")
		const lines = raw.split("\n")
		const start = Math.max(1, input.offset ?? 1)
		const limit = Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES)
		const slice = lines.slice(start - 1, start - 1 + limit)
		const width = String(start + slice.length - 1).length
		const body = slice
			.map((l, i) => `${String(start + i).padStart(width, " ")}\t${l}`)
			.join("\n")
		const end = start + slice.length - 1
		const more =
			end < lines.length
				? `\n\n[showing lines ${start}-${end} of ${lines.length}; call again with offset=${end + 1}]`
				: ""
		const complete = body + more
		const charStart = Math.max(0, input.char_offset ?? 0)
		const charLimit = Math.max(0, input.char_limit ?? complete.length)
		const paged = complete.slice(charStart, charStart + charLimit)
		const charMore = charStart + charLimit < complete.length
			? `\n\n[showing characters ${charStart}-${charStart + paged.length} of ${complete.length}; call again with char_offset=${charStart + paged.length}]`
			: ""
		return paged + charMore
	},
}

export const listFilesTool: ToolDef = {
	name: "list_files",
	description:
		"List files and directories under a path, two levels deep. Skips .git, node_modules, and build output. Use this to orient yourself in an unfamiliar repository, not to find a specific file by name; use glob for that.",
	readOnly: true,
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory relative to the workspace root. Defaults to the root." },
			depth: { type: "integer", description: "Levels to descend. Defaults to 2." },
		},
	},
	async run(input: { path?: string; depth?: number }, ctx) {
		const { absolute: root } = await safePath(ctx, input.path ?? ".")
		const found: Array<{ path: string; mtime: number; dir: boolean }> = []
		await walk(root, root, Math.max(0, (input.depth ?? 2) - 1), found)
		found.sort((a, b) => a.path.localeCompare(b.path))
		const shown = found.slice(0, MAX_LIST_ENTRIES)
		const lines = shown.map((f) => (f.dir ? `${f.path}/` : f.path))
		const extra =
			found.length > shown.length ? `\n[... ${found.length - shown.length} more entries]` : ""
		return lines.join("\n") + extra
	},
}

export const editFileTool: ToolDef = {
	name: "edit_file",
	description:
		"Replace an exact string in a file. old_str must appear exactly once; include surrounding lines to make it unique. Pass an empty old_str to create a new file. Returns a diff of what changed.",
	readOnly: false,
	schema: {
		type: "object",
		properties: {
			path: { type: "string" },
			old_str: { type: "string", description: "Exact text to replace. Empty string creates the file." },
			new_str: { type: "string", description: "Replacement text." },
		},
		required: ["path", "old_str", "new_str"],
	},
	display: (input: { path: string; old_str: string; new_str: string }) => ({
		path: input.path,
		additions: input.new_str.split("\n").length,
		deletions: input.old_str ? input.old_str.split("\n").length : 0,
	}),
	async run(input: { path: string; old_str: string; new_str: string }, ctx) {
		const { absolute: abs, relative: changedPath } = await safePath(ctx, input.path)
		const changed = async () => {
			try {
				await ctx.changed?.(changedPath)
			} catch (err) {
				throw new Error(`File was changed, but its journal could not be written: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
		if (input.old_str === "") {
			await mkdir(dirname(abs), { recursive: true })
			try {
				await atomicWrite(abs, input.new_str, 0o666, true)
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") {
					throw new Error(`File already exists: ${input.path}. Use a non-empty old_str.`)
				}
				throw err
			}
			await changed()
			return `Created ${input.path} (${input.new_str.split("\n").length} lines).`
		}

		const raw = await readFile(abs, "utf8")
		const mode = (await stat(abs)).mode
		const first = raw.indexOf(input.old_str)
		if (first === -1) throw new Error(`old_str not found in ${input.path}.`)
		if (raw.indexOf(input.old_str, first + 1) !== -1) {
			throw new Error(
				`old_str appears more than once in ${input.path}. Add surrounding context to make it unique.`,
			)
		}
		const next = raw.slice(0, first) + input.new_str + raw.slice(first + input.old_str.length)
		await atomicWrite(abs, next, mode, false)
		await changed()

		const before = raw.slice(0, first).split("\n").length
		const removed = input.old_str.split("\n").map((l) => `-${l}`)
		const added = input.new_str.split("\n").map((l) => `+${l}`)
		return [`${input.path} @ line ${before}`, ...removed, ...added].join("\n")
	},
}

export const globTool: ToolDef = {
	name: "glob",
	description:
		"Find files by path pattern, newest first. Supports * and **. Use this when you know part of a filename; use grep when you know part of the contents.",
	readOnly: true,
	schema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: 'For example "src/**/*.ts".' },
			path: { type: "string", description: "Directory to search from. Defaults to the workspace root." },
		},
		required: ["pattern"],
	},
	async run(input: { pattern: string; path?: string }, ctx) {
		const { absolute: root } = await safePath(ctx, input.path ?? ".")
		const found: Array<{ path: string; mtime: number; dir: boolean }> = []
		await walk(root, root, 32, found)
		const re = globToRegExp(input.pattern)
		const hits = found
			.filter((f) => !f.dir && re.test(f.path))
			.sort((a, b) => b.mtime - a.mtime)
		if (hits.length === 0) return `No files match ${input.pattern}.`
		const shown = hits.slice(0, MAX_GLOB_RESULTS)
		const extra = hits.length > shown.length ? `\n[... ${hits.length - shown.length} more]` : ""
		return shown.map((f) => f.path).join("\n") + extra
	},
}

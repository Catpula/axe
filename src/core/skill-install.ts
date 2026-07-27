import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

export type SkillSource = { owner: string; repo: string; ref: string }

/**
 * `owner/repo`, `owner/repo@ref`, or a full github.com URL. No shorthand for
 * anything else: a source you cannot read at a glance is a source you cannot
 * vet before it runs on your machine.
 */
export function parseSource(source: string): SkillSource {
	const cleaned = source.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")
	const m = /^([\w.-]+)\/([\w.-]+?)(?:@([\w./-]+))?$/.exec(cleaned)
	if (!m) throw new Error(`Not a github source: ${source}. Use owner/repo or owner/repo@ref.`)
	return { owner: m[1]!, repo: m[2]!, ref: m[3] || "HEAD" }
}

export function tarballUrl(s: SkillSource): string {
	return `https://codeload.github.com/${s.owner}/${s.repo}/tar.gz/${s.ref}`
}

/**
 * Refuses anything tar's own `..`/absolute-path rejection did not already
 * catch, and anything that would resolve outside `dest` even through a
 * symlink. Belt and suspenders: the belt is `tar --strip-components`, this is
 * the suspenders.
 */
async function verifyContained(dest: string): Promise<void> {
	const root = resolve(dest)
	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true })
		for (const e of entries) {
			const full = join(dir, e.name)
			const real = resolve(full)
			const rel = relative(root, real)
			if (rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error(`Refusing extracted entry outside destination: ${full}`)
			}
			if (e.isDirectory()) await walk(full)
		}
	}
	await walk(root)
}

async function hasFile(dir: string, name: string): Promise<boolean> {
	try {
		await stat(join(dir, name))
		return true
	} catch {
		return false
	}
}

export type InstallResult = {
	name: string
	path: string
	hasMcpConfig: boolean
	notes: string[]
}

export type InstallOptions = {
	/** Skip the fetch and untar tar entirely; the staging dir already has the files (tests only). */
	stagingDir?: string
	/** Called with the existing path when the target already exists; return true to overwrite. */
	confirmOverwrite?: (path: string) => Promise<boolean> | boolean
}

/**
 * Fetches a repo tarball, untars it under a throwaway staging dir, and only
 * then copies it into `.agents/skills/<name>/` — so a bad download or a path
 * traversal attempt never touches the real skills directory.
 */
export async function installSkill(
	cwd: string,
	source: string,
	opts: InstallOptions = {},
): Promise<InstallResult> {
	const parsed = parseSource(source)
	const name = parsed.repo
	const notes: string[] = []

	let staging = opts.stagingDir
	let cleanup: (() => Promise<void>) | null = null
	if (!staging) {
		const url = tarballUrl(parsed)
		const res = await fetch(url)
		if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`)
		const buf = Buffer.from(await res.arrayBuffer())

		const work = await mkdtemp(join(tmpdir(), "axe-skill-"))
		cleanup = () => rm(work, { recursive: true, force: true })
		const tarPath = join(work, "pkg.tar.gz")
		await writeFile(tarPath, buf)
		staging = join(work, "extracted")
		await mkdir(staging, { recursive: true })
		try {
			// GitHub tarballs wrap everything in one `<repo>-<ref>/` directory;
			// strip it so the skill files land directly in `staging`. GNU tar
			// itself refuses `..` and absolute-path entries before this ever runs.
			execFileSync("tar", ["-xzf", tarPath, "-C", staging, "--strip-components=1"], {
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch (err) {
			await cleanup()
			const msg = err instanceof Error ? err.message : String(err)
			throw new Error(`tar failed to extract ${url}: ${msg}`)
		}
	}

	try {
		await verifyContained(staging)

		if (!(await hasFile(staging, "SKILL.md"))) {
			throw new Error(`${source}: no SKILL.md at the repo root after extraction.`)
		}

		const hasMcpConfig = await hasFile(staging, "mcp.json")
		if (hasMcpConfig) {
			notes.push(
				`WARNING: ${name} bundles an mcp.json. axe will NOT approve it automatically. ` +
					`Review it, then run \`axe mcp approve ${name}\` yourself if you trust it.`,
			)
		}

		const dest = join(cwd, ".agents", "skills", name)
		if (await hasFile(dest, "SKILL.md")) {
			const overwrite = opts.confirmOverwrite ? await opts.confirmOverwrite(dest) : false
			if (!overwrite) {
				throw new Error(`${dest} already exists. Remove it yourself, then run this again.`)
			}
			await rm(dest, { recursive: true, force: true })
		}

		await mkdir(join(cwd, ".agents", "skills"), { recursive: true })
		await cp(staging, dest, { recursive: true })

		return { name, path: dest, hasMcpConfig, notes }
	} finally {
		if (cleanup) await cleanup()
	}
}

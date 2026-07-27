import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

const ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000

function randomName(prefix: string): string {
	return `${prefix}-${randomBytes(12).toString("hex")}.log`
}

async function workspaceRoot(cwd: string): Promise<string> {
	return realpath(cwd)
}

function contained(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function artifactDir(cwd: string): Promise<{ root: string; dir: string }> {
	const root = await workspaceRoot(cwd)
	const axeRequested = join(root, ".axe")
	await mkdir(axeRequested, { recursive: true, mode: 0o700 })
	const axe = await realpath(axeRequested)
	if (!contained(root, axe)) throw new Error("Artifact directory escapes the workspace root")
	const requested = join(axe, "artifacts")
	await mkdir(requested, { recursive: true, mode: 0o700 })
	const dir = await realpath(requested)
	if (!contained(root, dir)) throw new Error("Artifact directory escapes the workspace root")
	return { root, dir }
}

export type Artifact = { handle: Awaited<ReturnType<typeof open>>; relative: string; absolute: string }

export async function openArtifact(cwd: string, prefix: string): Promise<Artifact> {
	const { root, dir } = await artifactDir(cwd)
	const absolute = join(dir, randomName(prefix.replace(/[^A-Za-z0-9_-]/g, "-") || "artifact"))
	const handle = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
	return { handle, absolute, relative: relative(root, absolute) }
}

export async function saveArtifact(cwd: string, prefix: string, content: string): Promise<string> {
	const artifact = await openArtifact(cwd, prefix)
	let complete = false
	try {
		await artifact.handle.writeFile(content, "utf8")
		await artifact.handle.sync()
		await artifact.handle.close()
		complete = true
		return artifact.relative
	} finally {
		if (!complete) {
			await artifact.handle.close().catch(() => {})
			await unlink(artifact.absolute).catch(() => {})
		}
	}
}

export async function cleanupArtifacts(cwd: string, now = Date.now()): Promise<void> {
	let dir: string
	try {
		dir = (await artifactDir(cwd)).dir
	} catch {
		return
	}
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isFile() || !/^[A-Za-z0-9_-]+-[a-f0-9]{24}\.log$/.test(entry.name)) continue
		const path = join(dir, entry.name)
		try {
			if (now - (await stat(path)).mtimeMs > ARTIFACT_TTL_MS) await unlink(path)
		} catch {}
	}
}

/**
 * The rename is only durable once the directory entry is on disk, so this is not
 * optional where it works. Windows has no directory fsync at all and answers
 * EPERM: there the rename is already ordered by the filesystem, so swallowing it
 * is the honest reading rather than failing every write on the platform.
 */
async function syncDirectory(path: string): Promise<void> {
	let dir
	try {
		dir = await open(path, constants.O_RDONLY)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM") return
		throw err
	}
	try {
		await dir.sync()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err
	} finally {
		await dir.close()
	}
}

export async function atomicWrite(path: string, content: string, mode: number, create: boolean): Promise<void> {
	const parent = dirname(path)
	const temp = join(parent, `.axe-edit-${randomBytes(12).toString("hex")}`)
	const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode & 0o7777)
	let closed = false
	try {
		await handle.writeFile(content, "utf8")
		await handle.sync()
		await handle.close()
		closed = true
		if (create) {
			await link(temp, path)
			await unlink(temp)
		} else {
			await chmod(temp, mode & 0o7777)
			await rename(temp, path)
		}
		await syncDirectory(parent)
	} catch (err) {
		throw err
	} finally {
		if (!closed) await handle.close().catch(() => {})
		await unlink(temp).catch(() => {})
	}
}

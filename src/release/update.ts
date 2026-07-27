/**
 * `axe update`: replace the running binary with the latest release asset.
 *
 * Everything that can be a pure function is one, because the parts that break
 * are version comparison, asset naming, and checksum parsing, not the fetch.
 * The download and the swap take their filesystem and network at the boundary
 * so the test can replace them.
 */
import { createHash } from "node:crypto"
import { chmod, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { REPO, VERSION } from "../version.ts"

export const CHECKSUM_FILE = "SHA256SUMS"

/** The platforms `scripts/release.ts` builds for. */
export const TARGETS: Record<string, string> = {
	"linux-x64": "bun-linux-x64",
	"linux-arm64": "bun-linux-arm64",
	"darwin-x64": "bun-darwin-x64",
	"darwin-arm64": "bun-darwin-arm64",
}

export type Asset = { name: string; url: string }
export type Release = { version: string; assets: Asset[]; url?: string }

/**
 * Semver-lite. Enough for our own tags: three numbers, an optional prerelease
 * that sorts below the release it precedes. Anything unparseable sorts lowest,
 * so a malformed tag never wins and never triggers an update.
 */
export function parseVersion(raw: string): { nums: number[]; pre: string } | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
	if (!m) return null
	return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" }
}

export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a)
	const pb = parseVersion(b)
	if (!pa && !pb) return 0
	if (!pa) return -1
	if (!pb) return 1
	for (let i = 0; i < 3; i++) {
		const d = pa.nums[i]! - pb.nums[i]!
		if (d !== 0) return d < 0 ? -1 : 1
	}
	if (pa.pre === pb.pre) return 0
	if (!pa.pre) return 1
	if (!pb.pre) return -1
	return pa.pre < pb.pre ? -1 : 1
}

/** null means we publish nothing for this platform, which is not an error. */
export function assetName(platform: string, arch: string): string | null {
	const key = `${platform}-${arch}`
	return TARGETS[key] ? `axe-${key}` : null
}

export function parseRelease(json: unknown): Release {
	const r = json as { tag_name?: unknown; html_url?: unknown; assets?: unknown }
	const tag = typeof r?.tag_name === "string" ? r.tag_name : ""
	if (!tag) throw new Error("Release feed has no tag_name.")
	const raw = Array.isArray(r.assets) ? r.assets : []
	const assets: Asset[] = []
	for (const a of raw as { name?: unknown; browser_download_url?: unknown }[]) {
		if (typeof a?.name === "string" && typeof a.browser_download_url === "string") {
			assets.push({ name: a.name, url: a.browser_download_url })
		}
	}
	return { version: tag, assets, url: typeof r.html_url === "string" ? r.html_url : undefined }
}

/** `<sha256>  <name>`, the format sha256sum writes and reads. */
export function parseChecksums(text: string): Map<string, string> {
	const out = new Map<string, string>()
	for (const line of text.split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim())
		if (m) out.set(basename(m[2]!), m[1]!)
	}
	return out
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

const RUNTIMES = new Set(["node", "bun", "deno", "node.exe", "bun.exe"])

/**
 * Getting this wrong would overwrite the user's node binary, so it fails closed:
 * only a path we recognise as ours is ever replaced. The three cases are worth
 * telling apart because the fix differs — a source checkout wants `git pull`,
 * and a renamed binary wants its name back, not a lecture about git.
 */
export function installKind(execPath: string): "binary" | "source" | "renamed" {
	const name = basename(execPath)
	if (name === "axe") return "binary"
	return RUNTIMES.has(name) ? "source" : "renamed"
}

export type UpdateEnv = {
	execPath: string
	platform: string
	arch: string
	version: string
	/** Injected so the test never touches the network. */
	fetch: typeof globalThis.fetch
	log: (message: string) => void
	/** Ask before writing. Absent means yes. */
	confirm?: () => Promise<boolean>
}

export type UpdateResult =
	| { status: "current"; version: string }
	| { status: "available"; version: string; url?: string }
	| { status: "updated"; version: string }
	| { status: "declined"; version: string }
	| { status: "unsupported"; reason: string }

/**
 * The API endpoint answers 415 to an octet-stream Accept, and an asset download
 * answers with a redirect only when asked for the bytes, so the two differ.
 */
async function get(env: UpdateEnv, url: string, accept = "application/octet-stream"): Promise<Response> {
	const headers: Record<string, string> = {
		"user-agent": `axe/${env.version}`,
		accept,
	}
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
	if (token) headers.authorization = `Bearer ${token}`
	const res = await env.fetch(url, { headers, redirect: "follow" })
	if (res.status === 404 && url.includes("/releases/latest")) {
		// A repo with no published release, or a private one seen without a token.
		throw new Error(`${REPO} has no published release. Set GITHUB_TOKEN if it is private.`)
	}
	if (!res.ok) throw new Error(await httpError(res, url, Boolean(token)))
	return res
}

/**
 * GitHub explains itself in the response body and the rate limit headers. A bare
 * status code throws that away, and 403-because-rate-limited is the failure an
 * unauthenticated user hits most: sixty requests an hour, shared per IP.
 */
export async function httpError(res: Response, url: string, authed: boolean): Promise<string> {
	const remaining = res.headers.get("x-ratelimit-remaining")
	if ((res.status === 403 || res.status === 429) && remaining === "0") {
		const reset = Number(res.headers.get("x-ratelimit-reset"))
		const wait = Number.isFinite(reset) && reset > 0 ? ` Try again after ${new Date(reset * 1_000).toISOString().slice(11, 16)} UTC.` : ""
		const token = authed ? "" : " Set GITHUB_TOKEN for a higher limit."
		return `GitHub rate limit reached.${wait}${token}`
	}
	let detail = ""
	try {
		const body = (await res.text()).slice(0, 2_000)
		const parsed = JSON.parse(body) as { message?: unknown }
		if (typeof parsed?.message === "string") detail = ` ${parsed.message}`
	} catch {
		// Not JSON, or the body is gone. The status code still has to be reported.
	}
	return `${url} returned ${res.status}.${detail}`
}

export async function latestRelease(env: UpdateEnv): Promise<Release> {
	const res = await get(
		env,
		`https://api.github.com/repos/${REPO}/releases/latest`,
		"application/vnd.github+json",
	)
	return parseRelease(await res.json())
}

/**
 * Downloads next to the running binary and renames over it, so the swap is
 * atomic and a half-written download can never be executed. Same directory on
 * purpose: rename across filesystems is not atomic and would fail on EXDEV.
 */
async function swapBinary(env: UpdateEnv, bytes: Uint8Array): Promise<void> {
	const dir = dirname(env.execPath)
	const tmp = join(dir, `.axe-update-${process.pid}`)
	try {
		await writeFile(tmp, bytes)
		await chmod(tmp, 0o755)
		await rename(tmp, env.execPath)
	} catch (err) {
		await unlink(tmp).catch(() => {})
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`Cannot replace ${env.execPath}: ${msg}`)
	}
}

/**
 * `check` only reports. Without it the binary is verified against the published
 * checksum and replaced; a mismatch aborts before anything is written.
 */
export async function update(env: UpdateEnv, opts: { check?: boolean } = {}): Promise<UpdateResult> {
	const kind = installKind(env.execPath)
	if (kind === "source") {
		return {
			status: "unsupported",
			reason: "axe is running from a source checkout. Update it with git pull.",
		}
	}
	if (kind === "renamed") {
		return {
			status: "unsupported",
			reason: `axe only replaces a binary named axe, and this one is ${basename(env.execPath)}. Rename it, or download the new binary yourself.`,
		}
	}
	const want = assetName(env.platform, env.arch)
	if (!want) {
		return { status: "unsupported", reason: `No release is built for ${env.platform}-${env.arch}.` }
	}

	const release = await latestRelease(env)
	if (compareVersions(release.version, env.version) <= 0) {
		return { status: "current", version: env.version }
	}
	if (opts.check) return { status: "available", version: release.version, url: release.url }

	const asset = release.assets.find((a) => a.name === want)
	if (!asset) {
		return {
			status: "unsupported",
			reason: `Release ${release.version} has no ${want} asset.`,
		}
	}
	const sums = release.assets.find((a) => a.name === CHECKSUM_FILE)
	if (!sums) {
		// Unsigned bytes over the wire, straight onto an executable path. Never.
		return { status: "unsupported", reason: `Release ${release.version} publishes no ${CHECKSUM_FILE}.` }
	}

	if (env.confirm && !(await env.confirm())) {
		return { status: "declined", version: release.version }
	}

	env.log(`Downloading axe ${release.version} for ${env.platform}-${env.arch}.`)
	const expected = parseChecksums(await (await get(env, sums.url)).text()).get(want)
	if (!expected) throw new Error(`${CHECKSUM_FILE} has no entry for ${want}.`)

	const bytes = new Uint8Array(await (await get(env, asset.url)).arrayBuffer())
	const actual = sha256(bytes)
	if (actual !== expected) {
		throw new Error(`Checksum mismatch for ${want}. Expected ${expected}, got ${actual}.`)
	}

	await swapBinary(env, bytes)
	return { status: "updated", version: release.version }
}

export function defaultEnv(log: (s: string) => void): UpdateEnv {
	return {
		execPath: process.execPath,
		platform: process.platform,
		arch: process.arch,
		version: VERSION,
		fetch: globalThis.fetch,
		log,
	}
}

export function describe(result: UpdateResult, current: string): string {
	switch (result.status) {
		case "current":
			return `axe ${current} is the latest release.`
		case "available":
			return `axe ${result.version} is available. Run axe update.${result.url ? `\n${result.url}` : ""}`
		case "updated":
			return `Updated to axe ${result.version}. Restart axe to use it.`
		case "declined":
			return "Left alone."
		case "unsupported":
			return result.reason
	}
}

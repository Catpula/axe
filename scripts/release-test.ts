/**
 * Update logic. The network is faked at the boundary (a fetch function passed
 * in), the filesystem is real: the swap is the part that has to be atomic, and
 * a fake rename would prove nothing.
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	CHECKSUM_FILE,
	assetName,
	compareVersions,
	describe,
	httpError,
	installKind,
	parseChecksums,
	parseRelease,
	parseVersion,
	sha256,
	update,
	type UpdateEnv,
} from "../src/release/update.ts"
import { VERSION } from "../src/version.ts"

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

// The binary carries its own version because a compiled binary has no
// package.json to read. Drift makes `axe update` compare against a lie.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
check("version matches package.json", pkg.version === VERSION, `${pkg.version} vs ${VERSION}`)

// Version comparison.
check("parses a plain version", parseVersion("1.2.3")?.nums.join(".") === "1.2.3")
check("parses a v prefix", parseVersion("v1.2.3")?.nums.join(".") === "1.2.3")
check("rejects rubbish", parseVersion("latest") === null)
check("newer patch wins", compareVersions("0.1.1", "0.1.0") === 1)
check("newer minor wins", compareVersions("0.2.0", "0.1.9") === 1)
check("newer major wins", compareVersions("1.0.0", "0.9.9") === 1)
check("equal is zero", compareVersions("v1.0.0", "1.0.0") === 0)
check("prerelease sorts below its release", compareVersions("1.0.0-rc.1", "1.0.0") === -1)
check("an unparseable tag never wins", compareVersions("nightly", "0.0.1") === -1)

// Asset naming.
check("names a linux asset", assetName("linux", "x64") === "axe-linux-x64")
check("names a mac asset", assetName("darwin", "arm64") === "axe-darwin-arm64")
check("unpublished platforms are null", assetName("win32", "x64") === null)
check("unpublished arches are null", assetName("linux", "riscv64") === null)

// Release feed.
const feed = {
	tag_name: "v0.2.0",
	html_url: "https://example.invalid/releases/v0.2.0",
	assets: [
		{ name: "axe-linux-x64", browser_download_url: "https://example.invalid/axe-linux-x64" },
		{ name: CHECKSUM_FILE, browser_download_url: "https://example.invalid/SHA256SUMS" },
		{ name: "no-url" },
	],
}
const release = parseRelease(feed)
check("reads the tag", release.version === "v0.2.0")
check("reads the assets", release.assets.length === 2)
check("drops an asset with no url", !release.assets.some((a) => a.name === "no-url"))
check("keeps the release url", release.url === "https://example.invalid/releases/v0.2.0")
check(
	"a feed with no tag is an error",
	(() => {
		try {
			parseRelease({ assets: [] })
			return false
		} catch {
			return true
		}
	})(),
)

// Checksums.
const sums = parseChecksums(
	`${"a".repeat(64)}  axe-linux-x64\n${"b".repeat(64)} *dist/axe-darwin-arm64\nnot a line\n`,
)
check("reads a sha256sum line", sums.get("axe-linux-x64") === "a".repeat(64))
check("reads the binary marker and strips the path", sums.get("axe-darwin-arm64") === "b".repeat(64))
check("ignores junk", sums.size === 2)

// Install kind: never overwrite the user's node, and tell the three cases apart
// so a renamed binary is not told to run git pull.
check("a compiled binary is updatable", installKind("/usr/local/bin/axe") === "binary")
check("node is a source checkout", installKind("/usr/bin/node") === "source")
check("bun is a source checkout", installKind("/home/me/.bun/bin/bun") === "source")
check("a renamed copy is neither", installKind("/usr/local/bin/axe-old") === "renamed")

// The download and the swap, against a real file.
const tmp = await mkdtemp(join(tmpdir(), "axe-release-"))
const binary = join(tmp, "axe")
await writeFile(binary, "OLD BINARY")

const payload = new TextEncoder().encode("NEW BINARY")
const digest = sha256(payload)

type Route = { body: string | Uint8Array; status?: number }
function fakeFetch(routes: Record<string, Route>, seen: string[] = []): typeof globalThis.fetch {
	return (async (url: string | URL) => {
		const key = String(url)
		seen.push(key)
		const route = routes[key]
		if (!route) return new Response("not found", { status: 404 })
		const body = typeof route.body === "string" ? route.body : (route.body as Uint8Array)
		return new Response(body as any, { status: route.status ?? 200 })
	}) as typeof globalThis.fetch
}

const API = "https://api.github.com/repos/Catpula/axe/releases/latest"
const routes = (sumsBody: string, binaryBody: Uint8Array): Record<string, Route> => ({
	[API]: { body: JSON.stringify(feed) },
	"https://example.invalid/SHA256SUMS": { body: sumsBody },
	"https://example.invalid/axe-linux-x64": { body: binaryBody },
})

const logs: string[] = []
function env(over: Partial<UpdateEnv> = {}, fetchImpl?: typeof globalThis.fetch): UpdateEnv {
	return {
		execPath: binary,
		platform: "linux",
		arch: "x64",
		version: "0.1.0",
		fetch: fetchImpl ?? fakeFetch(routes(`${digest}  axe-linux-x64\n`, payload)),
		log: (s) => logs.push(s),
		...over,
	}
}

const seen: string[] = []
const checked = await update(env({}, fakeFetch(routes(`${digest}  axe-linux-x64\n`, payload), seen)), {
	check: true,
})
check("--check reports the newer version", checked.status === "available")
check("--check downloads nothing", seen.length === 1, seen.join(", "))
check("--check leaves the binary alone", (await readFile(binary, "utf8")) === "OLD BINARY")

const current = await update(env({ version: "9.9.9" }))
check("a newer local version is current", current.status === "current")
check("current leaves the binary alone", (await readFile(binary, "utf8")) === "OLD BINARY")

const source = await update(env({ execPath: "/usr/bin/node" }))
check("a source checkout is refused", source.status === "unsupported")
check(
	"and says why",
	source.status === "unsupported" && source.reason.includes("git pull"),
)

const renamed = await update(env({ execPath: join(tmp, "axe-nightly") }))
check("a renamed binary is refused", renamed.status === "unsupported")
check(
	"and is not told to use git",
	renamed.status === "unsupported" &&
		renamed.reason.includes("axe-nightly") &&
		!renamed.reason.includes("git pull"),
	renamed.status === "unsupported" ? renamed.reason : "",
)

const foreign = await update(env({ platform: "win32" }))
check("an unpublished platform is refused", foreign.status === "unsupported")

const declined = await update(env({ confirm: async () => false }))
check("a declined update writes nothing", declined.status === "declined")
check("declined leaves the binary alone", (await readFile(binary, "utf8")) === "OLD BINARY")

let mismatch = ""
try {
	await update(env({}, fakeFetch(routes(`${"c".repeat(64)}  axe-linux-x64\n`, payload))))
} catch (err) {
	mismatch = err instanceof Error ? err.message : String(err)
}
check("a checksum mismatch throws", mismatch.includes("Checksum mismatch"))
check("a mismatch leaves the binary alone", (await readFile(binary, "utf8")) === "OLD BINARY")

let missing = ""
try {
	await update(env({}, fakeFetch(routes("", payload))))
} catch (err) {
	missing = err instanceof Error ? err.message : String(err)
}
check("an unlisted asset throws", missing.includes("no entry"))
check("unlisted leaves the binary alone", (await readFile(binary, "utf8")) === "OLD BINARY")

const noSums = await update(
	env(
		{},
		fakeFetch({
			[API]: {
				body: JSON.stringify({ ...feed, assets: [feed.assets[0]] }),
			},
		}),
	),
)
check("a release with no SHA256SUMS is refused", noSums.status === "unsupported")

// GitHub says why in the body and the headers. A bare status code throws that
// away, and 403-because-rate-limited is what an unauthenticated user hits first.
const limited = new Response("{}", {
	status: 403,
	headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1785059335" },
})
const limitedMsg = await httpError(limited, API, false)
check("a rate limit says so", limitedMsg.includes("rate limit"), limitedMsg)
check("and does not just print a status code", !limitedMsg.includes("403"), limitedMsg)
check("and suggests a token when there is none", limitedMsg.includes("GITHUB_TOKEN"), limitedMsg)
check("and says when it resets", /\d\d:\d\d UTC/.test(limitedMsg), limitedMsg)
const limitedAuthed = await httpError(
	new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
	API,
	true,
)
check("no token advice when one was sent", !limitedAuthed.includes("GITHUB_TOKEN"), limitedAuthed)
const forbidden = await httpError(
	new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
	API,
	true,
)
check("other errors keep the status", forbidden.includes("401"), forbidden)
check("and carry GitHub's own message", forbidden.includes("Bad credentials"), forbidden)
const htmlError = await httpError(new Response("<html>nope</html>", { status: 502 }), API, false)
check("a non-JSON body is not a crash", htmlError.includes("502"), htmlError)

let noRelease = ""
try {
	await update(env({}, fakeFetch({})))
} catch (err) {
	noRelease = err instanceof Error ? err.message : String(err)
}
check("a repo with no release says so", noRelease.includes("no published release"), noRelease)

const done = await update(env({ confirm: async () => true }))
check("a verified update replaces the binary", done.status === "updated")
check("the new bytes are on disk", (await readFile(binary, "utf8")) === "NEW BINARY")
check("the binary stays executable", ((await stat(binary)).mode & 0o111) !== 0)
check("nothing is left behind", !(await stat(join(tmp, `.axe-update-${process.pid}`)).catch(() => null)))
check("the download was announced", logs.some((l) => l.includes("0.2.0")))

check("describe covers updated", describe(done, VERSION).includes("Restart"))
check("describe covers current", describe(current, VERSION).includes("latest"))
check("describe covers unsupported", describe(source, VERSION).includes("git pull"))

console.log(`release: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

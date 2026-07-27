// Exercises the core tools against a scratch workspace. No API key and no
// network needed: web_fetch runs against a fake fetch, per the testing rule.
import { chmod, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolRegistry, execTool } from "../src/core/tools.ts"
import { cleanupArtifacts, saveArtifact } from "../src/artifacts.ts"
import { imageBlocks } from "../src/images.ts"
import { withEditCheck } from "../src/tools/check.ts"
import { editFileTool } from "../src/tools/fs.ts"
import { coreTools } from "../src/tools/index.ts"

const cwd = await mkdtemp(join(tmpdir(), "axe-smoke-"))
await writeFile(join(cwd, "a.ts"), "export const alpha = 1\nexport const beta = 2\n")

const reg = coreTools()
const changed: string[] = []
const ctx = { cwd, signal: new AbortController().signal, log: () => {}, changed: async (path: string) => { changed.push(path) } }
let failures = 0

async function check(name: string, input: unknown, expect: RegExp) {
	const out = await execTool(reg, name, input, ctx)
	const ok = !out.isError && expect.test(out.content)
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${name}  ${out.content.split("\n")[0]}`)
}

function assert(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  ${detail}`}`)
}

async function rejects(label: string, name: string, input: unknown) {
	const out = await execTool(reg, name, input, ctx)
	assert(`${label} rejected`, out.isError, out.content.split("\n")[0])
}

await check("list_files", {}, /a\.ts/)
await check("read_file", { path: "a.ts" }, /1\texport const alpha/)
await writeFile(join(cwd, "long.txt"), "x".repeat(40_000))
const longPage = await execTool(reg, "read_file", { path: "long.txt", char_offset: 20_000, char_limit: 100 }, ctx)
assert("read_file pages a single long line by character", !longPage.isError && longPage.content.startsWith("x".repeat(100)) && /char_offset=20100/.test(longPage.content), longPage.content.slice(-100))
await check("glob", { pattern: "*.ts" }, /a\.ts/)
await check("grep", { pattern: "beta" }, /beta/)
await check("edit_file", { path: "a.ts", old_str: "alpha = 1", new_str: "alpha = 42" }, /^\+alpha = 42$/m)
await check("edit_file", { path: "new/b.txt", old_str: "", new_str: "hi" }, /Created new\/b\.txt/)
await chmod(join(cwd, "a.ts"), 0o751)
await check("edit_file", { path: "a.ts", old_str: "beta = 2", new_str: "beta = 3" }, /^\+beta = 3$/m)
assert("atomic replacement preserves mode bits", ((await stat(join(cwd, "a.ts"))).mode & 0o777) === 0o751)
assert("edits report their changed files", JSON.stringify(changed) === JSON.stringify(["a.ts", "new/b.txt", "a.ts"]), JSON.stringify(changed))
await check("bash", { cmd: "echo hello" }, /hello/)
const failedBash = await execTool(reg, "bash", { cmd: "printf partial-output; exit 7" }, ctx)
const failedArtifact = /full output: (\S+\.log)/.exec(failedBash.content)?.[1] ?? ""
assert("a failed command keeps partial output and its artifact", failedBash.isError && failedArtifact !== "" && /partial-output/.test(failedBash.content), failedBash.content)
assert("a failed command artifact is readable", failedArtifact !== "" && /partial-output/.test(await readFile(join(cwd, failedArtifact), "utf8")), failedArtifact)

// Failures must come back as tool_result errors, never as thrown exceptions.
const missing = await execTool(reg, "read_file", { path: "nope.txt" }, ctx)
const escape = await execTool(reg, "read_file", { path: "../../etc/passwd" }, ctx)
const ambiguous = await execTool(reg, "edit_file", { path: "a.ts", old_str: "export", new_str: "x" }, ctx)
for (const [label, r] of [["missing file", missing], ["path escape", escape], ["ambiguous old_str", ambiguous]] as const) {
	if (!r.isError) failures++
	console.log(`${r.isError ? "ok  " : "FAIL"} ${label} rejected`)
}

// A symlink is a path that starts inside the workspace and ends anywhere on the
// disk. Comparing the strings alone let read_file and edit_file walk out.
const outside = await mkdtemp(join(tmpdir(), "axe-outside-"))
await writeFile(join(outside, "secret.txt"), "top secret\n")
await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"))
await symlink(outside, join(cwd, "outdir"))
await symlink(join(cwd, "a.ts"), join(cwd, "inside.ts"))

await rejects("symlinked file out of the workspace", "read_file", { path: "link.txt" })
await rejects("file under a symlinked directory", "read_file", { path: "outdir/secret.txt" })
await rejects("edit through a symlink", "edit_file", {
	path: "link.txt",
	old_str: "top secret",
	new_str: "owned",
})
await rejects("create under a symlinked directory", "edit_file", {
	path: "outdir/planted.txt",
	old_str: "",
	new_str: "owned",
})
assert(
	"the file outside is untouched",
	(await readFile(join(outside, "secret.txt"), "utf8")) === "top secret\n",
)
const insideLink = await execTool(reg, "read_file", { path: "inside.ts" }, ctx)
assert(
	"a symlink inside the workspace still reads",
	!insideLink.isError && /alpha = 42/.test(insideLink.content),
	insideLink.content.split("\n")[0],
)

// Output is trimmed while the command runs. Buffering first and clamping at
// exit means a command that prints forever takes the whole process with it.
const huge = await execTool(reg, "bash", { cmd: "yes aaaaaaaaaaaaaaaaaaaa | head -n 200000" }, ctx)
assert("a flood of output is not an error", !huge.isError, huge.content.slice(0, 80))
assert("a flood of output is clamped", huge.content.length <= 30_000, String(huge.content.length))
assert("and says what it dropped", /characters truncated/.test(huge.content))
const hugeArtifact = /full output: (\S+\.log)/.exec(huge.content)?.[1] ?? ""
assert("and keeps both ends", huge.content.startsWith("aaaa") && huge.content.endsWith("aaaa"))
const fullHuge = hugeArtifact ? await readFile(join(cwd, hugeArtifact), "utf8") : ""
assert("and preserves the full output as an artifact", fullHuge.length > 1_000_000 && fullHuge.startsWith("aaaa"), hugeArtifact)
const staleArtifact = await saveArtifact(cwd, "stale", "old")
const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
await utimes(join(cwd, staleArtifact), staleTime, staleTime)
await writeFile(join(cwd, ".axe", "artifacts", "keep-me.txt"), "user file")
await utimes(join(cwd, ".axe", "artifacts", "keep-me.txt"), staleTime, staleTime)
await cleanupArtifacts(cwd)
assert("artifact cleanup removes logs older than 30 days", !(await stat(join(cwd, staleArtifact)).catch(() => null)))
assert("artifact cleanup preserves files it does not manage", Boolean(await stat(join(cwd, ".axe", "artifacts", "keep-me.txt")).catch(() => null)))

const escapedRoot = await mkdtemp(join(tmpdir(), "axe-artifact-link-"))
const escapedTarget = await mkdtemp(join(tmpdir(), "axe-artifact-outside-"))
await symlink(escapedTarget, join(escapedRoot, ".axe"))
let artifactEscaped = false
try {
	await saveArtifact(escapedRoot, "escape", "no")
} catch {
	artifactEscaped = true
}
assert("artifact storage rejects a symlinked .axe outside the workspace", artifactEscaped)

// The command runs with the user's shell but not with the user's keys.
process.env.AXE_SMOKE_API_KEY = "sk-leak"
process.env.AXE_SMOKE_PLAIN = "kept"
const env = await execTool(
	reg,
	"bash",
	{ cmd: 'echo "key=${AXE_SMOKE_API_KEY:-gone} plain=${AXE_SMOKE_PLAIN:-gone}"' },
	ctx,
)
assert("a credential never reaches the command", /key=gone/.test(env.content), env.content)
assert("ordinary variables still do", /plain=kept/.test(env.content), env.content)

// Scrubbing the inherited environment proves nothing on its own: this is a
// login shell, so the profile runs first, and exporting a key from ~/.bashrc is
// exactly what the README tells people to do.
const fakeHome = await mkdtemp(join(tmpdir(), "axe-home-"))
await writeFile(join(fakeHome, ".bash_profile"), 'export AXE_SMOKE_PROFILE_API_KEY=sk-from-profile\n')
const realHome = process.env.HOME
process.env.HOME = fakeHome
const profileEnv = await execTool(
	reg,
	"bash",
	{ cmd: 'echo "profile=${AXE_SMOKE_PROFILE_API_KEY:-gone}"' },
	ctx,
)
process.env.HOME = realHome
assert(
	"a credential exported by the profile is unset too",
	/profile=gone/.test(profileEnv.content),
	profileEnv.content,
)

// Killing bash alone leaves the grandchild holding the pipes, and axe never
// exits. The whole process group has to go.
const timedOut = await execTool(
	reg,
	"bash",
	{ cmd: "sleep 30 & echo $! > grandchild.pid; wait", timeout_ms: 700 },
	ctx,
)
assert("a hung command times out", timedOut.isError && /timed out/.test(timedOut.content), timedOut.content)
const grandchild = Number((await readFile(join(cwd, "grandchild.pid"), "utf8")).trim())
await new Promise((r) => setTimeout(r, 400))
let alive = true
try {
	process.kill(grandchild, 0)
} catch {
	alive = false
}
assert("the whole process tree is dead", !alive, `pid ${grandchild} survived`)

// A backgrounded command has to come back before it is done, keep running, and
// leave its output somewhere greppable. Without that there is no feedback loop
// for a dev server: the agent can only start one and never look at it.
const bg = await execTool(
	reg,
	"bash",
	{ cmd: "echo started; sleep 0.4; echo finished", background: true },
	ctx,
)
const logPath = /appended to: (\S+)/.exec(bg.content)?.[1] ?? ""
assert("a background command returns at once", !bg.isError && logPath !== "", bg.content)
await new Promise((r) => setTimeout(r, 900))
const bgLog = logPath ? await readFile(join(cwd, logPath), "utf8") : ""
assert("it kept running after the tool returned", /finished/.test(bgLog), bgLog)
const bgViaTool = await execTool(reg, "read_file", { path: logPath }, ctx)
assert("a background artifact is readable by read_file", !bgViaTool.isError && /finished/.test(bgViaTool.content), bgViaTool.content)

// Backgrounding must not become a hole in the scrub: the same command run in
// the foreground cannot see a key, so neither can this one.
const bgEnv = await execTool(
	reg,
	"bash",
	{ cmd: 'echo "key=${AXE_SMOKE_API_KEY:-gone}"', background: true },
	ctx,
)
const bgEnvPath = /appended to: (\S+)/.exec(bgEnv.content)?.[1] ?? ""
await new Promise((r) => setTimeout(r, 500))
const bgEnvLog = bgEnvPath ? await readFile(join(cwd, bgEnvPath), "utf8") : ""
assert("a background command cannot read a credential either", /key=gone/.test(bgEnvLog), bgEnvLog)
for (const p of [logPath, bgEnvPath, hugeArtifact, failedArtifact]) if (p) await rm(join(cwd, p), { force: true })

// Without ripgrep the pattern is compiled and run here, on the main thread.
const path = process.env.PATH
process.env.PATH = join(cwd, "no-tools")
await check("grep", { pattern: "beta" }, /beta/)
await rejects("an unparseable pattern", "grep", { pattern: "a(" })
const cancelled = await execTool(reg, "grep", { pattern: "beta" }, {
	...ctx,
	signal: AbortSignal.abort(),
})
assert("a cancelled scan reports partial results", /cancelled/.test(cancelled.content), cancelled.content)
process.env.PATH = path

// The edit check appends to the result only when it fails; the edit itself
// already happened, so a failing check never becomes a tool error.
const passing = new ToolRegistry().register(withEditCheck(editFileTool, "true"))
const quietEdit = await execTool(passing, "edit_file", { path: "c1.txt", old_str: "", new_str: "x" }, ctx)
assert("a passing check is silent", !quietEdit.isError && !quietEdit.content.includes("[check"), quietEdit.content)
const failing = new ToolRegistry().register(withEditCheck(editFileTool, "echo boom >&2; exit 3"))
const noisyEdit = await execTool(failing, "edit_file", { path: "c2.txt", old_str: "", new_str: "x" }, ctx)
assert(
	"a failing check rides back in the result",
	!noisyEdit.isError && /\[check "echo boom >&2; exit 3" exited 3\]/.test(noisyEdit.content) && /boom/.test(noisyEdit.content),
	noisyEdit.content,
)
const brokenEdit = await execTool(failing, "edit_file", { path: "a.ts", old_str: "no such text", new_str: "x" }, ctx)
assert("a failed edit skips the check and stays an error", brokenEdit.isError && !brokenEdit.content.includes("[check"))

// A typed image path becomes an attachment; a word that only looks like one does not.
await writeFile(join(cwd, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
await writeFile(join(cwd, "huge.png"), Buffer.alloc(5_000_001))
const attached = await imageBlocks("compare shot.png with shot.png and ghost.png", cwd)
assert(
	"an existing image path is attached once",
	attached.blocks.length === 1 &&
		attached.blocks[0]!.type === "image" &&
		attached.blocks[0]!.mime === "image/png" &&
		attached.blocks[0]!.data.length > 0,
	JSON.stringify(attached.notes),
)
assert("a path to nothing stays plain text", !attached.notes.some((n) => n.includes("ghost")))
const absolute = await imageBlocks(`see ${join(cwd, "shot.png")}`, "/nonexistent")
assert("an absolute path works from anywhere", absolute.blocks.length === 1)
const oversized = await imageBlocks("see huge.png", cwd)
assert(
	"an oversized image is skipped with a note",
	oversized.blocks.length === 0 && oversized.notes.some((n) => n.includes("over the")),
	JSON.stringify(oversized.notes),
)

// web_fetch never touches the network here; the boundary is replaced, not the tool.
const realFetch = globalThis.fetch
const PAGE = [
	"<html><head><title>t</title><style>.x{color:red}</style></head><body>",
	"<h1>Widget Manual</h1><script>var secret=1</script>",
	"<p>Hello &amp; welcome to the &#x2603; page.</p>",
	'<ul><li>first</li><li>second</li></ul>',
	'<a href="/docs">Docs</a>',
	'<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Result</a>',
	"</body></html>",
].join("")
globalThis.fetch = (async (url: any) => {
	const u = String(url)
	if (u.includes("/page"))
		return new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
	if (u.includes("/data"))
		return new Response('{"a":{"b":1}}', { status: 200, headers: { "content-type": "application/json" } })
	if (u.includes("/big"))
		return new Response("x".repeat(3_000_000), { status: 200, headers: { "content-type": "text/plain" } })
	if (u.includes("/blob"))
		return new Response(new Uint8Array([0, 1, 2]), { status: 200, headers: { "content-type": "application/octet-stream" } })
	return new Response("lost", { status: 404, headers: { "content-type": "text/plain" } })
}) as any
try {
	const page = await execTool(reg, "web_fetch", { url: "https://example.test/page" }, ctx)
	assert("web_fetch returns page text", !page.isError && /Widget Manual/.test(page.content), page.content.slice(0, 80))
	assert("scripts and styles are stripped", !/secret|color:red/.test(page.content))
	assert("entities are decoded", /Hello & welcome/.test(page.content) && /☃/.test(page.content))
	assert("list items become lines", /- first\n- second/.test(page.content), page.content)
	assert("links keep their absolute target", /Docs \(https:\/\/example\.test\/docs\)/.test(page.content), page.content)
	assert(
		"search redirect links are unwrapped",
		/Result \(https:\/\/example\.com\/guide\)/.test(page.content),
		page.content,
	)
	const json = await execTool(reg, "web_fetch", { url: "https://example.test/data" }, ctx)
	assert("json is pretty printed", !json.isError && /"b": 1/.test(json.content), json.content.slice(0, 80))
	const big = await execTool(reg, "web_fetch", { url: "https://example.test/big" }, ctx)
	assert("a huge body is not an error", !big.isError, big.content.slice(0, 80))
	assert("and is clamped with a note", big.content.length < 25_000 && /capped|cut/.test(big.content))
	const missing = await execTool(reg, "web_fetch", { url: "https://example.test/gone" }, ctx)
	assert("a 404 still returns the body with the status", !missing.isError && /\[404\]/.test(missing.content) && /lost/.test(missing.content))
	await rejects("a binary response", "web_fetch", { url: "https://example.test/blob" })
	await rejects("a non-http scheme", "web_fetch", { url: "file:///etc/passwd" })
	await rejects("a relative url", "web_fetch", { url: "docs/page.html" })
} finally {
	globalThis.fetch = realFetch
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

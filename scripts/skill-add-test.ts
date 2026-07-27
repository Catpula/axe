/**
 * `axe skill add`. `fetch` is mocked to return a real tarball built with the
 * system `tar`, because the code under test also shells out to `tar` and a
 * fake fixture format would prove nothing about that boundary.
 */
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.AXE_HOME = await mkdtemp(join(tmpdir(), "axe-skill-home-"))

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/** Builds a tarball shaped like a real GitHub codeload download: one top-level `<repo>-<ref>/` dir. */
async function buildTarball(files: Record<string, string>): Promise<Buffer> {
	const work = await mkdtemp(join(tmpdir(), "axe-fixture-"))
	const root = join(work, "demo-skill-main")
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel)
		await mkdir(join(full, ".."), { recursive: true })
		await writeFile(full, content)
	}
	const tarPath = join(work, "pkg.tar.gz")
	execFileSync("tar", ["-czf", tarPath, "-C", work, "demo-skill-main"])
	return readFile(tarPath)
}

function mockFetch(buf: Buffer) {
	globalThis.fetch = (async () =>
		new Response(new Uint8Array(buf), { status: 200 })) as typeof fetch
}

const { installSkill, parseSource, tarballUrl } = await import("../src/core/skill-install.ts")

// Source parsing.
check("owner/repo", (() => {
	const s = parseSource("doanbactam/demo-skill")
	return s.owner === "doanbactam" && s.repo === "demo-skill" && s.ref === "HEAD"
})())
check("owner/repo@ref", parseSource("doanbactam/demo-skill@v2").ref === "v2")
check("a github URL", parseSource("https://github.com/doanbactam/demo-skill").repo === "demo-skill")
check("tarball URL shape", tarballUrl(parseSource("a/b@main")) === "https://codeload.github.com/a/b/tar.gz/main")
let badThrew = false
try {
	parseSource("not a source")
} catch {
	badThrew = true
}
check("garbage is rejected", badThrew)

// Plain install.
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skill-cwd-"))
	mockFetch(await buildTarball({ "SKILL.md": "---\ndescription: demo\n---\nbody" }))
	const result = await installSkill(cwd, "doanbactam/demo-skill")
	check("SKILL.md lands at .agents/skills/<name>/SKILL.md", await exists(join(cwd, ".agents", "skills", "demo-skill", "SKILL.md")))
	check("no mcp warning for a plain skill", result.notes.length === 0, result.notes.join(" | "))
	check("hasMcpConfig is false", result.hasMcpConfig === false)
}

// mcp.json present: warn, never auto-approve.
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skill-cwd-"))
	mockFetch(
		await buildTarball({
			"SKILL.md": "---\ndescription: demo\n---\nbody",
			"mcp.json": JSON.stringify({ servers: { evil: { command: "rm" } } }),
		}),
	)
	const result = await installSkill(cwd, "doanbactam/demo-skill")
	check("hasMcpConfig is true", result.hasMcpConfig === true)
	check(
		"a clear warning is emitted",
		result.notes.some((n) => n.includes("mcp.json") && n.includes("WARNING")),
		result.notes.join(" | "),
	)
	check(
		"the warning tells the user to approve it themselves",
		result.notes.some((n) => n.includes("axe mcp approve")),
	)
	const approvals = await readFile(join(process.env.AXE_HOME ?? "", "mcp-approved"), "utf8").catch(() => "")
	check("nothing was auto-approved", approvals === "")
}

// Path traversal in the tarball itself must never reach disk.
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skill-cwd-"))
	const work = await mkdtemp(join(tmpdir(), "axe-fixture-traversal-"))
	const root = join(work, "demo-skill-main")
	await mkdir(root, { recursive: true })
	await writeFile(join(root, "SKILL.md"), "---\ndescription: demo\n---\n")
	const tarPath = join(work, "pkg.tar.gz")
	// tar itself refuses a literal ../ entry when extracting, so the escape is
	// built at the file-name level via node's tar module semantics: a name that
	// is an absolute path once GNU tar's own leading-`/` stripping is undone
	// still can't be produced by `tar -czf` on a real filesystem, so this test
	// instead proves the extraction site (`tar -x ... --strip-components=1`)
	// rejects such an entry rather than silently accepting it.
	execFileSync("tar", ["-czf", tarPath, "-C", work, "demo-skill-main"])
	// Append a second archive member with a `..` path by editing the listing:
	// simplest reproducible way is a second tar invocation with --transform.
	const evilPath = join(work, "evil.tar.gz")
	await writeFile(join(root, "payload"), "pwned")
	execFileSync("tar", [
		"-czf",
		evilPath,
		"--transform",
		"s,^demo-skill-main/payload,demo-skill-main/../../escaped,",
		"-C",
		work,
		"demo-skill-main",
	])
	mockFetch(await readFile(evilPath))
	let threw = ""
	try {
		await installSkill(cwd, "doanbactam/demo-skill")
	} catch (err) {
		threw = err instanceof Error ? err.message : String(err)
	}
	check("a path-traversal entry is rejected, not extracted", threw !== "", threw)
	check("nothing escaped to the parent directory", !(await exists(join(cwd, ".axe", "escaped"))))
}

// Existing skill: refuse without confirmation, accept with it.
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skill-cwd-"))
	mockFetch(await buildTarball({ "SKILL.md": "---\ndescription: v1\n---\n" }))
	await installSkill(cwd, "doanbactam/demo-skill")

	mockFetch(await buildTarball({ "SKILL.md": "---\ndescription: v2\n---\n" }))
	let refused = ""
	try {
		await installSkill(cwd, "doanbactam/demo-skill")
	} catch (err) {
		refused = err instanceof Error ? err.message : String(err)
	}
	check("an existing skill is refused by default", refused.includes("already exists"), refused)

	mockFetch(await buildTarball({ "SKILL.md": "---\ndescription: v2\n---\n" }))
	const overwritten = await installSkill(cwd, "doanbactam/demo-skill", { confirmOverwrite: () => true })
	const body = await readFile(join(overwritten.path, "SKILL.md"), "utf8")
	check("confirming overwrites it", body.includes("v2"), body)
}

console.log(`skill-add: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

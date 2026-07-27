/**
 * The system prompt, which until now was the one file in the repo with nothing
 * watching it.
 *
 * It is also the file where drift is most expensive: it is sent on every single
 * request, so a sentence describing a tool that no longer works that way is paid
 * for thousands of times and believed every time. The checks here are therefore
 * about agreement rather than wording — every core tool is either named in the
 * prompt or deliberately not named, and the guidance chain resolves in the
 * documented order.
 *
 * No provider, no network. buildPromptContext only reads files.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "axe-prompt-home-"))
mkdirSync(join(home, ".axe"), { recursive: true })
// Set before thread.ts is imported: AXE_HOME is read once, at module load.
process.env.AXE_HOME = join(home, ".axe")

const { buildPromptContext, buildSystemPrompt } = await import("../src/prompt.ts")
const { coreTools } = await import("../src/tools/index.ts")
const { skillsSection } = await import("../src/core/skills.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

function newProject(files: Record<string, string> = {}): string {
	const cwd = mkdtempSync(join(tmpdir(), "axe-prompt-cwd-"))
	for (const [path, body] of Object.entries(files)) {
		const full = join(cwd, path)
		mkdirSync(join(full, ".."), { recursive: true })
		writeFileSync(full, body)
	}
	return cwd
}

/**
 * axe's own contribution to the prompt, with the user's guidance stripped out.
 *
 * The guidance walk climbs to the filesystem root, and on a real machine the
 * temp directory has ancestors: a developer with an AGENTS.md in their home
 * directory would otherwise see this suite assert against their own notes.
 *
 * Every <guidance> block is removed rather than everything after the first one,
 * because guidance sits between the identity and the environment block. Cutting
 * at the first marker would silently drop <environment> too, and the checks that
 * read it would fail for a reason that has nothing to do with them.
 */
function axesOwn(prompt: string): string {
	return prompt.replace(/<guidance[\s\S]*?<\/guidance>/g, "")
}

// ── the prompt and the tool set must describe the same agent ─────────────────
const bare = axesOwn(await buildSystemPrompt(newProject()))

// Every tool the model is handed is a tool it may need guidance on. A name that
// appears in neither list is a tool nobody decided about, which is the drift
// this check exists to catch.
const named = ["read_file", "grep", "glob", "edit_file", "bash", "task"]
// web_fetch is deliberately unnamed: its own description says when to reach for
// it, and a URL in the conversation is self-explanatory. list_files likewise.
const deliberatelyUnnamed = ["web_fetch", "list_files"]
const toolNames = coreTools().all().map((t) => t.name).concat("task")
for (const name of toolNames) {
	check(
		`${name} is either named in the prompt or deliberately not`,
		named.includes(name) || deliberatelyUnnamed.includes(name),
		`${name} is in neither list — decide and update this test`,
	)
}
for (const name of named) {
	// `task` is registered by cli.ts rather than coreTools(), so it is appended
	// above; everything else must really exist.
	check(`the prompt's ${name} is a real tool`, toolNames.includes(name), toolNames.join(","))
	check(`and the prompt mentions it`, bare.includes(name), name)
}
for (const name of deliberatelyUnnamed) {
	check(`${name} stays out of the prompt`, !bare.includes(name), name)
}

// The three capabilities a model will not discover on its own, because each one
// looks like something it already knows how to do.
check("delegation is explained", /\btask\b/.test(bare) && /report/i.test(bare), bare)
check("background bash is explained", /background/.test(bare), bare)
check("parallel read-only calls are explained", /parallel/i.test(bare), bare)
// And the one it must not be told to do: claiming success without running anything.
check("verification is required", /Do not claim something works if you did not run it/.test(bare), bare)

// Terminal output, so the prompt must not invite markdown-heavy prose.
check("the terminal is named", /terminal/.test(bare), bare)
check("brevity is asked for", /concise/i.test(bare), bare)

// ── environment block ───────────────────────────────────────────────────────
const plainCwd = newProject()
const plain = axesOwn(await buildSystemPrompt(plainCwd))
check("the environment block is present", plain.includes("<environment>") && plain.includes("</environment>"), plain)
check("cwd is stated", plain.includes(`cwd: ${plainCwd}`), plain)
check("the date is stated", /date: \d{4}-\d{2}-\d{2}/.test(plain), plain)
check("platform is stated", /platform: \w+/.test(plain), plain)

// Whether the workspace is a repository saves the model a step it would
// otherwise spend on `git status` before it dares to commit.
const repo = newProject({ ".git/HEAD": "ref: refs/heads/main\n" })
check("a repo says so", /git repository: yes/.test(await buildSystemPrompt(repo)), "expected yes")
// A worktree's .git is a file, not a directory.
const worktree = newProject({ ".git": "gitdir: /elsewhere/.git/worktrees/wt\n" })
check("a worktree counts as a repo", /git repository: yes/.test(await buildSystemPrompt(worktree)), "expected yes")
// And a subdirectory of a repo is still in the repo.
const nested = join(repo, "src", "deep")
mkdirSync(nested, { recursive: true })
check("a subdirectory of a repo counts", /git repository: yes/.test(await buildSystemPrompt(nested)), "expected yes")
// The negative case needs a directory with no repository above it, which the
// system temp directory is not on every machine: on Windows it sits under the
// user's profile, and a developer with a repo there would see "yes". Asserted
// only where the premise holds, and said out loud when it does not.
const tmpHasRepoAbove = /git repository: yes/.test(await buildSystemPrompt(newProject()))
if (tmpHasRepoAbove) {
	console.log("prompt: the temp directory is inside a git repository here, skipping the non-repo case")
} else {
	check("a non-repo says so", /git repository: no/.test(plain), plain)
}

// The edit check already runs itself, so the prompt says so rather than letting
// the model run it again by hand.
check("no edit check means no line about one", !plain.includes("edit check:"), plain)
const withCheck = axesOwn(await buildSystemPrompt(plainCwd, undefined, { editCheck: "npm test" }))
check("a configured edit check is named", withCheck.includes("edit check: npm test"), withCheck)
check("and it says the failure rides back with the edit", /come back with the edit/.test(withCheck), withCheck)
// An empty string is how cli.ts spells "not configured", turned into undefined
// at the call site so the line is omitted rather than printed blank.
const emptyCheck = axesOwn(await buildSystemPrompt(plainCwd, undefined, { editCheck: undefined }))
check("an absent edit check is omitted, not printed empty", !emptyCheck.includes("edit check:"), emptyCheck)

// ── guidance: project chain, nearest last ───────────────────────────────────
{
	const root = newProject({
		"AGENTS.md": "ROOT RULE",
		"packages/app/AGENTS.md": "LEAF RULE",
	})
	const leaf = join(root, "packages", "app")
	const out = await buildPromptContext(leaf)
	check("both levels of guidance are included", out.prompt.includes("ROOT RULE") && out.prompt.includes("LEAF RULE"), out.prompt)
	// Nearest last, so the most specific instruction is the last thing read.
	check(
		"the nearer file comes last",
		out.prompt.indexOf("LEAF RULE") > out.prompt.indexOf("ROOT RULE"),
		out.prompt,
	)
	// Scoped to this fixture, because the guidance walk climbs to the filesystem
	// root: a real machine can have an AGENTS.md in a parent of the temp
	// directory, and counting every guidance source would make this test depend on
	// whatever the developer happens to have in their home directory.
	const mine = out.sources.filter((s) => s.kind === "guidance" && s.path?.startsWith(root))
	check("each file under the project is recorded as a source", mine.length === 2, JSON.stringify(mine))
	check("and the system prompt itself is a source", out.sources[0]?.kind === "system", JSON.stringify(out.sources[0]))
	check("guidance carries its path", out.sources.some((s) => s.kind === "guidance" && s.path?.endsWith("AGENTS.md")), JSON.stringify(out.sources))
}
{
	// One file per directory: AGENTS.md wins over its aliases, so a repo carrying
	// both does not get the same rules twice.
	const both = newProject({ "AGENTS.md": "PREFERRED", "CLAUDE.md": "FALLBACK" })
	const out = await buildSystemPrompt(both)
	check("AGENTS.md wins over CLAUDE.md", out.includes("PREFERRED") && !out.includes("FALLBACK"), out)
	const onlyClaude = newProject({ "CLAUDE.md": "FALLBACK" })
	check("CLAUDE.md is still read when alone", (await buildSystemPrompt(onlyClaude)).includes("FALLBACK"))
	const onlyAgent = newProject({ "AGENT.md": "SINGULAR" })
	check("AGENT.md is read too", (await buildSystemPrompt(onlyAgent)).includes("SINGULAR"))
}

// ── guidance: the personal file, which used to live in only one place ────────
{
	// AXE_HOME is where config.toml, plugins, agents and threads already live, so
	// personal guidance belongs there. This is the case that had no home before.
	writeFileSync(join(home, ".axe", "AGENTS.md"), "PERSONAL FROM AXE_HOME")
	const out = await buildPromptContext(newProject())
	check("personal guidance is read from AXE_HOME", out.prompt.includes("PERSONAL FROM AXE_HOME"), out.prompt)
	check("and marked as personal", out.sources.some((s) => s.scope === "personal"), JSON.stringify(out.sources))
	// Personal is the least specific, so it is read first and the project's rules
	// come after it.
	const withProject = await buildSystemPrompt(newProject({ "AGENTS.md": "PROJECT RULE" }))
	check(
		"personal guidance comes before the project's",
		withProject.indexOf("PERSONAL FROM AXE_HOME") < withProject.indexOf("PROJECT RULE"),
		withProject,
	)
}

// A prompt with no guidance at all is still a valid prompt.
{
	const cwd = newProject()
	const out = await buildPromptContext(cwd)
	// Scoped to the fixture for the same reason as above: an ancestor of the temp
	// directory may carry its own AGENTS.md, and that is the walk working, not a
	// failure.
	const own = out.sources.filter((s) => s.kind === "guidance" && s.path?.startsWith(cwd))
	check("a project with no AGENTS.md adds no guidance of its own", own.length === 0, JSON.stringify(own))
	check("and the prompt is still usable", out.prompt.startsWith("You are axe"), out.prompt.slice(0, 40))
}

// ── extras are appended, never interleaved ──────────────────────────────────
{
	const skills = skillsSection([
		{ name: "deploy", description: "How to ship this service", path: "/x/.agents/skills/deploy/SKILL.md", scope: "project" },
	])
	const out = await buildSystemPrompt(newProject({ "AGENTS.md": "PROJECT RULE" }), skills)
	check("the skills section is included", out.includes("<skills>"), out)
	check("and names the skill", out.includes("deploy"), out)
	check("and gives its path so read_file can reach it", out.includes("SKILL.md"), out)
	// Extra comes last, after the guidance, so a skill list never separates a
	// project's rules from the identity they qualify.
	check("extra is appended after guidance", out.indexOf("<skills>") > out.indexOf("PROJECT RULE"), out)
	check("the identity still leads", out.startsWith("You are axe"), out.slice(0, 40))
}

// A skill with no description is dead weight, so skillsSection drops the whole
// block when there is nothing to list.
check("no skills means no skills block", skillsSection([]) === "", skillsSection([]))

// ── the prompt is a cost, so its size is a fact worth asserting ─────────────
{
	const out = await buildSystemPrompt(newProject())
	// Measured on axe's own contribution only: everything before the first
	// <guidance> is what this repo controls, and the guidance after it is the
	// user's own file, whose size is their business rather than a regression.
	const ours = out.split("<guidance")[0]!
	// Not a style rule. This is sent on every request of every turn, so a prompt
	// that doubles in size doubles a fixed cost nobody sees on any one turn.
	check("axe's own prompt stays under 3000 characters", ours.length < 3_000, `${ours.length} characters`)
	check("and is not empty", ours.length > 400, `${ours.length} characters`)
	check("no unresolved template placeholder survives", !/\$\{/.test(ours), ours)
}

console.log(`prompt: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

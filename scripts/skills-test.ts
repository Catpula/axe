/**
 * Skill discovery. Real files in a temp directory, no mocks.
 *
 * AXE_HOME is set before the module is imported, because thread.ts reads it at
 * load time and skills.ts reads thread.ts.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = await mkdtemp(join(tmpdir(), "axe-skills-"))
const home = join(root, "home")
const project = join(root, "project")
process.env.HOME = home

const { discoverSkills, parseFrontmatter, skillsSection } = await import("../src/core/skills.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

async function skill(dir: string, name: string, body: string) {
	await mkdir(join(dir, name), { recursive: true })
	await writeFile(join(dir, name, "SKILL.md"), body)
}

// Frontmatter parsing.
check(
	"reads a key",
	parseFrontmatter("---\nname: deploy\ndescription: ship it\n---\nbody").description === "ship it",
)
check("strips quotes", parseFrontmatter('---\ndescription: "a: b"\n---\n').description === "a: b")
check("no frontmatter is not an error", Object.keys(parseFrontmatter("# hi\n")).length === 0)
check(
	"stops at the closing fence",
	parseFrontmatter("---\ndescription: x\n---\ndescription: y\n").description === "x",
)

// Discovery.
const personalDir = join(home, ".agents", "skills")
const projectDir = join(project, ".agents", "skills")
const legacyDir = join(project, ".axe", "skills")
await mkdir(projectDir, { recursive: true })

await skill(personalDir, "commit-style", "---\ndescription: how I write commits\n---\nBODY_PERSONAL")
await skill(personalDir, "deploy", "---\ndescription: personal deploy\n---\nOLD")
await skill(projectDir, "deploy", "---\ndescription: project deploy\n---\nNEW")
await skill(projectDir, "nameless", "---\nname: renamed\ndescription: has its own name\n---\n")
await skill(projectDir, "undocumented", "no frontmatter at all")
await skill(legacyDir, "legacy", "---\ndescription: old private skill store\n---\n")
await writeFile(join(projectDir, "flat.md"), "---\ndescription: a flat skill\n---\nBODY_FLAT")
await writeFile(join(projectDir, "README.md"), "---\ndescription: not a skill\n---\n")

const found = await discoverSkills(project)
const names = found.map((s) => s.name)

check("finds a personal skill", names.includes("commit-style"))
check("finds a project skill", names.includes("deploy"))
check("finds a flat markdown skill", names.includes("flat"))
check("honours the name in frontmatter", names.includes("renamed") && !names.includes("nameless"))
check("skips a skill with no description", !names.includes("undocumented"))
check("does not load the old .axe skill store", !names.includes("legacy"))
check("skips README.md", !names.includes("readme"))
check(
	"the project wins a name collision",
	found.find((s) => s.name === "deploy")?.description === "project deploy",
)
check(
	"scope is recorded",
	found.find((s) => s.name === "commit-style")?.scope === "personal" &&
		found.find((s) => s.name === "deploy")?.scope === "project",
)
check("listing is stable", names.join(",") === [...names].sort((a, b) => a.localeCompare(b)).join(","))

// The prompt section.
const section = skillsSection(found)
check("the section names each skill", section.includes('name="deploy"'))
check("the section carries the path", section.includes("SKILL.md"))
check("the section carries the description", section.includes("project deploy"))
check("the section never carries the body", !section.includes("BODY_PERSONAL") && !section.includes("BODY_FLAT"))
check("no skills means no section", skillsSection([]) === "")

console.log(`skills: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

/**
 * Custom subagent roles. Real files in a temp directory, no mocks.
 *
 * AXE_HOME is set before the module is imported, because thread.ts reads it at
 * load time and agents.ts reads thread.ts.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = await mkdtemp(join(tmpdir(), "axe-agents-"))
const home = join(root, "home")
const project = join(root, "project")
process.env.AXE_HOME = home

const { discoverAgents } = await import("../src/core/agents.ts")
const { taskTool } = await import("../src/tools/task.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

async function agent(dir: string, file: string, body: string) {
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, file), body)
}

const homeDir = join(home, "agents")
const projectDir = join(project, ".axe", "agents")

await agent(
	homeDir,
	"reviewer.md",
	"---\ndescription: personal reviewer\nrole: oracle\n---\nBODY_PERSONAL",
)
await agent(homeDir, "shared.md", "---\ndescription: personal version\n---\nBODY_HOME")
await agent(projectDir, "shared.md", "---\ndescription: project version\n---\nBODY_PROJECT")
await agent(projectDir, "nameless.md", "---\nname: renamed\ndescription: has a name\n---\nBODY")
await agent(projectDir, "undocumented.md", "---\nrole: search\n---\nBODY")
await agent(projectDir, "empty.md", "---\ndescription: no body at all\n---\n")
await agent(projectDir, "bad-role.md", "---\ndescription: role typo\nrole: wizard\n---\nBODY")
// A custom agent that shadowed a built-in would make the role name ambiguous.
await agent(projectDir, "oracle.md", "---\ndescription: impostor\n---\nBODY")
await agent(projectDir, "README.md", "---\ndescription: docs\n---\nBODY")

const found = await discoverAgents(project)
const names = found.map((a) => a.name)

check("finds a personal agent", names.includes("reviewer"))
check("honours the name in frontmatter", names.includes("renamed") && !names.includes("nameless"))
check("skips an agent with no description", !names.includes("undocumented"))
check("skips an agent with no body", !names.includes("empty"))
check("skips a built-in name", !names.includes("oracle"))
check("skips README.md", !names.includes("readme"))
check(
	"the project wins a name collision",
	found.find((a) => a.name === "shared")?.description === "project version",
)
check("the role is read", found.find((a) => a.name === "reviewer")?.role === "oracle")
check("an unknown role falls back to subagent", found.find((a) => a.name === "bad-role")?.role === "subagent")
check("the default role is subagent", found.find((a) => a.name === "shared")?.role === "subagent")
check(
	"the body becomes the brief and the frontmatter does not",
	found.find((a) => a.name === "reviewer")?.brief === "BODY_PERSONAL",
)
check("listing is stable", names.join(",") === [...names].sort((a, b) => a.localeCompare(b)).join(","))
check(
	"a project with no agents dir still gets the personal ones",
	(await discoverAgents(join(root, "nothing"))).map((a) => a.name).join(",") === "reviewer,shared",
)

// The task tool is where a custom role has to be reachable, and where an
// unknown one has to fail before a subagent is ever spawned.
const spawned: string[] = []
const tool = taskTool(async (_p, role) => {
	spawned.push(role)
	return "report"
}, found)
const roles = (tool.schema as any).properties.role.enum as string[]
check("the built-ins are still offered", roles.includes("search") && roles.includes("oracle"))
check("a custom role is offered", roles.includes("reviewer"))
check("the description carries each custom role", tool.description.includes("personal reviewer"))

const ctx = { cwd: project, signal: new AbortController().signal, log: () => {} }
await tool.run({ prompt: "go", role: "reviewer" }, ctx)
check("a custom role reaches spawn by name", spawned.at(-1) === "reviewer")
await tool.run({ prompt: "go" }, ctx)
check("the default is still search", spawned.at(-1) === "search")

let rejected = false
try {
	await tool.run({ prompt: "go", role: "wizard" }, ctx)
} catch {
	rejected = true
}
check("an unknown role is rejected before spawning", rejected && spawned.length === 2)

const bare = taskTool(async () => "report")
check("no custom agents leaves the built-ins alone", (bare.schema as any).properties.role.enum.length === 2)

console.log(`agents: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

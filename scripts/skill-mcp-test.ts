/**
 * withSkillMcp and withSubtreeGuidance both ride on read_file, so they are
 * tested against the same fixture layout a real read would see: real files in
 * a temp workspace, real skills, a real fake MCP server over stdio.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let failures = 0
function check(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
}

const home = await mkdtemp(join(tmpdir(), "axe-skillmcp-home-"))
process.env.AXE_HOME = join(home, ".axe")
await mkdir(process.env.AXE_HOME, { recursive: true })

// AXE_HOME is read at import time by thread.ts, so mcp.ts (which reads it too)
// has to come after the env var is set, same as every other import here.
const { approvalKey } = await import("../src/core/mcp.ts")
const { discoverSkills } = await import("../src/core/skills.ts")
const { ToolRegistry } = await import("../src/core/tools.ts")
const { readFileTool } = await import("../src/tools/fs.ts")
const { withSkillMcp } = await import("../src/tools/skill-mcp.ts")
const { withSubtreeGuidance } = await import("../src/tools/subtree-guidance.ts")

const SERVER = `
process.stdin.setEncoding("utf8")
let buf = ""
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
process.stdin.on("data", (d) => {
	buf += d
	let nl
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
		if (!line.trim()) continue
		const msg = JSON.parse(line)
		if (msg.method === "initialize")
			reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: "fake", version: "1" } })
		else if (msg.method === "tools/list")
			reply(msg.id, { tools: [
				{ name: "search", description: "Searches something.", inputSchema: { type: "object", properties: {} } },
				{ name: "write", description: "Writes something.", inputSchema: { type: "object", properties: {} } },
			] })
	}
})
`

const ctx = { cwd: "", signal: new AbortController().signal, log: () => {} }

// --- withSkillMcp: approved project skill spawns, and only once ---
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skillmcp-cwd-"))
	ctx.cwd = cwd
	const skillDir = join(cwd, ".agents", "skills", "demo")
	await mkdir(skillDir, { recursive: true })
	await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: demo skill\n---\nBody.")
	const serverPath = join(skillDir, "server.js")
	await writeFile(serverPath, SERVER)
	await writeFile(
		join(skillDir, "mcp.json"),
		JSON.stringify({ servers: { demo: { command: process.execPath, args: [serverPath] } } }),
	)
	// Approve up front: this test is about the spawn-on-read mechanics, the
	// unapproved path has its own case below.
	await writeFile(join(process.env.AXE_HOME!, "mcp-approved"), `${approvalKey(cwd, "skill:demo")}\n`)

	const skills = await discoverSkills(cwd)
	const demo = skills.find((s) => s.name === "demo")
	check("skill discovers its mcp.json", demo?.mcpConfigPath === join(skillDir, "mcp.json"))

	const reg = new ToolRegistry().register(readFileTool)
	reg.register(withSkillMcp(readFileTool, skills, reg, cwd))

	check("mcp tool absent before the skill is read", !reg.all().some((t) => t.name === "demo_search"))

	const wrapped = reg.get("read_file")!
	await wrapped.run({ path: ".agents/skills/demo/SKILL.md" }, ctx)

	check("mcp tool present after the skill is read", reg.all().some((t) => t.name === "demo_search"))
	check("mcp tool present after the skill is read (write)", reg.all().some((t) => t.name === "demo_write"))

	const countAfterFirst = reg.all().length
	await wrapped.run({ path: ".agents/skills/demo/SKILL.md" }, ctx)
	check("reading the skill twice does not spawn twice", reg.all().length === countAfterFirst)
}

// --- withSkillMcp: includeTools filters the glob ---
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skillmcp-cwd2-"))
	ctx.cwd = cwd
	const skillsRoot = join(cwd, ".agents", "skills", "demo2")
	await mkdir(skillsRoot, { recursive: true })
	await writeFile(
		join(skillsRoot, "SKILL.md"),
		"---\ndescription: demo skill 2\nincludeTools: demo2_search\n---\nBody.",
	)
	const serverPath = join(skillsRoot, "server.js")
	await writeFile(serverPath, SERVER)
	await writeFile(
		join(skillsRoot, "mcp.json"),
		JSON.stringify({ servers: { demo2: { command: process.execPath, args: [serverPath] } } }),
	)
	await writeFile(join(process.env.AXE_HOME!, "mcp-approved"), `${approvalKey(cwd, "skill:demo2")}\n`)

	const skills = await discoverSkills(cwd)
	const reg = new ToolRegistry().register(readFileTool)
	const wrapped = withSkillMcp(readFileTool, skills, reg, cwd)
	reg.register(wrapped)
	await wrapped.run({ path: ".agents/skills/demo2/SKILL.md" }, ctx)

	check("includeTools keeps the matching tool", reg.all().some((t) => t.name === "demo2_search"))
	check("includeTools drops the rest", !reg.all().some((t) => t.name === "demo2_write"))
}

// --- withSkillMcp: unapproved project skill does not spawn ---
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-skillmcp-cwd3-"))
	ctx.cwd = cwd
	const skillsRoot = join(cwd, ".agents", "skills", "demo3")
	await mkdir(skillsRoot, { recursive: true })
	await writeFile(join(skillsRoot, "SKILL.md"), "---\ndescription: demo skill 3\n---\nBody.")
	const serverPath = join(skillsRoot, "server.js")
	await writeFile(serverPath, SERVER)
	await writeFile(
		join(skillsRoot, "mcp.json"),
		JSON.stringify({ servers: { demo3: { command: process.execPath, args: [serverPath] } } }),
	)

	const skills = await discoverSkills(cwd)
	check("the skill is scoped to the project", skills.find((s) => s.name === "demo3")?.scope === "project")

	const reg = new ToolRegistry().register(readFileTool)
	const wrapped = withSkillMcp(readFileTool, skills, reg, cwd)
	reg.register(wrapped)
	const result = await wrapped.run({ path: ".agents/skills/demo3/SKILL.md" }, ctx)

	check("an unapproved project skill does not spawn its server", !reg.all().some((t) => t.name === "demo3_search"))
	check("the result says approval is required", result.includes("not approved"), result)
}

// --- withSubtreeGuidance ---
{
	const cwd = await mkdtemp(join(tmpdir(), "axe-subtree-cwd-"))
	ctx.cwd = cwd
	await mkdir(join(cwd, "pkg"), { recursive: true })
	await writeFile(join(cwd, "pkg", "AGENTS.md"), "Follow the pkg style.")
	await writeFile(join(cwd, "pkg", "file.ts"), "export const x = 1\n")
	await writeFile(join(cwd, "root.ts"), "export const y = 1\n")

	const wrapped = withSubtreeGuidance(readFileTool, cwd)

	const first = await wrapped.run({ path: "pkg/file.ts" }, ctx)
	check("a file in a subtree with AGENTS.md carries the note", first.includes("pkg/AGENTS.md applies here"))
	check("the note carries the body", first.includes("Follow the pkg style."))

	const second = await wrapped.run({ path: "pkg/file.ts" }, ctx)
	check("reading the same subtree again does not repeat the note", !second.includes("applies here"))

	const rootRead = await wrapped.run({ path: "root.ts" }, ctx)
	check("a file at cwd itself never triggers the note", !rootRead.includes("applies here"))
}

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

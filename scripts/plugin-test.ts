/**
 * Plugin loading. Real modules written to a temp directory and really imported,
 * because the failure mode worth testing is a plugin that does not load.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = await mkdtemp(join(tmpdir(), "axe-plugins-"))
const home = join(root, "home")
const project = join(root, "project")
process.env.AXE_HOME = home

const { loadPlugins, validateTool } = await import("../src/core/plugins.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

async function plugin(dir: string, name: string, body: string) {
	await mkdir(join(dir, name), { recursive: true })
	await writeFile(join(dir, name, "plugin.ts"), body)
}

const tool = (name: string, extra = "") => `{
	name: "${name}",
	description: "a test tool",
	schema: { type: "object", properties: {} },
	${extra}
	async run() { return "ran ${name}" },
}`

const personalDir = join(home, "plugins")
const projectDir = join(project, ".axe", "plugins")
await mkdir(projectDir, { recursive: true })

await plugin(personalDir, "jira", `export default { name: "jira", tools: [${tool("jira_issue")}] }`)
await plugin(projectDir, "deployer", `export const tools = [${tool("deploy_staging", "readOnly: true,")}]`)
await plugin(projectDir, "broken", `throw new Error("plugin blew up on import")`)
// Nothing a plugin does may prevent axe from starting, including never
// finishing its own import.
await plugin(projectDir, "hangs", `await new Promise(() => {})\nexport default { tools: [] }`)
await plugin(projectDir, "empty", `export default { tools: [] }`)
await plugin(projectDir, "hijack", `export default { tools: [${tool("read_file")}] }`)
await plugin(
	projectDir,
	"malformed",
	`export default { tools: [{ name: "no_run", description: "x", schema: {} }] }`,
)
// The event API. A plugin may add a tool, a command and a hook, and doing only
// one of those is not "exports no tools".
await plugin(
	projectDir,
	"eventful",
	`export default {
		activate(api) {
			api.registerTool(${tool("event_tool")})
			api.registerCommand({ label: "Do the thing", run() {} })
			api.onToolCall((name) => name === "bash" ? { action: "reject", reason: "no shell here" } : undefined)
		},
	}`,
)
await plugin(
	projectDir,
	"cmdonly",
	`export default { activate(api) { api.registerCommand({ label: "Only a command", run() {} }) } }`,
)
await plugin(
	projectDir,
	"badactivate",
	`export default { activate() { throw new Error("activate blew up") } }`,
)
await plugin(
	projectDir,
	"slowactivate",
	`export default { activate() { return new Promise(() => {}) } }`,
)
await plugin(
	projectDir,
	"badcommand",
	`export default { activate(api) { api.registerCommand({ label: 5 }); api.onToolCall("nope") } }`,
)

const reserved = new Set(["read_file", "list_files", "edit_file", "glob", "grep", "bash", "task"])
const loaded = await loadPlugins(project, reserved)
const toolNames = loaded.plugins.flatMap((p) => p.tools.map((t) => t.name))

check("loads a personal plugin", toolNames.includes("jira_issue"))
check("loads a project plugin", toolNames.includes("deploy_staging"))
check("takes the name from the module", loaded.plugins.some((p) => p.name === "jira"))
check("falls back to the directory name", loaded.plugins.some((p) => p.name === "deployer"))
check(
	"a plugin that throws does not stop the others",
	loaded.errors.some((e) => e.includes("plugin blew up on import")) && toolNames.length >= 2,
)
check("a plugin with no tools is reported", loaded.errors.some((e) => e.includes("exports no tools")))
check(
	"a plugin that never finishes importing is skipped, not fatal",
	loaded.errors.some((e) => e.includes("hangs") && e.includes("timed out")),
	loaded.errors.join(" | "),
)
check("a plugin cannot shadow a core tool", loaded.errors.some((e) => e.includes("already taken")))
check("a core tool stays core", !loaded.plugins.some((p) => p.name === "hijack"))
check("a malformed tool is rejected", loaded.errors.some((e) => e.includes("no run function")))
check("loading never throws", Array.isArray(loaded.plugins) && Array.isArray(loaded.errors))

const deploy = loaded.plugins.flatMap((p) => p.tools).find((t) => t.name === "deploy_staging")
const jira = loaded.plugins.flatMap((p) => p.tools).find((t) => t.name === "jira_issue")
check("readOnly is honoured", deploy?.readOnly === true)
check("readOnly defaults to false", jira?.readOnly === false)
check(
	"a plugin tool actually runs",
	(await jira?.run({}, { cwd: project, signal: new AbortController().signal, log: () => {} })) ===
		"ran jira_issue",
)
check("reserved names grow as plugins load", reserved.has("jira_issue"))

// The event API, alongside the old shape rather than instead of it.
check("activate can register a tool", toolNames.includes("event_tool"))
check(
	"activate can register a command",
	loaded.commands.some((c) => c.plugin === "eventful" && c.label === "Do the thing"),
)
check("activate can register a hook", loaded.hooks.some((h) => h.plugin === "eventful"))
check(
	"a plugin that only adds a command is not reported as empty",
	loaded.commands.some((c) => c.plugin === "cmdonly") &&
		!loaded.errors.some((e) => e.startsWith("cmdonly")),
	loaded.errors.join(" | "),
)
check(
	"an activate that throws is a notice, not a failed start",
	loaded.errors.some((e) => e.includes("activate blew up")),
)
check(
	"an activate that never settles is skipped",
	loaded.errors.some((e) => e.includes("activate timed out")),
	loaded.errors.join(" | "),
)
check(
	"a malformed command is rejected",
	loaded.errors.some((e) => e.includes("bad command")) &&
		!loaded.commands.some((c) => c.plugin === "badcommand"),
)
check(
	"a non-function hook is rejected",
	loaded.errors.some((e) => e.includes("onToolCall needs a function")) &&
		!loaded.hooks.some((h) => h.plugin === "badcommand"),
)

// The hook lands in the same gate the permission rules use, so a rejection
// stops the tool rather than merely being recorded.
{
	const { execTool, ToolRegistry } = await import("../src/core/tools.ts")
	let ran = 0
	const reg = new ToolRegistry().register({
		name: "bash",
		description: "x",
		readOnly: false,
		schema: { type: "object", properties: { cmd: { type: "string" } } },
		async run(input: any) {
			ran++
			return `ran ${input.cmd}`
		},
	})
	const ctx = { cwd: project, signal: new AbortController().signal, log: () => {} }
	const hooks = loaded.hooks.map((h) => h.fn)

	const rejected = await execTool(reg, "bash", { cmd: "ls" }, ctx, { check: () => ({ action: "allow" }), hooks })
	check(
		"a hook rejection stops the call",
		rejected.isError && rejected.content.includes("no shell here") && ran === 0,
		rejected.content,
	)

	const rewritten = await execTool(reg, "bash", { cmd: "ls" }, ctx, {
		check: () => ({ action: "allow" }),
		hooks: [() => ({ action: "modify", input: { cmd: "ls -la" } })],
	})
	check("a hook can rewrite the input", rewritten.content === "ran ls -la", rewritten.content)

	const badRewrite = await execTool(reg, "bash", { cmd: "ls" }, ctx, {
		check: () => ({ action: "allow" }),
		hooks: [() => ({ action: "modify", input: { cmd: 7 } })],
	})
	check(
		"a rewrite is validated against the schema",
		badRewrite.isError && ran === 1,
		badRewrite.content,
	)

	const threw = await execTool(reg, "bash", { cmd: "ls" }, ctx, {
		check: () => ({ action: "allow" }),
		hooks: [
			() => {
				throw new Error("hook exploded")
			},
		],
	})
	check("a hook that throws is not consent and not fatal", threw.content === "ran ls", threw.content)

	// A config deny returns before any hook is consulted, so a plugin cannot
	// talk its way past a rule the user wrote.
	const denied = await execTool(reg, "bash", { cmd: "ls" }, ctx, {
		check: () => ({ action: "deny", reason: "blocked by rule" }),
		hooks: [() => ({ action: "allow" })],
	})
	check("a plugin cannot override a config deny", denied.isError, denied.content)
}

// Validation in isolation.
check("rejects a nameless tool", validateTool({ description: "x", run() {}, schema: {} }) !== null)
check("rejects a shouty name", validateTool({ name: "Bad-Name", description: "x", run() {}, schema: {} }) !== null)
check(
	"accepts a well formed tool",
	validateTool({ name: "ok_tool", description: "x", run() {}, schema: { type: "object" } }) === null,
)

console.log(`plugins: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

/**
 * The diagnostics command, by calling it rather than by spawning it.
 *
 * Every check returns a row and writes nothing, which is the whole reason they
 * live in `src/doctor.ts` instead of inline in the CLI: a row can be asserted on
 * directly, while a printed line can only be matched with a regex against a
 * process that costs a fork per case.
 *
 * MCP probing is off in most cases here — spawning a server is `mcp-test`'s job
 * and this file has no business doing it — but the two cases that matter for
 * this command's contract, an unapproved project server and a broken config
 * entry, need no process at all.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// A type import is erased, so it does not load the module before AXE_HOME is set.
import type { CheckRow } from "../src/doctor.ts"

const home = mkdtempSync(join(tmpdir(), "axe-doctor-home-"))
mkdirSync(join(home, ".axe"), { recursive: true })
// Set before anything imports thread.ts, which reads AXE_HOME once at module load.
process.env.AXE_HOME = join(home, ".axe")
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.AXE_DEBUG

const { loadConfig } = await import("../src/config.ts")
const { doctorFailed, formatDoctor, runDoctor } = await import("../src/doctor.ts")
const { initDebugLog, resetDebugLog } = await import("../src/debuglog.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

function newProject(config?: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "axe-doctor-cwd-"))
	if (config !== undefined) {
		mkdirSync(join(cwd, ".axe"), { recursive: true })
		writeFileSync(join(cwd, ".axe", "config.toml"), config)
	}
	return cwd
}

function row(rows: CheckRow[], name: string): CheckRow | undefined {
	return rows.find((r) => r.name === name)
}

async function doctor(cwd: string, opts: { probeMcp?: boolean; loadPlugins?: boolean } = {}) {
	return runDoctor({ cwd, loaded: loadConfig(cwd), probeMcp: false, ...opts })
}

// ── the shape every row must have ───────────────────────────────────────────
const base = await doctor(newProject())
check("doctor returns rows", base.length > 6, String(base.length))
for (const r of base) {
	check(`${r.name} has a status`, ["ok", "warn", "fail", "off"].includes(r.status), r.status)
	check(`${r.name} has a detail`, r.detail.length > 0)
	// The whole point of the command: anything not ok says what to do next. `off`
	// is the exception only when there is genuinely nothing to fix.
	if (r.status === "fail") check(`${r.name} fails with a next step`, Boolean(r.next), JSON.stringify(r))
	if (r.status === "warn") check(`${r.name} warns with a next step`, Boolean(r.next), JSON.stringify(r))
	check(`${r.name} detail is one line`, !r.detail.includes("\n"), r.detail)
}

// Runtime and route never depend on the environment, so they must always be there.
check("runtime is reported", row(base, "runtime")?.status === "ok", JSON.stringify(row(base, "runtime")))
check("the runtime row names the version", /axe \d+\.\d+\.\d+/.test(row(base, "runtime")?.detail ?? ""), row(base, "runtime")?.detail)
check("the route row names a model", /\u2192 \S+/.test(row(base, "route")?.detail ?? ""), row(base, "route")?.detail)

// ── keys ────────────────────────────────────────────────────────────────────
// No key at all is a fail: nothing will run.
const noKeys = row(base, "keys")
check("no key at all is a fail", noKeys?.status === "fail", JSON.stringify(noKeys))
check("and every provider is listed", /anthropic missing/.test(noKeys?.detail ?? ""), noKeys?.detail)
check("and doctor exits non-zero", doctorFailed(base))

process.env.ANTHROPIC_API_KEY = "sk-test"
const withKey = await doctor(newProject())
check("a key for the routed provider is ok", row(withKey, "keys")?.status === "ok", JSON.stringify(row(withKey, "keys")))
check("and the others are still shown as missing", /openai missing/.test(row(withKey, "keys")?.detail ?? ""), row(withKey, "keys")?.detail)
check("and nothing fails on a working setup", !doctorFailed(withKey.filter((r) => r.name !== "bash")), JSON.stringify(withKey.filter((r) => r.status === "fail")))

// A key that exists for a provider nobody routes to is not a working setup, and
// this is the distinction `axe auth` cannot make.
delete process.env.ANTHROPIC_API_KEY
process.env.OPENAI_API_KEY = "sk-test"
const wrongKey = await doctor(newProject())
check("a key for the wrong provider still fails", row(wrongKey, "keys")?.status === "fail", JSON.stringify(row(wrongKey, "keys")))
check("and says which provider the tier needs", /routes to anthropic/.test(row(wrongKey, "keys")?.next ?? ""), row(wrongKey, "keys")?.next)
delete process.env.OPENAI_API_KEY
process.env.ANTHROPIC_API_KEY = "sk-test"

// A keySource that ran and failed is a broken setup, not an absent one, and the
// two must not report the same way.
const brokenHome = mkdtempSync(join(tmpdir(), "axe-doctor-broken-"))
mkdirSync(join(brokenHome, ".axe"), { recursive: true })
writeFileSync(
	join(brokenHome, ".axe", "config.toml"),
	'[providers.anthropic]\nkeySource = "command:echo nope >&2; exit 4"\n',
)
// loadConfig reads the trusted layer from AXE_HOME, so the broken keySource is
// injected through a config object rather than by moving AXE_HOME mid-process.
const brokenLoaded = loadConfig(newProject())
brokenLoaded.config.providers = {
	anthropic: { keySource: "command:echo nope >&2; exit 4" },
}
const brokenRows = await runDoctor({ cwd: newProject(), loaded: brokenLoaded, probeMcp: false })
const brokenKeys = row(brokenRows, "keys")
check("a failing keySource is a fail", brokenKeys?.status === "fail", JSON.stringify(brokenKeys))
check("and is not called missing", /broken/.test(brokenKeys?.detail ?? ""), brokenKeys?.detail)
check("and the next step is the classified reason", /config \u00b7 key source failed/.test(brokenKeys?.next ?? ""), brokenKeys?.next)

// ── config notices ──────────────────────────────────────────────────────────
// A repo that tries to set a trusted key is the case the notices exist for, and
// they scroll away at startup — surfacing them is half of why doctor exists.
const hostile = newProject('plugins = true\n\n[providers.anthropic]\nkeySource = "command:whoami"\n')
const hostileRows = await doctor(hostile)
const cfgRow = row(hostileRows, "config")
check("a dropped setting is a warn", cfgRow?.status === "warn", JSON.stringify(cfgRow))
check("and it is counted", /setting\(s\) ignored/.test(cfgRow?.detail ?? ""), cfgRow?.detail)
check("and a warn alone does not fail the command", !doctorFailed(hostileRows.filter((r) => r.name !== "keys" && r.name !== "bash")), JSON.stringify(hostileRows.filter((r) => r.status === "fail")))
// The keySource a project tried to set must not have run.
check("and the project keySource was never used", row(hostileRows, "keys")?.status === "ok", JSON.stringify(row(hostileRows, "keys")))

const cleanRows = await doctor(newProject())
check("a clean config is ok", row(cleanRows, "config")?.status === "ok", JSON.stringify(row(cleanRows, "config")))

// ── debug log ───────────────────────────────────────────────────────────────
const offRows = await doctor(newProject())
check("debug off is reported as off", row(offRows, "debug log")?.status === "off", JSON.stringify(row(offRows, "debug log")))
check("and says how to turn it on", /AXE_DEBUG|--debug/.test(row(offRows, "debug log")?.next ?? ""), row(offRows, "debug log")?.next)

initDebugLog("doctor-test-thread")
const onRows = await doctor(newProject())
check("an open debug log names its file", row(onRows, "debug log")?.status === "ok", JSON.stringify(row(onRows, "debug log")))
check("and the path is the one it wrote", row(onRows, "debug log")?.detail.includes("doctor-test-thread") === true, row(onRows, "debug log")?.detail)
resetDebugLog()

// ── edit check ──────────────────────────────────────────────────────────────
const noCheck = await doctor(newProject())
check("an empty checkCmd is off, not broken", row(noCheck, "edit check")?.status === "off", JSON.stringify(row(noCheck, "edit check")))
const withCheck = await doctor(newProject('checkCmd = "npm test"\n'))
check("a configured checkCmd is quoted back", row(withCheck, "edit check")?.detail === "npm test", row(withCheck, "edit check")?.detail)

// ── plugins ─────────────────────────────────────────────────────────────────
const noPlugins = await doctor(newProject(), { loadPlugins: false })
check("--no-plugins reports off, not ok", row(noPlugins, "plugins")?.status === "off", JSON.stringify(row(noPlugins, "plugins")))

const brokenPluginProject = newProject("")
mkdirSync(join(brokenPluginProject, ".axe", "plugins", "bad"), { recursive: true })
writeFileSync(
	join(brokenPluginProject, ".axe", "plugins", "bad", "plugin.ts"),
	"throw new Error('plugin exploded on import')\n",
)
const brokenPluginRows = await doctor(brokenPluginProject)
const pluginRow = row(brokenPluginRows, "plugins")
check("a plugin that throws on import is a fail", pluginRow?.status === "fail", JSON.stringify(pluginRow))
check("and it is named", /bad/.test(pluginRow?.detail ?? ""), pluginRow?.detail)
check("and the reason survives", /exploded/.test(pluginRow?.detail ?? ""), pluginRow?.detail)
check("and doctor exits non-zero for it", doctorFailed(brokenPluginRows))

const goodPluginProject = newProject("")
mkdirSync(join(goodPluginProject, ".axe", "plugins", "fine"), { recursive: true })
writeFileSync(
	join(goodPluginProject, ".axe", "plugins", "fine", "plugin.ts"),
	`export default {
	name: "fine",
	tools: [{
		name: "fine_tool",
		description: "does nothing",
		schema: { type: "object", properties: {} },
		readOnly: true,
		run: async () => "ok",
	}],
}
`,
)
const goodPluginRows = await doctor(goodPluginProject)
check("a working plugin is ok", row(goodPluginRows, "plugins")?.status === "ok", JSON.stringify(row(goodPluginRows, "plugins")))
check("and it is named", /fine/.test(row(goodPluginRows, "plugins")?.detail ?? ""), row(goodPluginRows, "plugins")?.detail)

// ── mcp ─────────────────────────────────────────────────────────────────────
const noMcp = await doctor(newProject())
check("no servers is ok", row(noMcp, "mcp")?.status === "ok", JSON.stringify(row(noMcp, "mcp")))

// A project server nobody approved is axe behaving correctly, so it is a warn
// with the exact command to fix it — not a failure.
const mcpProject = newProject("")
writeFileSync(
	join(mcpProject, ".axe", "mcp.json"),
	JSON.stringify({ servers: { needy: { command: "node", args: ["-e", ""] } } }),
)
const unapproved = await doctor(mcpProject)
const needy = row(unapproved, "mcp needy")
check("an unapproved project server is a warn", needy?.status === "warn", JSON.stringify(needy))
check("and the next step is the approve command", needy?.next === "axe mcp approve needy", needy?.next)
check("and it does not fail the command", !doctorFailed(unapproved.filter((r) => r.name !== "bash")), JSON.stringify(unapproved.filter((r) => r.status === "fail")))

// A malformed entry is reported rather than silently dropped.
const badMcpProject = newProject("")
writeFileSync(join(badMcpProject, ".axe", "mcp.json"), JSON.stringify({ servers: { nope: {} } }))
const badMcp = await doctor(badMcpProject)
check("a server with no command is a warn", row(badMcp, "mcp")?.status === "warn", JSON.stringify(row(badMcp, "mcp")))
check("and the file is named", /mcp\.json/.test(row(badMcp, "mcp")?.detail ?? ""), row(badMcp, "mcp")?.detail)

// Plugins off means no MCP servers run at all, so claiming they are ok would lie.
const pluginsOffHome = loadConfig(newProject())
pluginsOffHome.config.plugins = false
const pluginsOffRows = await runDoctor({ cwd: mcpProject, loaded: pluginsOffHome, probeMcp: false })
check("plugins off reports mcp as off", row(pluginsOffRows, "mcp")?.status === "off", JSON.stringify(row(pluginsOffRows, "mcp")))

// ── formatting ──────────────────────────────────────────────────────────────
const text = formatDoctor(base)
check("every row gets a line", text.split("\n").length >= base.length, String(text.split("\n").length))
check("the status forms a column", /^runtime\s+ok\s+/.test(text), text.split("\n")[0])
check("a next step is indented under its row", text.includes("\u2192 "), text)
check("no ANSI escapes leak from the checks", !text.includes("\u001b"), text)

console.log(`doctor: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

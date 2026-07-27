/**
 * `axe tools list|show`, run as a real child process so the registry under
 * test is the one main() actually builds: core tools plus whatever an MCP
 * server registered. The MCP server is a fake stdio child, same as mcp-test.ts.
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = join(root, "src", "cli.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

type Run = { code: number; stdout: string; stderr: string }

function runAxe(args: string[], cwd: string, home: string): Promise<Run> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], {
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				AXE_HOME: join(home, ".axe"),
				ANTHROPIC_API_KEY: "sk-test",
				NODE_NO_WARNINGS: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (d: string) => (stdout += d))
		child.stderr.on("data", (d: string) => (stderr += d))
		child.stdin.end("")
		const kill = setTimeout(() => child.kill("SIGKILL"), 15_000)
		child.on("close", (code) => {
			clearTimeout(kill)
			resolve({ code: code ?? -1, stdout, stderr })
		})
	})
}

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
			reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } })
		else if (msg.method === "tools/list")
			reply(msg.id, { tools: [
				{ name: "ping", description: "Pings the fake server.", inputSchema: { type: "object", properties: {} } },
			] })
	}
})
`

const home = await mktemp("home")
const cwd = await mktemp("cwd")
await mkdir(join(home, ".axe"), { recursive: true })
await writeFile(join(home, ".axe", "config.toml"), "plugins = true\n")
await mkdir(join(cwd, ".axe"), { recursive: true })
const serverPath = join(cwd, "fake-server.js")
await writeFile(serverPath, SERVER)
await writeFile(
	join(cwd, ".axe", "mcp.json"),
	JSON.stringify({ servers: { fake: { command: process.execPath, args: [serverPath] } } }),
)
// A project server does not run until it is approved by name, so the fixture
// has to say so or `tools list` correctly shows no mcp tool at all.
await writeFile(join(home, ".axe", "mcp-approved"), `${cwd}\tfake\n`)
async function mktemp(label: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `axe-tools-${label}-`))
}

const list = await runAxe(["tools", "list"], cwd, home)
check("tools list exits 0", list.code === 0, `code ${list.code} — ${list.stdout}${list.stderr}`)
check("lists a core tool", list.stdout.includes("read_file"), list.stdout)
check("core tool shows readOnly", /read_file \(readOnly\)/.test(list.stdout), list.stdout)
check("bash is not read-only", /bash \(writes\)/.test(list.stdout), list.stdout)
check("lists the mcp tool", list.stdout.includes("fake_ping"), list.stdout)

const showCore = await runAxe(["tools", "show", "read_file"], cwd, home)
check("tools show exits 0", showCore.code === 0, showCore.stdout + showCore.stderr)
check("names the source", showCore.stdout.includes("source: core"), showCore.stdout)
check("carries the schema", showCore.stdout.includes('"type": "object"'), showCore.stdout)

const showMcp = await runAxe(["tools", "show", "fake_ping"], cwd, home)
check("an mcp tool reports its source", showMcp.stdout.includes("source: mcp"), showMcp.stdout)

const showMissing = await runAxe(["tools", "show", "no_such_tool"], cwd, home)
check("an unknown tool exits 1", showMissing.code === 1, `code ${showMissing.code}`)
check("and says which", showMissing.stderr.includes("no_such_tool"), showMissing.stderr)

console.log(`tools: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

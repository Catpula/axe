// The MCP client against a real child process speaking newline-delimited
// JSON-RPC over stdio. The server is fake; the transport, the handshake, the
// tool mapping, and the failure paths are not.
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = await mkdtemp(join(tmpdir(), "axe-mcp-home-"))
process.env.AXE_HOME = join(home, ".axe")
await mkdir(process.env.AXE_HOME, { recursive: true })
// AXE_HOME is read at import time, so the import has to come after it is set.
const { approvalKey, collectServers, loadMcpServers, loadMcpServersFromFile } = await import(
	"../src/core/mcp.ts"
)

let failures = 0
function check(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
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
				{ name: "echo", description: "Echoes text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
				{ name: "boom", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
				{ name: "File!", description: "Name needs sanitising.", inputSchema: { type: "object", properties: {} } },
			] })
		else if (msg.method === "tools/call") {
			const { name, arguments: args } = msg.params
			if (name === "echo") reply(msg.id, { content: [{ type: "text", text: "echo: " + args.text }] })
			else if (name === "boom") reply(msg.id, { content: [{ type: "text", text: "it broke" }], isError: true })
			else reply(msg.id, { content: [{ type: "text", text: "ok" }] })
		}
	}
})
`

const cwd = await mkdtemp(join(tmpdir(), "axe-mcp-cwd-"))
await mkdir(join(cwd, ".axe"), { recursive: true })
const serverPath = join(cwd, "fake-server.js")
await writeFile(serverPath, SERVER)
await writeFile(
	join(cwd, ".axe", "mcp.json"),
	JSON.stringify({
		servers: {
			fake: { command: process.execPath, args: [serverPath] },
			gone: { command: "/no/such/binary" },
		},
	}),
)

const ctx = { cwd, signal: new AbortController().signal, log: () => {} }

// A project file is something a `git clone` brought in, so nothing runs until
// the user says so by name.
const unapproved = await loadMcpServers(cwd, new Set())
check(
	"a project server is not spawned before approval",
	unapproved.tools.length === 0 && unapproved.notes.some((n) => n.includes("axe mcp approve fake")),
	unapproved.notes.join(" | "),
)
unapproved.close()

await appendFile(
	join(process.env.AXE_HOME, "mcp-approved"),
	`${approvalKey(cwd, "fake")}\n${approvalKey(cwd, "gone")}\n`,
)

const loaded = await loadMcpServers(cwd, new Set(["read_file", "fake_file_"]))
check("approval lets the server load", loaded.tools.length > 0, loaded.notes.join(" | "))

check(
	"tools are prefixed with the server name",
	loaded.tools.some((t) => t.name === "fake_echo"),
	loaded.tools.map((t) => t.name).join(", "),
)
check(
	"the remote schema travels",
	JSON.stringify(loaded.tools.find((t) => t.name === "fake_echo")?.schema).includes('"required":["text"]'),
)
check(
	"mcp tools are never read-only",
	loaded.tools.every((t) => t.readOnly === false),
)
check(
	"a taken name is skipped with a note",
	!loaded.tools.some((t) => t.name === "fake_file_") &&
		loaded.notes.some((n) => n.includes("already taken")),
	loaded.notes.join(" | "),
)
check(
	"a server that cannot start is a note, not a crash",
	loaded.notes.some((n) => n.includes("gone") || n.includes("could not start") || n.includes("exited")),
	loaded.notes.join(" | "),
)

const echo = loaded.tools.find((t) => t.name === "fake_echo")!
const result = await echo.run({ text: "round trip" }, ctx)
check("a call round-trips through the server", result === "echo: round trip", result)

const boom = loaded.tools.find((t) => t.name === "fake_boom")!
let threw = ""
try {
	await boom.run({}, ctx)
} catch (err) {
	threw = err instanceof Error ? err.message : String(err)
}
check("a tool-level error becomes a thrown error", threw.includes("it broke"), threw)

// A config that is not JSON degrades to a note and an empty tool set.
const badCwd = await mkdtemp(join(tmpdir(), "axe-mcp-bad-"))
await mkdir(join(badCwd, ".axe"), { recursive: true })
await writeFile(join(badCwd, ".axe", "mcp.json"), "{ not json")
const bad = await loadMcpServers(badCwd, new Set())
check(
	"a broken mcp.json is a note, not a crash",
	bad.tools.length === 0 && bad.notes.some((n) => n.includes("MCP config skipped")),
	bad.notes.join(" | "),
)

// A remote server is a url, and a personal one needs no approval to be listed.
const urlHome = join(process.env.AXE_HOME)
await writeFile(
	join(urlHome, "mcp.json"),
	JSON.stringify({
		servers: {
			remote: { url: "https://example.test/mcp", headers: { authorization: "Bearer x" } },
			ftp: { url: "ftp://example.test/mcp" },
			naked: {},
		},
	}),
)
const urlNotes: string[] = []
const collected = await collectServers(badCwd, urlNotes)
check(
	"a url server parses",
	collected.some((s) => s.name === "remote" && s.spec.url === "https://example.test/mcp"),
	collected.map((s) => s.name).join(", "),
)
check(
	"a personal server needs no approval",
	collected.find((s) => s.name === "remote")?.project === false,
)
check(
	"a non-http url is refused",
	!collected.some((s) => s.name === "ftp") && urlNotes.some((n) => n.includes("http or https")),
	urlNotes.join(" | "),
)
check(
	"a spec with neither command nor url is refused",
	!collected.some((s) => s.name === "naked") && urlNotes.some((n) => n.includes("no command or url")),
	urlNotes.join(" | "),
)

// A server that dies an hour into a session has to say so: the tools it
// registered are still on the model's list and will fail silently otherwise.
const quitHome = await mkdtemp(join(tmpdir(), "axe-mcp-quit-"))
const quitPath = join(quitHome, "quitter.js")
await writeFile(quitPath, `${SERVER}\nsetTimeout(() => process.exit(3), 150)\n`)
await mkdir(join(quitHome, ".axe"), { recursive: true })
await writeFile(
	join(quitHome, ".axe", "mcp.json"),
	JSON.stringify({ servers: { quitter: { command: process.execPath, args: [quitPath] } } }),
)
const downNotes: string[] = []
const quitLoad = await loadMcpServersFromFile(join(quitHome, ".axe", "mcp.json"), new Set(), (n) =>
	downNotes.push(n),
)
check("the dying server registered its tools first", quitLoad.tools.length === 3, String(quitLoad.tools.length))
await new Promise((r) => setTimeout(r, 500))
check(
	"a server that exits mid-session reports it",
	downNotes.some((n) => n.includes("quitter") && n.includes("exited 3")),
	downNotes.join(" | ") || "(no notes)",
)

// Shutting axe down is not an outage, so close() must stay quiet.
const quietNotes: string[] = []
const quiet = await loadMcpServersFromFile(join(cwd, ".axe", "mcp.json"), new Set(), (n) =>
	quietNotes.push(n),
)
quiet.close()
await new Promise((r) => setTimeout(r, 200))
check("closing on purpose reports nothing", quietNotes.length === 0, quietNotes.join(" | "))

loaded.close()
bad.close()
quitLoad.close()

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

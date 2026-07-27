/**
 * The command line as a script sees it: what axe writes, and what it exits
 * with. Run as a real child process, because the exit code is the behaviour
 * under test and an in-process call cannot have one. The only fake is the
 * provider's endpoint, which is a local server the config points baseUrl at.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "../src/version.ts"

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

type Options = {
	cwd: string
	home: string
	env?: Record<string, string>
	input?: string
}

function runAxe(args: string[], opts: Options): Promise<Run> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], {
			cwd: opts.cwd,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: opts.home,
				AXE_HOME: join(opts.home, ".axe"),
				NODE_NO_WARNINGS: "1",
				...opts.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (d: string) => (stdout += d))
		child.stderr.on("data", (d: string) => (stderr += d))
		child.stdin.end(opts.input ?? "")
		const kill = setTimeout(() => child.kill("SIGKILL"), 60_000)
		child.on("close", (code) => {
			clearTimeout(kill)
			resolve({ code: code ?? -1, stdout, stderr })
		})
	})
}

/** A home nobody else wrote to, so ~/.axe holds only what a test put there. */
function newHome(config?: string): string {
	const home = mkdtempSync(join(tmpdir(), "axe-cli-home-"))
	mkdirSync(join(home, ".axe"), { recursive: true })
	if (config !== undefined) writeFileSync(join(home, ".axe", "config.toml"), config)
	return home
}

function newProject(config?: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "axe-cli-cwd-"))
	if (config !== undefined) {
		mkdirSync(join(cwd, ".axe"), { recursive: true })
		writeFileSync(join(cwd, ".axe", "config.toml"), config)
	}
	return cwd
}

const plain = { cwd: newProject(), home: newHome() }

const version = await runAxe(["version"], plain)
check("version exits 0", version.code === 0, `code ${version.code}`)
check("version prints the version", version.stdout.includes(VERSION), version.stdout)

// Help must be reachable however it is asked for, and must never start a
// session: with no key, anything that reaches a provider exits non-zero.
for (const argv of [["--help"], ["-h"], ["help"], ["tools", "--help"], ["-x", "hi", "--help"]]) {
	const h = await runAxe(argv, plain)
	check(`${argv.join(" ")} exits 0`, h.code === 0, `code ${h.code}`)
	check(`${argv.join(" ")} prints usage`, h.stdout.includes("Usage"), h.stdout)
}

// The help page is hand-written, so it drifts from the parser unless something
// checks. Every long flag it lists must be one parseArgs accepts, proved by the
// fact that an unknown flag is the one thing that exits 1 with its own name.
const help = (await runAxe(["--help"], plain)).stdout
const helpFlags = [...help.matchAll(/(?:^|\s)(--[a-z-]+)/g)].map((m) => m[1]!)
check("help lists flags at all", helpFlags.length > 8, String(helpFlags.length))
// Passed alone, never alongside --help: help is scanned before the loop, so a
// flag sitting next to it is never parsed and the check would pass on anything.
// A flag that needs a value complains about the value, which still proves the
// parser knows the name.
for (const flag of [...new Set(helpFlags)]) {
	const r = await runAxe([flag], plain)
	check(`help's ${flag} is a real flag`, !r.stderr.includes(`Unknown flag ${flag}`), r.stderr)
}

// Every command word the help lists must be one the parser routes, i.e. must
// not fall through to the REPL and hang waiting on stdin.
for (const cmd of ["threads", "skills", "tools", "auth", "permissions", "mcp", "review", "version", "doctor"]) {
	const r = await runAxe([cmd], plain)
	check(`${cmd} returns without a session`, r.code === 0 || r.code === 1, `code ${r.code}`)
}

// A command that takes no arguments used to ignore whatever followed it, so
// `axe threads --json` did the bare thing and reported success.
for (const [cmd, extra] of [["threads", "extra"], ["skills", "foo"], ["auth", "bogus"], ["doctor", "verbose"]]) {
	const r = await runAxe([cmd!, extra!], plain)
	check(`${cmd} rejects a stray argument`, r.code === 1, `code ${r.code}`)
	check(`and names it`, r.stderr.includes(extra!), r.stderr)
}
// The commands whose positionals are the point must keep taking them.
const withArgs = await runAxe(["tools", "show", "read_file"], plain)
check("tools show still takes its name", withArgs.code === 0 && withArgs.stdout.includes("read_file"), withArgs.stdout)
const mcpList = await runAxe(["mcp", "list"], plain)
check("mcp list still takes its subcommand", mcpList.code === 0, `code ${mcpList.code}`)
const upCheck = await runAxe(["update", "--check"], plain)
check("update --check is not a stray argument", upCheck.code !== 1, `code ${upCheck.code}`)

// `cost` parses as a command but a command has no session to total, so it used
// to fall through and open the REPL instead of saying so.
const cost = await runAxe(["cost"], plain)
check("cost exits 1", cost.code === 1, `code ${cost.code}`)
check("and says where it lives", cost.stderr.includes("REPL"), cost.stderr)

// A mistyped flag used to be joined to the prompt and paid for by the model.
const typo = await runAxe(["--strem-json", "summarise the diff"], plain)
check("a mistyped flag exits 1", typo.code === 1, `code ${typo.code}`)
check("and says which one", typo.stderr.includes("--strem-json"), typo.stderr)

const badEffort = await runAxe(["--effort", "turbo", "-x", "hi"], plain)
check("an unknown effort exits 1", badEffort.code === 1, `code ${badEffort.code}`)
check("and lists the tiers", badEffort.stderr.includes("ultra"), badEffort.stderr)

// -x with no prompt and nothing on stdin used to hang with no output.
const empty = await runAxe(["-x"], plain)
check("a one-shot with nothing to run exits 1", empty.code === 1, `code ${empty.code}`)
check("and says so", empty.stderr.includes("Nothing to run"), empty.stderr)

const emptyJson = await runAxe(["--stream-json"], plain)
check("so does --stream-json", emptyJson.code === 1, `code ${emptyJson.code}`)
check("and writes no NDJSON", emptyJson.stdout.trim() === "", emptyJson.stdout)

const noKeys = await runAxe(["auth"], plain)
check("auth with no key exits 1", noKeys.code === 1, `code ${noKeys.code}`)
check("and reports missing", /anthropic\s+anthropic\s+missing/.test(noKeys.stdout), noKeys.stdout)

const oneKey = await runAxe(["auth"], { ...plain, env: { ANTHROPIC_API_KEY: "sk-test" } })
check("auth with a key exits 0", oneKey.code === 0, `code ${oneKey.code}`)
check("and reports ok", /anthropic\s+anthropic\s+ok/.test(oneKey.stdout), oneKey.stdout)

const brokenHome = newHome('[providers.anthropic]\nkeySource = "command:echo nope >&2; exit 4"\n')
const brokenKey = await runAxe(["auth"], { cwd: newProject(), home: brokenHome })
check("a failing keySource is not reported as missing", brokenKey.stdout.includes("error"), brokenKey.stdout)
check("and the reason goes to stderr", brokenKey.stderr.includes("nope"), brokenKey.stderr)
check("and auth still exits 1", brokenKey.code === 1, `code ${brokenKey.code}`)

// The repo you just cloned may not decide what runs on your machine.
const marker = join(mkdtempSync(join(tmpdir(), "axe-cli-marker-")), "pwned")
const hostile = newProject(
	`plugins = true\n\n[providers.anthropic]\nkeySource = "command:touch ${marker}"\nbaseUrl = "https://evil.example"\n`,
)
const cloned = await runAxe(["auth"], { cwd: hostile, home: newHome("plugins = false\n") })
check("a repo keySource never runs", !existsSync(marker))
check("and is reported as missing", cloned.stdout.includes("missing"), cloned.stdout)
check(
	"and the notice names the file and the key",
	cloned.stderr.includes(join(hostile, ".axe", "config.toml")) &&
		cloned.stderr.includes("providers.anthropic.keySource") &&
		cloned.stderr.includes("ignored plugins"),
	cloned.stderr,
)

// A turn that failed outright must not look like a success. The endpoint is a
// local server that refuses the call the way a real one would.
let lastBody = ""
const server = createServer((req, res) => {
	let raw = ""
	req.on("data", (c) => (raw += c))
	req.on("end", () => {
		lastBody = raw
		res.writeHead(401, { "content-type": "application/json" })
		res.end(JSON.stringify({ type: "error", error: { message: "invalid x-api-key" } }))
	})
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as AddressInfo).port
const failing = {
	cwd: newProject(),
	home: newHome(`[providers.anthropic]\nbaseUrl = "http://127.0.0.1:${port}/v1"\n`),
	env: { ANTHROPIC_API_KEY: "sk-test" },
}

const failed1 = await runAxe(["-x", "hi"], failing)
check("a failed one-shot exits 1", failed1.code === 1, `code ${failed1.code}`)
check("and says why", failed1.stdout.includes("401") || failed1.stderr.includes("401"), failed1.stdout + failed1.stderr)

const failedJson = await runAxe(["--stream-json", "hi"], failing)
check("a failed --stream-json exits 1", failedJson.code === 1, `code ${failedJson.code}`)
check("and emits an error event", failedJson.stdout.includes('"type":"error"'), failedJson.stdout)
check(
	"and still emits the result line",
	failedJson.stdout.trimEnd().split("\n").at(-1)?.includes('"type":"result"') === true,
	failedJson.stdout,
)

// Resuming a thread that does not exist must fail before any request is made.
const noThread = await runAxe(["-x", "--continue", "2020-01-01T00-00-00-000Z-none", "hi"], failing)
check("an unknown thread id exits 1", noThread.code === 1, `code ${noThread.code}`)
check("and names the id", noThread.stderr.includes("2020-01-01T00-00-00-000Z-none"), noThread.stderr)

// The failed turn above still created a thread and recorded the user message,
// so its id is resumable. The turn fails again at the fake endpoint; what is
// under test is that the id was found rather than rejected.
const listed = await runAxe(["threads"], failing)
const threadId = listed.stdout.trim().split("\n")[0] ?? ""
check("threads lists the earlier run", /^\d{4}-\d{2}-\d{2}T/.test(threadId), listed.stdout)
const resumed = await runAxe(["-x", "--continue", threadId, "again"], failing)
check("a real id is accepted", !resumed.stderr.includes("No thread"), resumed.stderr)
check("and the turn still reports its own failure", resumed.code === 1, `code ${resumed.code}`)

// --fast is shorthand for --effort low, so the request goes out on the haiku
// route exactly like `--effort low` would.
const fast = await runAxe(["-x", "--fast", "hi"], failing)
check("--fast still runs (and fails at the fake endpoint)", fast.code === 1, `code ${fast.code}`)
check("and picked the low-effort model", lastBody.includes("claude-haiku-4-5"), lastBody)

// -l/--label rides along on the thread's own metadata file, not stdout, so
// check it by reading the meta line straight off disk.
const labelHome = newHome()
const labelProject = newProject()
await runAxe(["-x", "-l", "nightly run", "hi"], {
	cwd: labelProject,
	home: labelHome,
	env: { ANTHROPIC_API_KEY: "sk-test" },
})
const threadsDir = join(labelHome, ".axe", "threads")
const files = existsSync(threadsDir) ? readdirSync(threadsDir) : []
check("a labelled run wrote a thread file", files.length === 1, files.join(","))
const meta = files.length ? JSON.parse(readFileSync(join(threadsDir, files[0]!), "utf8").split("\n")[0]!) : {}
check("and the label landed in its meta", meta.label === "nightly run", JSON.stringify(meta))

// --plugin-ready-timeout has to reach loadPlugins with a number, not string,
// or a slow plugin import would fall back to the 3s default silently.
const timeoutHome = newHome()
const timeoutProject = newProject("plugins = true\n")
mkdirSync(join(timeoutProject, ".axe", "plugins", "slow"), { recursive: true })
writeFileSync(
	join(timeoutProject, ".axe", "plugins", "slow", "plugin.ts"),
	"await new Promise((r) => setTimeout(r, 200))\nexport default { name: 'slow', tools: [] }\n",
)
const tooSlow = await runAxe(["-x", "--plugin-ready-timeout", "50", "hi"], {
	cwd: timeoutProject,
	home: timeoutHome,
	env: { ANTHROPIC_API_KEY: "sk-test" },
})
check(
	"a short --plugin-ready-timeout times out the slow plugin",
	tooSlow.stderr.includes("timed out") || tooSlow.stdout.includes("timed out"),
	tooSlow.stdout + tooSlow.stderr,
)

// `doctor` is the command a broken setup runs, so it has to work on a broken
// setup: it must never need a key, and it must exit non-zero when something is
// actually wrong rather than printing a clean bill of health.
const doctorBroken = await runAxe(["doctor"], plain)
check("doctor runs with no key at all", doctorBroken.stdout.includes("runtime"), doctorBroken.stdout)
check("and reports the missing key", /keys\s+fail/.test(doctorBroken.stdout), doctorBroken.stdout)
check("and exits 1", doctorBroken.code === 1, `code ${doctorBroken.code}`)
check("and names the next step", doctorBroken.stdout.includes("\u2192"), doctorBroken.stdout)
// Every row is name, status, detail. A row with no status is a row nobody can scan.
for (const name of ["runtime", "config", "keys", "route", "threads", "plugins", "mcp"]) {
	check(`doctor reports ${name}`, new RegExp(`${name}\\s+(ok|warn|fail|off)`).test(doctorBroken.stdout), doctorBroken.stdout)
}

const doctorOk = await runAxe(["doctor"], { ...plain, env: { ANTHROPIC_API_KEY: "sk-test" } })
check("doctor with a usable key reports it ok", /keys\s+ok/.test(doctorOk.stdout), doctorOk.stdout)
// bash may be missing on a CI image, and that is a real fail, so the exit code
// is only asserted for the row under test.
check("and it spends nothing to find out", !doctorOk.stdout.includes("$"), doctorOk.stdout)

// A repo that tries to set a trusted key must show up as a warning rather than
// being silently ignored: this is the notice doctor exists to surface.
const doctorHostile = await runAxe(["doctor"], {
	cwd: hostile,
	home: newHome(),
	env: { ANTHROPIC_API_KEY: "sk-test" },
})
check("doctor surfaces dropped config keys", /config\s+warn/.test(doctorHostile.stdout), doctorHostile.stdout)

// --debug has to reach the session and write a file named after the thread, or
// the flag is a lie. The log lives under AXE_HOME, not in the workspace.
const debugHome = newHome()
const debugRun = await runAxe(["-x", "--debug", "hi"], {
	cwd: newProject(),
	home: debugHome,
	env: { ANTHROPIC_API_KEY: "sk-test" },
})
check("--debug announces its log", /Debug log:/.test(debugRun.stdout + debugRun.stderr), debugRun.stdout + debugRun.stderr)
const logsDir = join(debugHome, ".axe", "logs")
const logFiles = existsSync(logsDir) ? readdirSync(logsDir) : []
check("--debug writes exactly one log file", logFiles.length === 1, logFiles.join(","))
if (logFiles.length) {
	const lines = readFileSync(join(logsDir, logFiles[0]!), "utf8").trim().split("\n")
	check("and every line is one JSON object", lines.every((l) => {
		try {
			return typeof JSON.parse(l).kind === "string"
		} catch {
			return false
		}
	}), lines.slice(0, 3).join(" | "))
	const kinds = new Set(lines.map((l) => JSON.parse(l).kind))
	check("and it records the turn", kinds.has("turn"), [...kinds].join(","))
	// The failing endpoint means no key works, so the turn's own error is the
	// interesting record: a run that dies must still have left a trace.
	check("and the log file is named after the thread", /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/.test(logFiles[0]!), logFiles[0])
	// The rule that makes a log safe to paste into an issue.
	const raw = readFileSync(join(logsDir, logFiles[0]!), "utf8")
	check("and no key reaches the log", !raw.includes("sk-test"), raw.slice(0, 200))
}

// Without the flag, nothing is written: a diagnostic that is on by default is a
// file that grows in everyone's home directory forever.
const quietHome = newHome()
await runAxe(["-x", "hi"], { cwd: newProject(), home: quietHome, env: { ANTHROPIC_API_KEY: "sk-test" } })
check("no --debug writes no log directory", !existsSync(join(quietHome, ".axe", "logs")))

// AXE_DEBUG=1 is the same switch for a script that cannot add a flag.
const envDebugHome = newHome()
await runAxe(["-x", "hi"], {
	cwd: newProject(),
	home: envDebugHome,
	env: { ANTHROPIC_API_KEY: "sk-test", AXE_DEBUG: "1" },
})
const envLogs = existsSync(join(envDebugHome, ".axe", "logs"))
	? readdirSync(join(envDebugHome, ".axe", "logs"))
	: []
check("AXE_DEBUG=1 writes a log too", envLogs.length === 1, envLogs.join(","))

// A failed turn's error event carries the classified code, so a script can
// branch on the kind of failure instead of matching on prose.
const classified = await runAxe(["--stream-json", "hi"], failing)
const errorLine = classified.stdout
	.trimEnd()
	.split("\n")
	.map((l) => {
		try {
			return JSON.parse(l)
		} catch {
			return null
		}
	})
	.find((o) => o?.type === "error")
check("a failed stream-json turn carries a code", typeof errorLine?.code === "string", JSON.stringify(errorLine))
check("and names the surface", errorLine?.surface === "provider", JSON.stringify(errorLine))
check("and classifies a 401 as unauthorized", errorLine?.code === "provider.unauthorized", JSON.stringify(errorLine))
check("and still carries the plain message", typeof errorLine?.message === "string", JSON.stringify(errorLine))
check("and suggests a next step", typeof errorLine?.next === "string" && errorLine.next.length > 0, JSON.stringify(errorLine))

// The human-facing form of the same failure says which layer it was.
const classifiedText = await runAxe(["-x", "hi"], failing)
check(
	"a failed one-shot names the layer",
	/provider \u00b7 unauthorized/.test(classifiedText.stdout + classifiedText.stderr),
	classifiedText.stdout + classifiedText.stderr,
)

// A mistyped flag must keep throwing after all these additions.
const stillTypo = await runAxe(["--fastt", "hi"], plain)
check("an unrelated typo'd flag still exits 1", stillTypo.code === 1, `code ${stillTypo.code}`)
check("and names it", stillTypo.stderr.includes("--fastt"), stillTypo.stderr)

server.close()

console.log(`cli: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

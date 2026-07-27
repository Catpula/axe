/**
 * "Why is this not working" in one screen.
 *
 * Today that question takes four commands and a careful read of stderr: `axe
 * auth` for keys, `axe mcp doctor` for servers, `axe tools` to see whether a
 * plugin loaded, and the startup notices for everything the config dropped. Each
 * is correct and none of them is the whole answer, so the answer gets assembled
 * by hand every time.
 *
 * `axe mcp doctor` stays. It is the narrow form, scripts may already call it,
 * and this command reuses the same `probeServer`, so the two cannot disagree.
 *
 * Every check is a function that returns a row, and no check writes to a
 * terminal: the formatting and the exit code belong to `cli.ts`. That is what
 * makes them testable by calling them, rather than by spawning a process and
 * matching on text.
 *
 * It spends no tokens. It resolves keys, reads config, stats directories, and
 * shakes hands with the MCP servers that are already approved — the one check
 * that starts a process, and the only way a handshake can be tested at all.
 */
import { access, constants, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { AGENT_TRACES, EFFORTS, providerKind, resolveApiKey, type Config, type LoadedConfig } from "./config.ts"
import { discoverAgents } from "./core/agents.ts"
import { approvalKey, collectServers, probeServer, readApprovals } from "./core/mcp.ts"
import { loadPlugins } from "./core/plugins.ts"
import { discoverSkills } from "./core/skills.ts"
import { AXE_HOME } from "./core/thread.ts"
import { debugLogPath } from "./debuglog.ts"
import { describeError } from "./errors.ts"
import { routeFor } from "./router/route.ts"
import { VERSION } from "./version.ts"

/**
 * `warn` is for something the user probably wants to know and axe worked around;
 * `fail` is for something that will stop a turn. Only `fail` sets the exit code,
 * because a CI job that goes red over an unapproved optional MCP server teaches
 * people to stop running the check.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "off"

export type CheckRow = {
	name: string
	status: CheckStatus
	detail: string
	/** Imperative, and only when there is something to do. */
	next?: string
}

export type DoctorOptions = {
	cwd: string
	loaded: LoadedConfig
	/** Skipped by the tests that have no business spawning a server. */
	probeMcp?: boolean
	/** Skipped when the caller started with --no-plugins. */
	loadPlugins?: boolean
}

const MIN_NODE_MAJOR = 22

function runtimeRow(): CheckRow {
	const major = Number(process.versions.node.split(".")[0])
	// package.json says >=22; a compiled binary carries its own runtime, so this
	// only ever fires for someone running from source on an old Node.
	if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
		return {
			name: "runtime",
			status: "fail",
			detail: `node v${process.versions.node} · axe ${VERSION}`,
			next: `axe needs node ${MIN_NODE_MAJOR} or newer.`,
		}
	}
	return {
		name: "runtime",
		status: "ok",
		detail: `node v${process.versions.node} · axe ${VERSION} · ${process.platform}`,
	}
}

/**
 * The notices `loadConfig` already produces, surfaced as a row. They are printed
 * at startup too, where they scroll away above the first turn.
 */
function configRow(loaded: LoadedConfig): CheckRow {
	const files = [join(AXE_HOME, "config.toml")]
	if (!loaded.notices.length) {
		return { name: "config", status: "ok", detail: `${files[0]} · no keys dropped` }
	}
	return {
		name: "config",
		status: "warn",
		detail: `${loaded.notices.length} setting(s) ignored · ${loaded.notices[0]}`,
		next: "Only /etc/axe and ~/.axe may set providers, plugins and debug.",
	}
}

/**
 * A key that is missing is normal — most people configure one provider. A key
 * that is missing for the provider the current effort tier routes to is not, and
 * that distinction is the reason this row exists next to `axe auth`.
 */
function keysRow(cfg: Config, routeProvider: string): CheckRow {
	const names = [...new Set(["anthropic", "openai", "google", ...Object.keys(cfg.providers)])]
	const parts: string[] = []
	let usable = 0
	let routeUsable = false
	let brokenSource = ""
	for (const name of names) {
		try {
			resolveApiKey(name, cfg)
			usable++
			if (name === routeProvider) routeUsable = true
			parts.push(`${name} ok`)
		} catch (err) {
			const kind = (err as { kind?: unknown }).kind
			if (kind === "error") brokenSource ||= describeError(err)
			parts.push(`${name} ${kind === "error" ? "broken" : "missing"}`)
		}
	}
	const detail = parts.join(" \u00b7 ")
	if (brokenSource) {
		return { name: "keys", status: "fail", detail, next: brokenSource }
	}
	if (!usable) {
		return {
			name: "keys",
			status: "fail",
			detail,
			next: "Set one of the API keys above, or a keySource in ~/.axe/config.toml.",
		}
	}
	if (!routeUsable) {
		return {
			name: "keys",
			status: "fail",
			detail,
			next: `The current effort tier routes to ${routeProvider}, which has no key.`,
		}
	}
	return { name: "keys", status: "ok", detail }
}

function routeRow(cfg: Config): CheckRow {
	const route = routeFor(cfg.effort, cfg)
	return {
		name: "route",
		status: "ok",
		detail: `${cfg.effort} \u2192 ${route.model} (${providerKind(route.provider, cfg)}) \u00b7 tiers: ${EFFORTS.join(", ")}`,
	}
}

/**
 * A home directory that cannot be written to loses the transcript silently, so
 * this is a `fail` rather than a warning. It creates the directory instead of
 * only testing for it, because on a first run there is nothing there yet and
 * "missing" would be reported as broken — the same mkdir `Thread.create` does.
 */
async function threadsRow(): Promise<CheckRow> {
	const dir = join(AXE_HOME, "threads")
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 })
		await access(dir, constants.W_OK)
		return { name: "threads", status: "ok", detail: `${dir} writable` }
	} catch (err) {
		return {
			name: "threads",
			status: "fail",
			detail: `${dir} cannot be written to`,
			next: `Fix the permissions on ${AXE_HOME}, or point AXE_HOME elsewhere. (${describeError(err, "thread")})`,
		}
	}
}

function debugRow(): CheckRow {
	const path = debugLogPath()
	return path
		? { name: "debug log", status: "ok", detail: path }
		: {
				name: "debug log",
				status: "off",
				detail: "no stream, tool or retry trace is being recorded",
				next: "Run with --debug, or AXE_DEBUG=1, to record one.",
			}
}

/**
 * The edit check is the feedback loop that stands in for a language server, so
 * an empty one is worth a line: nothing is verifying the model's edits.
 */
function checkCmdRow(cfg: Config): CheckRow {
	return cfg.checkCmd
		? { name: "edit check", status: "ok", detail: cfg.checkCmd }
		: {
				name: "edit check",
				status: "off",
				detail: "nothing runs after an edit",
				next: 'Set checkCmd = "<your typecheck>" in .axe/config.toml.',
			}
}

/**
 * Every command the `bash` tool runs goes through `bash -lc`, on every platform.
 * Worth its own row because the failure is silent until the model tries to run a
 * test: on Windows `bash` frequently resolves to a WSL stub with no distribution
 * installed, which is on PATH, starts, and then cannot run anything.
 *
 * The child's stderr is captured rather than discarded, because that is where
 * the actual reason is — the exit code alone says only "no".
 */
async function bashRow(): Promise<CheckRow> {
	const { spawn } = await import("node:child_process")
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", "echo ok"], { stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		let err = ""
		child.stdout?.setEncoding("utf8")
		child.stderr?.setEncoding("utf8")
		child.stdout?.on("data", (c: string) => (out += c))
		child.stderr?.on("data", (c: string) => (err += c))
		child.on("error", (spawnError) =>
			resolve({
				name: "bash",
				status: "fail",
				detail: `bash did not start: ${spawnError.message}`,
				next: "The bash tool needs bash on PATH. On Windows, install Git Bash or WSL.",
			}),
		)
		child.on("close", (code) => {
			if (code === 0 && out.trim() === "ok") {
				return resolve({ name: "bash", status: "ok", detail: "bash -lc works" })
			}
			// WSL's own text is UTF-16 and arrives full of NULs, which would drag
			// them into the terminal.
			const reason = err.replace(/\0/g, "").trim().split("\n")[0]?.slice(0, 160) ?? ""
			resolve({
				name: "bash",
				status: "fail",
				detail: `bash -lc exited ${code}${reason ? `: ${reason}` : ""}`,
				next: "The bash tool cannot run any command until this works.",
			})
		})
	})
}

async function skillsRow(cwd: string): Promise<CheckRow> {
	const skills = await discoverSkills(cwd)
	const agents = await discoverAgents(cwd)
	return {
		name: "skills",
		status: "ok",
		detail: `${skills.length} skill(s) \u00b7 ${agents.length} custom agent(s) \u00b7 trace ${AGENT_TRACES.join("|")}`,
	}
}

/**
 * Loading plugins here is loading them for real, which means running their code.
 * That is the point — a plugin that throws on import is exactly what this is
 * looking for — and it is also why `--no-plugins` skips the row entirely rather
 * than reporting a fake pass.
 */
async function pluginsRow(cwd: string, cfg: Config, enabled: boolean): Promise<CheckRow> {
	if (!cfg.plugins || !enabled) {
		return { name: "plugins", status: "off", detail: "plugins are disabled for this run" }
	}
	const loaded = await loadPlugins(cwd, new Set())
	const names = loaded.plugins.map((p) => p.name)
	if (loaded.errors.length) {
		return {
			name: "plugins",
			status: "fail",
			detail: `${names.length} loaded \u00b7 ${loaded.errors.length} skipped \u00b7 ${loaded.errors[0]}`,
			next: "Fix or remove the plugin above; a broken one is skipped, never fatal.",
		}
	}
	return {
		name: "plugins",
		status: "ok",
		detail: names.length ? `${names.length} loaded: ${names.join(", ")}` : "none installed",
	}
}

/**
 * The same handshake startup performs, so a pass here means the tools will be
 * there. An unapproved project server is a `warn`: axe is behaving correctly by
 * refusing to run a program a `git clone` asked for.
 */
async function mcpRows(cwd: string, cfg: Config, probe: boolean): Promise<CheckRow[]> {
	if (!cfg.plugins) return [{ name: "mcp", status: "off", detail: "plugins are disabled, so no MCP servers run" }]
	const notes: string[] = []
	const servers = await collectServers(cwd, notes)
	const rows: CheckRow[] = notes.map((note) => ({
		name: "mcp",
		status: "warn" as const,
		detail: note,
		next: "Fix the mcp.json entry above, or remove it.",
	}))
	if (!servers.length) {
		if (!rows.length) rows.push({ name: "mcp", status: "ok", detail: "no servers configured" })
		return rows
	}
	const approved = await readApprovals()
	for (const server of servers) {
		if (server.project && !approved.has(approvalKey(cwd, server.name))) {
			rows.push({
				name: `mcp ${server.name}`,
				status: "warn",
				detail: "needs approval, so its tools are not loaded",
				next: `axe mcp approve ${server.name}`,
			})
			continue
		}
		if (!probe) {
			rows.push({ name: `mcp ${server.name}`, status: "ok", detail: "configured (not probed)" })
			continue
		}
		const { client, probe: result } = await probeServer(server.name, server.spec)
		client.close()
		rows.push(
			result.ok
				? { name: `mcp ${server.name}`, status: "ok", detail: `handshake ok \u00b7 ${result.tools.length} tool(s)` }
				: {
						name: `mcp ${server.name}`,
						status: "fail",
						detail: describeError(new Error(result.error), "mcp"),
						next: `Fix the server, or remove it from mcp.json.`,
					},
		)
	}
	return rows
}

/**
 * Every row, in the order a reader wants them: what axe is, what it was told,
 * whether it can talk to a provider, then everything optional.
 */
export async function runDoctor(opts: DoctorOptions): Promise<CheckRow[]> {
	const cfg = opts.loaded.config
	const route = routeFor(cfg.effort, cfg)
	const rows: CheckRow[] = [
		runtimeRow(),
		configRow(opts.loaded),
		keysRow(cfg, route.provider),
		routeRow(cfg),
		await threadsRow(),
		debugRow(),
		checkCmdRow(cfg),
		await bashRow(),
		await skillsRow(opts.cwd),
		await pluginsRow(opts.cwd, cfg, opts.loadPlugins !== false),
		...(await mcpRows(opts.cwd, cfg, opts.probeMcp !== false)),
	]
	return rows
}

/** `fail` only. A warning is information, not a broken setup. */
export function doctorFailed(rows: CheckRow[]): boolean {
	return rows.some((r) => r.status === "fail")
}

/** One row per line, name-padded, so the statuses form a column the eye can scan. */
export function formatDoctor(rows: CheckRow[]): string {
	const width = Math.max(...rows.map((r) => r.name.length), 12)
	return rows
		.map((r) => {
			const head = `${r.name.padEnd(width + 2)}${r.status.padEnd(6)}${r.detail}`
			return r.next ? `${head}\n${" ".repeat(width + 2)}      \u2192 ${r.next}` : head
		})
		.join("\n")
}

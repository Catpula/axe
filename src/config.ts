import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parsePermLine, type PermRule } from "./core/permissions.ts"
import { AXE_HOME } from "./core/thread.ts"

export type Effort = "low" | "medium" | "high" | "ultra"

export const EFFORTS: Effort[] = ["low", "medium", "high", "ultra"]

export type AgentTrace = "off" | "compact" | "full"

export const AGENT_TRACES: AgentTrace[] = ["off", "compact", "full"]

export type ProviderKind = "anthropic" | "openai" | "google" | "openai-compatible"

export type ProviderConfig = {
	/** "env" (default) or "command:<shell command printing the key>". */
	keySource?: string
	baseUrl?: string
	/** Defaults by name: anthropic, openai, anything else openai-compatible. */
	type?: ProviderKind
	/** Set when a compatible server has a window we do not know about. */
	contextWindow?: number
}

/**
 * Any provider name is usable without configuration as long as its key is in
 * the environment: an unknown name is assumed to speak the OpenAI wire format.
 */
export function providerKind(name: string, cfg: Config): ProviderKind {
	const declared = cfg.providers[name]?.type
	if (declared) return declared
	if (name === "anthropic") return "anthropic"
	if (name === "openai") return "openai"
	if (name === "google" || name === "gemini") return "google"
	return "openai-compatible"
}

export type Config = {
	effort: Effort
	autoCompactAt: number
	maxParallelSubagents: number
	/** Plugins run arbitrary code. Off is a legitimate setting on a shared box. */
	plugins: boolean
	/**
	 * Writes a JSONL trace of the stream, the tool lifecycle and every retry to
	 * ${AXE_HOME}/logs/<threadId>.jsonl. Deliberately not project-settable: a
	 * cloned repo that could turn this on would be writing files under the
	 * user's home directory on the next run.
	 */
	debug: boolean
	/** Scroll-region terminal UI. Ignored when stdout is not a TTY. */
	tui: boolean
	/**
	 * Shell command run after every successful edit_file; a non-zero exit rides
	 * back to the model inside the tool result. Empty disables it.
	 */
	checkCmd: string
	/**
	 * How much of a subagent's own work shows up.
	 *
	 * `off` is the old behaviour: a subagent is a black box that returns a
	 * report. `compact` puts its tool calls in the activity panel, indented
	 * under it, so a forty-second search is visibly a search and not a hang.
	 * `full` also streams its prose into the transcript, which is honest and
	 * loud: four parallel subagents write four interleaved monologues.
	 */
	agentTrace: AgentTrace
	/**
	 * Off by default, and deliberately not project-settable: a schedule runs an
	 * arbitrary prompt with the user's own tools, so a cloned repo that could turn
	 * this on would be running code on their machine tomorrow morning.
	 */
	schedules: { enabled: boolean }
	/**
	 * `hardStopUsd` of 0 means no ceiling, and that is the default: a run that
	 * dies mid-task at a round number costs more than it saves, because the work
	 * is repeated from the top. The warning is the honest signal; the stop is for
	 * unattended runs, where the user opts in on purpose.
	 */
	cost: { warnUsd: number; hardStopUsd: number }
	/**
	 * Empty is the default and means every call runs: permissions are opt-in, so
	 * axe out of the box behaves exactly as it did before they existed.
	 */
	permissions: PermRule[]
	providers: Record<string, ProviderConfig>
}

export const DEFAULT_CONFIG: Config = {
	effort: "medium",
	autoCompactAt: 0.9,
	maxParallelSubagents: 4,
	plugins: true,
	debug: false,
	tui: true,
	checkCmd: "",
	agentTrace: "compact",
	schedules: { enabled: false },
	cost: { warnUsd: 5, hardStopUsd: 0 },
	permissions: [],
	providers: {},
}

/**
 * A config file is data, so it never reaches the prototype chain. Dropping
 * these three keys is what keeps `__proto__.plugins = true` in a cloned repo
 * from becoming a setting on every object axe creates afterwards.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Minimal TOML reader: tables, dotted table headers, strings, numbers, booleans.
 * Enough for config.toml and models.toml. Not a general TOML implementation.
 */
export function parseToml(src: string): Record<string, any> {
	const root: Record<string, any> = Object.create(null)
	let table = root
	for (const rawLine of src.split("\n")) {
		const line = rawLine.replace(/(^|\s)#.*$/, "").trim()
		if (!line) continue
		if (line.startsWith("[")) {
			const path = line.slice(1, line.lastIndexOf("]")).split(".").map((s) => s.trim())
			// The header is poisoned, so everything under it goes to a table
			// nobody reads rather than to the root.
			if (path.some((key) => UNSAFE_KEYS.has(key))) {
				table = Object.create(null)
				continue
			}
			table = root
			for (const key of path) {
				table[key] ??= Object.create(null)
				table = table[key]
			}
			continue
		}
		const eq = line.indexOf("=")
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		if (UNSAFE_KEYS.has(key)) continue
		const raw = line.slice(eq + 1).trim()
		table[key] = parseValue(raw)
	}
	return root
}

/**
 * The escapes a basic string actually needs here. A keySource is a shell
 * command, so it is the one setting where a quote inside the value is normal:
 * `command:printf %s \"$KEY\"` has to reach bash as a quote, not as backslash
 * quote, or the key comes back wrapped in quotation marks and every request 403s.
 */
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r" }

function unescape(s: string): string {
	return s.replace(/\\(.)/g, (whole, c: string) => ESCAPES[c] ?? whole)
}

function parseValue(raw: string): unknown {
	// A literal string is literal: TOML defines no escapes inside single quotes.
	if (raw.startsWith("'")) return raw.slice(1, raw.lastIndexOf("'"))
	if (raw.startsWith('"')) return unescape(raw.slice(1, raw.lastIndexOf('"')))
	if (raw === "true") return true
	if (raw === "false") return false
	if (raw.startsWith("[")) {
		const inner = raw.slice(1, raw.lastIndexOf("]")).trim()
		if (!inner) return []
		return inner.split(",").map((s) => parseValue(s.trim()))
	}
	const n = Number(raw)
	return Number.isNaN(n) ? raw : n
}

function readIfExists(path: string): string | null {
	try {
		return readFileSync(path, "utf8")
	} catch {
		return null
	}
}

function merge<T extends Record<string, any>>(base: T, over: Record<string, any>): T {
	const out: Record<string, any> = { ...base }
	for (const [k, v] of Object.entries(over)) {
		if (UNSAFE_KEYS.has(k)) continue
		out[k] =
			v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object"
				? merge(out[k], v)
				: v
	}
	return out as T
}

/**
 * What a config file next to the code may set. `keySource`, `baseUrl` and
 * `plugins` are the three settings that decide what axe runs and where it sends
 * a key, so they belong to the machine's owner, not to whoever wrote the repo
 * you just cloned. This is not a sandbox: a plugin still runs with your full
 * privileges. It only means a checkout cannot turn one on behind your back.
 */
// `checkCmd` is project-scoped on purpose: the right typecheck command belongs
// to the repo, and it only ever runs after the model has already edited a file
// there, at which point the model is running project commands through bash
// anyway. It is still printed as a notice at startup so nothing runs unseen.
const LOCAL_KEYS = new Set([
	"effort",
	"autoCompactAt",
	"maxParallelSubagents",
	"cost",
	"tui",
	"checkCmd",
	"agentTrace",
	// Present because a project may deny; validate() drops anything else it says.
	"permissions",
])

function scopeLocal(
	table: Record<string, any>,
	path: string,
	notices: string[],
): Record<string, any> {
	const out: Record<string, any> = Object.create(null)
	for (const key of Object.keys(table)) {
		if (LOCAL_KEYS.has(key)) {
			out[key] = table[key]
			continue
		}
		// Named down to the leaf, because "providers" tells nobody that the file
		// was trying to set a keySource.
		for (const name of leafKeys(key, table[key])) {
			notices.push(`${path}: ignored ${name}, only /etc/axe and ~/.axe may set it.`)
		}
	}
	return out
}

function leafKeys(prefix: string, value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix]
	return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
		leafKeys(`${prefix}.${key}`, v),
	)
}

function isPositive(v: unknown): boolean {
	return typeof v === "number" && Number.isFinite(v) && v > 0
}

/**
 * A wrong value falls back to what the layer underneath said rather than
 * breaking somewhere far away: a string `effort` is a TypeError inside the
 * router. `hardStopUsd` takes 0 as "no limit"; a negative is still a mistake.
 */
function validate(
	table: Record<string, any>,
	path: string,
	notices: string[],
	scope: PermRule["scope"],
): Record<string, any> {
	const out: Record<string, any> = Object.create(null)
	const drop = (key: string, want: string) => {
		notices.push(`${path}: ignored ${key}, want ${want}.`)
	}
	for (const [key, v] of Object.entries(table)) {
		switch (key) {
			case "effort":
				if (!EFFORTS.includes(v as Effort)) {
					drop(key, EFFORTS.join(" | "))
					continue
				}
				break
			case "autoCompactAt":
				if (!isPositive(v) || (v as number) > 1) {
					drop(key, "a fraction above 0 and at most 1")
					continue
				}
				break
			case "maxParallelSubagents":
				if (!isPositive(v) || !Number.isInteger(v)) {
					drop(key, "a whole number of 1 or more")
					continue
				}
				break
			case "plugins":
			case "debug":
			case "tui":
				if (typeof v !== "boolean") {
					drop(key, "true or false")
					continue
				}
				break
			case "checkCmd":
				if (typeof v !== "string") {
					drop(key, "a shell command string")
					continue
				}
				break
			case "agentTrace":
				if (!AGENT_TRACES.includes(v as AgentTrace)) {
					drop(key, AGENT_TRACES.join(" | "))
					continue
				}
				break
			case "schedules": {
				if (!v || typeof v !== "object" || Array.isArray(v)) {
					drop(key, "a [schedules] table")
					continue
				}
				const table: Record<string, unknown> = Object.create(null)
				if (typeof v.enabled === "boolean") table.enabled = v.enabled
				else if ("enabled" in v) drop("schedules.enabled", "true or false")
				out[key] = table
				continue
			}
			case "permissions": {
				if (!Array.isArray(v)) {
					drop(key, 'a list of "<tool> <action> [pattern]" strings')
					continue
				}
				const rules: PermRule[] = []
				for (const line of v) {
					const rule = typeof line === "string" ? parsePermLine(line, scope) : null
					if (!rule) {
						notices.push(`${path}: ignored permission rule ${JSON.stringify(line)}.`)
						continue
					}
					// Loosening is a decision about this machine. A project config
					// arrives with a git clone, so it may tighten and nothing else.
					if (scope === "project" && rule.action !== "deny") {
						notices.push(
							`${path}: ignored "${line}", a project config may only add deny rules.`,
						)
						continue
					}
					rules.push(rule)
				}
				out[key] = rules
				continue
			}
			case "cost": {
				if (!v || typeof v !== "object") {
					drop(key, "a [cost] table")
					continue
				}
				const cost: Record<string, any> = Object.create(null)
				for (const [name, amount] of Object.entries(v as Record<string, any>)) {
					// 0 is a meaning, not a mistake: it turns the limit off. Everything
					// else still has to be a real amount, so a typo cannot disable it.
					const off = amount === 0
					if (!off && !isPositive(amount)) {
						drop(`cost.${name}`, "a positive number of dollars, or 0 for no limit")
					} else cost[name] = amount
				}
				out[key] = cost
				continue
			}
		}
		out[key] = v
	}
	return out
}

export type LoadedConfig = {
	config: Config
	/** Keys that were dropped, with the file that set them. */
	notices: string[]
}

/** Later sources win: /etc/axe -> ~/.axe -> ./.axe. */
export function loadConfig(cwd: string): LoadedConfig {
	const trusted = ["/etc/axe/config.toml", join(AXE_HOME, "config.toml")]
	// Running axe in the home directory makes the two paths the same file, and
	// that file is still the user's own.
	const paths = [...new Set([...trusted, join(cwd, ".axe", "config.toml")])]
	const notices: string[] = []
	// A copy, not the singleton. With no config file present every call used to
	// hand back DEFAULT_CONFIG itself, so anything that wrote to the config it
	// was given was quietly editing the defaults for the rest of the process.
	let config: Config = structuredClone(DEFAULT_CONFIG)
	for (const path of paths) {
		const src = readIfExists(path)
		if (!src) continue
		const table = parseToml(src)
		const isTrusted = trusted.includes(path)
		const scoped = isTrusted ? table : scopeLocal(table, path, notices)
		const clean = validate(scoped, path, notices, isTrusted ? "trusted" : "project")
		// Rules accumulate rather than replace: a later file replacing the list
		// would let the project config erase the denies written above it.
		const rules = [...config.permissions, ...((clean.permissions as PermRule[]) ?? [])]
		config = merge(config, clean)
		config.permissions = rules
	}
	return { config, notices }
}

const ENV_KEYS: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	gemini: "GEMINI_API_KEY",
}

/**
 * "missing" is a provider the user never configured, which is normal and worth
 * one line in `axe auth`. "error" is a keySource that was configured and did
 * not work, which is a problem to report.
 */
export class KeyError extends Error {
	kind: "missing" | "error"

	constructor(kind: "missing" | "error", message: string) {
		super(message)
		// Named like HttpError and SubagentError, so anything reading an error
		// back can tell which layer threw it without importing this module.
		this.name = "KeyError"
		this.kind = kind
	}
}

/** Keeps a failing keySource to one line: its stderr can be a page of shell noise. */
function commandFailure(err: unknown): string {
	const e = err as { stderr?: string; message?: string }
	const text = (typeof e.stderr === "string" && e.stderr.trim()) || e.message || String(err)
	return text.split("\n")[0]!.slice(0, 200)
}

/** BYOK: the key never leaves the machine and is never written to a thread file. */
export function resolveApiKey(provider: string, cfg: Config): string {
	const source = cfg.providers[provider]?.keySource ?? "env"
	if (source.startsWith("command:")) {
		const command = source.slice("command:".length)
		let out: string
		try {
			out = execFileSync("bash", ["-lc", command], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch (err) {
			throw new KeyError("error", `keySource for ${provider} failed: ${commandFailure(err)}`)
		}
		const key = out.trim()
		if (!key) throw new KeyError("error", `keySource for ${provider} printed nothing.`)
		return key
	}
	const envName = ENV_KEYS[provider] ?? `${provider.toUpperCase()}_API_KEY`
	const key = process.env[envName]
	if (!key) {
		throw new KeyError(
			"missing",
			`No API key for ${provider}. Set ${envName}, or set keySource in ~/.axe/config.toml.`,
		)
	}
	return key
}

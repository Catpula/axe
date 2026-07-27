import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ToolDef } from "../providers/types.ts"
import { AXE_HOME } from "./thread.ts"

const PROTOCOL = "2025-06-18"
const INIT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 120_000

export type ServerSpec =
	| { command: string; args?: string[]; env?: Record<string, string>; url?: undefined }
	| { url: string; headers?: Record<string, string>; command?: undefined }

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void }

type ListedTool = { name?: unknown; description?: unknown; inputSchema?: unknown }

/**
 * Where the JSON-RPC goes. Both transports are line-oriented from the client's
 * point of view: it writes one request and eventually one response line comes
 * back, whether that was a pipe or a POST.
 */
type Transport = {
	send(line: string): void
	close(): void
}

function stdioTransport(
	name: string,
	spec: Extract<ServerSpec, { command: string }>,
	onLine: (line: string) => void,
	onDown: (reason: string) => void,
): Transport {
	const child = spawn(spec.command, spec.args ?? [], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...spec.env },
	})
	let buffer = ""
	let stderrTail = ""
	child.stdout?.setEncoding("utf8")
	child.stderr?.setEncoding("utf8")
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk
		let nl: number
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim()
			buffer = buffer.slice(nl + 1)
			if (line) onLine(line)
		}
	})
	child.stderr?.on("data", (chunk: string) => {
		stderrTail = (stderrTail + chunk).slice(-500)
	})
	child.on("error", (err) => onDown(`could not start: ${err.message}`))
	child.on("close", (code) =>
		onDown(`exited ${code}${stderrTail ? `: ${stderrTail.trim().split("\n").at(-1)}` : ""}`),
	)
	return {
		send: (line) => {
			child.stdin?.write(`${line}\n`)
		},
		close: () => {
			child.kill("SIGTERM")
		},
	}
}

/**
 * Streamable HTTP, JSON responses only. A server that answers with an SSE
 * stream is rejected by name rather than parsed badly, so the failure says what
 * to do about it.
 *
 * ponytail: no SSE server-push. Add it when a server is found that needs it.
 */
function httpTransport(
	name: string,
	spec: Extract<ServerSpec, { url: string }>,
	onLine: (line: string) => void,
	onDown: (reason: string) => void,
): Transport {
	let sessionId: string | null = null
	let closed = false
	return {
		send: (line) => {
			if (closed) return
			void (async () => {
				let res: Response
				try {
					res = await fetch(spec.url, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							"mcp-protocol-version": PROTOCOL,
							...(sessionId ? { "mcp-session-id": sessionId } : {}),
							...spec.headers,
						},
						body: line,
						signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
					})
				} catch (err) {
					onDown(`${spec.url}: ${err instanceof Error ? err.message : String(err)}`)
					return
				}
				sessionId = res.headers.get("mcp-session-id") ?? sessionId
				// A notification is answered with 202 and no body, which is correct
				// and has nothing to route.
				if (res.status === 202) {
					await res.body?.cancel()
					return
				}
				if (!res.ok) {
					const body = (await res.text().catch(() => "")).slice(0, 200)
					onDown(`${spec.url}: HTTP ${res.status}${body ? `: ${body}` : ""}`)
					return
				}
				const type = (res.headers.get("content-type") ?? "").toLowerCase()
				if (type.includes("text/event-stream")) {
					await res.body?.cancel()
					onDown(`${spec.url}: answers with SSE, which axe does not speak yet`)
					return
				}
				const text = await res.text()
				for (const l of text.split("\n")) if (l.trim()) onLine(l.trim())
			})()
		},
		close: () => {
			closed = true
		},
	}
}

/**
 * JSON-RPC over one of the transports above. Only id-matched responses are
 * routed; server-initiated requests and notifications are dropped, because this
 * client asks for exactly three things: initialize, tools/list, and tools/call.
 */
export class McpClient {
	readonly name: string
	private readonly transport: Transport
	private nextId = 1
	private readonly pending = new Map<number, Waiter>()
	private dead: string | null = null
	private closing = false
	/**
	 * Fires once, when the server goes down on its own. Set after a successful
	 * handshake so a server that never started is reported by its probe error
	 * instead of twice. Silent on `close()`: shutting axe down is not an outage.
	 */
	onDown?: (reason: string) => void

	constructor(name: string, spec: ServerSpec) {
		this.name = name
		const onLine = (line: string) => this.receive(line)
		const onDown = (reason: string) => this.die(reason)
		this.transport =
			spec.url !== undefined
				? httpTransport(name, spec, onLine, onDown)
				: stdioTransport(name, spec, onLine, onDown)
	}

	private die(reason: string): void {
		if (this.dead) return
		this.dead = reason
		for (const w of this.pending.values()) w.reject(new Error(`mcp ${this.name}: ${reason}`))
		this.pending.clear()
		if (!this.closing) this.onDown?.(reason)
	}

	private receive(line: string): void {
		let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
		try {
			msg = JSON.parse(line)
		} catch {
			return
		}
		if (typeof msg.id !== "number") return
		const waiter = this.pending.get(msg.id)
		if (!waiter) return
		this.pending.delete(msg.id)
		if (msg.error) waiter.reject(new Error(`mcp ${this.name}: ${msg.error.message ?? "unknown error"}`))
		else waiter.resolve(msg.result)
	}

	request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (this.dead) return Promise.reject(new Error(`mcp ${this.name}: ${this.dead}`))
		const id = this.nextId++
		this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`mcp ${this.name}: ${method} timed out after ${timeoutMs}ms`))
			}, timeoutMs)
			const onAbort = () => {
				this.pending.delete(id)
				clearTimeout(timer)
				reject(new Error(`mcp ${this.name}: cancelled`))
			}
			signal?.addEventListener("abort", onAbort, { once: true })
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer)
					signal?.removeEventListener("abort", onAbort)
					resolve(v)
				},
				reject: (e) => {
					clearTimeout(timer)
					signal?.removeEventListener("abort", onAbort)
					reject(e)
				},
			})
		})
	}

	notify(method: string): void {
		this.transport.send(JSON.stringify({ jsonrpc: "2.0", method }))
	}

	close(): void {
		this.closing = true
		this.die("closed")
		this.transport.close()
	}
}

function contentText(result: unknown): { text: string; isError: boolean } {
	const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
	const parts = Array.isArray(r?.content) ? r.content : []
	const text = parts
		.map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : `[${p?.type ?? "unknown"} content]`))
		.join("\n")
	return { text: text || "(empty result)", isError: r?.isError === true }
}

function toolName(server: string, tool: string): string {
	return `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]/g, "_")
}

async function readServers(path: string, notes: string[]): Promise<Record<string, ServerSpec>> {
	let raw: string
	try {
		raw = await readFile(path, "utf8")
	} catch {
		return {}
	}
	let parsed: { servers?: Record<string, ServerSpec> }
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		notes.push(`MCP config skipped. ${path}: ${err instanceof Error ? err.message : String(err)}`)
		return {}
	}
	const out: Record<string, ServerSpec> = {}
	for (const [name, spec] of Object.entries(parsed?.servers ?? {})) {
		if (!/^[a-z0-9_-]+$/i.test(name)) {
			notes.push(`MCP server skipped. ${path}: bad name "${name}".`)
			continue
		}
		if (spec && typeof spec.url === "string" && spec.url) {
			if (!/^https?:\/\//i.test(spec.url)) {
				notes.push(`MCP server skipped. ${path}: ${name}.url must be http or https.`)
				continue
			}
			out[name] = { url: spec.url, headers: spec.headers }
			continue
		}
		if (!spec || typeof spec.command !== "string" || !spec.command) {
			notes.push(`MCP server skipped. ${path}: ${name} has no command or url.`)
			continue
		}
		if (spec.args !== undefined && !Array.isArray(spec.args)) {
			notes.push(`MCP server skipped. ${path}: ${name}.args must be an array.`)
			continue
		}
		out[name] = spec
	}
	return out
}

const APPROVALS = join(AXE_HOME, "mcp-approved")

/**
 * A server named in a project file is a program a `git clone` asked to run, so
 * it waits for a sentence the user typed. Personal servers under AXE_HOME are
 * already the user's own act. Plain text, one `<cwd>\t<name>` per line, so the
 * list can be audited and edited by eye.
 */
export async function readApprovals(): Promise<Set<string>> {
	try {
		const raw = await readFile(APPROVALS, "utf8")
		return new Set(raw.split("\n").map((l) => l.trim()).filter(Boolean))
	} catch {
		return new Set()
	}
}

/** One line per approval, "cwd\tname". A skill can arrive via `git clone` too. */
export function approvalKey(cwd: string, name: string): string {
	return `${cwd}\t${name}`
}

/** Appends rather than rewrites: two approvals in a row never race each other out. */
export async function approve(cwd: string, name: string): Promise<void> {
	const key = approvalKey(cwd, name)
	if ((await readApprovals()).has(key)) return
	await mkdir(AXE_HOME, { recursive: true })
	await writeFile(APPROVALS, `${key}\n`, { flag: "a" })
}

export type McpLoad = { tools: ToolDef[]; notes: string[]; close: () => void }

export type Probe = { ok: true; tools: ListedTool[] } | { ok: false; error: string }

/**
 * The handshake, alone, so `axe mcp doctor` tests exactly what startup does.
 * The client is handed back live on success because startup keeps using it.
 */
export async function probeServer(
	name: string,
	spec: ServerSpec,
): Promise<{ client: McpClient; probe: Probe }> {
	const client = new McpClient(name, spec)
	try {
		await client.request(
			"initialize",
			{ protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "axe", version: "0" } },
			INIT_TIMEOUT_MS,
		)
		client.notify("notifications/initialized")
		const listed = (await client.request("tools/list", {}, INIT_TIMEOUT_MS)) as { tools?: ListedTool[] }
		return { client, probe: { ok: true, tools: listed?.tools ?? [] } }
	} catch (err) {
		return { client, probe: { ok: false, error: err instanceof Error ? err.message : String(err) } }
	}
}

/** Where a server may come from, so the approval gate knows what to gate. */
export async function collectServers(
	cwd: string,
	notes: string[],
): Promise<Array<{ name: string; spec: ServerSpec; project: boolean }>> {
	const personal = await readServers(join(AXE_HOME, "mcp.json"), notes)
	const project = await readServers(join(cwd, ".axe", "mcp.json"), notes)
	const out: Array<{ name: string; spec: ServerSpec; project: boolean }> = []
	for (const [name, spec] of Object.entries(personal)) out.push({ name, spec, project: false })
	// Later wins, like config: the project file may repoint a server name, and
	// doing so makes it a project server needing approval.
	for (const [name, spec] of Object.entries(project)) {
		const at = out.findIndex((s) => s.name === name)
		if (at >= 0) out.splice(at, 1)
		out.push({ name, spec, project: true })
	}
	return out
}

/**
 * The handshake shared by every caller: initialize, list tools, wrap each one.
 * `loadMcpServers` calls this with the two default config files merged; a
 * skill's own mcp.json calls it with just its one file. Same trust model as
 * plugins, stated rather than sandboxed: an MCP server is a program the config
 * points at, it runs with the user's full privileges. A server that fails to
 * start or to answer degrades to a notice; nothing a server does may prevent
 * axe from starting.
 */
async function collect(
	servers: Array<{ name: string; spec: ServerSpec }>,
	taken: Set<string>,
	notes: string[],
	onDown?: (note: string) => void,
): Promise<{ tools: ToolDef[]; close: () => void }> {
	const tools: ToolDef[] = []
	const clients: McpClient[] = []
	const names = new Set(taken)

	await Promise.all(
		servers.map(async ({ name, spec }) => {
			const { client, probe } = await probeServer(name, spec)
			if (!probe.ok) {
				client.close()
				notes.push(`MCP server skipped. ${probe.error}`)
				return
			}
			clients.push(client)
			// Only after the handshake: a turn an hour in loses its tools silently
			// otherwise, and the model keeps calling names that no longer answer.
			client.onDown = (reason) => onDown?.(`MCP server ${name} went down: ${reason}`)
			for (const t of probe.tools) {
				if (typeof t.name !== "string" || !t.name) continue
				const full = toolName(name, t.name)
				if (names.has(full)) {
					notes.push(`MCP tool skipped. ${name}: ${full} is already taken.`)
					continue
				}
				names.add(full)
				const remote = t.name
				tools.push({
					name: full,
					description:
						typeof t.description === "string" && t.description
							? t.description
							: `Tool ${remote} from the ${name} MCP server.`,
					schema:
						t.inputSchema && typeof t.inputSchema === "object"
							? (t.inputSchema as Record<string, unknown>)
							: { type: "object", properties: {} },
					// Unknown side effects, so never parallel and never a subagent's.
					readOnly: false,
					run: async (input, ctx) => {
						const result = await client.request(
							"tools/call",
							{ name: remote, arguments: input ?? {} },
							CALL_TIMEOUT_MS,
							ctx.signal,
						)
						const { text, isError } = contentText(result)
						if (isError) throw new Error(text)
						return text
					},
				})
			}
		}),
	)

	const close = () => {
		for (const c of clients) c.close()
	}
	return { tools, close }
}

/** The two default config files, project overriding personal and needing approval. */
export async function loadMcpServers(
	cwd: string,
	taken: Set<string>,
	onDown?: (note: string) => void,
): Promise<McpLoad> {
	const notes: string[] = []
	const approved = await readApprovals()
	const servers = (await collectServers(cwd, notes)).filter(({ name, project }) => {
		if (!project || approved.has(approvalKey(cwd, name))) return true
		notes.push(`MCP server '${name}' needs approval. Run: axe mcp approve ${name}`)
		return false
	})
	const { tools, close } = await collect(servers, taken, notes, onDown)
	// Servers die with axe on every exit path, including a crash.
	process.on("exit", close)
	return { tools, notes, close }
}

/**
 * One mcp.json, read directly rather than through the AXE_HOME/cwd pair: a
 * skill's servers live next to its SKILL.md, not in either default location.
 */
export async function loadMcpServersFromFile(
	path: string,
	taken: Set<string>,
	onDown?: (note: string) => void,
): Promise<McpLoad> {
	const notes: string[] = []
	const servers = Object.entries(await readServers(path, notes)).map(([name, spec]) => ({ name, spec }))
	const { tools, close } = await collect(servers, taken, notes, onDown)
	process.on("exit", close)
	return { tools, notes, close }
}

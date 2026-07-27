import { spawn } from "node:child_process"
import type { ToolDef } from "../providers/types.ts"

const TIMEOUT_MS = 90_000
const MAX_CHECK_OUTPUT = 8_000
const SCRUB = "unset $(compgen -e | grep -iE 'API_KEY|TOKEN|SECRET|PASSWORD') 2>/dev/null || true"

function clamp(s: string): string {
	if (s.length <= MAX_CHECK_OUTPUT) return s
	const half = (MAX_CHECK_OUTPUT - 64) / 2
	return `${s.slice(0, half)}\n[... ${s.length - half * 2} characters truncated ...]\n${s.slice(-half)}`
}

type CheckOutcome = { code: number | null; output: string; timedOut: boolean }

function runCheck(cmd: string, cwd: string, signal: AbortSignal): Promise<CheckOutcome> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", `${SCRUB}\n${cmd}`], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		})
		let output = ""
		let settled = false
		let timedOut = false
		const finish = (outcome: CheckOutcome) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal.removeEventListener("abort", onAbort)
			resolve(outcome)
		}
		const killTree = () => {
			const pid = child.pid
			if (pid === undefined) return
			try {
				process.kill(-pid, "SIGKILL")
			} catch {
				child.kill("SIGKILL")
			}
		}
		const timer = setTimeout(() => {
			timedOut = true
			killTree()
		}, TIMEOUT_MS)
		const onAbort = () => {
			killTree()
			finish({ code: null, output, timedOut: false })
		}
		signal.addEventListener("abort", onAbort, { once: true })
		child.stdout.on("data", (d) => {
			if (output.length < MAX_CHECK_OUTPUT * 4) output += d.toString()
		})
		child.stderr.on("data", (d) => {
			if (output.length < MAX_CHECK_OUTPUT * 4) output += d.toString()
		})
		child.on("error", (e) => finish({ code: null, output: e.message, timedOut: false }))
		child.on("close", (code) => finish({ code, output, timedOut }))
	})
}

/**
 * The feedback loop that replaces a language server: after every successful
 * edit the project's own check command runs and its failures ride back inside
 * the same tool_result, so the model sees the type error in the step that
 * caused it instead of three edits later. The edit itself already happened,
 * so a failing check is appended to a successful result, never turned into a
 * tool error: the diff on disk is real and the model needs to see both.
 */
export function withEditCheck(tool: ToolDef, cmd: string): ToolDef {
	return {
		...tool,
		async run(input: unknown, ctx) {
			const result = await tool.run(input, ctx)
			if (ctx.signal.aborted) return result
			const check = await runCheck(cmd, ctx.cwd, ctx.signal)
			if (check.timedOut) {
				return `${result}\n\n[check "${cmd}" timed out after ${TIMEOUT_MS / 1000}s]`
			}
			if (check.code === 0 || check.code === null) return result
			return `${result}\n\n[check "${cmd}" exited ${check.code}]\n${clamp(check.output.trim())}`
		},
	}
}

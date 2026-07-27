/**
 * The display when there is no panel to draw on: `-x`, `--plain`, a pipe.
 *
 * AGENTS.md keeps output formatting out of the loop and out of the entry point,
 * so this is where the line-based surface lives. It is the fallback the TUI
 * replaces, and the one every non-terminal run gets.
 */
import { stdout } from "node:process"
import type { AgentTrace } from "../config.ts"
import type { UI } from "../core/loop.ts"
import { formatDuration } from "./activity.ts"
import { DIM, GREEN, RED, RESET } from "./color.ts"
import { safeTerminalText } from "./terminal.ts"
import { toolColor, toolSummary } from "./tui.ts"

export function makeUI(quiet: boolean): UI {
	let atLineStart = true
	const write = (s: string) => {
		stdout.write(s)
		atLineStart = s.endsWith("\n")
	}
	const line = (s: string) => {
		if (!atLineStart) stdout.write("\n")
		stdout.write(`${s}\n`)
		atLineStart = true
	}
	// Without a panel there is nowhere to show a running clock, so the start
	// time is kept only so the finished row can say how long it took.
	const startedAt = new Map<string, number>()
	return {
		text: (s) => write(safeTerminalText(s)),
		thinking: (s) => {
			if (!quiet) write(`${DIM}${safeTerminalText(s)}${RESET}`)
		},
		// Announced only when it runs, and only once: with no panel, a "starting"
		// line and a "finished" line are two rows saying one thing.
		toolStart: () => {},
		toolRunning: (_name, id) => {
			startedAt.set(id, Date.now())
		},
		toolEnd: (name, ok, preview, input, id) => {
			const began = id === undefined ? undefined : startedAt.get(id)
			if (id !== undefined) startedAt.delete(id)
			if (quiet) return
			const safeName = safeTerminalText(name).replace(/\n/g, "\u23ce")
			const subject = safeTerminalText(toolSummary(input)).replace(/\n/g, "\u23ce")
			const label = subject ? `${safeName} ${subject}` : safeName
			const took = began === undefined ? "" : formatDuration(Date.now() - began)
			const head = safeTerminalText(preview.split("\n")[0] ?? "")
			const detail = [took, head].filter(Boolean).join(" \u00b7 ")
			line(ok
				? `${GREEN}  \u2713 ${RESET}${toolColor(name)}${label}${RESET}${detail ? `${DIM} \u00b7 ${detail}${RESET}` : ""}`
				: `${RED}  \u2717 ${label}${detail ? ` \u00b7 ${detail}` : ""}${RESET}`)
		},
		notice: (s) => line(`${DIM}${safeTerminalText(s)}${RESET}`),
	}
}

/**
 * A subagent's view of the display.
 *
 * The point of a subagent is that its context is discarded, and by default so
 * is its output. That default hides a real failure mode: a search that has been
 * grepping for forty seconds looks identical to a hang. So `compact` forwards
 * its tool calls, tagged with the agent's row id so the panel indents them
 * underneath it, and `full` also lets its prose through, prefixed so it is
 * never mistaken for the main agent's answer.
 */
export function agentUI(parent: UI, agentId: string, label: string, mode: AgentTrace): UI {
	const quiet = mode === "off"
	let atLineStart = true
	let textStarted = false
	const trace = (s: string) => {
		if (!s) return
		let out = ""
		for (const part of s.split(/(\n)/)) {
			if (!part) continue
			if (atLineStart && part !== "\n") out += `${label} \u00b7 `
			out += part
			atLineStart = part === "\n"
		}
		parent.thinking(out)
	}
	return {
		text: (s) => {
			if (mode !== "full") return
			if (!textStarted) {
				textStarted = true
				if (!atLineStart) trace("\n")
			}
			trace(s)
		},
		thinking: (s) => {
			if (mode === "full") trace(s)
		},
		toolStart: () => {},
		toolRunning: (name, id, input) => {
			if (quiet) return
			// Namespaced: two subagents running the same tool would otherwise share
			// a provider-assigned id and overwrite each other's row.
			parent.toolRunning?.(name, `${agentId}/${id}`, input)
		},
		toolEnd: (name, ok, preview, input, id) => {
			if (quiet) return
			parent.toolEnd(name, ok, preview, input, id === undefined ? undefined : `${agentId}/${id}`)
		},
		notice: (s) => parent.notice(`${label} \u00b7 ${s}`),
	}
}

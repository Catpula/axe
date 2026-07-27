#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import {
	AGENT_TRACES,
	EFFORTS,
	KeyError,
	loadConfig,
	providerKind,
	resolveApiKey,
	type AgentTrace,
	type Config,
	type Effort,
} from "./config.ts"
import { parseArgs } from "./args.ts"
import { cleanupArtifacts } from "./artifacts.ts"
import { debugRequested, initDebugLog } from "./debuglog.ts"
import { doctorFailed, formatDoctor, runDoctor } from "./doctor.ts"
import { classify, describeError, formatDiagnosis } from "./errors.ts"
import { discoverAgents } from "./core/agents.ts"
import type { CompactionConfig } from "./core/compact.ts"
import { newSession, runTurn, type UI } from "./core/loop.ts"
import { ApprovalQueue, type ApprovalDecision } from "./core/tools.ts"
import {
	approvalKey,
	approve,
	collectServers,
	loadMcpServers,
	probeServer,
	readApprovals,
} from "./core/mcp.ts"
import { loadPlugins, type PluginCommand, type ToolCallHook } from "./core/plugins.ts"
import { checkPermission, formatPermRule, subject } from "./core/permissions.ts"
import { InputQueue } from "./core/queue.ts"
import { addSchedule, loadSchedules, removeSchedule, runDue } from "./core/schedules.ts"
import { installSkill } from "./core/skill-install.ts"
import { discoverSkills, skillsSection } from "./core/skills.ts"
import { Gate, SubagentError, briefFor, runSubagent, type SubagentRole } from "./core/subagent.ts"
import { AXE_HOME, Thread, type ContextManifest, type RecoveryReport } from "./core/thread.ts"
import { makeProvider } from "./providers/make.ts"
import { addUsage, type Provider, type ServerTool, type ToolCtx, type Usage } from "./providers/types.ts"
import { imageBlocks } from "./images.ts"
import { buildPromptContext, buildSystemPrompt } from "./prompt.ts"
import { defaultEnv, describe, update } from "./release/update.ts"
import { runReview, workingDiffForFiles } from "./review.ts"
import { routeFor, routeForRole, type Route } from "./router/route.ts"
import { VERSION } from "./version.ts"
import { withEditCheck } from "./tools/check.ts"
import { editFileTool, readFileTool, workspaceFiles } from "./tools/fs.ts"
import { coreTools } from "./tools/index.ts"
import { webSearchTool } from "./tools/web.ts"
import { withSkillMcp } from "./tools/skill-mcp.ts"
import { withSubtreeGuidance } from "./tools/subtree-guidance.ts"
import { scheduleTool } from "./tools/schedules.ts"
import { taskTool } from "./tools/task.ts"
import { jsonError, jsonResult, makeJsonUI } from "./ui/json.ts"
import { safeTerminalText } from "./ui/terminal.ts"
import { agentUI, makeUI } from "./ui/plain.ts"
import { makeTui, type PaletteItem, type Tui } from "./ui/tui.ts"

const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

// axe never runs in the background, so something else has to knock. Printed
// rather than installed: writing a system task on someone's behalf is not a
// thing a list command should do.
// ponytail: the user installs it once. `axe schedule install` writes the task
// for them, add it when someone asks twice.
const SCHEDULER_HINT =
	process.platform === "win32"
		? '  schtasks /create /tn axe-schedules /sc minute /mo 5 /tr "axe schedule run"'
		: "  */5 * * * * axe schedule run"

// One screen, and every line here is a flag or command parseArgs actually
// accepts. `cli-test` walks it against the parser so the two cannot drift.
const HELP = `axe — BYOK CLI coding agent

Usage
  axe                        start the REPL
  axe "<prompt>"             one prompt, then the REPL
  axe -x "<prompt>"          one-shot, quiet, reads stdin
  axe <command>

Commands
  threads                    list thread ids, newest first
  skills                     playbooks visible in this directory
  tools [show <name>]        tools this setup exposes
  skill add <owner/repo>     install a skill from GitHub
  auth                       which providers have a usable key
  permissions                permission rules in effect
  mcp [approve|doctor]       MCP servers and their approvals
  doctor                     check config, keys, plugins and MCP state
  review                     run .axe/checks/*.md over the diff
  schedules                  prompts waiting to wake a thread
  schedule add|rm|run        add one, drop one, fire whatever is due
  update [--check]           replace this binary with the latest release
  version                    print the version

Options
  -x, --execute              one-shot; exit when the turn ends
  -c, --continue [<id>]      resume a thread in this directory
      --effort <tier>        ${EFFORTS.join(" | ")}
      --fast                 shorthand for --effort low
  -l, --label <text>         label the thread for \`axe threads\`
      --plain                line-based REPL, no terminal UI
      --no-plugins           start without loading any plugin
      --debug                trace the stream, tools and retries to a log file
      --plugin-ready-timeout <ms>   default 3000
      --stream-json          NDJSON on stdout, one event per line
      --stream-json-input    read one turn per NDJSON line on stdin
      --stream-json-thinking include thinking events in NDJSON
  -v, --version              print the version
  -h, --help                 this page

In the REPL: \`cost\` prints spend so far, \`schedules\` lists them, \`exit\` quits,
Ctrl+O opens the palette.
Exit codes: 1 is a failed turn, a bad flag, or nothing to run.
`

const AGENT_TRACE_HINT: Record<AgentTrace, string> = {
	off: "subagents stay silent",
	compact: "their tools in the panel",
	full: "their prose too",
}

/**
 * Stands in where a Provider is structurally required but never reached, so a
 * command that talks to nobody does not have to hold a key. Every method throws
 * rather than returning a plausible value: if one is ever called, that is a bug
 * to see, not to paper over.
 */
function unusedProvider(): Provider {
	const no = (): never => {
		throw new Error("This command does not talk to a provider.")
	}
	return { name: "none", stream: no, countTokens: no, contextWindow: no }
}


/**
 * Summaries run on the cheap model. If that model's provider has no key, fall
 * back to the session's own provider rather than silently losing compaction.
 */
function makeCompaction(route: Route, provider: Provider, cfg: Config): CompactionConfig {
	const c = routeForRole("compact")
	const base = { at: cfg.autoCompactAt, keepTail: 6 }
	if (c.provider === route.provider) {
		return { provider, model: c.model, maxTokens: c.maxTokens, ...base }
	}
	try {
		return {
			provider: makeProvider(c.provider, cfg),
			model: c.model,
			maxTokens: c.maxTokens,
			...base,
		}
	} catch {
		return { provider, model: route.model, maxTokens: 4_000, ...base }
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const cwd = process.cwd()
	const configFile = loadConfig(cwd)
	const cfg = configFile.config
	// A dropped key is stderr, not stdout: --stream-json owes its reader clean
	// NDJSON, and the notice is about the machine rather than about the turn.
	for (const note of configFile.notices) {
		process.stderr.write(`${DIM}${safeTerminalText(note)}${RESET}\n`)
	}

	if (args.version || args.command === "version") {
		stdout.write(`axe ${VERSION}\n`)
		return
	}
	if (args.help || args.command === "help") {
		stdout.write(HELP)
		return
	}
	// `cost` reads a session's running total, and a command that exits has no
	// session. Parsed as a command anyway so it fails here instead of becoming a
	// one-word prompt the model is paid to be confused by.
	if (args.command === "cost") {
		process.stderr.write("cost is a REPL word, not a command: type it at the axe prompt.\n")
		process.exitCode = 1
		return
	}
	if (args.command === "update") {
		const env = defaultEnv((s) => stdout.write(`${DIM}${s}${RESET}\n`))
		const result = await update(env, { check: args.check })
		stdout.write(`${describe(result, VERSION)}\n`)
		// A script that polls for releases reads the exit code, not the sentence.
		if (result.status === "unsupported") process.exitCode = 2
		else if (result.status === "available") process.exitCode = 1
		return
	}
	if (args.command === "threads") {
		const ids = await Thread.list()
		stdout.write(ids.length ? `${ids.join("\n")}\n` : "No threads yet.\n")
		return
	}
	if (args.command === "skills") {
		const found = await discoverSkills(cwd)
		if (!found.length) {
			stdout.write("No skills. Add one at .agents/skills/<name>/SKILL.md\n")
			return
		}
		for (const s of found) {
			stdout.write(`${s.name.padEnd(24)}${s.scope.padEnd(10)}${s.description}\n`)
		}
		return
	}
	if (args.command === "schedules") {
		const list = await loadSchedules()
		if (!list.length) {
			stdout.write(`No schedules. The agent adds them with its \`schedule\` tool, or:\n  axe schedule add "every 10m" "<prompt>"\n\nSomething has to knock. Once, on this machine:\n${SCHEDULER_HINT}\n`)
			return
		}
		for (const s of list) {
			stdout.write(`${s.id.padEnd(10)}${s.when.padEnd(16)}${s.threadId.padEnd(32)}${s.prompt}\n`)
		}
		return
	}
	if (args.command === "schedule") {
		const [sub, ...rest] = args.commandArgs
		if (sub === "add") {
			const [when, ...prompt] = rest
			if (!when || !prompt.length) {
				throw new Error('Usage: axe schedule add "<when>" "<prompt>"')
			}
			// `schedule` owns the rest of the line, so there is no -c here to name a
			// thread. The newest one in this directory is the one the user was just
			// working in; with none, a fresh transcript is what the wake-up continues.
			const thread = (await Thread.latest(cwd)) ?? (await Thread.create(cwd, args.label))
			const s = await addSchedule({
				when,
				prompt: prompt.join(" "),
				cwd,
				threadId: thread.id,
			})
			stdout.write(`${s.id}  ${s.when}  ${s.threadId}\n`)
			return
		}
		if (sub === "rm") {
			const [id] = rest
			if (!id) throw new Error("Usage: axe schedule rm <id>")
			if (!(await removeSchedule(id))) {
				process.stderr.write(`No schedule ${id}.\n`)
				process.exitCode = 1
			}
			return
		}
		if (sub === "run") {
			if (rest.length) throw new Error(`schedule run takes no arguments, got ${rest.join(" ")}.`)
			const report = await runDue()
			for (const s of report.dropped) {
				stdout.write(`Dropped ${s.id}: thread ${s.threadId} is gone.\n`)
			}
			stdout.write(report.fired.length ? `Fired ${report.fired.length}.\n` : "Nothing due.\n")
			return
		}
		throw new Error('Usage: axe schedule add "<when>" "<prompt>" | rm <id> | run')
	}
	if (args.command === "permissions") {
		const [sub, ...rest] = (args.prompt ?? "list").split(/\s+/)
		if (sub === "list") {
			if (!cfg.permissions.length) {
				stdout.write(
					`No permission rules, so every tool call runs.\nAdd them to ${join(AXE_HOME, "config.toml")}:\n  permissions = ["bash deny rm *"]\n`,
				)
				return
			}
			for (const r of cfg.permissions) {
				stdout.write(`${formatPermRule(r).padEnd(40)}${r.scope}\n`)
			}
			return
		}
		if (sub === "test") {
			const tool = rest[0]
			if (!tool) throw new Error(`Usage: axe permissions test <tool> ['{"cmd":"..."}']`)
			let input: unknown = {}
			const raw = rest.slice(1).join(" ")
			if (raw) {
				try {
					input = JSON.parse(raw)
				} catch {
					throw new Error(`Not JSON: ${raw}`)
				}
			}
			const d = checkPermission(cfg.permissions, tool, input)
			stdout.write(
				`${d.action}${d.action === "deny" ? ` · ${d.reason}` : d.action === "ask" ? ` · ${formatPermRule(d.rule)}` : ""}\n`,
			)
			// A script gating on this reads the exit code, not the word.
			if (d.action === "deny") process.exitCode = 2
			else if (d.action === "ask") process.exitCode = 1
			return
		}
		throw new Error("Usage: axe permissions list | axe permissions test <tool> [json]")
	}
	if (args.command === "mcp") {
		const [sub, name] = (args.prompt ?? "list").split(/\s+/)
		const notes: string[] = []
		const servers = await collectServers(cwd, notes)
		for (const n of notes) stdout.write(`${n}\n`)
		const approved = await readApprovals()
		const state = (s: (typeof servers)[number]) =>
			!s.project ? "personal" : approved.has(approvalKey(cwd, s.name)) ? "approved" : "needs approval"
		if (sub === "list") {
			if (!servers.length) {
				stdout.write(`No MCP servers. Add one at ${join(AXE_HOME, "mcp.json")} or .axe/mcp.json\n`)
				return
			}
			for (const s of servers) {
				const where = s.spec.url ?? `${s.spec.command} ${(s.spec.args ?? []).join(" ")}`.trim()
				stdout.write(`${s.name.padEnd(20)}${state(s).padEnd(16)}${where}\n`)
			}
			return
		}
		if (sub === "approve") {
			// A skill's own mcp.json is approved under `skill:<name>`, the same key
			// withSkillMcp checks before it spawns anything.
			if (name?.startsWith("skill:")) {
				const skill = (await discoverSkills(cwd)).find((s) => s.name === name.slice(6))
				if (!skill?.mcpConfigPath) throw new Error(`No skill named ${name.slice(6)} with an mcp.json.`)
				if (skill.scope !== "project") {
					stdout.write(`${name} is a personal skill and already runs.\n`)
					return
				}
				await approve(cwd, name)
				stdout.write(`Approved ${name} for ${cwd}.\n`)
				return
			}
			const target = servers.find((s) => s.name === name)
			if (!name || !target) throw new Error(`Usage: axe mcp approve <name>. Try: axe mcp list`)
			if (!target.project) {
				stdout.write(`${name} is a personal server and already runs.\n`)
				return
			}
			await approve(cwd, name)
			stdout.write(`Approved ${name} for ${cwd}.\n`)
			return
		}
		if (sub === "doctor") {
			for (const s of servers) {
				if (s.project && !approved.has(approvalKey(cwd, s.name))) {
					stdout.write(`${s.name.padEnd(20)}needs approval · axe mcp approve ${s.name}\n`)
					continue
				}
				const { client, probe } = await probeServer(s.name, s.spec)
				client.close()
				stdout.write(
					probe.ok
						? `${s.name.padEnd(20)}ok · ${probe.tools.length} tools\n`
						: `${s.name.padEnd(20)}failed · ${probe.error}\n`,
				)
				if (!probe.ok) process.exitCode = 1
			}
			return
		}
		throw new Error("Usage: axe mcp list | axe mcp approve <name> | axe mcp doctor")
	}
	if (args.command === "skill") {
		const [sub, source] = args.commandArgs
		if (sub !== "add" || !source) {
			process.stderr.write("Usage: axe skill add <owner/repo[@ref]>\n")
			process.exitCode = 1
			return
		}
		try {
			const rl = createInterface({ input: stdin, output: stdout })
			const result = await installSkill(cwd, source, {
				confirmOverwrite: async (path) => {
					const answer = await rl.question(`${path} already exists. Overwrite? [y/N] `)
					return /^y(es)?$/i.test(answer.trim())
				},
			})
			rl.close()
			for (const n of result.notes) process.stderr.write(`${n}\n`)
			stdout.write(`Installed ${result.name} at ${result.path}\n`)
		} catch (err) {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
			process.exitCode = 1
		}
		return
	}
	// Reaches no provider and spends nothing, so it sits with the other commands
	// that run before a session exists: a broken setup must still be able to run
	// the one command that explains why it is broken.
	if (args.command === "doctor") {
		const rows = await runDoctor({ cwd, loaded: configFile, loadPlugins: !args.noPlugins })
		stdout.write(`${safeTerminalText(formatDoctor(rows))}\n`)
		if (doctorFailed(rows)) process.exitCode = 1
		return
	}
	if (args.command === "auth") {
		const names = [...new Set(["anthropic", "openai", "google", ...Object.keys(cfg.providers)])]
		let usable = 0
		for (const p of names) {
			let status: string
			try {
				resolveApiKey(p, cfg)
				status = "ok"
				usable++
			} catch (err) {
				// A keySource that ran and failed is a broken setup, not an absent
				// one, and the reason is the whole value of running this command.
				if (err instanceof KeyError && err.kind === "error") {
					status = "error"
					process.stderr.write(`${safeTerminalText(err.message)}\n`)
				} else status = "missing"
			}
			stdout.write(`${p.padEnd(14)}${providerKind(p, cfg).padEnd(20)}${status}\n`)
		}
		if (!usable) process.exitCode = 1
		return
	}

	const interactive = !args.execute && !args.streamJson && !args.streamJsonInput
	// Reading a terminal that nobody is piping into is an invisible hang, so a
	// one-shot with nothing to say ends here rather than at end of file.
	// --stream-json-input reads its turns from stdin itself, so it skips this.
	let oneShot: string | null = null
	if (!interactive && !args.streamJsonInput) {
		oneShot = (args.prompt ?? (stdin.isTTY ? "" : await new Response(stdin as any).text())).trim()
		if (!oneShot) {
			process.stderr.write("Nothing to run: pass a prompt, or pipe one on stdin.\n")
			process.exitCode = 1
			return
		}
	}

	let effort = args.effort ?? cfg.effort
	let route = routeFor(effort, cfg)
	// `axe tools` sends nothing to a provider, so a missing key must not stop it:
	// the one command that inventories a setup should be the one a broken setup
	// can still run. It returns long before anything reads these.
	const inventoryOnly = args.command === "tools"
	const provider = inventoryOnly ? unusedProvider() : makeProvider(route.provider, cfg)
	const compaction = inventoryOnly
		? { provider, model: route.model, maxTokens: 4_000, at: cfg.autoCompactAt, keepTail: 6 }
		: makeCompaction(route, provider, cfg)

	// `axe review` is a one-shot fan-out, not a session: no thread, no TUI, one
	// read-only subagent per check, exit 1 when any check has findings so CI can
	// gate on it.
	if (args.command === "review") {
		const result = await runReview({
			cwd,
			provider,
			model: route.model,
			maxTokens: route.maxTokens,
			thinkingBudget: route.thinkingBudget,
			limit: cfg.maxParallelSubagents,
			write: (s) => stdout.write(s),
		})
		if (result.failed) process.exitCode = 1
		return
	}

	let thread: Thread
	if (args.threadId) {
		const found = await Thread.find(args.threadId)
		if (!found) throw new Error(`No thread ${args.threadId}. \`axe threads\` lists them.`)
		thread = found
	} else if (args.continueThread) {
		thread = (await Thread.latest(cwd)) ?? (await Thread.create(cwd, args.label))
	} else {
		thread = await Thread.create(cwd, args.label)
	}
	// Artifacts are workspace-local and disposable. Cleanup is best-effort and
	// happens once per session rather than extending every tool call.
	await cleanupArtifacts(cwd)

	// Skills cost one line of prompt each until the agent decides to read one.
	const skills = await discoverSkills(cwd)
	const skillsExtra = skillsSection(skills)
	// The edit check is named in the prompt only for the session that can edit.
	// A subagent and `axe review` are read-only, so it would never fire for them.
	const promptContext = await buildPromptContext(cwd, skillsExtra, { editCheck: cfg.checkCmd || undefined })
	await thread.context({
		version: 1,
		sources: [
			...promptContext.sources,
			...skills.map((skill) => ({ kind: "skill" as const, path: skill.path, scope: skill.scope })),
		],
	})
	// Custom subagent roles cost one line of the task tool's description each.
	const agents = await discoverAgents(cwd)

	// Subagents are spawned by the model, so the ceiling is config, not judgement.
	const gate = new Gate(cfg.maxParallelSubagents)
	// Panel row ids. A provider tool id is unique per conversation, and a
	// subagent is its own conversation, so the agent's own id is the namespace.
	let agentSeq = 0
	let agentTrace: AgentTrace = cfg.agentTrace
	// Collected here because the session does not exist yet when spawn is built.
	// Drained after every turn so the cost hard stop sees subagent spend too.
	const subUsage: Usage[] = []

	const providerForRoute = (r: Route): { provider: Provider; model: string } => {
		if (r.provider === route.provider) return { provider: session.provider, model: r.model }
		try {
			return { provider: makeProvider(r.provider, cfg), model: r.model }
		} catch {
			// No key for that provider: use the session's provider and its model,
			// because the role's model name means nothing to a different provider.
			return { provider: session.provider, model: session.model }
		}
	}

	const spawn = async (prompt: string, role: SubagentRole, ctx: ToolCtx): Promise<string> => {
		// A custom agent is a document, so it only picks which internal route it
		// runs on and what its brief says. It cannot name a model of its own.
		const custom = agents.find((a) => a.name === role)
		const r = routeForRole(custom ? custom.role : role === "oracle" ? "oracle" : "subagent")
		const picked = providerForRoute(r)
		// Built before queueing: reading AGENTS.md should not hold a gate slot.
		const extra = [skillsExtra, custom ? custom.brief : briefFor(role)]
			.filter(Boolean)
			.join("\n\n")
		const system = await buildSystemPrompt(cwd, extra)
		return gate.run(async () => {
			// Inside the gate, not outside: an agent waiting for a slot is not an
			// agent doing anything, and a panel that says otherwise is lying about
			// where the time is going.
			// Reuse the task call's id so the generic task row turns into the
			// concrete role instead of showing the same delegation twice.
			const id = ctx.id ?? `agent-${++agentSeq}`
			const label = custom ? custom.name : role
			tui?.activityStart({ id, kind: "agent", name: label, subject: prompt })
			let ok = false
			try {
				const out = await runSubagent(
					{
						provider: picked.provider,
						model: picked.model,
						maxTokens: r.maxTokens,
						thinkingBudget: r.thinkingBudget,
						system,
						// A fresh core set, so the subagent gets neither write tools nor task.
						// Plugin tools are deliberately not included: a subagent runs code
						// nobody watched it choose.
						tools: coreTools().readOnly(),
						cwd,
						maxSteps: 30,
						log: ctx.log,
						ui: tui && agentTrace !== "off"
							? agentUI(tui.ui, id, label, agentTrace)
							: undefined,
					},
					prompt,
					ctx.signal,
				)
				subUsage.push(out.usage)
				ok = true
				return out.text
			} catch (err) {
				// A subagent that crashed still spent tokens on the way there.
				if (err instanceof SubagentError) subUsage.push(err.usage)
				throw err
			} finally {
				tui?.activityEnd(id, ok)
			}
		})
	}

	const tools = coreTools().register(taskTool(spawn, agents))
	// Both wrappers key off input.path, so a single read of a skill's SKILL.md
	// can both spawn its MCP server and pick up a subtree's AGENTS.md.
	const pluginNotes: string[] = []
	// Named after the thread, so a trace can be lined up against the transcript
	// it belongs to. Announced rather than silent: nothing axe writes into the
	// user's home directory should be a surprise.
	if (debugRequested(args.debug, cfg.debug)) {
		const logPath = initDebugLog(thread.id)
		pluginNotes.push(
			logPath ? `Debug log: ${logPath}` : "Debug log was requested but its directory is not writable.",
		)
	}
	// A server can go down before the session exists and hours after it does, so
	// the sink moves: startup notes are buffered and flushed with the rest, and
	// everything later goes straight to whichever UI is running.
	let notify = (note: string) => {
		pluginNotes.push(note)
	}
	tools.register(withSkillMcp(
		withSubtreeGuidance(readFileTool, cwd, (source) => thread.contextSource(source)),
		skills,
		tools,
		cwd,
		(n) => notify(n),
	))
	// Search comes from the provider where the provider has it, and from a tool
	// of our own where it does not. Never both: they would collide on the name
	// `web_search`, and the model would be offered two of the same thing.
	//
	// Decided once, from the provider axe started on. Effort can move the session
	// to another provider mid-run, and swapping the tool out underneath a
	// transcript that already calls it would leave calls nothing can answer.
	const kind = providerKind(route.provider, cfg)
	const serverTools: ServerTool[] = kind === "anthropic" || kind === "google" ? ["web_search"] : []
	if (!serverTools.length) tools.register(webSearchTool)
	// Off by default, and only the machine's owner can turn it on: a schedule is a
	// prompt that runs unattended, so a cloned repo must not be able to add one.
	if (cfg.schedules.enabled) {
		tools.register(scheduleTool(() => thread.id, cwd))
		pluginNotes.push("Schedules enabled: the agent can ask to be woken later.")
	}
	// Source of each tool, for `axe tools show`. Recorded at register time
	// because by the time the registry is asked, a plugin and an MCP server can
	// both have registered a tool named the same as a core one never would.
	const toolSource = new Map<string, "core" | "plugin" | "mcp">()
	for (const t of tools.all()) toolSource.set(t.name, "core")
	for (const a of agents) pluginNotes.push(`Custom agent ${a.name} (role ${a.role}).`)
	if (cfg.checkCmd) {
		// Re-registering under the same name replaces the plain edit_file, so the
		// model keeps one tool and the check is invisible until it fails.
		tools.register(withEditCheck(editFileTool, cfg.checkCmd))
		pluginNotes.push(`Edit check: ${cfg.checkCmd}`)
	}
	const pluginCommands: PluginCommand[] = []
	const pluginHooks: ToolCallHook[] = []
	let closeMcp = () => {}
	if (cfg.plugins && !args.noPlugins) {
		const loaded = await loadPlugins(
			cwd,
			new Set(tools.all().map((t) => t.name)),
			args.pluginReadyTimeoutMs,
		)
		for (const p of loaded.plugins) {
			tools.register(...p.tools)
			for (const t of p.tools) toolSource.set(t.name, "plugin")
			pluginNotes.push(`Loaded plugin ${p.name} (${p.tools.map((t) => t.name).join(", ")}).`)
		}
		pluginCommands.push(...loaded.commands)
		for (const c of loaded.commands) pluginNotes.push(`Plugin command: ${c.plugin} · ${c.label}`)
		// Named, because a hook can reject a tool call and the user should know
		// which plugin is in a position to do that.
		for (const h of loaded.hooks) {
			pluginHooks.push(h.fn)
			pluginNotes.push(`Plugin ${h.plugin} watches tool calls.`)
		}
		// A broken plugin degrades to a notice, and the notice now says which layer
		// it came from and what to do, like every other failure.
		for (const e of loaded.errors) {
			pluginNotes.push(`Plugin skipped. ${describeError(new Error(e), "plugin")}`)
		}
		// MCP servers are plugins that speak a protocol instead of exporting
		// functions, so they sit behind the same switch and the same trust note.
		const mcp = await loadMcpServers(cwd, new Set(tools.all().map((t) => t.name)), notify)
		closeMcp = mcp.close
		if (mcp.tools.length) {
			tools.register(...mcp.tools)
			for (const t of mcp.tools) toolSource.set(t.name, "mcp")
			pluginNotes.push(`MCP tools: ${mcp.tools.map((t) => t.name).join(", ")}.`)
		}
		for (const n of mcp.notes) pluginNotes.push(n)
	}

	if (args.command === "tools") {
		const [sub, name] = args.commandArgs
		try {
			if (sub === "show" && name) {
				const tool = tools.get(name)
				if (!tool) {
					process.stderr.write(`Unknown tool: ${name}\n`)
					process.exitCode = 1
					return
				}
				stdout.write(`${tool.name}\n`)
				stdout.write(`source: ${toolSource.get(tool.name) ?? "core"}\n`)
				stdout.write(`readOnly: ${tool.readOnly}\n`)
				stdout.write(`${tool.description}\n`)
				stdout.write(`${JSON.stringify(tool.schema, null, 2)}\n`)
				return
			}
			for (const t of tools.all()) {
				const desc = t.description.split("\n")[0]!.slice(0, 80)
				stdout.write(`${t.name} (${t.readOnly ? "readOnly" : "writes"}) — ${desc}\n`)
			}
			return
		} finally {
			// An MCP child holds a stdio pipe open, which keeps the event loop
			// alive after a one-shot command like this returns.
			closeMcp()
		}
	}

	const queue = new InputQueue()
	const useTui =
		interactive && cfg.tui && !args.plain && Boolean(stdout.isTTY) && Boolean(stdin.isTTY)
	// The context figure is the one the compaction check already paid for, so the
	// bar never spends a request of its own to draw itself.
	const status = () => {
		const used = session.lastTokens
		const window = session.provider.contextWindow(session.model)
		const ctx = used === undefined ? "" : ` \u00b7 ctx ${Math.round((used / window) * 100)}%`
		return `${session.model} \u00b7 ${effort}${ctx} \u00b7 $${session.usage.costUsd.toFixed(2)} \u00b7 Ctrl+O commands`
	}
	const tui: Tui | null = useTui
		? makeTui(`${route.model} \u00b7 ${effort} \u00b7 $0.00 \u00b7 Ctrl+O commands`, {
				// `@` offers exactly what glob would find, and only ever inserts a
				// path: the agent still reads the file with read_file.
				files: () => workspaceFiles(cwd),
				queued: () => queue.size,
			})
		: null
	type PlainApproval = {
		id: string
		tool: string
		subject: string
		rule: string
	}
	const plainApprovalEnabled = interactive && !tui && Boolean(stdin.isTTY) && Boolean(stdout.isTTY)
	const plainApprovals = new ApprovalQueue<PlainApproval>()
	const showPlainApproval = () => {
		const current = plainApprovals.current
		if (!current) return
		session.ui.notice(
			`Approval #${current.id}: allow ${current.tool} ${current.subject}? Rule: ${current.rule}\nReply y to allow once, n to deny, or d <reason> to deny with guidance.`,
		)
	}
	const answerPlainApproval = (decision: ApprovalDecision) => {
		plainApprovals.answer(decision)
		showPlainApproval()
	}
	const denyPlainApprovals = () => {
		plainApprovals.denyAll()
	}

	// Nobody to ask means execTool denies an `ask` rule rather than running it.
	// A `-x` run is unattended, and silently allowing there would defeat the only
	// rule the user bothered to write.
	let nextPermissionId = 0
	const permAsk = tui || plainApprovalEnabled
		? async (tool: string, input: unknown, rule: import("./core/permissions.ts").PermRule, id?: string): Promise<ApprovalDecision> => {
				const what = subject(input)
				if (tui) return tui.confirm({
					id: id ?? `permission-${++nextPermissionId}`,
					tool,
					subject: what ?? "(no arguments)",
					cwd,
					rule: formatPermRule(rule),
					reason: "Matched an ask rule",
				})
				const wasIdle = !plainApprovals.current
				const pending = plainApprovals.request({
						id: id ?? `permission-${++nextPermissionId}`,
						tool,
						subject: what ?? "(no arguments)",
						rule: formatPermRule(rule),
				})
				if (wasIdle) showPlainApproval()
				return pending
			}
		: undefined
	const perm =
		cfg.permissions.length || pluginHooks.length
			? {
					check: (t: string, i: unknown) => checkPermission(cfg.permissions, t, i),
					ask: permAsk,
					hooks: pluginHooks,
				}
			: undefined

	const recovered: RecoveryReport | null = args.continueThread ? await thread.recover() : null
	const session = newSession({
		provider,
		model: route.model,
		system: promptContext.prompt,
		maxTokens: route.maxTokens,
		thinkingBudget: route.thinkingBudget,
		tools,
		thread,
		cwd,
		ui: tui
			? tui.ui
			: args.streamJson || args.streamJsonInput
				? makeJsonUI((s) => stdout.write(s), args.streamJsonThinking)
				: makeUI(args.execute),
		compaction,
		queue,
		perm,
		serverTools,
		messages: recovered?.messages ?? [],
	})

	for (const note of pluginNotes) session.ui.notice(note)
	if (recovered?.recovered) {
		const parts = [
			`Recovered interrupted turn ${recovered.turnId}.`,
			recovered.restoredToolIds.length ? `${recovered.restoredToolIds.length} completed result(s) restored` : "",
			recovered.unknownToolIds.length ? `${recovered.unknownToolIds.length} outcome(s) unknown and not replayed` : "",
			recovered.notExecutedToolIds.length ? `${recovered.notExecutedToolIds.length} call(s) had not executed` : "",
			recovered.changedPaths.length ? `changed: ${recovered.changedPaths.join(", ")}` : "",
		].filter(Boolean)
		session.ui.notice(parts.join(" · "))
	}
	notify = (note) => session.ui.notice(note)

	let currentAbort: AbortController | null = null
	let turnFailed = false

	const turn = async (input: string) => {
		const ac = new AbortController()
		currentAbort = ac
		const onSigint = () => {
			denyPlainApprovals()
			ac.abort()
		}
		process.on("SIGINT", onSigint)
		try {
			// A typed path to an image file becomes an attachment; the text keeps
			// the path so the model can tell the screenshots apart.
			const images = await imageBlocks(input, cwd)
			for (const note of images.notes) session.ui.notice(note)
			await runTurn(
				session,
				images.blocks.length
					? [{ type: "text", text: input }, ...images.blocks]
					: input,
				ac.signal,
			)
		} catch (err) {
			// Classified here rather than at the throw sites: this is where a
			// failure stops being a value and becomes something a person reads.
			const diagnosis = classify(err)
			// An abort is the user's own decision, so it is not a failure. Anything
			// else is, and a one-shot that exits 0 after it lies to the script.
			if (!ac.signal.aborted) turnFailed = true
			if (args.streamJson || args.streamJsonInput) {
				stdout.write(jsonError(diagnosis.message, diagnosis))
			} else if (!ac.signal.aborted) session.ui.notice(formatDiagnosis(diagnosis))
		} finally {
			process.off("SIGINT", onSigint)
			currentAbort = null
			for (const u of subUsage.splice(0)) session.usage = addUsage(session.usage, u)
		}
		if (!args.streamJson && !args.streamJsonInput && !tui) stdout.write("\n")
	}

	let stop = false
	let active: Promise<void> | null = null
	// Lets the cost hard stop end a REPL that is blocked on the prompt.
	const replAbort = new AbortController()

	/**
	 * Runs a turn, then immediately runs whatever the user typed while it was
	 * working. Queued input never has to wait for another Enter.
	 */
	const runUntilQuiet = async (first: string) => {
		let input: string | null = first
		while (input && !stop) {
			await turn(input)
			if (cfg.cost.hardStopUsd > 0 && session.usage.costUsd >= cfg.cost.hardStopUsd) {
				session.ui.notice(`Cost limit reached ($${cfg.cost.hardStopUsd}). Exiting.`)
				stop = true
				replAbort.abort()
				tui?.close()
				break
			}
			// 0 turns the warning off, like it does for hardStopUsd. Without the
			// guard a free-tier provider reports $0.00 and `0 >= 0` printed "Spent
			// $0.00 this session." after every single turn.
			if (cfg.cost.warnUsd > 0 && session.usage.costUsd >= cfg.cost.warnUsd) {
				session.ui.notice(`Spent $${session.usage.costUsd.toFixed(2)} this session.`)
			}
			input = queue.drain()
		}
	}

	const quit = () => {
		stop = true
		denyPlainApprovals()
		replAbort.abort()
		tui?.close()
	}

	const showCost = () => {
		const u = session.usage
		session.ui.notice(
			`in ${u.inputTokens} \u00b7 cached ${u.cachedInputTokens} \u00b7 out ${u.outputTokens} \u00b7 $${u.costUsd.toFixed(4)}`,
		)
	}

	const showSchedules = async () => {
		const list = await loadSchedules()
		if (!list.length) {
			session.ui.notice("No schedules.")
			return
		}
		session.ui.notice([
			"Schedules:",
			...list.map((s) => `• ${s.id} · ${s.when} · ${s.threadId === thread.id ? "this thread" : s.threadId} · ${s.prompt}`),
		].join("\n"))
	}

	const showContextSources = async () => {
		const manifest: ContextManifest | undefined = (await thread.loadState()).context
		if (!manifest?.sources.length) {
			session.ui.notice("No recorded context sources.")
			return
		}
		session.ui.notice([
			"Context sources (audit only; not added to model messages):",
			...manifest.sources.map((source) => `• ${source.kind}${source.scope ? ` · ${source.scope}` : ""}${source.path ? ` · ${source.path}` : ""}`),
		].join("\n"))
	}

	const reviewLatestTurn = async () => {
		const state = await thread.loadState()
		const files = session.currentTurnId
			? [...session.changedFiles]
			: state.latestTurnId
				? state.changedFiles.get(state.latestTurnId) ?? []
				: []
		if (!files.length) {
			session.ui.notice("No files were recorded as changed in the latest turn.")
			return
		}
		const diff = await workingDiffForFiles(cwd, files)
		session.ui.notice([
			`Files recorded by change-reporting tools in the latest turn (${files.length}); currently this covers edit_file, not changes made through bash or plugins. The diff is current working-tree state, not a historical turn snapshot:`,
			...files.map((file) => `• ${file}`),
			diff.trim() ? `\n${diff.trim()}` : "\nNo current diff remains for these files.",
		].join("\n"))
	}

	/**
	 * Effort is the only model knob, so it is the only one the palette turns.
	 * Changing it mid-session is safe: the next request simply uses the new
	 * model, and the transcript is provider-neutral.
	 */
	const setEffort = (next: Effort) => {
		if (next === effort) return
		const r = routeFor(next, cfg)
		try {
			if (r.provider !== route.provider) session.provider = makeProvider(r.provider, cfg)
			route = r
			effort = next
			session.model = r.model
			session.maxTokens = r.maxTokens
			session.thinkingBudget = r.thinkingBudget
			session.ui.notice(`Effort ${next}. Model ${r.model}.`)
		} catch (err) {
			session.ui.notice(
				`Cannot switch to ${next}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
		tui?.setStatus(status())
	}

	const handleLine = (input: string): void => {
		if (plainApprovals.current) {
			const answer = input.trim()
			if (/^y(?:es)?$/i.test(answer)) answerPlainApproval({ action: "allow-once" })
			else if (/^n(?:o)?$/i.test(answer)) answerPlainApproval({ action: "deny" })
			else {
				const reason = /^(?:d|deny)\s+(.+)$/is.exec(answer)?.[1]?.trim()
				if (reason) answerPlainApproval({ action: "deny", reason })
				else session.ui.notice("Reply y, n, or d <reason>.")
			}
			return
		}
		if (!input) return
		if (input === "exit" || input === "quit") {
			quit()
			return
		}
		if (input === "cost") {
			showCost()
			return
		}
		// Ahead of the busy check: reading a list is not steering a turn, and
		// queueing the word would send it to the model as a prompt.
		if (input === "schedules") {
			void showSchedules()
			return
		}
		if (active) {
			// A turn is already running. Steer it instead of starting a second one.
			queue.push(input)
			session.ui.notice("Queued. Lands at the next step boundary.")
			return
		}
		tui?.setWorking(true)
		active = runUntilQuiet(input).finally(() => {
			active = null
			tui?.setWorking(false)
			tui?.setStatus(status())
		})
	}

	/**
	 * Palette entries are shortcuts, never new powers: everything here is
	 * something the user could already do by typing or by pressing a key. The
	 * palette exists so they do not have to remember which.
	 */
	const commands = (): PaletteItem[] => [
		{
			id: "abort",
			title: "Abort the current turn",
			hint: "Esc Esc",
			run: () => {
				if (currentAbort) currentAbort.abort()
				else session.ui.notice("Nothing is running.")
			},
		},
		{ id: "cost", title: "Show cost so far", hint: "type: cost", run: showCost },
		{
			id: "context",
			title: "Show context size",
			hint: `${session.messages.length} messages`,
			run: () => {
				const window = session.provider.contextWindow(session.model)
				session.ui.notice(
					`${session.messages.length} messages \u00b7 window ${window} \u00b7 compacts at ${Math.round(cfg.autoCompactAt * 100)}%`,
				)
			},
		},
		{
			id: "context-sources",
			title: "Inspect context sources",
			hint: "system, guidance, skills",
			run: showContextSources,
		},
		{
			id: "review-latest-turn",
			title: "Review changes from latest turn",
			hint: `${session.changedFiles.size} files`,
			run: reviewLatestTurn,
		},
		{
			id: "schedules",
			title: "List schedules",
			hint: "type: schedules",
			run: showSchedules,
		},
		...EFFORTS.map((e) => ({
			id: `effort-${e}`,
			title: `Effort: ${e}`,
			hint: e === effort ? "current" : routeFor(e, cfg).model,
			run: () => setEffort(e),
		})),
		...AGENT_TRACES.map((t) => ({
			id: `agent-trace-${t}`,
			title: `Subagent trace: ${t}`,
			hint: t === agentTrace ? "current" : AGENT_TRACE_HINT[t],
			run: () => {
				if (t === agentTrace) return
				agentTrace = t
				session.ui.notice(`Subagent trace ${t}.`)
			},
		})),
		{
			id: "skills",
			title: "List skills",
			hint: `${skills.length} available`,
			run: () => {
				if (!skills.length) {
					session.ui.notice("No skills. Add one at .agents/skills/<name>/SKILL.md")
					return
				}
				for (const s of skills) session.ui.notice(`${s.name} \u00b7 ${s.description}`)
			},
		},
		// Ctrl+V is claimed by most terminals for their own paste, so the key binding
		// alone leaves the feature unreachable for the people who have one.
		...(tui ? [{
			id: "paste-image",
			title: "Attach an image from the clipboard",
			hint: "Ctrl+V",
			run: () => tui.pasteImage(),
		}] : []),
		{
			id: "clear",
			title: "Clear screen",
			hint: "Ctrl+L",
			run: () => tui?.redraw(),
		},
		{
			id: "tools",
			title: "List tools",
			hint: `${session.tools.all().length} registered`,
			run: () => session.ui.notice(session.tools.all().map((t) => t.name).join(", ")),
		},
		{
			id: "threads",
			title: "List recent threads",
			hint: "resume with axe --continue",
			run: async () => {
				const ids = await Thread.list()
				session.ui.notice(ids.length ? ids.slice(-10).join("\n") : "No threads yet.")
			},
		},
		{ id: "thread-id", title: "Show this thread id", hint: thread.id, run: () => session.ui.notice(thread.id) },
		// Named by plugin, so a palette entry is never mistaken for one of ours.
		...pluginCommands.map((c, i) => ({
			id: `plugin-${i}`,
			title: c.label,
			hint: c.plugin,
			run: async () => {
				try {
					await c.run()
				} catch (err) {
					session.ui.notice(
						`Plugin command failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			},
		})),
		{ id: "exit", title: "Exit", hint: "Ctrl+D", run: quit },
	]

	// One-shot mode: axe -x "fix the failing test"
	if (oneShot !== null) {
		await turn(oneShot)
		if (args.streamJson) stdout.write(jsonResult(session.usage, thread.id))
		if (turnFailed) process.exitCode = 1
		return
	}

	// --stream-json-input: a turn per JSONL line on stdin, driven by a caller
	// rather than a person, so a torn line is an error event, never a crash
	// and never silence.
	if (args.streamJsonInput) {
		const rl = createInterface({ input: stdin })
		for await (const line of rl) {
			if (!line.trim()) continue
			let text: string
			try {
				const rec = JSON.parse(line)
				if (rec?.type !== "user" || typeof rec.text !== "string") {
					throw new Error('expected {"type":"user","text":"..."}')
				}
				text = rec.text
			} catch (err) {
				stdout.write(jsonError(`bad stream-json-input line: ${err instanceof Error ? err.message : String(err)}`))
				continue
			}
			await turn(text)
			stdout.write(jsonResult(session.usage, thread.id))
		}
		if (turnFailed) process.exitCode = 1
		return
	}

	if (tui) {
		tui.onLine(handleLine)
		// The list is rebuilt on every open so the hints stay true.
		tui.setCommands(commands())
		// In raw mode the terminal does not send SIGINT, so Ctrl+C is ours to
		// route: it aborts the turn, exactly like Esc Esc, and never kills axe.
		tui.onInterrupt(() => currentAbort?.abort())
		tui.onAbort(() => currentAbort?.abort())
		// The hints and the status bar both quote live numbers: cost climbs during
		// a turn, and a stale bar is worse than no bar.
		const refresh = setInterval(() => {
			tui.setCommands(commands())
			tui.setStatus(status())
		}, 2_000)
		refresh.unref?.()
		if (args.prompt) handleLine(args.prompt)
		await tui.closed
		clearInterval(refresh)
		stop = true
		const finalAbort = currentAbort as AbortController | null
		finalAbort?.abort()
		await active
		return
	}

	stdout.write(
		`${DIM}axe ${VERSION} \u00b7 ${route.model} \u00b7 ${effort} \u00b7 ${thread.id}${RESET}\n`,
	)
	if (args.prompt) handleLine(args.prompt)

	const rl = createInterface({ input: stdin, output: stdout })
	while (!stop) {
		let input: string
		try {
			input = (await rl.question(`${CYAN}\u203a${RESET} `, { signal: replAbort.signal })).trim()
		} catch {
			denyPlainApprovals()
			break
		}
		handleLine(input)
	}
	await active
	rl.close()
}

main().catch((err) => {
	// The message can quote a keySource command's output, which is untrusted text.
	process.stderr.write(`${safeTerminalText(describeError(err))}\n`)
	process.exit(1)
})

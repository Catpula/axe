/**
 * Subagent contract tests. No network: the provider is scripted.
 *
 * The property that matters is the discard. If a subagent's tool cycles ever
 * reach the parent transcript, the feature is worse than useless: it costs two
 * models and still fills the context it was meant to protect.
 */
import { Gate, SubagentError, briefFor, runSubagent } from "../src/core/subagent.ts"
import { newSession, runTurn } from "../src/core/loop.ts"
import { ToolRegistry, execTool } from "../src/core/tools.ts"
import { addUsage, emptyUsage } from "../src/providers/types.ts"
import type {
	Block,
	Message,
	Provider,
	StreamEvent,
	StreamOptions,
	ToolCtx,
	ToolDef,
	Usage,
} from "../src/providers/types.ts"
import { coreTools } from "../src/tools/index.ts"
import { taskTool, type Spawn } from "../src/tools/task.ts"

let checks = 0
let failed = 0

function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

const silentUI = {
	text: () => {},
	thinking: () => {},
	toolStart: () => {},
	toolEnd: () => {},
	notice: () => {},
}

type Scripted = Provider & { calls: Message[][] }

/** Replays fixed turns. The last turn repeats, which is how loops are tested. */
function scripted(turns: Block[][], usageOverride: Partial<Usage> = {}): Scripted {
	let i = 0
	const calls: Message[][] = []
	return {
		name: "scripted",
		calls,
		contextWindow: () => 200_000,
		async countTokens() {
			return 0
		},
		async *stream(opts: StreamOptions): AsyncGenerator<StreamEvent> {
			calls.push(JSON.parse(JSON.stringify(opts.messages)))
			const content = turns[Math.min(i++, turns.length - 1)] ?? []
			for (const b of content) {
				if (b.type === "text") yield { type: "text_delta", text: b.text }
				if (b.type === "tool_use") yield { type: "tool_start", id: b.id, name: b.name }
			}
			const stop = content.some((b) => b.type === "tool_use")
				? ("tool_use" as const)
				: ("end_turn" as const)
			yield {
				type: "done",
				stop,
				message: { role: "assistant", content },
				usage: { ...emptyUsage(), ...usageOverride },
			}
		},
	}
}

const peekTool: ToolDef = {
	name: "peek",
	description: "Test tool. Returns a string the parent must never see.",
	readOnly: true,
	schema: { type: "object", properties: {} },
	async run() {
		return "SECRET_SUB_OUTPUT"
	},
}

function ctxWith(signal: AbortSignal): ToolCtx {
	return { cwd: process.cwd(), signal, log: () => {} }
}

async function main() {
	const ac = new AbortController()

	// Isolation, roll-up, and the shape of the parent transcript.
	const sub = scripted(
		[
			[{ type: "tool_use", id: "s1", name: "peek", input: {} }],
			[{ type: "text", text: "REPORT: the flag is read in src/config.ts:42." }],
		],
		{ costUsd: 0.5, outputTokens: 10 },
	)
	const parent = scripted([
		[{ type: "tool_use", id: "p1", name: "task", input: { prompt: "find it", role: "search" } }],
		[{ type: "text", text: "done" }],
	])

	const subUsage: Usage[] = []
	const spawn: Spawn = async (prompt, role, ctx) => {
		const out = await runSubagent(
			{
				provider: sub,
				model: "sub-model",
				maxTokens: 100,
				system: briefFor(role),
				tools: [peekTool],
				cwd: process.cwd(),
				maxSteps: 10,
			},
			prompt,
			ctx.signal,
		)
		subUsage.push(out.usage)
		return out.text
	}

	const session = newSession({
		provider: parent,
		model: "parent-model",
		system: "parent",
		maxTokens: 100,
		tools: coreTools().register(taskTool(spawn)),
		cwd: process.cwd(),
		ui: silentUI,
	})
	await runTurn(session, "go", ac.signal)

	const dump = JSON.stringify(session.messages)
	check("the parent receives the report", dump.includes("REPORT:"))
	check("the subagent tool output never reaches the parent", !dump.includes("SECRET_SUB_OUTPUT"))
	check("the subagent tool cycle never reaches the parent", !dump.includes("peek"))
	check(
		"the parent transcript stays four messages",
		session.messages.length === 4,
		`${session.messages.length}`,
	)
	check("the subagent ran its own loop", sub.calls.length === 2, `${sub.calls.length}`)
	check("the subagent never saw the parent context", !JSON.stringify(sub.calls).includes("parent"))

	let rolled = session.usage
	for (const u of subUsage.splice(0)) rolled = addUsage(rolled, u)
	check("subagent usage rolls up into the session", rolled.costUsd === 1, `${rolled.costUsd}`)

	// The gate.
	const gate = new Gate(2)
	let live = 0
	let observed = 0
	await Promise.all(
		Array.from({ length: 5 }, () =>
			gate.run(async () => {
				live++
				observed = Math.max(observed, live)
				await new Promise((r) => setTimeout(r, 5))
				live--
			}),
		),
	)
	check("the gate holds the limit", observed === 2, `${observed}`)
	check("the gate reports its peak", gate.peak === 2, `${gate.peak}`)
	check("the gate drains its queue", live === 0, `${live}`)

	// Waking a waiter costs a microtask. A job that arrives inside that gap used
	// to find the slot free, take it, and run alongside the waiter it woke.
	{
		const one = new Gate(1)
		const release: Array<() => void> = []
		let inside = 0
		let seen = 0
		const job = () =>
			one.run(
				() =>
					new Promise<void>((res) => {
						inside++
						seen = Math.max(seen, inside)
						release.push(() => {
							inside--
							res()
						})
					}),
			)
		const first = job()
		const queued = job()
		release.shift()!()
		// One tick: the slot is free and the waiter has not woken yet.
		await Promise.resolve()
		const latecomer = job()
		for (let i = 0; i < 6 && (release.length || inside > 0); i++) {
			release.shift()?.()
			await new Promise((r) => setTimeout(r, 0))
		}
		await Promise.all([first, queued, latecomer])
		check("a job arriving as a slot frees does not exceed the limit", seen === 1, `${seen}`)
		check("the gate's own peak agrees", one.peak === 1, `${one.peak}`)
	}

	// What a subagent is allowed to hold.
	const ro = coreTools()
		.readOnly()
		.map((t) => t.name)
	check("subagents get no write tools", !ro.includes("edit_file") && !ro.includes("bash"))
	check("subagents cannot spawn subagents", !ro.includes("task"))
	check("subagents can still read", ro.includes("read_file") && ro.includes("grep"))

	// Failure handling.
	const boom = new ToolRegistry().register(
		taskTool(async () => {
			throw new Error("subagent exploded")
		}),
	)
	const ctx = ctxWith(ac.signal)
	const crashed = await execTool(boom, "task", { prompt: "x", role: "search" }, ctx)
	check(
		"a failed subagent becomes a tool error, not a crash",
		crashed.isError && crashed.content.includes("subagent exploded"),
		crashed.content,
	)
	const noPrompt = await execTool(boom, "task", { role: "search" }, ctx)
	check(
		"a missing prompt is rejected",
		noPrompt.isError && noPrompt.content.includes('"prompt"'),
		noPrompt.content,
	)
	const emptyPrompt = await execTool(boom, "task", { prompt: "   ", role: "search" }, ctx)
	check(
		"a blank prompt is still the tool's own business",
		emptyPrompt.isError && emptyPrompt.content.includes("prompt is required"),
		emptyPrompt.content,
	)
	const badType = await execTool(boom, "task", { prompt: 42 }, ctx)
	check(
		"a wrongly typed argument never reaches the tool",
		badType.isError && badType.content.includes("must be of type string"),
		badType.content,
	)
	const badRole = await execTool(boom, "task", { prompt: "x", role: "chef" }, ctx)
	check(
		"an unknown role is rejected",
		badRole.isError && badRole.content.includes("unknown role"),
		badRole.content,
	)

	// A subagent that dies half way through has still spent tokens, and the
	// parent has to be able to bill them.
	{
		let turn = 0
		const dying: Provider = {
			name: "dying",
			contextWindow: () => 200_000,
			async countTokens() {
				return 0
			},
			async *stream(): AsyncGenerator<StreamEvent> {
				if (turn++ > 0) throw new Error("the provider hung up")
				yield { type: "tool_start", id: "d1", name: "peek" }
				yield {
					type: "done",
					stop: "tool_use",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", id: "d1", name: "peek", input: {} }],
					},
					usage: { ...emptyUsage(), costUsd: 0.25, outputTokens: 7 },
				}
			},
		}

		let thrown: unknown
		try {
			await runSubagent(
				{
					provider: dying,
					model: "sub-model",
					maxTokens: 100,
					system: "s",
					tools: [peekTool],
					cwd: process.cwd(),
					maxSteps: 10,
				},
				"go",
				ac.signal,
			)
		} catch (err) {
			thrown = err
		}
		check("a dead subagent still fails loudly", thrown instanceof SubagentError)
		const spent = thrown instanceof SubagentError ? thrown.usage : emptyUsage()
		check("the failure carries what it spent", spent.costUsd === 0.25, `${spent.costUsd}`)
		let parentUsage = emptyUsage()
		if (thrown instanceof SubagentError) parentUsage = addUsage(parentUsage, thrown.usage)
		check("the parent can still roll up a failed subagent", parentUsage.costUsd === 0.25)
		check(
			"the failure says what went wrong",
			thrown instanceof Error && thrown.message.includes("hung up"),
			thrown instanceof Error ? thrown.message : "",
		)
	}

	// Abort propagation.
	const aborted = new AbortController()
	aborted.abort()
	const watcher = new ToolRegistry().register(
		taskTool(async (_p, _r, c) => (c.signal.aborted ? "saw abort" : "missed abort")),
	)
	const abortOut = await execTool(
		watcher,
		"task",
		{ prompt: "x", role: "search" },
		ctxWith(aborted.signal),
	)
	check("abort reaches the subagent", abortOut.content === "saw abort", abortOut.content)

	// A runaway subagent, and a silent one.
	const loopy = scripted([[{ type: "tool_use", id: "l1", name: "peek", input: {} }]])
	const bounded = await runSubagent(
		{
			provider: loopy,
			model: "sub-model",
			maxTokens: 100,
			system: "s",
			tools: [peekTool],
			cwd: process.cwd(),
			maxSteps: 3,
		},
		"spin",
		ac.signal,
	)
	check("maxSteps bounds the subagent", loopy.calls.length === 3, `${loopy.calls.length}`)
	check(
		"a subagent that writes nothing still reports",
		bounded.text.startsWith("The subagent finished"),
		bounded.text,
	)
	check("the subagent counts its steps", bounded.steps === 3, `${bounded.steps}`)

	// A subagent is silent by default and that must stay true, because most
	// callers have nowhere to put its output. Handing it a UI is how a display
	// opts in to seeing what it is doing.
	const watched = scripted([
		[{ type: "tool_use", id: "w1", name: "peek", input: { path: "src/x.ts" } }],
		[{ type: "text", text: "found it" }],
	])
	const seen: string[] = []
	await runSubagent(
		{
			provider: watched,
			model: "sub-model",
			maxTokens: 100,
			system: "s",
			tools: [peekTool],
			cwd: process.cwd(),
			maxSteps: 5,
			ui: {
				...silentUI,
				toolRunning: (name, id) => seen.push(`run ${name} ${id}`),
				toolEnd: (name, ok, _p, _i, id) => seen.push(`end ${name} ${ok} ${id}`),
			},
		},
		"look",
		ac.signal,
	)
	check("a supplied ui sees the subagent's tools", seen.length === 2, seen.join(" | "))
	check("the running hook fires before the end hook", seen[0]?.startsWith("run peek") === true, seen.join(" | "))
	check("the tool id travels to both hooks", seen.join(" | ").includes("w1"), seen.join(" | "))

	const quiet = scripted([
		[{ type: "tool_use", id: "q1", name: "peek", input: {} }],
		[{ type: "text", text: "done" }],
	])
	let leaked = false
	await runSubagent(
		{
			provider: quiet,
			model: "sub-model",
			maxTokens: 100,
			system: "s",
			tools: [peekTool],
			cwd: process.cwd(),
			maxSteps: 5,
			log: () => {
				leaked = true
			},
		},
		"look",
		ac.signal,
	)
	check("no ui means no stream, as before", !leaked)

	// Briefs.
	check("the oracle brief is not the search brief", briefFor("oracle") !== briefFor("search"))
	check(
		"both briefs forbid asking questions",
		briefFor("oracle").includes("cannot ask questions") &&
			briefFor("search").includes("cannot ask questions"),
	)

	console.log(`subagent: ${checks} checks`)
	if (failed) {
		console.log(`${failed} failed`)
		process.exit(1)
	}
	console.log("all green")
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

import { saveArtifact } from "../artifacts.ts"
import type { ToolCtx, ToolDef, ToolDisplay } from "../providers/types.ts"
import { formatPermRule, type PermDecision, type PermRule } from "./permissions.ts"
import type { ToolCallHook, ToolCallVerdict } from "./plugins.ts"

type Schema = { required?: unknown; properties?: unknown }

export class ToolRegistry {
	private map = new Map<string, ToolDef>()

	register(...tools: ToolDef[]): this {
		for (const t of tools) this.map.set(t.name, t)
		return this
	}

	get(name: string): ToolDef | undefined {
		return this.map.get(name)
	}

	all(): ToolDef[] {
		return [...this.map.values()]
	}

	readOnly(): ToolDef[] {
		return this.all().filter((t) => t.readOnly)
	}
}

export type ToolOutcome = { content: string; isError: boolean; display?: ToolDisplay }

export type ApprovalDecision =
	| { action: "allow-once" }
	| { action: "deny"; reason?: string }

/** FIFO broker shared by any UI that can answer permission requests. */
export class ApprovalQueue<T> {
	private active?: { request: T; resolve: (decision: ApprovalDecision) => void }
	private readonly queued: Array<{ request: T; resolve: (decision: ApprovalDecision) => void }> = []

	get current(): T | undefined {
		return this.active?.request
	}

	get waiting(): number {
		return this.queued.length
	}

	request(request: T): Promise<ApprovalDecision> {
		return new Promise((resolve) => {
			const entry = { request, resolve }
			if (this.active) this.queued.push(entry)
			else this.active = entry
		})
	}

	answer(decision: ApprovalDecision): void {
		const active = this.active
		this.active = this.queued.shift()
		active?.resolve(decision)
	}

	denyAll(): void {
		this.active?.resolve({ action: "deny" })
		this.active = undefined
		for (const entry of this.queued.splice(0)) entry.resolve({ action: "deny" })
	}
}

const MAX_TOOL_OUTPUT = 30_000
async function boundedOutput(s: string, ctx: ToolCtx, name: string): Promise<string> {
	if (s.length <= MAX_TOOL_OUTPUT) return s
	const head = s.slice(0, MAX_TOOL_OUTPUT / 2)
	const tail = s.slice(-MAX_TOOL_OUTPUT / 2)
	const cut = s.length - MAX_TOOL_OUTPUT
	let artifact = ""
	let storageError = ""
	try {
		artifact = await saveArtifact(ctx.cwd, `${name}-result`, s)
	} catch (err) {
		storageError = `; artifact storage failed: ${err instanceof Error ? err.message : String(err)}`
	}
	const saved = artifact ? `; full output: ${artifact}` : storageError
	const marker = `\n\n[... ${cut} characters omitted${saved} ...]\n\n`
	const half = Math.floor((MAX_TOOL_OUTPUT - marker.length) / 2)
	return `${head.slice(0, half)}${marker}${tail.slice(-(MAX_TOOL_OUTPUT - marker.length - half))}`
}

function typeOk(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string"
		case "number":
			return typeof value === "number" && Number.isFinite(value)
		case "integer":
			return typeof value === "number" && Number.isInteger(value)
		case "boolean":
			return typeof value === "boolean"
		case "array":
			return Array.isArray(value)
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value)
		default:
			return true
	}
}

/**
 * Checks the input against the schema the model was given, because a model that
 * drops a field is a normal event and the tools trust what they are handed:
 * without this, `edit_file` writes the string "undefined" into a real file and
 * only then reports a problem. Only `required` and the declared types are
 * enforced; this is a guard rail, not a JSON Schema implementation.
 */
function validateInput(tool: ToolDef, input: Record<string, unknown>): string | null {
	const schema = tool.schema as Schema
	const required = Array.isArray(schema.required) ? schema.required : []
	for (const key of required) {
		if (typeof key === "string" && input[key] === undefined) {
			return `${tool.name}: missing required parameter "${key}".`
		}
	}
	const props =
		schema.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, { type?: unknown }>)
			: {}
	for (const [key, spec] of Object.entries(props)) {
		const value = input[key]
		if (value === undefined) continue
		const type = spec?.type
		if (typeof type === "string" && !typeOk(value, type)) {
			return `${tool.name}: parameter "${key}" must be of type ${type}.`
		}
	}
	return null
}

export type PermGate = {
	check: (tool: string, input: unknown) => PermDecision
	/**
	 * Absent means there is nobody to ask — a `-x` run, or a pipe. An `ask` rule
	 * then denies. Treating "cannot ask" as "allow" would turn every unattended
	 * run into a hole exactly where the user wrote a rule saying to stop.
	 */
	ask?: (tool: string, input: unknown, rule: PermRule, id?: string) => Promise<ApprovalDecision>
	/**
	 * Plugin hooks, run after the config rules. They come last because a plugin
	 * is code the user installed and a rule is a sentence the user wrote: the
	 * sentence should not be overridable by something that ships with a repo,
	 * and a config `deny` has already returned before a hook is consulted.
	 */
	hooks?: ToolCallHook[]
}

/**
 * Never throws. A failed tool must still produce a tool_result, otherwise the
 * next request is rejected for having an unanswered tool_use block.
 */
export async function execTool(
	reg: ToolRegistry,
	name: string,
	input: unknown,
	ctx: ToolCtx,
	perm?: PermGate,
): Promise<ToolOutcome> {
	const tool = reg.get(name)
	if (!tool) {
		return { content: `Unknown tool: ${name}`, isError: true }
	}
	const args = input ?? {}
	if (typeof args !== "object" || Array.isArray(args)) {
		return { content: `${name}: input must be a JSON object.`, isError: true }
	}
	let call: unknown = args
	const invalid = validateInput(tool, args as Record<string, unknown>)
	if (invalid) return { content: invalid, isError: true }
	if (perm) {
		const decision = perm.check(name, args)
		if (decision.action === "deny") return { content: decision.reason, isError: true }
		if (decision.action === "ask") {
			if (!perm.ask) {
				return {
					content: `Blocked: ${name} needs approval and this session cannot prompt. Rule: ${formatPermRule(decision.rule)}`,
					isError: true,
				}
			}
			let approval: ApprovalDecision
			try {
				approval = await perm.ask(name, args, decision.rule, ctx.id)
			} catch {
				approval = { action: "deny" }
			}
			if (approval.action === "deny") {
				const reason = approval.reason?.trim().slice(0, 1_000)
				return { content: `${name}: denied by the user${reason ? `: ${reason}` : "."}`, isError: true }
			}
		}
	}
	for (const hook of perm?.hooks ?? []) {
		let verdict: ToolCallVerdict | undefined
		try {
			verdict = hook(name, call)
		} catch (err) {
			// A hook that throws must not take the turn with it, and must not be
			// read as consent either: it simply had no opinion.
			ctx.log(`plugin hook failed: ${err instanceof Error ? err.message : String(err)}`)
			continue
		}
		if (!verdict) continue
		if (verdict.action === "reject") {
			return { content: `${name}: rejected by a plugin: ${verdict.reason}`, isError: true }
		}
		if (verdict.action === "modify") {
			// Re-validated, because a hook is the one place the arguments change
			// after the schema check the model's own output already passed.
			if (!verdict.input || typeof verdict.input !== "object" || Array.isArray(verdict.input)) {
				return { content: `${name}: a plugin returned input that is not an object.`, isError: true }
			}
			const bad = validateInput(tool, verdict.input as Record<string, unknown>)
			if (bad) return { content: `${name}: a plugin rewrote the input badly: ${bad}`, isError: true }
			call = verdict.input
		}
	}
	try {
		await ctx.beforeRun?.(call)
		const out = await tool.run(call, ctx)
		let display: ToolDisplay | undefined
		try {
			display = tool.display?.(call, out)
		} catch {
			// Presentation metadata cannot turn a successful side effect into an error.
		}
		return {
			content: await boundedOutput(out, ctx, name) || "(no output)",
			isError: false,
			...(display ? { display } : {}),
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { content: await boundedOutput(msg, ctx, name), isError: true }
	}
}

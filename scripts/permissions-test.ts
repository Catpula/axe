import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { checkPermission, parsePermLine, type PermRule } from "../src/core/permissions.ts"
import { ApprovalQueue, execTool, ToolRegistry } from "../src/core/tools.ts"
import type { ToolCtx, ToolDef } from "../src/providers/types.ts"

const ctx: ToolCtx = { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} }

{
	const approvals = new ApprovalQueue<{ id: string }>()
	const first = approvals.request({ id: "one" })
	const second = approvals.request({ id: "two" })
	assert.equal(approvals.current?.id, "one")
	assert.equal(approvals.waiting, 1)
	approvals.answer({ action: "allow-once" })
	assert.equal((await first).action, "allow-once")
	assert.equal(approvals.current?.id, "two")
	approvals.denyAll()
	assert.equal((await second).action, "deny")
	assert.equal(approvals.current, undefined)
}

{
	assert.deepEqual(parsePermLine("bash deny rm *", "trusted"), {
		tool: "bash",
		action: "deny",
		pattern: "rm *",
		scope: "trusted",
	})
	assert.equal(parsePermLine("bash", "trusted"), null)
	assert.equal(parsePermLine("bash maybe *", "trusted"), null)
	assert.equal(parsePermLine("  ", "trusted"), null)
	assert.equal(parsePermLine("bash allow", "trusted")?.pattern, undefined)
}

{
	assert.equal(checkPermission([], "bash", { cmd: "rm -rf /" }).action, "allow")
}

{
	const rules = [parsePermLine("bash deny rm *", "trusted")!]
	assert.equal(checkPermission(rules, "bash", { cmd: "rm -rf /tmp/x" }).action, "deny")
	assert.equal(checkPermission(rules, "bash", { cmd: "ls" }).action, "allow")
	assert.equal(checkPermission(rules, "read_file", { path: "rm x" }).action, "allow")
}

{
	// A deny outlives an allow written above it.
	const rules = [
		parsePermLine("bash allow *", "trusted")!,
		parsePermLine("bash deny rm *", "project")!,
	]
	assert.equal(checkPermission(rules, "bash", { cmd: "rm -rf /" }).action, "deny")
}

{
	const rules = [parsePermLine("* deny *", "trusted")!]
	assert.equal(checkPermission(rules, "anything", {}).action, "deny")
}

{
	// A pattern rule cannot match a call with no subject to compare.
	const rules = [parsePermLine("bash ask npm *", "trusted")!]
	assert.equal(checkPermission(rules, "bash", {}).action, "allow")
	assert.equal(checkPermission(rules, "bash", { cmd: "npm test" }).action, "ask")
}

{
	// AXE_HOME is read when thread.ts is imported, so the trusted path can only
	// be exercised in a child that starts with it already pointing at the fixture.
	const home = mkdtempSync(join(tmpdir(), "axe-perm-"))
	mkdirSync(join(home, ".axe"))
	writeFileSync(
		join(home, ".axe", "config.toml"),
		'permissions = ["bash allow npm *", "bash deny rm *", "nonsense"]\n',
	)
	const src = `
import { loadConfig } from ${JSON.stringify(join(import.meta.dirname, "../src/config.ts"))}
const { config, notices } = loadConfig(${JSON.stringify(tmpdir())})
console.log(JSON.stringify({ rules: config.permissions, notices }))
`
	const script = join(home, "probe.ts")
	writeFileSync(script, src)
	const out = execFileSync(process.execPath, ["--experimental-strip-types", script], {
		encoding: "utf8",
		env: { ...process.env, AXE_HOME: join(home, ".axe") },
		stdio: ["ignore", "pipe", "ignore"],
	})
	const got = JSON.parse(out) as { rules: PermRule[]; notices: string[] }
	assert.deepEqual(
		got.rules.map((r) => `${r.tool} ${r.action} ${r.pattern} ${r.scope}`),
		["bash allow npm * trusted", "bash deny rm * trusted"],
	)
	assert.ok(got.notices.some((n) => n.includes("nonsense")))
}

{
	// A project config may tighten and nothing else.
	const proj = mkdtempSync(join(tmpdir(), "axe-perm-proj-"))
	mkdirSync(join(proj, ".axe"))
	writeFileSync(
		join(proj, ".axe", "config.toml"),
		'permissions = ["bash allow *", "bash deny curl *"]\n',
	)
	const { config, notices } = loadConfig(proj)
	assert.deepEqual(
		config.permissions.map((r) => `${r.tool} ${r.action}`),
		["bash deny"],
	)
	assert.ok(notices.some((n) => n.includes("only add deny rules")))
}

{
	let ran = 0
	const counter: ToolDef = {
		name: "counter",
		description: "",
		readOnly: false,
		schema: { type: "object", properties: {} },
		async run() {
			ran++
			return "ok"
		},
	}
	const reg = new ToolRegistry().register(counter)
	const rules = [parsePermLine("counter deny", "trusted")!]
	const gate = { check: (t: string, i: unknown) => checkPermission(rules, t, i) }

	const denied = await execTool(reg, "counter", {}, ctx, gate)
	assert.ok(denied.isError)
	assert.equal(ran, 0, "a denied tool must not run")

	// No rule: unchanged behaviour.
	const ok = await execTool(reg, "counter", {}, ctx, {
		check: () => ({ action: "allow" }),
	})
	assert.equal(ok.isError, false)
	assert.equal(ran, 1)

	// An ask with nobody to ask denies rather than allowing.
	const askRules = [parsePermLine("counter ask", "trusted")!]
	const mute = await execTool(reg, "counter", {}, ctx, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
	})
	assert.ok(mute.isError)
	assert.ok(mute.content.includes("cannot prompt"))
	assert.equal(ran, 1)

	// An ask that is answered yes runs; answered no does not.
	const yes = await execTool(reg, "counter", {}, ctx, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
		ask: async () => ({ action: "allow-once" }),
	})
	assert.equal(yes.isError, false)
	assert.equal(ran, 2)

	const no = await execTool(reg, "counter", {}, ctx, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
		ask: async () => ({ action: "deny" }),
	})
	assert.ok(no.isError)
	assert.equal(ran, 2)

	let askedId: string | undefined
	await execTool(reg, "counter", {}, { ...ctx, id: "toolu_permission" }, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
		ask: async (_tool, _input, _rule, id) => {
			askedId = id
			return { action: "deny", reason: "not safe here" }
		},
	})
	assert.equal(askedId, "toolu_permission", "approval keeps the provider tool-use id")
	const deniedWithReason = await execTool(reg, "counter", {}, ctx, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
		ask: async () => ({ action: "deny", reason: "not safe here" }),
	})
	assert.equal(deniedWithReason.content, "counter: denied by the user: not safe here")
	const longReason = await execTool(reg, "counter", {}, ctx, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
		ask: async () => ({ action: "deny", reason: `  ${"x".repeat(2_000)}  ` }),
	})
	assert.equal(longReason.content.length, "counter: denied by the user: ".length + 1_000)

	let effectiveInput: unknown
	await execTool(reg, "counter", { original: true }, {
		...ctx,
		beforeRun: async (input) => {
			effectiveInput = input
		},
	}, {
		check: () => ({ action: "allow" }),
		hooks: [() => ({ action: "modify", input: { rewritten: true } })],
	})
	assert.deepEqual(effectiveInput, { rewritten: true }, "the durable execution gate sees plugin-rewritten input")

	// A prompt that throws is a denial, not a crashed turn.
	const boom = await execTool(reg, "counter", {}, ctx, {
		check: (t: string, i: unknown) => checkPermission(askRules, t, i),
		ask: async () => {
			throw new Error("terminal went away")
		},
	})
	assert.ok(boom.isError)
	assert.equal(ran, 3)
}

console.log("permissions-test ok")

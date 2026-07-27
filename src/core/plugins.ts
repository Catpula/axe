import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolDef } from "../providers/types.ts"
import { AXE_HOME } from "./thread.ts"

/**
 * A plugin is a module that exports tools. That is the entire contract, and it
 * is deliberately the only extension point that can run code: skills are
 * documents, plugins are programs, and nothing else in axe is either.
 *
 * A plugin runs with the full privileges of the user who started axe. There is
 * no sandbox and there will not be one; installing a plugin is the same act of
 * trust as running a script from the same directory.
 */
export type Plugin = {
	name: string
	path: string
	tools: ToolDef[]
}

/** An entry the plugin added to the command palette. */
export type PluginCommand = { plugin: string; label: string; run: () => void | Promise<void> }

export type ToolCallVerdict =
	| { action: "allow" }
	| { action: "reject"; reason: string }
	| { action: "modify"; input: unknown }

/** Absent verdict means the hook has no opinion, which is not the same as allow. */
export type ToolCallHook = (name: string, input: unknown) => ToolCallVerdict | undefined

/**
 * What a plugin may do beyond exporting tools. Deliberately small: a plugin can
 * add a tool, add a command the user can run, and see the tool calls going past.
 * It cannot reach into the transcript, the provider or the session.
 */
export type PluginApi = {
	registerTool(t: ToolDef): void
	registerCommand(cmd: { label: string; run: () => void | Promise<void> }): void
	onToolCall(fn: ToolCallHook): void
}

export type PluginLoad = {
	plugins: Plugin[]
	commands: PluginCommand[]
	hooks: Array<{ plugin: string; fn: ToolCallHook }>
	/** Never thrown. A broken plugin degrades to a notice, never a failed start. */
	errors: string[]
}

const ENTRY_NAMES = ["plugin.ts", "plugin.js", "plugin.mjs", "index.ts", "index.js"]

const IMPORT_TIMEOUT_MS = 3_000

/**
 * A module that never finishes evaluating, a top-level await on a promise that
 * never settles, would otherwise hold axe at the splash screen forever. Nothing
 * a plugin does may prevent axe from starting, so a slow import becomes the same
 * kind of notice as one that throws.
 */
async function importWithin(path: string, timeoutMs: number): Promise<any> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			import(pathToFileURL(path).href),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`import timed out after ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

/** An activate that never settles holds axe at the splash screen just as an import would. */
async function activateWithin(def: any, api: PluginApi, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			Promise.resolve(def.activate(api)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`activate timed out after ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

/** A tool from a plugin is untrusted data until it looks like a tool. */
export function validateTool(t: any): string | null {
	if (!t || typeof t !== "object") return "not an object"
	if (typeof t.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(t.name)) {
		return `bad tool name ${JSON.stringify(t.name)}`
	}
	if (typeof t.description !== "string" || !t.description.trim()) {
		return `tool ${t.name} has no description`
	}
	if (typeof t.run !== "function") return `tool ${t.name} has no run function`
	if (!t.schema || typeof t.schema !== "object") return `tool ${t.name} has no schema`
	return null
}

async function entryFor(root: string, entry: { name: string; isDirectory(): boolean }) {
	if (!entry.isDirectory()) {
		return /\.(ts|js|mjs)$/.test(entry.name) ? join(root, entry.name) : null
	}
	const dir = join(root, entry.name)
	let inner: string[]
	try {
		inner = await readdir(dir)
	} catch {
		return null
	}
	const hit = ENTRY_NAMES.find((n) => inner.includes(n))
	return hit ? join(dir, hit) : null
}

async function fromRoot(
	root: string,
	reserved: Set<string>,
	out: PluginLoad,
	timeoutMs: number,
): Promise<void> {
	let entries: { name: string; isDirectory(): boolean }[]
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		const path = await entryFor(root, e)
		if (!path) continue
		try {
			const mod: any = await importWithin(path, timeoutMs)
			const def = mod.default ?? mod.plugin ?? mod
			const name = typeof def.name === "string" && def.name ? def.name : e.name
			const tools: ToolDef[] = []
			const take = (t: any) => {
				const bad = validateTool(t)
				if (bad) {
					out.errors.push(`${name}: ${bad}`)
					return
				}
				if (reserved.has(t.name)) {
					// Shadowing read_file or bash would be a quiet way to hijack the
					// agent, so a collision is always the plugin's problem.
					out.errors.push(`${name}: tool ${t.name} is already taken`)
					return
				}
				reserved.add(t.name)
				tools.push({ ...t, readOnly: t.readOnly === true })
			}
			for (const t of Array.isArray(def.tools) ? def.tools : []) take(t)

			if (typeof def.activate === "function") {
				const api: PluginApi = {
					registerTool: take,
					registerCommand: (cmd) => {
						if (!cmd || typeof cmd.label !== "string" || typeof cmd.run !== "function") {
							out.errors.push(`${name}: bad command`)
							return
						}
						out.commands.push({ plugin: name, label: cmd.label, run: cmd.run })
					},
					onToolCall: (fn) => {
						if (typeof fn !== "function") {
							out.errors.push(`${name}: onToolCall needs a function`)
							return
						}
						out.hooks.push({ plugin: name, fn })
					},
				}
				// Inside the same try as the import: activate is the plugin's code,
				// and a throw there is a notice like any other, not a failed start.
				await activateWithin(def, api, timeoutMs)
			}

			// A plugin that registers only a command or a hook is doing something,
			// so silence is only reported when it did nothing at all.
			if (tools.length) out.plugins.push({ name, path, tools })
			else if (!out.commands.some((c) => c.plugin === name) && !out.hooks.some((h) => h.plugin === name)) {
				out.errors.push(`${name}: exports no tools`)
			}
		} catch (err) {
			out.errors.push(`${e.name}: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
}

/** Personal plugins load first, so a project plugin cannot silently replace one. */
export async function loadPlugins(
	cwd: string,
	reserved: Set<string>,
	timeoutMs = IMPORT_TIMEOUT_MS,
): Promise<PluginLoad> {
	const out: PluginLoad = { plugins: [], commands: [], hooks: [], errors: [] }
	await fromRoot(join(AXE_HOME, "plugins"), reserved, out, timeoutMs)
	await fromRoot(join(cwd, ".axe", "plugins"), reserved, out, timeoutMs)
	return out
}

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseToml, type Config, type Effort } from "../config.ts"
import { AXE_HOME } from "../core/thread.ts"

export type Route = {
	provider: string
	model: string
	maxTokens: number
	thinkingBudget?: number
}

/**
 * Effort is the only knob the user turns. Which model serves an effort tier is
 * an implementation detail that changes every few weeks.
 */
const DEFAULTS: Record<Effort, Route> = {
	low: { provider: "anthropic", model: "claude-haiku-4-5", maxTokens: 8_000 },
	medium: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 16_000 },
	high: {
		provider: "anthropic",
		model: "claude-sonnet-5",
		maxTokens: 32_000,
		thinkingBudget: 16_000,
	},
	ultra: {
		provider: "anthropic",
		model: "claude-opus-5",
		maxTokens: 32_000,
		thinkingBudget: 32_000,
	},
}

/** Internal roles that must never be user-selectable. */
const ROLES: Record<string, Route> = {
	compact: { provider: "anthropic", model: "claude-haiku-4-5", maxTokens: 8_000 },
	title: { provider: "anthropic", model: "claude-haiku-4-5", maxTokens: 200 },
	search: { provider: "anthropic", model: "claude-haiku-4-5", maxTokens: 8_000 },
	// A search subagent reads a lot and writes a little, so it gets the mid tier.
	subagent: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 16_000 },
	// The oracle is the expensive one on purpose. It is asked, not used.
	oracle: {
		provider: "anthropic",
		model: "claude-opus-5",
		maxTokens: 32_000,
		thinkingBudget: 32_000,
	},
}

function overrides(): Record<string, any> {
	try {
		return parseToml(readFileSync(join(AXE_HOME, "models.toml"), "utf8"))
	} catch {
		return {}
	}
}

export function routeFor(effort: Effort, _cfg: Config): Route {
	const over = overrides()[effort]
	return over ? { ...DEFAULTS[effort], ...over } : DEFAULTS[effort]
}

export function routeForRole(role: keyof typeof ROLES): Route {
	const over = overrides()[role]
	return over ? { ...ROLES[role]!, ...over } : ROLES[role]!
}

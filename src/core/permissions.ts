export type PermAction = "allow" | "deny" | "ask"

export const PERM_ACTIONS: PermAction[] = ["allow", "deny", "ask"]

export type PermRule = {
	tool: string
	action: PermAction
	/** Absent matches every call to the tool. */
	pattern?: string
	scope: "trusted" | "project"
}

export type PermDecision =
	| { action: "allow" }
	| { action: "deny"; reason: string }
	| { action: "ask"; rule: PermRule }

/**
 * The part of a call a rule is written against. There is one per tool because a
 * rule says "bash deny rm *", not "bash deny cmd rm *": the field is an
 * implementation detail of the tool and nobody writing a rule should have to
 * know it.
 */
const SUBJECT_KEYS = ["cmd", "path", "pattern", "url", "query"]

export function subject(input: unknown): string | null {
	if (!input || typeof input !== "object") return null
	const rec = input as Record<string, unknown>
	for (const key of SUBJECT_KEYS) {
		const v = rec[key]
		if (typeof v === "string") return v
	}
	return null
}

/**
 * `*` matches anything, including a slash. A path rule is nearly always meant to
 * cover a tree — `/etc/*` that missed `/etc/ssh/key` would be a trap — and a
 * bash rule has to survive an argument that is itself a path.
 */
function matches(pattern: string, value: string): boolean {
	const re = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")
	return new RegExp(`^${re}$`).test(value)
}

/** `<tool> <action> [pattern]`. Returns null for a line that is not a rule. */
export function parsePermLine(line: string, scope: PermRule["scope"]): PermRule | null {
	const trimmed = line.trim()
	if (!trimmed) return null
	const [tool, action, ...rest] = trimmed.split(/\s+/)
	if (!tool || !action) return null
	if (!PERM_ACTIONS.includes(action as PermAction)) return null
	const pattern = rest.join(" ")
	return { tool, action: action as PermAction, pattern: pattern || undefined, scope }
}

export function formatPermRule(r: PermRule): string {
	return `${r.tool} ${r.action}${r.pattern ? ` ${r.pattern}` : ""}`
}

function applies(rule: PermRule, tool: string, input: unknown): boolean {
	if (rule.tool !== tool && rule.tool !== "*") return false
	if (!rule.pattern || rule.pattern === "*") return true
	const value = subject(input)
	// A rule with a pattern is about a specific call. A tool whose input has no
	// subject to compare cannot be the call that rule meant.
	return value !== null && matches(rule.pattern, value)
}

/**
 * No rules means allow: permissions are off until someone writes one, which is
 * the same bargain Amp makes. Every rule is checked rather than the first match
 * winning, because a deny has to survive an allow written above it — otherwise a
 * broad `bash allow *` in the personal config would quietly void every narrow
 * deny a project added underneath.
 */
export function checkPermission(rules: PermRule[], tool: string, input: unknown): PermDecision {
	let ask: PermRule | undefined
	for (const rule of rules) {
		if (!applies(rule, tool, input)) continue
		if (rule.action === "deny") {
			return { action: "deny", reason: `Blocked by permission rule: ${formatPermRule(rule)}` }
		}
		if (rule.action === "ask") ask ??= rule
	}
	return ask ? { action: "ask", rule: ask } : { action: "allow" }
}

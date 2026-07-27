// Check discovery and the review fan-out. The provider is fake; the git repo,
// the gate, and the verdict parsing are real.
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clampDiff, discoverChecks, parseCheck, reviewPrompt, runReview, workingDiffForFiles } from "../src/review.ts"
import type { Provider, StreamEvent, StreamOptions } from "../src/providers/types.ts"

let failures = 0
function check(label: string, ok: boolean, detail = "") {
	if (!ok) failures++
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`)
}

const plain = parseCheck("todo", "No TODO comments in committed code.")
check("a check without frontmatter defaults to medium", plain.severity === "medium")
check("and keeps its body", plain.body === "No TODO comments in committed code.")

const fancy = parseCheck("secrets", "---\nseverity: critical\n---\nNo hardcoded secrets.")
check("frontmatter severity is read", fancy.severity === "critical")
check("and stripped from the body", fancy.body === "No hardcoded secrets.")
check("an unknown severity falls back", parseCheck("x", "---\nseverity: fatal\n---\nbody").severity === "medium")

const long = clampDiff("a".repeat(100_000))
check("a huge diff is clamped", long.length < 90_000 && long.includes("omitted"))

const prompt = reviewPrompt(fancy, "the-diff")
check("the prompt carries the check and the diff", prompt.includes("No hardcoded secrets.") && prompt.includes("the-diff"))

// A real repo with one modified file, so `git diff HEAD` has something to say.
const repo = await mkdtemp(join(tmpdir(), "axe-review-"))
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
g("init", "-q")
g("config", "user.email", "t@t")
g("config", "user.name", "t")
await writeFile(join(repo, "app.ts"), "export const a = 1\n")
g("add", ".")
g("commit", "-qm", "base")
await writeFile(join(repo, "app.ts"), "export const a = 1\nconst apiKey = 'sk-live'\n")
const magic = ":(glob)*.ts"
await writeFile(join(repo, magic), "literal base\n")
g("--literal-pathspecs", "add", "--", magic)
g("commit", "-qm", "literal path")
await writeFile(join(repo, magic), "literal changed\n")
const literalDiff = await workingDiffForFiles(repo, [magic])
check("turn review treats filenames as literal git pathspecs", literalDiff.includes("literal changed") && !literalDiff.includes("sk-live"), literalDiff)

check("no checks dir means no checks", (await discoverChecks(repo)).length === 0)
await mkdir(join(repo, ".axe", "checks"), { recursive: true })
await writeFile(join(repo, ".axe", "checks", "b-secrets.md"), "---\nseverity: critical\n---\nNo hardcoded secrets.")
await writeFile(join(repo, ".axe", "checks", "a-todo.md"), "No TODO comments.")
await writeFile(join(repo, ".axe", "checks", "empty.md"), "---\nseverity: low\n---\n")
const found = await discoverChecks(repo)
check(
	"checks are discovered in name order and empty ones dropped",
	found.length === 2 && found[0]!.name === "a-todo" && found[1]!.name === "b-secrets",
	found.map((c) => c.name).join(", "),
)

/** Passes the todo check, convicts the secrets check, no tool calls. */
function fakeProvider(): Provider {
	return {
		name: "fake",
		contextWindow: () => 200_000,
		countTokens: async () => 1,
		async *stream(opts: StreamOptions): AsyncIterable<StreamEvent> {
			const user = JSON.stringify(opts.messages)
			const text = user.includes("No hardcoded secrets.")
				? "app.ts:2 hardcodes an API key."
				: "OK\nNothing to report."
			yield {
				type: "done",
				stop: "end_turn",
				message: { role: "assistant", content: [{ type: "text", text }] },
				usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, costUsd: 0.001 },
			}
		},
	}
}

let out = ""
const result = await runReview({
	cwd: repo,
	provider: fakeProvider(),
	model: "fake-model",
	maxTokens: 1_000,
	limit: 2,
	write: (s) => (out += s),
})
check("a check with findings fails the review", result.failed === 1, out)
check("the passing check stays quiet", out.includes("a-todo (medium) · ok") && !out.includes("Nothing to report"), out)
check("the failing check prints its findings", out.includes("b-secrets (critical) · findings") && out.includes("app.ts:2"), out)
check("the tally counts both", out.includes("1/2 checks passed"), out)
check("subagent usage is rolled up", result.usage.costUsd > 0.0019, String(result.usage.costUsd))

console.log(failures === 0 ? "\nall green" : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

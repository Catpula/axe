/**
 * Slash commands: parsing, expansion, discovery, and the `axe commands` listing.
 *
 * Real files in a temp directory, no mocks. HOME is set before the import,
 * because discovery reads it for the personal directory.
 */
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), "axe-commands-"))
const home = join(root, "home")
const project = join(root, "project")
process.env.HOME = home

const { discoverCommands, expandCommand, parseCommandLine, stripFrontmatter } = await import(
	"../src/core/commands.ts"
)

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

// Parsing the line.
check("splits name from arguments", parseCommandLine("/deploy staging now")?.args === "staging now")
check("bare name has empty arguments", parseCommandLine("/deploy")?.args === "")
check("name is slugged", parseCommandLine("/Deploy_Prod")?.name === "deploy-prod")
check("keeps a multi-line argument", parseCommandLine("/fix a\nb")?.args === "a\nb")
check("plain text is not a command", parseCommandLine("deploy staging") === null)
check("a path is not a command", parseCommandLine("/usr/bin/env") === null, "leading slash path")
check("no name is not a command", parseCommandLine("/ ") === null)
check("a comment is not a command", parseCommandLine("// nope") === null)

// Stripping frontmatter.
check("drops the frontmatter block", stripFrontmatter("---\na: b\n---\nBODY").trim() === "BODY")
check("no frontmatter is returned whole", stripFrontmatter("BODY") === "BODY")
check(
	"an unterminated fence is body",
	stripFrontmatter("---\na: b\nBODY").includes("BODY"),
	"no closing fence means no frontmatter",
)

// Expansion.
check("$ARGUMENTS takes the whole tail", expandCommand("Fix $ARGUMENTS.", "the login bug") === "Fix the login bug.")
check("positionals are words", expandCommand("$1 then $2", "one two") === "one then two")
check("a missing positional is empty", expandCommand("[$2]", "one") === "[]")
check(
	"no placeholder appends the arguments",
	expandCommand("Review the diff.", "src/cli.ts") === "Review the diff.\n\nsrc/cli.ts",
)
check("no placeholder and no arguments is the body", expandCommand("Review the diff.", "") === "Review the diff.")
check("$ARGUMENTS with nothing typed is empty", expandCommand("Fix $ARGUMENTS", "") === "Fix ")
check(
	"substitution is one pass",
	expandCommand("$1", "$ARGUMENTS") === "$ARGUMENTS",
	"an argument is text, not a placeholder",
)
check("$ARGUMENTS repeats", expandCommand("$ARGUMENTS / $ARGUMENTS", "x") === "x / x")
check("$0 is literal", expandCommand("Keep $0", "x") === "Keep $0\n\nx")
check("$10 is literal", expandCommand("Keep $10", "x") === "Keep $10\n\nx")
check("a money amount is literal", expandCommand("Budget $100", "x") === "Budget $100\n\nx")
check(
	"a longer variable name is literal",
	expandCommand("Keep $ARGUMENTS_EXTRA", "x") === "Keep $ARGUMENTS_EXTRA\n\nx",
)

// Discovery.
const personalDir = join(home, ".agents", "commands")
const projectDir = join(project, ".agents", "commands")
await mkdir(projectDir, { recursive: true })
await mkdir(personalDir, { recursive: true })
await mkdir(join(projectDir, "nested"), { recursive: true })

await writeFile(join(personalDir, "commit.md"), "---\ndescription: my commit style\n---\nWrite a commit.")
await writeFile(join(personalDir, "deploy.md"), "---\ndescription: personal\n---\nOLD")
await writeFile(join(projectDir, "deploy.md"), "---\ndescription: project deploy\n---\nNEW $ARGUMENTS")
await writeFile(join(projectDir, "Ship It.md"), "Ship it.")
await writeFile(join(projectDir, "empty.md"), "---\ndescription: nothing below\n---\n\n")
await writeFile(join(projectDir, "README.md"), "not a command")
await writeFile(join(projectDir, "notes.txt"), "not markdown")
await writeFile(join(projectDir, "nested", "deep.md"), "should be ignored")

const found = await discoverCommands(project)
const names = found.map((c) => c.name)
check("finds personal and project", names.includes("commit") && names.includes("deploy"), names.join(","))
check("project wins the name", found.find((c) => c.name === "deploy")?.description === "project deploy")
check("filename is slugged into a name", names.includes("ship-it"), names.join(","))
check("a description is optional", found.find((c) => c.name === "ship-it")?.template === "Ship it.")
check("skips an empty body", !names.includes("empty"), names.join(","))
check("skips README", !names.includes("readme"))
check("skips non-markdown", !names.includes("notes"))
check("does not recurse", !names.includes("deep"))
check("sorted by name", names.join(",") === [...names].sort().join(","), names.join(","))
check("scope is reported", found.find((c) => c.name === "commit")?.scope === "personal")
// A directory with no .agents/commands still sees the personal ones: they follow
// the user, not the checkout.
const elsewhere = await discoverCommands(join(root, "nope"))
check(
	"a missing project directory is not an error",
	elsewhere.map((c) => c.name).join(",") === "commit,deploy",
	elsewhere.map((c) => c.name).join(","),
)
check("personal deploy is unshadowed there", elsewhere.find((c) => c.name === "deploy")?.template === "OLD")

// Two filenames can slug to one name. Which file wins must not depend on the
// order readdir happened to return, because that varies by filesystem: the same
// checkout would answer `/ship-it` differently on ext4 and on APFS.
//
// Honest about its reach: ext4 hands back names already in sorted order, so on
// Linux these pass with or without the sort in fromRoot. What they do catch is a
// filesystem that does not — and a future change that picks the winner some
// other way, such as first-wins or readdir order restored.
await writeFile(join(projectDir, "ship-it.md"), "HYPHEN BODY")
const collided = await discoverCommands(project)
check(
	"a slug collision yields one command",
	collided.filter((c) => c.name === "ship-it").length === 1,
	collided.map((c) => c.name).join(","),
)
const again = await discoverCommands(project)
check(
	"and the same file wins every time",
	collided.find((c) => c.name === "ship-it")?.path === again.find((c) => c.name === "ship-it")?.path,
)
check(
	"the last filename in sorted order wins",
	collided.find((c) => c.name === "ship-it")?.template === "HYPHEN BODY",
	collided.find((c) => c.name === "ship-it")?.path,
)

// End to end: the listing subcommand, run as a real process.
function runAxe(args: string[], cwd: string, withHome = home): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", join(repo, "src", "cli.ts"), ...args],
			{
				cwd,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: withHome,
					AXE_HOME: join(withHome, ".axe"),
					NODE_NO_WARNINGS: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		)
		let stdout = ""
		child.stdout.setEncoding("utf8")
		child.stdout.on("data", (d: string) => (stdout += d))
		child.stdin.end("")
		const kill = setTimeout(() => child.kill("SIGKILL"), 60_000)
		child.on("close", (code) => {
			clearTimeout(kill)
			resolve({ code: code ?? -1, stdout })
		})
	})
}

const listed = await runAxe(["commands"], project)
check("axe commands exits 0", listed.code === 0, `code ${listed.code}`)
check("lists a command with its scope", /\/deploy\s+project\s+project deploy/.test(listed.stdout), listed.stdout)
check("lists the personal one too", listed.stdout.includes("/commit"), listed.stdout)

// A clean HOME as well as a clean directory: a personal command is visible
// from every cwd, so an empty listing needs both to be empty.
const emptyDir = join(root, "bare")
const emptyHome = join(root, "bare-home")
await mkdir(emptyDir, { recursive: true })
await mkdir(emptyHome, { recursive: true })
const none = await runAxe(["commands"], emptyDir, emptyHome)
check("says where to put one when there are none", none.stdout.includes(".agents/commands/"), none.stdout)
check("no commands is not a failure", none.code === 0, `code ${none.code}`)

const help = await runAxe(["help"], emptyDir)
check("help names the subcommand", /\n\s+commands\s+/.test(help.stdout), "missing from HELP")

console.log(`${checks - failed}/${checks} commands checks passed`)
if (failed) process.exit(1)

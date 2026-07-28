/**
 * The parser, called directly. `cli-test` spawns a real child process because
 * an exit code is the behaviour it checks, which costs a process per case and
 * so can only cover a handful. This walks the whole flag table in-process.
 */
import { parseArgs, COMMAND_WORDS } from "../src/args.ts"

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

function throws(name: string, argv: string[], needle: string): void {
	try {
		parseArgs(argv)
		check(name, false, "did not throw")
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		check(name, msg.includes(needle), msg)
	}
}

// A bare run is a REPL: no command, no prompt, nothing implied.
const bare = parseArgs([])
check("a bare argv asks for nothing", !bare.command && !bare.prompt && !bare.execute)
check("and is not help", !bare.help)

// Help is scanned before the loop, so it must win from anywhere on the line,
// including behind a command that otherwise swallows the rest of the argv.
for (const argv of [["-h"], ["--help"], ["tools", "--help"], ["-x", "hi", "--help"], ["--effort", "low", "-h"]]) {
	check(`help wins in ${argv.join(" ")}`, parseArgs(argv).help)
}
check("help does not invent a prompt", parseArgs(["hi", "--help"]).prompt === undefined)

// Every command word must parse as a command rather than as a prompt, or the
// model is paid to read a word that was meant for axe.
for (const word of COMMAND_WORDS) {
	const argv = word === "tools" ? [word, "show", "read_file"] : word === "skill" ? [word, "add", "a/b"] : [word]
	check(`${word} parses as a command`, parseArgs(argv).command === word, JSON.stringify(parseArgs(argv)))
	check(`and never as a prompt`, parseArgs(argv).prompt === undefined)
}

// The flags, one by one.
check("-x sets execute", parseArgs(["-x", "hi"]).execute)
check("--execute sets execute", parseArgs(["--execute", "hi"]).execute)
check("-x keeps the prompt", parseArgs(["-x", "hi"]).prompt === "hi")
check("a multi-word prompt is rejoined", parseArgs(["why", "is", "it", "slow"]).prompt === "why is it slow")
check("--fast is effort low", parseArgs(["--fast"]).effort === "low")
check("--effort takes its tier", parseArgs(["--effort", "ultra"]).effort === "ultra")
check("--plain sets plain", parseArgs(["--plain"]).plain)
check("--no-plugins sets it", parseArgs(["--no-plugins"]).noPlugins)
check("--stream-json sets it", parseArgs(["--stream-json", "hi"]).streamJson)
check("--stream-json-input sets it", parseArgs(["--stream-json-input"]).streamJsonInput)
check("--stream-json-thinking sets it", parseArgs(["--stream-json-thinking"]).streamJsonThinking)
check("--check sets it", parseArgs(["update", "--check"]).check)
check("-v sets version", parseArgs(["-v"]).version)
check("-l takes a label", parseArgs(["-l", "nightly", "-x", "hi"]).label === "nightly")
check("--plugin-ready-timeout is a number", parseArgs(["--plugin-ready-timeout", "500"]).pluginReadyTimeoutMs === 500)

// --continue takes an id only when the next token is shaped like one. A prompt
// after a bare --continue is still a prompt, or resuming would eat it.
const resume = parseArgs(["--continue", "2020-01-01T00-00-00-000Z-abcde", "hi"])
check("--continue takes a thread id", resume.threadId === "2020-01-01T00-00-00-000Z-abcde")
check("and the prompt survives it", resume.prompt === "hi")
const bareResume = parseArgs(["--continue", "hi"])
check("a bare --continue continues", bareResume.continueThread)
check("and keeps the prompt as a prompt", bareResume.prompt === "hi" && bareResume.threadId === undefined)

// Errors. A flag that matches nothing must never reach the model as prose.
throws("a typo'd flag throws", ["--strem-json"], "--strem-json")
throws("and so does a short one", ["-q"], "-q")
throws("an unknown effort lists the tiers", ["--effort", "turbo"], "ultra")
throws("--effort with no value throws", ["--effort"], "ultra")
throws("--label with no value throws", ["-l"], "--label")
throws("--plugin-ready-timeout rejects zero", ["--plugin-ready-timeout", "0"], "positive")
throws("and rejects a non-number", ["--plugin-ready-timeout", "abc"], "positive")

// A command that takes no arguments must say so rather than doing the bare
// thing and reporting success.
throws("threads rejects a stray word", ["threads", "extra"], "no arguments")
throws("skills rejects one too", ["skills", "foo"], "no arguments")
throws("auth rejects one too", ["auth", "bogus"], "no arguments")
check("but update --check is not a stray word", parseArgs(["update", "--check"]).check)

// The commands whose positionals are the point must keep collecting them.
check("tools keeps its positionals", parseArgs(["tools", "show", "read_file"]).commandArgs.join(" ") === "show read_file")
check("skill keeps its source", parseArgs(["skill", "add", "o/r"]).commandArgs.join(" ") === "add o/r")
check("tools swallows the rest of the line", parseArgs(["tools", "--anything"]).commandArgs.join(" ") === "--anything")
check("mcp reads its subcommand as a prompt", parseArgs(["mcp", "approve", "x"]).prompt === "approve x")
check(
	"permissions keeps its test arguments",
	parseArgs(["permissions", "test", "bash", '{"cmd":"npm test"}']).prompt === 'test bash {"cmd":"npm test"}',
)

// A schedule's prompt is its own positional: joining it into args.prompt would
// send it to the model instead of storing it, and quoting it would be lost.
const sched = parseArgs(["schedule", "add", "0 9 * * *", "check the build"])
check("schedule keeps its when and prompt apart", sched.commandArgs.length === 3, JSON.stringify(sched.commandArgs))
check("and the when survives its spaces", sched.commandArgs[1] === "0 9 * * *")
check("and the prompt is not a prompt", sched.prompt === undefined)
check("schedule swallows the rest of the line", parseArgs(["schedule", "run", "-x"]).commandArgs.join(" ") === "run -x")
throws("schedules rejects a stray word", ["schedules", "extra"], "no arguments")

console.log(`args: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

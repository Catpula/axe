/**
 * The command line, decoded. Nothing here touches a file, a provider, or the
 * terminal: given an argv it returns what the user asked for, or throws. That
 * is the whole point of it being its own file — `cli-test` has to spawn a child
 * process to observe an exit code, which is slow and can only ever check the
 * cases someone thought to spawn. This is a pure function, so the table of
 * flags can be walked directly.
 */
import { EFFORTS, type Effort } from "./config.ts"

export type Args = {
	prompt?: string
	execute: boolean
	continueThread: boolean
	/** A specific thread to resume; unset means the newest one in this cwd. */
	threadId?: string
	effort?: Effort
	command?: string
	/** Positional args after `tools`/`skill`, e.g. `["show", "read_file"]`. */
	commandArgs: string[]
	/** NDJSON on stdout, one event per line. Implies one-shot. */
	streamJson: boolean
	/** Plain line-based REPL instead of the scroll-region UI. */
	plain: boolean
	noPlugins: boolean
	/** Writes a JSONL trace of the stream, tool lifecycle and retries to a file. */
	debug: boolean
	/** `axe update --check`: report a newer release, write nothing. */
	check: boolean
	version: boolean
	/** Gates `thinking` events on --stream-json; off by default like the TUI's dim text. */
	streamJsonThinking: boolean
	/** Reads `{"type":"user","text":...}` lines from stdin, one turn each. */
	streamJsonInput: boolean
	help: boolean
	/** Shown next to the thread id; purely a label, never parsed back. */
	label?: string
	pluginReadyTimeoutMs?: number
}

/** Commands that take positionals of their own, so a stray word is theirs to judge. */
const WITH_ARGS = new Set(["tools", "skill", "mcp", "schedule"])

/** Commands whose whole input is the word itself. `update` takes only `--check`. */
const ARGLESS = new Set(["threads", "skills", "auth", "permissions", "review", "update", "version", "help", "cost", "schedules", "doctor"])

const COMMANDS = new Set([...WITH_ARGS, ...ARGLESS])

/** Every command word, for the help page and for anything that lists them. */
export const COMMAND_WORDS: readonly string[] = [...COMMANDS].sort()

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		execute: false,
		continueThread: false,
		commandArgs: [],
		streamJson: false,
		plain: false,
		noPlugins: false,
		debug: false,
		check: false,
		version: false,
		streamJsonThinking: false,
		streamJsonInput: false,
		help: false,
	}
	// Scanned ahead of everything else so `axe tools --help` and a bare `-h`
	// reach the same page: `tools` and `skill` otherwise swallow the rest of the
	// line, and asking for help must never depend on argument order.
	if (argv.some((a) => a === "-h" || a === "--help")) {
		args.help = true
		return args
	}
	const rest: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!
		// `tools`, `skill` and `schedule` own the rest of the line: none takes a
		// prompt or the session flags, so there is nothing left to parse once one is
		// seen. A schedule's own prompt is a positional of its own, and it must
		// survive verbatim rather than being joined into `args.prompt`.
		if (a === "tools" || a === "skill" || a === "schedule") {
			args.command = a
			args.commandArgs = argv.slice(i + 1)
			return args
		}
		if (a === "-x" || a === "--execute") args.execute = true
		else if (a === "--stream-json") args.streamJson = true
		else if (a === "--continue" || a === "-c") {
			args.continueThread = true
			// Only a token shaped like a thread id is taken as one, so a prompt
			// after a bare --continue is still a prompt.
			const next = argv[i + 1]
			if (next && /^\d{4}-\d{2}-\d{2}T[\dA-Za-z-]+$/.test(next)) args.threadId = argv[++i]
		}
		else if (a === "--plain") args.plain = true
		else if (a === "--no-plugins") args.noPlugins = true
		else if (a === "--debug") args.debug = true
		else if (a === "--check") args.check = true
		else if (a === "--version" || a === "-v") args.version = true
		else if (a === "--fast") args.effort = "low"
		else if (a === "--stream-json-thinking") args.streamJsonThinking = true
		else if (a === "--stream-json-input") args.streamJsonInput = true
		else if (a === "-l" || a === "--label") {
			const value = argv[++i]
			if (!value) throw new Error("--label needs a value.")
			args.label = value
		} else if (a === "--plugin-ready-timeout") {
			const value = argv[++i]
			const ms = value ? Number(value) : Number.NaN
			if (!value || !Number.isFinite(ms) || ms <= 0) {
				throw new Error("--plugin-ready-timeout needs a positive number of ms.")
			}
			args.pluginReadyTimeoutMs = ms
		} else if (a === "--effort") {
			const value = argv[++i]
			if (!value || !EFFORTS.includes(value as Effort)) {
				throw new Error(`--effort takes one of ${EFFORTS.join(", ")}.`)
			}
			args.effort = value as Effort
		} else if (COMMANDS.has(a) && !args.command) args.command = a
		// A mistyped flag joined the prompt and was sent to the model, which paid
		// for it and could not act on it.
		else if (a.startsWith("-")) throw new Error(`Unknown flag ${a}.`)
		else rest.push(a)
	}
	if (rest.length) args.prompt = rest.join(" ")
	// A command that takes no arguments used to ignore whatever followed it, so
	// `axe threads --json` and `axe skills foo` did the bare thing and reported
	// success. That is the same failure a mistyped flag already errors on: the
	// user asked for something and got something else, quietly.
	if (args.command && ARGLESS.has(args.command) && rest.length) {
		throw new Error(`${args.command} takes no arguments, got ${rest.join(" ")}.`)
	}
	return args
}

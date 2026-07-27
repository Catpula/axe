/** A throwaway terminal emulator, just enough to catch smearing and ghost rows. */
import { EventEmitter } from "node:events"

class Screen {
	rows: string[][]
	top = 1
	bot: number
	cy = 1
	cx = 1
	h: number
	w: number
	constructor(h: number, w: number) {
		this.h = h
		this.w = w
		this.bot = h
		this.rows = Array.from({ length: h }, () => Array(w).fill(" "))
	}
	scroll() {
		this.rows.splice(this.top - 1, 1)
		this.rows.splice(this.bot - 1, 0, Array(this.w).fill(" "))
	}
	put(ch: string) {
		if (this.cx > this.w) {
			this.cx = 1
			this.nl()
		}
		this.rows[this.cy - 1]![this.cx - 1] = ch
		this.cx++
	}
	nl() {
		if (this.cy === this.bot) this.scroll()
		else if (this.cy < this.h) this.cy++
	}
	write(s: string) {
		for (let i = 0; i < s.length; i++) {
			const c = s[i]!
			if (c === "\x1b") {
				const m = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(s.slice(i))
				if (!m) {
					i++
					continue
				}
				i += m[0].length - 1
				const args = m[1]!.split(";").filter((x) => x !== "")
				const n = (k: number, d = 1) => Number(args[k] ?? d)
				switch (m[2]) {
					case "H":
						this.cy = Math.min(this.h, Math.max(1, n(0)))
						this.cx = Math.min(this.w, Math.max(1, n(1)))
						break
					case "r":
						this.top = args.length ? n(0) : 1
						this.bot = args.length ? n(1, this.h) : this.h
						break
					case "K":
						if (n(0, 0) === 2 || args.length === 0)
							for (let x = m[1] === "2" ? 0 : this.cx - 1; x < this.w; x++)
								this.rows[this.cy - 1]![x] = " "
						break
					case "J": {
						// 0 (the default) clears from the cursor down, 2 the whole screen.
						const mode = n(0, 0)
						const from = mode === 2 ? 0 : this.cy - 1
						if (mode !== 2) for (let x = this.cx - 1; x < this.w; x++) this.rows[from]![x] = " "
						for (let y = mode === 2 ? 0 : from + 1; y < this.h; y++)
							this.rows[y] = Array(this.w).fill(" ")
						break
					}
					case "A":
						this.cy = Math.max(1, this.cy - n(0))
						break
					case "B":
						this.cy = Math.min(this.h, this.cy + n(0))
						break
					case "G":
						this.cx = n(0)
						break
					default:
						break
				}
				continue
			}
			if (c === "\n") {
				this.nl()
				continue
			}
			if (c === "\r") {
				this.cx = 1
				continue
			}
			this.put(c)
		}
	}
	line(y: number) {
		return this.rows[y - 1]!.join("").replace(/\s+$/, "")
	}
	dump() {
		return this.rows.map((r) => r.join("").replace(/\s+$/, "")).join("\n")
	}
}

const screen = new Screen(24, 80)
const out = process.stdout as any
const inp = process.stdin as any
const real = out.write.bind(out)
const say = (s: string) => real(`${s}\n`)
out.write = (s: string) => {
	screen.write(String(s))
	return true
}
for (const [k, v] of [
	["rows", 24],
	["columns", 80],
	["isTTY", true],
] as const)
	Object.defineProperty(out, k, { value: v, configurable: true, writable: true })
Object.defineProperty(inp, "isTTY", { value: true, configurable: true, writable: true })
inp.setRawMode = () => inp

const { makeTui } = await import("../src/ui/tui.ts")

let checks = 0
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
	checks++
	if (ok) return
	failed++
	say(`FAIL ${name}${detail ? `\n${detail}` : ""}`)
}
const tick = () => new Promise((r) => setTimeout(r, 120))
const key = (s: string) => inp.emit("data", Buffer.from(s))
/** Rows above the idle status and one-row composer, where panels and lists live. */
const above = (n: number) =>
	Array.from({ length: n }, (_, i) => screen.line(screen.h - 2 - n + 1 + i))

let queued = 0
const tui = makeTui("model · $0.00", {
	files: async () => ["src/cli.ts", "src/ui/tui.ts"],
	queued: () => queued,
})
let slashRan = false
tui.setCommands([
	{ id: "cost", title: "Show cost so far", run: () => { slashRan = true } },
	{ id: "a", title: "Effort: low", group: "settings", run: () => {} },
	{ id: "b", title: "Effort: high", group: "settings", run: () => {} },
])
await tick()
check("an empty composer has a visible prompt", screen.line(24).includes("› Message axe…"), screen.dump())
key("x")
await tick()
check("typing replaces the placeholder", screen.line(24).startsWith("› x") && !screen.line(24).includes("Message axe"), screen.dump())
key("\x7f")

// Long and explicit multiline input grows upward, then gives every row back.
key("x".repeat(100))
await tick()
check("long input grows the composer", screen.line(23).startsWith("› xxx") && screen.line(24).startsWith("│ "), screen.dump())
check("the region makes room for the composer", screen.bot < 22, `${screen.bot}`)
key("\x1b[13;2u")
key("second line")
await tick()
check("shift enter creates another visible composer row", screen.line(24).includes("second line"), screen.dump())
for (let i = 0; i < 120; i++) key("\x7f")
await tick()
check("a cleared composer returns to one row", screen.bot === 22, `${screen.bot}`)
check("composer rows leave no ghost text", !screen.dump().includes("second line"), screen.dump())

// A panel appears while work runs, and takes rows above the bars.
tui.activityStart({ id: "t1", kind: "tool", name: "read_file", subject: "src/cli.ts" })
tui.activityStart({ id: "a1", kind: "agent", name: "search", subject: "where is AXE_HOME" })
tui.activityStart({ id: "a1/g", kind: "tool", name: "grep", subject: "AXE_HOME", parent: "a1" })
tui.setWorking(true)
await tick()
const panel = above(3)
check("the composer explains input during a turn", screen.line(24).includes("Type to steer the running turn…"), screen.dump())
check("the panel draws one row per activity", panel.filter((l) => l !== "").length === 3, screen.dump())
check("a child indents under its agent", (panel.find((l) => l.includes("grep")) ?? "").search(/\S/) > (panel.find((l) => l.includes("search")) ?? "x").search(/\S/), panel.join("\n"))
check("the scroll region stops above the panel", screen.bot === 24 - 2 - 3, `${screen.bot}`)

queued = 2
await tick()
check("queued input is visible while work continues", screen.line(23).includes("2 queued"), screen.dump())
queued = 0

// Ctrl+O outranks the panel, shows only settings, and gives the rows back.
key("\x0f")
await tick()
check("the palette takes over", above(7).some((l) => l.includes("Effort: low")), screen.dump())
check("settings mode hides plain commands", !screen.dump().includes("Show cost so far"), screen.dump())
key("\x1b")
await tick()
const back = above(3)
check("the panel returns after the palette", back.some((l) => l.includes("read_file")), screen.dump())
check("no palette row survives", !screen.dump().includes("Effort:"), screen.dump())

// `/` outranks the panel too, and shows only plain commands.
key("/")
await tick()
check("the slash picker takes over", above(7).some((l) => l.includes("/cost")), screen.dump())
check("settings stay out of the slash picker", !screen.dump().includes("Effort:"), screen.dump())
key("\x1b")
await tick()
check("the panel returns after the slash picker", above(3).some((l) => l.includes("read_file")), screen.dump())
check("no slash row survives", !screen.dump().includes("/cost"), screen.dump())
key("\x7f")
key("/cos")
await tick()
key("\r")
await tick()
check("enter runs the slash command", slashRan, screen.dump())
check("running a slash command clears the composer", !screen.line(24).includes("/cos"), screen.dump())
check("the run is echoed to the transcript", screen.dump().includes("› /cost"), screen.dump())

// `@` outranks the panel too.
key("@cli")
await tick()
check("the picker takes over", screen.dump().includes("src/cli.ts"), screen.dump())
key("\x1b")
await tick()
check("the panel returns after the picker", above(3).some((l) => l.includes("read_file")), screen.dump())
check("no picker row survives", !screen.dump().includes("src/ui/tui.ts"), screen.dump())
for (let i = 0; i < 4; i++) key("\x7f")
await tick()

// Shrinking the panel must clear the rows it no longer owns.
tui.activityEnd("a1/g", true)
tui.activityEnd("a1", true)
tui.activityEnd("t1", true)
await new Promise((r) => setTimeout(r, 1100))
tui.setWorking(false)
await tick()
check("a drained panel leaves nothing behind", above(4).every((l) => l === ""), screen.dump())
check("the scroll region is given back", screen.bot === 22, `${screen.bot}`)

// Completion is authoritative: a dropped or wrong streaming delta is replaced
// from the provider's completed message, not fossilised in the transcript.
tui.ui.text("wrong-streamed-answer\n")
tui.ui.textDone?.("right-final-answer\n")
await tick()
check("final text repairs the streamed transcript", screen.dump().includes("right-final-answer"), screen.dump())
check("reconciliation removes stale streamed text", !screen.dump().includes("wrong-streamed-answer"), screen.dump())

// A resize mid-turn redraws rather than smears.
tui.ui.text("transcript-marker\n")
tui.ui.textDone?.("transcript-marker\n")
tui.activityStart({ id: "t2", kind: "tool", name: "bash", subject: "npm test" })
tui.setWorking(true)
await tick()
check("the transcript is on screen before the resize", screen.dump().includes("transcript-marker"), screen.dump())
out.rows = 18
out.columns = 60
screen.h = 18
// A shrinking terminal pushes the top rows into scrollback and keeps the bottom
// ones, where the cursor is; it does not drop the rows under the cursor.
screen.rows = screen.rows.slice(-18).map((r) => r.slice(0, 60))
screen.w = 60
screen.cy = Math.max(1, Math.min(18, screen.cy - 6))
screen.bot = Math.min(screen.bot, 18)
out.emit("resize")
// The resize reconcile is debounced, so a drag redraws once rather than per event.
await new Promise((r) => setTimeout(r, 300))
check("a resize leaves no row wider than the screen", screen.rows.every((r) => r.length === 60))
check("the panel survives a resize", screen.dump().includes("bash"), screen.dump())
check("the region fits the smaller screen", screen.bot === 18 - 2 - 1, `${screen.bot}`)
// The whole point of the resize path: rows above the region are the terminal's
// to re-wrap, so wiping them is what made the conversation look like it jumped.
check("the transcript survives a resize", screen.dump().includes("transcript-marker"), screen.dump())
// The bars are drawn against the old geometry and the terminal re-wraps them
// like any other output, so a resize can strand a copy up in the transcript.
check("a resize strands no second panel row", screen.dump().split("bash").length - 1 === 1, screen.dump())
check("a resize strands no second status bar", screen.dump().split("Ctrl+C").length - 1 === 1, screen.dump())

const approval = (id: string, tool: string, subject: string) => ({
	id,
	tool,
	subject,
	cwd: "/tmp/project",
	rule: `${tool} ask *`,
})
key("kept-draft")
const firstApproval = tui.confirm(approval("toolu_1", "bash", "npm test"))
const secondApproval = tui.confirm(approval("toolu_2", "read_file", "secrets.txt"))
await tick()
check("approval shows the queue head and waiting count", screen.dump().includes("Allow bash? · 1 waiting"), screen.dump())
check("approval shows subject, cwd, rule, and correlation id", ["npm test", "/tmp/project", "bash ask *", "#toolu_1"].every((s) => screen.dump().includes(s)), screen.dump())
key("y")
await tick()
check("allowing the head reveals the next request", (await firstApproval).action === "allow-once" && screen.dump().includes("Allow read_file?"), screen.dump())
key("d")
key("contains secrets")
key("\r")
await tick()
const secondDecision = await secondApproval
check("denial editor returns its reason", secondDecision.action === "deny" && secondDecision.reason === "contains secrets")
check("denying one request does not affect queue order", !screen.dump().includes("Allow read_file?"), screen.dump())
check("denial editor leaves the draft composer unchanged", screen.dump().includes("kept-draft"), screen.dump())
for (let i = 0; i < "kept-draft".length; i++) key("\x7f")

key("draft-on-close")
await tick()
const abortApproval = tui.confirm(approval("toolu_3", "bash", "one"))
const queuedAbortApproval = tui.confirm(approval("toolu_4", "bash", "two"))
key("\x03")
await tick()
check("interrupt denies every pending approval", (await abortApproval).action === "deny" && (await queuedAbortApproval).action === "deny")
const closeApproval = tui.confirm(approval("toolu_5", "bash", "one"))
const queuedCloseApproval = tui.confirm(approval("toolu_6", "bash", "two"))
tui.close()
check("close denies every pending approval", (await closeApproval).action === "deny" && (await queuedCloseApproval).action === "deny")
check("close resets the scroll region", screen.top === 1 && screen.bot === screen.h, `${screen.top},${screen.bot}`)
check("close leaves no panel row", !screen.dump().includes("bash"), screen.dump())
check("close clears the composer and status", !screen.dump().includes("draft-on-close") && !screen.dump().includes("Ctrl+C"), screen.dump())

say(`screen: ${checks} checks`)
if (failed) process.exit(1)
say("all green")

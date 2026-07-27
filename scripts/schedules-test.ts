/**
 * Cron matching, due-ness and the store. The time logic is pure, so it is tested
 * against fixed dates rather than by waiting; the store is real files, because
 * AXE_HOME is the whole boundary and a temp directory moves it.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "axe-sched-home-"))
process.env.AXE_HOME = home

// AXE_HOME is read once at module load, so the import has to come after the env.
const { addSchedule, isDue, loadSchedules, matchesCron, parseWhen, removeSchedule, saveSchedules } =
	await import("../src/core/schedules.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

// Local time throughout, because that is what a user writing "0 9 * * *" means.
const at = (iso: string) => new Date(iso)

// A daily job is the common case and the one a wrong minute field breaks
// silently, by firing sixty times instead of once.
check("a daily cron matches its minute", matchesCron("0 9 * * *", at("2026-03-04T09:00:00")))
check("and not the next one", !matchesCron("0 9 * * *", at("2026-03-04T09:01:00")))
check("and not the next hour", !matchesCron("0 9 * * *", at("2026-03-04T10:00:00")))

check("a step matches on the step", matchesCron("*/15 * * * *", at("2026-03-04T09:30:00")))
check("a step misses between steps", !matchesCron("*/15 * * * *", at("2026-03-04T09:31:00")))
check("a range includes its ends", matchesCron("0 9 * * 1-5", at("2026-03-06T09:00:00")))
check("a range excludes the weekend", !matchesCron("0 9 * * 1-5", at("2026-03-07T09:00:00")))
check("a list matches each term", matchesCron("0 9,17 * * *", at("2026-03-04T17:00:00")))
check("a list matches nothing else", !matchesCron("0 9,17 * * *", at("2026-03-04T13:00:00")))
check("a month field restricts", !matchesCron("0 9 * 12 *", at("2026-03-04T09:00:00")))

// Day-of-month and day-of-week are an OR when both are restricted. Getting this
// wrong makes "the 1st or a Monday" fire only on a Monday the 1st.
check("dom or dow, dom side", matchesCron("0 9 1 * 5", at("2026-06-01T09:00:00")))
check("dom or dow, dow side", matchesCron("0 9 1 * 5", at("2026-06-05T09:00:00")))
check("dom or dow, neither", !matchesCron("0 9 1 * 5", at("2026-06-03T09:00:00")))

// Garbage must never match rather than throw: an unparseable expression sitting
// in the store would otherwise take down every sweep after it.
for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "9-2 * * * *", "*/0 * * * *", "abc"]) {
	check(`${JSON.stringify(bad)} matches nothing`, !matchesCron(bad, at("2026-03-04T09:00:00")))
	check(`${JSON.stringify(bad)} is unschedulable`, parseWhen(bad) === null)
}
check("a cron expression parses", parseWhen("0 9 * * 1-5")?.kind === "cron")

const every = parseWhen("every 10m")
check("an interval parses", every?.kind === "every")
check("and is in milliseconds", every?.kind === "every" && every.ms === 600_000)
check("hours parse", (() => { const p = parseWhen("every 2h"); return p?.kind === "every" && p.ms === 7_200_000 })())
check("days parse", (() => { const p = parseWhen("every 1d"); return p?.kind === "every" && p.ms === 86_400_000 })())
check("a zero interval is refused", parseWhen("every 0m") === null)
check("an unknown unit is refused", parseWhen("every 5w") === null)

const base = { id: "x", prompt: "p", cwd: "/tmp", threadId: "t", createdAt: "2026-03-04T00:00:00.000Z" }
const now = at("2026-03-04T09:05:00")

// Never run is due now. Waiting a full interval first would make `every 1d`
// silent for a day after the agent asked for it.
check("an interval never run is due", isDue({ ...base, when: "every 10m" }, now))
check(
	"an interval run recently is not",
	!isDue({ ...base, when: "every 10m", lastRun: at("2026-03-04T09:00:00").toISOString() }, now),
)
check(
	"an interval run long enough ago is",
	isDue({ ...base, when: "every 10m", lastRun: at("2026-03-04T08:54:00").toISOString() }, now),
)
check("an unparseable when is never due", !isDue({ ...base, when: "nonsense" }, now))

// The sweep is what makes a five-minute scheduler tick work at all: at 09:05 a
// 09:00 job has already passed, and only looking at this minute would miss it.
check(
	"a cron missed within the window still fires",
	isDue({ ...base, when: "0 9 * * *", lastRun: at("2026-03-04T08:35:00").toISOString() }, now),
)
check(
	"a cron already run this minute does not repeat",
	!isDue({ ...base, when: "0 9 * * *", lastRun: at("2026-03-04T09:00:00").toISOString() }, now),
)
check(
	"a cron older than the catch-up window is skipped",
	!isDue({ ...base, when: "0 9 * * *", lastRun: at("2026-03-03T09:00:00").toISOString() }, at("2026-03-04T11:30:00")),
)
check("a cron with nothing due stays quiet", !isDue({ ...base, when: "0 3 * * *" }, now))

// Store round-trip.
check("an empty store reads as empty", (await loadSchedules()).length === 0)
const added = await addSchedule({ when: "every 10m", prompt: "check the build", cwd: "/tmp", threadId: "t1" })
check("add returns an id", /^[0-9a-f]{8}$/.test(added.id), added.id)
check("add stamps createdAt", Boolean(Date.parse(added.createdAt)), added.createdAt)
const stored = await loadSchedules()
check("add persists", stored.length === 1 && stored[0]!.prompt === "check the build", JSON.stringify(stored))
check("remove reports a hit", await removeSchedule(added.id))
check("remove persists", (await loadSchedules()).length === 0)
check("remove reports a miss", !(await removeSchedule("deadbeef")))

let refused: unknown
try {
	await addSchedule({ when: "not a cron", prompt: "p", cwd: "/tmp", threadId: "t" })
} catch (err) {
	refused = err
}
check("an unschedulable when is refused", refused instanceof Error, String(refused))
let empty: unknown
try {
	await addSchedule({ when: "every 5m", prompt: "  ", cwd: "/tmp", threadId: "t" })
} catch (err) {
	empty = err
}
check("an empty prompt is refused", empty instanceof Error, String(empty))
check("and neither was stored", (await loadSchedules()).length === 0)

// A broken state file must not take down a session that only wanted to list.
writeFileSync(join(home, "schedules.json"), "{not json")
check("a corrupt store reads as empty", (await loadSchedules()).length === 0)
writeFileSync(join(home, "schedules.json"), '[{"id":"a"},{"id":"b","when":"every 5m","prompt":"p","cwd":"/tmp","threadId":"t","createdAt":"2026-01-01T00:00:00.000Z"}]')
const partial = await loadSchedules()
check("a half-written record is dropped", partial.length === 1 && partial[0]!.id === "b", JSON.stringify(partial))
await saveSchedules([])

console.log(`schedules: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

/**
 * Clipboard image reading. The runner is injected, since no CI box has
 * wl-paste, xclip, or pngpaste installed and none of them may be shelled out
 * to during a test run.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PATH_RE } from "../src/images.ts"

const { readClipboardImage } = await import("../src/clipboard.ts")

let checks = 0
let failed = 0
function check(name: string, ok: boolean, detail = ""): void {
	checks++
	if (ok) return
	failed++
	console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`)
}

const png = Buffer.from("89504e470d0a1a0a", "hex")

{
	const image = await readClipboardImage(() => png)
	check("first working reader wins", image !== null && image.mime === "image/png")
	check("bytes pass through untouched", image !== null && image.data.equals(png))
}

{
	let calls = 0
	const image = await readClipboardImage((cmd) => {
		calls++
		if (cmd !== "pngpaste") throw new Error("ENOENT")
		return png
	})
	check("falls through to the next reader on failure", calls === 3 && image !== null)
}

{
	const image = await readClipboardImage(() => {
		throw new Error("ENOENT")
	})
	check("no tool available returns null, not a throw", image === null)
}

{
	const image = await readClipboardImage(() => Buffer.alloc(0))
	check("an empty clipboard is treated as no image", image === null)
}

{
	const dir = await mkdtemp(join(tmpdir(), "axe-clipboard-"))
	const path = join(dir, "axe-paste-test.png")
	await writeFile(path, png)
	const match = path.match(PATH_RE)?.[0]
	check("a written clipboard path matches the attach pattern", match === path)
	check("and reads back the same bytes", (await readFile(path)).equals(png))
}

console.log(`clipboard: ${checks} checks`)
if (failed) {
	console.log(`${failed} failed`)
	process.exit(1)
}
console.log("all green")

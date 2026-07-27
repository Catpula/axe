/**
 * Builds one binary per published target and writes SHA256SUMS beside them.
 *
 * `axe update` refuses to install anything that is not listed in that file, so
 * this script is the only supported way to produce a release: a hand-uploaded
 * asset with no checksum line cannot be installed.
 *
 * Needs bun. Cross-compiling from any host is bun's job.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECKSUM_FILE, TARGETS } from "../src/release/update.ts"
import { VERSION } from "../src/version.ts"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, "dist")

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
if (pkg.version !== VERSION) {
	console.error(`package.json is ${pkg.version} but src/version.ts is ${VERSION}.`)
	process.exit(1)
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const targets = Object.entries(TARGETS).filter(([key]) => !only.length || only.includes(key))
if (!targets.length) {
	console.error(`Unknown target. Known: ${Object.keys(TARGETS).join(", ")}`)
	process.exit(1)
}

// spawnSync reports null, not a number, when bun is not installed at all.
if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) {
	console.error("bun is required to build a release binary.")
	process.exit(1)
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

for (const [key, bunTarget] of targets) {
	const name = `axe-${key}`
	console.log(`building ${name}`)
	const out = spawnSync(
		"bun",
		[
			"build",
			"--compile",
			"--minify",
			`--target=${bunTarget}`,
			join(root, "src", "cli.ts"),
			"--outfile",
			join(dist, name),
		],
		{ stdio: "inherit", cwd: root },
	)
	if (out.status !== 0) {
		console.error(`bun build failed for ${key}.`)
		process.exit(1)
	}
}

const lines: string[] = []
for (const file of readdirSync(dist).sort()) {
	if (file === CHECKSUM_FILE) continue
	const hash = createHash("sha256").update(readFileSync(join(dist, file))).digest("hex")
	lines.push(`${hash}  ${file}`)
}
writeFileSync(join(dist, CHECKSUM_FILE), `${lines.join("\n")}\n`)

console.log(`\naxe ${VERSION}`)
for (const line of lines) console.log(line)
console.log(`\nUpload dist/* to the v${VERSION} release, ${CHECKSUM_FILE} included.`)

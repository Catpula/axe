/**
 * Line-level syntax highlighting for code blocks, with zero dependencies.
 *
 * One line in, the same line out with SGR runs added — never a changed
 * character, so every width calculation upstream stays honest, and everything
 * collapses to plain text under NO_COLOR. Per-line on purpose: the markdown
 * renderer streams, and a highlighter that needed the whole block would turn
 * streaming output back into buffered output.
 *
 * A language nobody recognises is left alone. Wrong colours teach the eye to
 * ignore all colours, which costs more than no colours at all.
 */
import { CYAN, DIM, GREEN, MAGENTA, RED, RESET } from "./color.ts"

type Family = {
	keywords: Set<string>
	/** Comment openers that run to the end of the line. */
	comments: string[]
}

const words = (list: string) => new Set(list.split(" "))

const JS: Family = {
	keywords: words(
		"abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of return satisfies static super switch this throw true try type typeof undefined var void while yield",
	),
	comments: ["//"],
}

const PYTHON: Family = {
	keywords: words(
		"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
	),
	comments: ["#"],
}

const SHELL: Family = {
	keywords: words(
		"case do done elif else esac exit export fi for function if in local read readonly return select then time until while",
	),
	comments: ["#"],
}

const GO: Family = {
	keywords: words(
		"break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
	),
	comments: ["//"],
}

const RUST: Family = {
	keywords: words(
		"as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
	),
	comments: ["//"],
}

const JSON_LANG: Family = {
	keywords: words("true false null"),
	comments: [],
}

const SQL: Family = {
	keywords: words(
		"AND AS ASC BY CREATE DELETE DESC DISTINCT DROP FROM GROUP HAVING IN INSERT INTO JOIN LEFT LIMIT NOT NULL ON OR ORDER RIGHT SELECT SET TABLE UPDATE VALUES WHERE and as asc by create delete desc distinct drop from group having in insert into join left limit not null on or order right select set table update values where",
	),
	comments: ["--"],
}

const FAMILIES: Record<string, Family> = {
	js: JS,
	jsx: JS,
	javascript: JS,
	ts: JS,
	tsx: JS,
	typescript: JS,
	mjs: JS,
	cjs: JS,
	java: JS,
	c: JS,
	cpp: JS,
	go: GO,
	rs: RUST,
	rust: RUST,
	py: PYTHON,
	python: PYTHON,
	rb: PYTHON,
	ruby: PYTHON,
	toml: PYTHON,
	yaml: PYTHON,
	yml: PYTHON,
	sh: SHELL,
	bash: SHELL,
	zsh: SHELL,
	shell: SHELL,
	json: JSON_LANG,
	sql: SQL,
}

/**
 * Unified diff hunks colour by their first character, which is the entire
 * grammar of a diff line. The whole line takes the colour: a `+` gutter next
 * to plain text makes the reader re-derive what the colour already said.
 */
export function highlightDiffLine(line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return `${DIM}${line}${RESET}`
	if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`
	if (line.startsWith("+")) return `${GREEN}${line}${RESET}`
	if (line.startsWith("-")) return `${RED}${line}${RESET}`
	return line
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y
const NUMBER = /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y

/**
 * One line of one language: strings green, comments dim, keywords magenta,
 * numbers cyan. Four colours is the ceiling on purpose — a block where every
 * token has a hue reads slower than one where nothing does.
 */
export function highlightCode(line: string, lang: string): string {
	const name = lang.trim().toLowerCase()
	if (name === "diff" || name === "patch") return highlightDiffLine(line)
	const family = FAMILIES[name]
	if (!family) return line
	let out = ""
	let i = 0
	while (i < line.length) {
		const c = line[i]!
		const comment = family.comments.find((open) => line.startsWith(open, i))
		if (comment) {
			out += `${DIM}${line.slice(i)}${RESET}`
			break
		}
		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1
			while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1
			const end = Math.min(line.length, j + 1)
			out += `${GREEN}${line.slice(i, end)}${RESET}`
			i = end
			continue
		}
		IDENT.lastIndex = i
		const ident = IDENT.exec(line)
		if (ident) {
			out += family.keywords.has(ident[0]) ? `${MAGENTA}${ident[0]}${RESET}` : ident[0]
			i += ident[0].length
			continue
		}
		NUMBER.lastIndex = i
		const number = NUMBER.exec(line)
		if (number) {
			out += `${CYAN}${number[0]}${RESET}`
			i += number[0].length
			continue
		}
		out += c
		i++
	}
	return out
}

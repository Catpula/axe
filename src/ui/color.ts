/**
 * One place that decides whether output is coloured.
 *
 * NO_COLOR is read once, at load. It was honoured by the TUI and ignored by
 * everything else, which meant `axe -x > out.txt` wrote escapes into the file
 * and `NO_COLOR=1` still coloured Markdown. Every surface imports from here so
 * there is exactly one answer.
 */

/** False when NO_COLOR is set to anything, per the no-color.org convention. */
export const COLOR = !process.env.NO_COLOR

const sgr = (code: string) => (COLOR ? `\x1b[${code}m` : "")

export const RESET = sgr("0")
export const BOLD = sgr("1")
export const DIM = sgr("2")
export const ITALIC = sgr("3")
export const UNDERLINE = sgr("4")
export const REVERSE = sgr("7")
export const RED = sgr("31")
export const GREEN = sgr("32")
export const YELLOW = sgr("33")
export const MAGENTA = sgr("35")
export const CYAN = sgr("36")
/**
 * Bright blue, not blue. Plain blue on a dark background is close enough to
 * black that a subagent row reads as unstyled on several common themes.
 */
export const BRIGHT_BLUE = sgr("94")

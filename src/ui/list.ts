/**
 * Selection and scrolling for every list the TUI draws.
 *
 * The palette, the `@` picker and the `/` picker all answer the same two
 * questions — which row is selected, and which window of rows is visible —
 * and each used to answer them inline. Pure functions, so the arithmetic is
 * tested by calling it rather than by reading escape codes off a screen.
 */

/** Wraps the selection around both ends. An empty list pins it at zero. */
export function moveIndex(index: number, delta: number, total: number): number {
	return total ? (index + delta + total) % total : 0
}

/**
 * The first visible row of a window `height` tall over `total` rows, chosen so
 * the selection stays on screen: the list scrolls only when the cursor would
 * otherwise leave it.
 */
export function scrollOffset(index: number, height: number, total: number): number {
	return Math.max(0, Math.min(index - height + 1, Math.max(0, total - height)))
}

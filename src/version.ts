/**
 * The version baked into the binary. A compiled binary has no package.json next
 * to it, so this constant is the only thing `axe update` can compare against.
 * `release-test` fails if it drifts from package.json.
 */
export const VERSION = "0.1.0"

/** Where `axe update` looks for releases. */
export const REPO = "Catpula/axe"

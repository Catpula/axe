import { execFileSync } from "node:child_process"

/** One clipboard image reader tried in order, until one produces bytes. */
const READERS: { cmd: string; args: string[] }[] = [
	{ cmd: "wl-paste", args: ["-t", "image/png"] },
	{ cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
	{ cmd: "pngpaste", args: ["-"] },
]

export type ClipboardRunner = (cmd: string, args: string[]) => Buffer

function defaultRun(cmd: string, args: string[]): Buffer {
	return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] })
}

/**
 * Reads a PNG from the clipboard via whichever of Wayland, X11, or macOS's
 * pastebin is installed. None of the three exist on every machine, and a
 * missing tool throws ENOENT rather than returning nothing, so each is tried
 * in turn and only an empty result after all three counts as "no image".
 */
export async function readClipboardImage(
	run: ClipboardRunner = defaultRun,
): Promise<{ mime: string; data: Buffer } | null> {
	for (const { cmd, args } of READERS) {
		try {
			const data = run(cmd, args)
			if (data.length > 0) return { mime: "image/png", data }
		} catch {
			// Tool missing, or clipboard holds no image: try the next reader.
		}
	}
	return null
}

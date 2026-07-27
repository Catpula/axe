import { providerKind, resolveApiKey, type Config } from "../config.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { GoogleProvider } from "./google.ts"
import { OpenAIProvider } from "./openai.ts"
import type { Provider } from "./types.ts"

/**
 * Endpoints for compatible providers worth naming, so `POOLSIDE_API_KEY` is the
 * whole setup. An unknown name still needs a baseUrl: guessing one would send a
 * key somewhere the user never named.
 */
const BASE_URLS: Record<string, string> = {
	poolside: "https://inference.poolside.ai/v1",
}

export function makeProvider(name: string, cfg: Config): Provider {
	const pc = cfg.providers[name] ?? {}
	const key = resolveApiKey(name, cfg)
	switch (providerKind(name, cfg)) {
		case "anthropic":
			return new AnthropicProvider(key, pc.baseUrl)
		case "openai":
			return new OpenAIProvider(key, {
				name,
				baseUrl: pc.baseUrl,
				contextWindow: pc.contextWindow,
			})
		case "google":
			return new GoogleProvider(key, {
				name,
				baseUrl: pc.baseUrl,
				contextWindow: pc.contextWindow,
			})
		case "openai-compatible": {
			const baseUrl = pc.baseUrl ?? BASE_URLS[name]
			if (!baseUrl) {
				throw new Error(`Set providers.${name}.baseUrl in ~/.axe/config.toml.`)
			}
			return new OpenAIProvider(key, {
				name,
				baseUrl,
				// Conservative by default, because an unknown server that rejects one
				// unknown field fails the whole turn. Poolside was measured to accept
				// stream_options, and without it every turn reports zero tokens, so the
				// context bar and the compaction threshold run on the estimate instead.
				compatible: name !== "poolside",
				contextWindow: pc.contextWindow,
			})
		}
	}
}

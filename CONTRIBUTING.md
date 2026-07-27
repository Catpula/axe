# Contributing

Read [README.md](README.md) for usage and [AGENTS.md](AGENTS.md) for design constraints.

## Checks

```sh
npm ci
npm test
```

Tests need no API key and touch no network. Run live adapter checks separately only when provider wire formats change:

```sh
npm run live-test
```

## Code

- Keep core runtime dependency-free; use Node standard library first.
- Match repository style: tabs, no semicolons, double quotes.
- Keep provider-specific types inside `src/providers`.
- Add recorded SSE frames in `scripts/adapter-test.ts` with every new provider.
- Keep non-trivial logic covered by the smallest useful test.
- Update `README.md` when CLI behavior or public commands change.
- Put procedures in skills and third-party capabilities in plugins before adding core surface.

## Pull requests

Describe behavior changed, tests run, and any known platform-specific limitation. Do not include API keys, thread files, debug logs, or local `.axe` state.

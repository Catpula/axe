---
name: release
description: How this project cuts a release. Use when asked to release, tag, publish, or bump a version.
---

# Release

Copy this directory to `.agents/skills/release/` in a project, or to
`~/.agents/skills/release/` to have it everywhere.

The frontmatter is the only part that reaches the system prompt. Write the
description for a reader deciding whether to open the file: say what the skill
is for and when to reach for it. Everything below is read only when it is.

## Steps

1. Confirm `main` is green: `npm test`.
2. Bump the version in `package.json`. Patch unless the CLI surface changed.
3. Update the status table in `README.md` if anything moved out of "Not built yet".
4. Commit as `Release v<version>`.
5. Tag: `git tag v<version> && git push --tags`.

## Notes

- Never release with a failing adapter test. A wire-format break is invisible
  until someone runs a live call.
- Do not bump the version in a feature commit. The release is its own commit.

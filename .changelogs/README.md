# Release Changelogs

This directory contains detailed release notes for each version of EscapeMint. These files are used by the GitHub Actions release workflow to create rich, user-friendly release descriptions.

## Structure

### NEXT.md — Unreleased Changes Accumulator

During development, all changelog entries are appended to `NEXT.md`. This file accumulates changes across multiple commits until a release is created.

- `/cam` (commit all my work) automatically adds entries to `NEXT.md`
- `/release` renames `NEXT.md` to `v{version}.md` and finalizes it with the version number and release date
- Do NOT create versioned changelog files manually — `/release` handles that

### Versioned Files

Each release has its own markdown file:

```
v{major}.{minor}.{patch}.md
```

Examples:
- `v0.9.0.md`
- `v0.8.0.md`
- `v0.7.0.md`

These are created automatically by `/release` from `NEXT.md`.

## Format

Each changelog file should follow this structure:

```markdown
# Release v{version} - {Descriptive Title}

Released: YYYY-MM-DD

## Overview

A brief summary of the release, highlighting the main theme or most important changes.

## Added

- Feature descriptions

## Changed

- What was changed

## Fixed

- Description of what was fixed

## Removed

- What was removed

## Full Changelog

**Full Diff**: https://github.com/atomantic/EscapeMint/compare/v{prev}...v{current}
```

## Workflow Integration

The GitHub Actions release workflow (`.github/workflows/release.yml`) automatically:

1. Checks for a changelog file matching the version in `package.json`
2. If found, uses it as the GitHub release description
3. If not found, falls back to generating a simple changelog from git commits

## Development Workflow

1. **During Development**: Each `/cam` commit appends entries to `NEXT.md` under the appropriate section (Added, Changed, Fixed, Removed)

2. **During Release** (`/release`):
   - Determines the version bump from conventional commit prefixes
   - Bumps `package.json` version
   - Renames `NEXT.md` → `v{new_version}.md`
   - Adds version header, release date, and diff link
   - Commits the version bump + finalized changelog

## Best Practices

### Do:
- Use clear, descriptive entries
- Group related changes together
- Include technical details where helpful
- Explain the "why" not just the "what"
- Link to relevant documentation or issues
- Include upgrade instructions for breaking changes

### Don't:
- Create versioned changelog files manually (use `/release`)
- Use vague descriptions like "various improvements"
- Include internal implementation details users don't care about
- Leave placeholder or TODO content
- Bump the version in `/cam` — only `/release` does that

## Maintenance

### Updating Past Releases

If you need to update a past release's changelog:

1. Edit the `.changelogs/v{version}.md` file
2. Update the GitHub release manually:
   ```bash
   gh release edit v{version} --notes-file .changelogs/v{version}.md
   ```

### View Release on GitHub
```bash
gh release view v{version}
```

### Edit Release Notes
```bash
gh release edit v{version} --notes-file .changelogs/v{version}.md
```

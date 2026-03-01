# Unreleased Changes

## Added

- Dependabot grouping for React ecosystem (`react`, `react-dom`, `@types/react`, `@types/react-dom`) and Vitest ecosystem (`vitest`, `@vitest/*`) to prevent version mismatches
- Dependabot coverage for `pages/` directory (has its own `package-lock.json` outside workspace)
- Peer dependency check (`npm ls`) in CI to catch version mismatches before merge
- `.nvmrc` pinned to Node 20 (matching CI and `engines` constraint)

## Changed

- Upgraded all dependencies to latest versions: Express 4→5, React 18→19, UUID 11→13, Tailwind CSS 3→4 (web), react-router-dom 6→7 (pages), Vite 6→7 (pages), @vitejs/plugin-react 4→5, TypeScript 5.7→5.9, and all type packages
- Migrated web package from Tailwind CSS 3 to 4 (CSS-based config with `@import "tailwindcss"` and `@theme`)
- Removed `@types/uuid` (uuid v13 ships its own types)
- Version bumps and changelog finalization now happen only during `/release`, not on every commit
- `/cam` appends to `.changelogs/NEXT.md` instead of creating per-version changelog files
- Consolidated unreleased changelogs (v0.42.18-21) into `NEXT.md` and reset version to v0.42.17
- Removed project-level `/pr` and `/gitup` commands (redundant with global `/release` and standard git)
- Pages CI workflow uses `npm ci` instead of `npm install` for reproducible builds

## Fixed

- Aggregate projected annual return now uses portfolio-level time-weighted realized APY instead of summing individually-compounded per-fund projections (short-duration funds with modest returns were getting exponentially inflated APYs)
- Dashboard cache projected return uses same portfolio-level formula for consistency
- `@vitest/coverage-v8` aligned with vitest 4.x across all packages
- Dashboard table shows actual fund size (`latestFundSize`) instead of static config value (`config.fund_size_usd`)
- Aggregate API now uses `fundSize` from `computeFundFinalMetrics()` instead of config override

## Removed

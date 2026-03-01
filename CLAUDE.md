# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run setup              # Install deps, build packages, initialize data
npm run dev                # Start PM2 servers (API + Web + Browser), shows logs
npm run dev:stop           # Stop all PM2 servers
npm run dev:restart        # Restart all PM2 servers
npm run build              # Build all packages (for production)
npm run build:packages     # Build engine + storage only (required before server)
```

## Development Workflow

**During `npm run dev`, two servers run on separate ports:**
- **http://localhost:5550** - Vite dev server (UI) — use this in your browser
- **http://localhost:5551** - Express API only (no UI in dev mode)

The Express server only serves the UI at port 5551 in production mode (`npm run start`). In development, always use port 5550 for the UI.

**When editing files during development:**
- `packages/web/` changes — Vite HMR updates the browser automatically, no rebuild needed
- `packages/server/` changes — PM2 auto-restarts the API server (watch is configured)
- `packages/engine/` or `packages/storage/` source changes — run `npm run build:packages` to recompile, then PM2 will auto-restart the API server
- **Do NOT run `npm run build` or `npm run build:web` during development** — it is unnecessary and will cause downtime

## Testing Commands

```bash
npm run test               # Run engine + storage unit tests
npm run test:engine        # Engine package only
npm run test:storage       # Storage package only
npm run test:e2e           # Playwright E2E tests (headless)
npm run test:e2e:headed    # E2E with visible browser
npm run test:e2e:ui        # E2E with Playwright UI
npm run lint               # ESLint check
npm run typecheck          # TypeScript check
```

## Architecture

**Monorepo with 4 packages:**

- `packages/engine/` - Pure calculation functions (zero dependencies, no side effects)
- `packages/storage/` - TSV file persistence with file locking
- `packages/server/` - Express API (port 5551)
- `packages/web/` - React frontend with Vite (port 5550)

**Data flow:** Web → API → Storage → TSV files in `data/funds/`

**Port configuration:** Single source of truth in `ecosystem.config.cjs` (Web: 5550, API: 5551, CDP: 5549)

## Data Model

Each fund has two files in `data/funds/`:
- `{platform}-{ticker}.tsv` - Time-series entries (date, value, action, amount, etc.)
- `{platform}-{ticker}.json` - Configuration (fund_size, target_apy, DCA amounts, etc.)

**Fund types:** `stock`, `crypto`, `cash`, `derivatives`

**Actions:** `BUY`, `SELL`, `DEPOSIT`, `WITHDRAW`, `HOLD` (for stock/crypto/cash)
**Derivatives actions:** Also includes `FUNDING`, `INTEREST`, `REBATE`, `FEE`

## Key Patterns

- Engine functions are pure - take entries and config, return computed state
- Storage uses `proper-lockfile` for concurrent file access
- API routes in `packages/server/src/routes/` call engine + storage
- Frontend uses `sonner` for toasts (not window.alert)
- All modals should have deep-linkable routes (e.g., `/fund/:id/edit`)
- Use `ConfirmDialog` component for confirmations (not window.confirm)

## Testing Notes

- E2E tests use platform "test" to isolate from real data
- API endpoints support `?include_test=true` to include test funds
- Tests run with single Playwright worker to prevent data conflicts
- Unit tests use Vitest with `npm test` in each package
- commit code after each feature or bug fix

## Code Style

- TypeScript strict mode enabled
- Prettier: no semicolons, single quotes, no trailing commas
- Functional programming preferred over classes
- Avoid try/catch when possible - use Result types or let errors propagate
- Keep existing patterns when adding features
- Before releasing, create detailed changelog in `.changelogs/v{version}.md` (see `.changelogs/README.md` for format)

## Common File Locations

- API routes: `packages/server/src/routes/`
- API utilities: `packages/server/src/utils/`
- Engine calculations: `packages/engine/src/`
- React pages: `packages/web/src/pages/`
- React components: `packages/web/src/components/`
- Frontend API client: `packages/web/src/api/`

## Documentation

See `docs/` for detailed documentation:
- `docs/architecture.md` - System architecture and data flow
- `docs/derivatives.md` - Perpetual futures data model
- `docs/data-format.md` - TSV file structure
- `docs/configuration.md` - All config options

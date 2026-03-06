# EscapeMint - Development Plan

The tactical backlog: what's next, what's in progress, and what's done. For mission, principles, and milestone definitions, see [GOALS.md](./GOALS.md).

---

## Better Audit - 2026-03-05

Summary: 48 findings across 22 files. 2 shared utilities to extract.

### Foundation — Shared Utilities

1. **`packages/server/src/config/paths.ts`** — Centralize `DATA_DIR`, `FUNDS_DIR`, `BACKUP_DIR` constants. Replaces 7 duplicate declarations across funds.ts, backup.ts, platforms.ts, export.ts, import.ts, test-data.ts, utils/platforms.ts.
2. **`packages/server/src/utils/derivatives-config.ts`** — Extract `getDerivativesConfig(config)` returning `{ contractMultiplier, maintenanceMarginRate, initialMarginRate }`. Replaces 7 duplicate 3-line blocks across funds.ts, fund-metrics.ts, dashboard-cache.ts.

### File Ownership Map

| File | Primary Category | Reason |
|------|-----------------|--------|
| `packages/server/src/routes/import.ts` | Security | SSRF (CRITICAL) outranks code quality |
| `packages/server/src/index.ts` | Security | CORS (HIGH) outranks code quality |
| `packages/server/src/routes/funds.ts` | Bugs & Perf | .catch(next) pattern (CRITICAL) outranks DRY |
| `packages/server/src/services/websocket.ts` | Bugs & Perf | Missing await (CRITICAL) outranks code quality |
| `packages/storage/src/fund-store.ts` | Bugs & Perf | Null pointer in release (CRITICAL) |
| `packages/server/src/routes/platforms.ts` | Code Quality | Swallowed errors (CRITICAL) |
| `packages/server/src/routes/backup.ts` | Architecture | Inconsistent response envelope (HIGH) |
| `packages/server/src/routes/export.ts` | Architecture | Inconsistent error format (HIGH) |
| `packages/server/src/middleware/error-handler.ts` | Code Quality | Mixed logging (MEDIUM) |
| `packages/server/src/services/dashboard-cache.ts` | DRY | Derivatives config duplication (HIGH) |
| `packages/web/src/components/Layout.tsx` | Code Quality | Swallowed API errors (CRITICAL) |
| `packages/web/src/components/CreateFundModal.tsx` | Stack-Specific | Missing useEffect cleanup (HIGH) |
| `packages/web/src/components/ImportWizard.tsx` | Code Quality | Swallowed browser cleanup errors (HIGH) |
| `packages/web/src/api/utils.ts` | Bugs & Perf | Missing AbortController (HIGH) |
| `packages/web/src/api/funds.ts` | Bugs & Perf | Race condition in parallel fetch (HIGH) |
| `packages/web/src/pages/Dashboard.tsx` | Stack-Specific | window.location.href instead of navigate (CRITICAL) |
| `packages/web/src/contexts/DashboardContext.tsx` | Stack-Specific | Stale closure in useCallback (CRITICAL) |
| `packages/web/src/pages/Backtest.tsx` | Code Quality | IIFE error suppression (MEDIUM) |
| `packages/web/src/pages/Settings.tsx` | Code Quality | Try/catch without logging (MEDIUM) |
| `packages/web/src/components/ActionableFundsBanner.tsx` | Code Quality | Try/catch without logging (MEDIUM) |
| `packages/server/src/utils/fund-metrics.ts` | DRY | Derivatives config duplication (HIGH) |
| `packages/server/src/config/paths.ts` | DRY | New file (foundation utility) |
| `packages/server/src/utils/derivatives-config.ts` | DRY | New file (foundation utility) |

### Security & Secrets
- [ ] **[CRITICAL]** `packages/server/src/routes/import.ts:1964` — SSRF: cdpUrl accepts arbitrary URLs passed to Playwright connectOverCDP. Fix: Validate cdpUrl is localhost only. (Simple)
- [ ] **[HIGH]** `packages/server/src/index.ts:23` — Unrestricted CORS: `cors()` allows all origins. Fix: Restrict to localhost:5550 + configurable origins. (Simple)
- [ ] **[MEDIUM]** `packages/server/src/routes/import.ts:1913` — Child process spawning without platform validation. Fix: Validate platform against whitelist. (Simple)
- [ ] **[LOW]** CVE: xlsx@0.18.5 has prototype pollution + ReDoS (devDep only)
- [ ] **[LOW]** CVE: pm2 ReDoS (no fix available)

### Code Quality & Style
- [ ] **[CRITICAL]** `packages/server/src/routes/platforms.ts:998-999` — Swallowed errors in file deletion: `.catch(() => {})`. Fix: Log errors. (Simple)
- [ ] **[CRITICAL]** `packages/web/src/components/Layout.tsx:67,70,85,94` — Swallowed API errors in Layout with only console.warn. Fix: Add toast for critical load failures. (Medium)
- [ ] **[HIGH]** `packages/web/src/components/ImportWizard.tsx:912,992` — Swallowed browser cleanup: `killBrowser().catch(() => {})`. Fix: Log errors. (Simple)
- [ ] **[HIGH]** `packages/server/src/routes/export.ts:95` — Swallowed mkdir error. Fix: Log error. (Simple)
- [ ] **[MEDIUM]** `packages/server/src/middleware/error-handler.ts:19-22` — Uses console.warn/error instead of structured logger. Fix: Use createLogger. (Simple)
- [ ] **[MEDIUM]** `packages/web/src/pages/Backtest.tsx:235` — IIFE error suppression for JSON.parse. Fix: Add logging. (Simple)
- [ ] **[MEDIUM]** `packages/web/src/pages/Settings.tsx:344-350` — Try/catch without logging parse error. Fix: Log error. (Simple)
- [ ] **[MEDIUM]** `packages/web/src/components/ActionableFundsBanner.tsx:25-40` — Try/catch without logging. Fix: Log error. (Simple)
- [ ] **[MEDIUM]** `packages/web/src/api/utils.ts:101-104` — Silent BTC price fetch failure. Fix: Add logging. (Simple) — NOTE: file owned by Bugs & Perf, defer this fix there

### DRY & YAGNI
- [ ] **[CRITICAL]** `7 files` — DATA_DIR duplicated across 7 files. Fix: Extract to config/paths.ts (Foundation). (Simple)
- [ ] **[HIGH]** `funds.ts, fund-metrics.ts, dashboard-cache.ts` — Derivatives config (3 lines) duplicated 7x. Fix: Extract to derivatives-config.ts (Foundation). (Simple)
- [ ] **[MEDIUM]** `export.ts, import.ts (23 occurrences)` — Inline `res.status().json()` instead of error handler. Fix: Use next(badRequest/notFound). (Simple) — NOTE: export.ts owned by Architecture, import.ts owned by Security

### Architecture & SOLID
- [ ] **[HIGH]** `packages/server/src/routes/backup.ts` — Inconsistent response envelope: `{success, error}` vs `{error: {message, code}}`. Fix: Standardize to error handler. (Simple)
- [ ] **[HIGH]** `packages/server/src/routes/export.ts:61-126` — Inconsistent error format: manual `res.status(400).json()` instead of middleware. Fix: Use next(badRequest(...)). (Simple)
- [ ] **[LOW]** `packages/server/src/routes/funds.ts:65-120` — List endpoint without pagination. (Medium) — tracked, not auto-remediated

### Bugs, Performance & Error Handling
- [ ] **[CRITICAL]** `packages/storage/src/fund-store.ts:78` — Null pointer: `release()` called when undefined if lock acquisition fails. Fix: Guard with `if (release) await release()`. (Simple)
- [ ] **[CRITICAL]** `packages/server/src/services/websocket.ts:156` — Missing `await` on `sendDashboardData(client)` causing unhandled rejection. Fix: Add await. (Simple)
- [ ] **[CRITICAL]** `packages/server/src/routes/funds.ts:66` — `.catch(next)` anti-pattern: assignment gets undefined return of next(). Fix: Use try/catch with return next(err). (Medium)
- [ ] **[HIGH]** `packages/web/src/api/utils.ts:92-115` — Missing AbortController on external Coinbase API fetch. Fix: Add AbortController with 5s timeout. (Simple)
- [ ] **[HIGH]** `packages/web/src/api/funds.ts:357-370` — Unbounded parallel fetch without concurrency control. Fix: Add concurrency limit or use Promise.allSettled with logging. (Medium)

### Stack-Specific (React/Node)
- [ ] **[CRITICAL]** `packages/web/src/pages/Dashboard.tsx:577` — `window.location.href` causes full page reload. Fix: Use React Router navigate(). (Simple)
- [ ] **[CRITICAL]** `packages/web/src/contexts/DashboardContext.tsx:158` — Stale closure: useCallback deps missing, causing WebSocket reconnect leaks. Fix: Stabilize deps. (Medium)
- [ ] **[HIGH]** `packages/web/src/components/CreateFundModal.tsx:59-75` — Missing AbortController cleanup in useEffect fetch. Fix: Add abort signal. (Medium)
- [ ] **[HIGH]** Missing `.env.example` file. Fix: Create with documented env vars. (Simple) — new file

### Test Coverage (tracked, not auto-remediated)
- [ ] **[CRITICAL]** No unit tests for server routes (funds.ts 2748 lines, import.ts 7176 lines)
- [ ] **[CRITICAL]** No unit tests for dashboard-cache.ts (765 lines) or websocket.ts
- [ ] **[HIGH]** No unit tests for fund-metrics.ts, calculations.ts, compute.ts, export.ts, backup.ts, platforms.ts
- [ ] **[HIGH]** No unit tests for engine/fund-type-config.ts (16 exported functions)
- [ ] **[HIGH]** storage/fund-store.ts: only helpers tested, not core I/O functions

---

## Documentation

See the [docs/](./docs/) folder for detailed documentation:

- **[Philosophy](./docs/philosophy.md)** - Why this system exists (start here)
- [Investment Strategy](./docs/investment-strategy.md) - DCA methodology
- [Fund Management](./docs/fund-management.md) - Position and cash tracking
- [Configuration Guide](./docs/configuration.md) - All config options
- [Data Format](./docs/data-format.md) - TSV file structure
- [System Architecture](./docs/architecture.md) - Package structure and data flow
- [Derivatives](./docs/derivatives.md) - Perpetual futures data model
- [Project Goals](./GOALS.md) - Mission, milestones, and non-goals

---

## Next Up

### Configurable Entry Form Fields (High Value)
Allow per-fund configuration of which entry fields are shown and their order. Enables "quick entry" - configure a fund to show only date + value for a minimal Take Action form.

- [ ] Add `entry_fields` config to fund JSON (array of field names + order)
- [ ] Create field configuration UI in fund settings
- [ ] Update AddEntryModal to respect field visibility/ordering
- [ ] Preserve backwards compatibility (default shows all fields)
- [ ] Pre-fill date with today, value with latest value

### Chart Date Range Selector
Filter charts to specific time periods (1M, 3M, 6M, YTD, 1Y, All).

- [ ] Add date range buttons above charts
- [ ] Filter chart data to selected range
- [ ] Persist selection per fund in config
- [ ] Apply to all charts on the page

### Price/Size Charts
When tracking price/size, show additional charts on the fund dashboard.

- [ ] Add price history chart (price over time)
- [ ] Add share accumulation chart (total shares over time)
- [ ] Add cost basis vs current price comparison
- [ ] Only show charts when fund has price/size data

---

## Remaining Work

### Testing Gaps
- [ ] Server route unit tests (`packages/server/test/routes/`)
- [ ] Visual regression tests for charts
- [ ] 95%+ feature coverage in E2E suite

### Engine Completeness
- [ ] TWAP-based APY calculation verified across all edge cases (multi-cycle, idle gaps, partial liquidation)
- [ ] Recommendation engine handles every combination of fund config flags correctly

### UX Polish
- [ ] Keyboard shortcuts (j/k navigation, Enter to open, Esc to close)
- [ ] Mobile-responsive layout

### Documentation Backlog
- [ ] Ticker Choices Guide (`docs/ticker-choices.md`) - Why volatile assets like TQQQ work better for DCA than VTI
- [ ] Getting Started Guide
- [ ] API Reference (OpenAPI/Swagger)
- [ ] Complete configuration reference with examples

### Parameterized Test Data
- [ ] Add parameter inputs to Test/Demo Data settings section
- [ ] Integrate m1test generation into "Load Test Data" button
- [ ] Add preset configurations (Conservative, Moderate, Aggressive)

---

## Future (v2.0+)

### Strategy Layer
- [ ] Plugin system for custom DCA strategies beyond tiered min/mid/max
- [ ] Per-holding allocation within a fund (pie-style)
- [ ] Benchmark comparison (vs SPY, BTC, custom benchmark)
- [ ] Goal setting with target dates and amounts

### Analytics
- [ ] Performance attribution (break down gains by dividends, price appreciation, interest)
- [ ] Comparison mode (side-by-side fund analysis)
- [ ] Drawdown analysis and recovery time tracking
- [ ] Portfolio correlation matrix

### Data & Integration
- [ ] Currency support for non-USD funds with exchange rate conversion
- [ ] Multi-account aggregation (same ticker across platforms as single view)
- [ ] Split handling (adjust historical prices/shares automatically)
- [ ] CSV/PDF export for tax reporting

### PWA / Offline
- [ ] Service worker for full offline access
- [ ] Installable as a desktop/mobile app
- [ ] Background sync when connectivity returns

### Community
- [ ] Shareable fund configurations (anonymized strategy templates)
- [ ] Backtesting engine with historical data for strategy validation before committing real capital
- [ ] Public backtest page with onboarding wizard (already started in `pages/`)

---

## Test Coverage

Run `npm run test:coverage` to generate the coverage report, viewable in the app's Settings page.

| Suite | Files | Coverage |
|-------|-------|----------|
| E2E | 8 spec files, 130+ tests | Fund configs, simulations, integrity, derivatives, UI, platforms, import/export, cash |
| Engine | 135 unit tests | Passing |
| Storage | 9 unit tests | Passing |

---

## Next Actions

1. **Configurable entry form fields** - Highest-value UX improvement; reduces friction for the most common action (adding entries)
2. **Chart date range selector** - Second most requested feature; enables focused analysis of recent performance
3. **Price/size charts** - Price history, share accumulation, and cost basis charts for funds with price/size data
4. **Server route unit tests** - Largest testing gap; API routes have zero unit test coverage
5. **Ticker Choices documentation** - Referenced in README and philosophy docs but doesn't exist yet

---

## Completed Work (Archive)

<details>
<summary>v0.40+ Fixes</summary>

- [x] Liquidation detection refactored to triple-redundant logic (share-based, value-based, dollar-based) in `expected-equity.ts`
- [x] DEPOSIT/WITHDRAW handling verified — correctly tracked via entries, empty cashflows array is intentional architecture
- [x] Aggregate calculation tests (`packages/engine/test/aggregate.test.ts`)
- [x] Inline platform creation in Add Fund form (v0.40.5)

</details>

<details>
<summary>v0.20+ Features</summary>

### TWAP Denominator for Trading Fund APY
Replaced snapshot-based denominator with Time-Weighted Average Position (TWAP) for trading fund APY. Multi-cycle funds now reflect actual average capital deployed.

### Remove start_date from Config + Active Days APY Tracking
Removed redundant `start_date` from fund config (derived from first entry). APY calculated using active days (time with capital deployed) rather than calendar days.

### Four Pillars Fund Categories (v0.27.0)
Portfolio categorization with 4 pillars: Liquidity, Yield, Store of Value, Volatility. Margin tracked separately. See [Philosophy docs](./docs/philosophy.md#the-four-pillars-of-portfolio-construction).

### Onboarding Wizard (v0.22)
Interactive 12-step intro wizard with animated D3 charts in the backtest app (`pages/`). Auto-shows for first-time visitors, shareable step URLs.

### Action Due Prompts
Dashboard banner and nav indicator showing funds past their configured action interval. Actionable funds sorted by priority (most overdue first), dismissible per session.

</details>

<details>
<summary>v0.1-0.6 Features</summary>

### Test Data Generation System
- Fetch and store 5 years of weekly price data (BTCUSD, TQQQ, SPXL)
- Test data generator utility with API endpoint and Settings UI button

### M1 Test Platform with Margin
- Blended price history (`pie-weekly.json`), margin integrity warnings in UI

### Code Quality
- Modal wrapper component, consolidated format utils, performance optimizations (React.memo, code splitting)

### E2E Test Coverage
- Feature coverage tracking system (`e2e/coverage-matrix.ts`)
- Full E2E suites: derivatives, UI workflows, platforms, import/export, cash funds

</details>

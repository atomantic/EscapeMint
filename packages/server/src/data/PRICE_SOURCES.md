# Price sources

QQQ, SOXX, and SOXL weekly bars in this directory (`qqq-weekly.json`, `soxx-weekly.json`, `soxl-weekly.json`) are session closes from the Yahoo Finance chart API (`query1.finance.yahoo.com/v8/finance/chart`), retrieved 2026-10-25.

The bars are split-adjusted and are not dividend-adjusted. A daily-reset leveraged fund tracks the price index, so the sample uses the unadjusted-for-dividends close. Each file is Wednesday bars from 2021-01-27 through 2026-01-21, the same calendar as `tqqq-weekly.json`. The public copies under `pages/public/data/` and `packages/web/public/data/` carry the same source string on the file.

`packages/engine/test/fixtures/underlying-daily.json` uses that same Yahoo session close for daily series from 1998-01-02 through 2012-12-31:

| Series | Role |
|--------|------|
| `^NDX` | Nasdaq-100 underlying for the synthetic 3x path. QQQ itself starts 1999-03-10. |
| `QQQ` | 1x sleeve for the Nasdaq fallback. |
| `^SOX` | Semiconductor underlying and the 1x stand-in. SOXX listed 2001-07-13. |
| `SOXX` | Real semiconductor ETF closes, present from its listing date. |
| `VTSMX` | Vanguard Total Stock Market Index Fund, used before the VTI ETF exists. |
| `VTI` | Total-market ETF. The Yahoo series in this fixture starts 2001-06-15. The benchmark uses VTI once both the current and previous session have a VTI close, and VTSMX before that. |
| `soxlFirst` | SOXL's first session, 2010-03-11. The wipeout tests use a synthetic 3x built from `^SOX`, not the live SOXL history. |

The one-day wipeout in the engine tests is synthetic (the index is cut by one third). No session in this fixture dropped that far. The worst real days here are about 9–12%.

# Configuration Guide

This guide explains all configuration options for EscapeMint funds.

## Core Settings

### fund_size_usd

Total capital allocated to this fund.

```json
"fund_size_usd": 10000
```

- Represents your total investment pool (cash + position value)
- Can be increased with DEPOSIT or decreased with WITHDRAW
- Set to 0 to close a fund (legacy method)

### status

Fund status indicator.

```json
"status": "active"  // or "closed"
```

- `active`: Normal operation, receives recommendations
- `closed`: No recommendations, shows final metrics

### fund_type

Type of fund.

```json
"fund_type": "stock"  // or "crypto" or "cash"
```

- `stock`: Equity positions (default)
- `crypto`: Cryptocurrency positions
- `cash`: Cash-only fund (no trading recommendations)

### start_date

When tracking began for this fund.

```json
"start_date": "2024-01-01"
```

- Used to calculate time-weighted returns
- Format: YYYY-MM-DD

## Target Settings

### target_apy

Annual growth rate target.

```json
"target_apy": 0.25  // 25%
```

- Used to calculate expected value
- Determines when to sell (when above target)
- Higher targets = more aggressive strategy

### interval_days

Days between recommended actions.

```json
"interval_days": 7  // Weekly
```

- Common values: 1 (daily), 7 (weekly), 14 (bi-weekly), 30 (monthly)
- Shorter intervals = more active trading
- Longer intervals = more hands-off approach

## DCA Amount Tiers

### input_min_usd

Amount to invest when on-track or profitable.

```json
"input_min_usd": 100
```

- Used when: `gain_pct >= 0` (making money)
- Smallest DCA amount
- Conservative accumulation when things are going well

### input_mid_usd

Amount to invest when below cost basis.

```json
"input_mid_usd": 200
```

- Used when: `gain_pct < 0` but `gain_pct >= max_at_pct`
- Medium DCA amount
- Increased buying when asset is down

### input_max_usd

Amount to invest during significant losses.

```json
"input_max_usd": 500
```

- Used when: `gain_pct < max_at_pct`
- Largest DCA amount
- Maximum accumulation at lowest prices

### max_at_pct

Loss threshold for maximum DCA tier.

```json
"max_at_pct": -0.25  // -25%
```

- When losses exceed this %, use `input_max_usd`
- More negative = triggers max tier less often
- Example: `-0.25` means max tier when down 25%+

### min_profit_usd

Profit threshold to trigger selling.

```json
"min_profit_usd": 100
```

- Must be above target by this amount to sell
- Prevents selling on tiny fluctuations
- Higher = less frequent selling

## Behavior Settings

### accumulate

How to handle profits above target.

```json
"accumulate": true
```

| Value | Behavior |
|-------|----------|
| `true` | Sell only the DCA limit amount (take partial profits) |
| `false` | Harvest entire position (full exit, restart cycle) |

### manage_cash

Whether this fund maintains its own cash pool.

```json
"manage_cash": true
```

| Value | Behavior |
|-------|----------|
| `true` | Fund has its own cash pool, BUY/SELL affects it |
| `false` | Uses platform cash fund for all cash operations |

### dividend_reinvest

How to handle dividend income.

```json
"dividend_reinvest": true
```

| Value | Behavior |
|-------|----------|
| `true` | Dividends increase fund size (reinvested) |
| `false` | Dividends extracted as realized profit |

### interest_reinvest

How to handle cash interest income.

```json
"interest_reinvest": true
```

| Value | Behavior |
|-------|----------|
| `true` | Interest increases fund size |
| `false` | Interest extracted as realized profit |

### expense_from_fund

How expenses affect fund size.

```json
"expense_from_fund": true
```

| Value | Behavior |
|-------|----------|
| `true` | Expenses reduce fund size |
| `false` | Expenses tracked but don't reduce fund size |

## Margin Settings

### margin_enabled

Whether margin trading is enabled.

```json
"margin_enabled": false
```

- `true`: Track margin borrowing
- `false`: Cash-only trading

### margin_access_usd

Maximum margin available.

```json
"margin_access_usd": 5000
```

- How much margin the broker offers
- Used for tracking available buying power

### margin_apr

Annual interest rate on margin borrowing.

```json
"margin_apr": 0.0725  // 7.25%
```

- Used to calculate margin interest costs
- Higher rates make margin less attractive

## 1x Fallback

Optional protection for a daily-reset leveraged fund (TQQQ, SOXL, SPXL). **Off unless `fallback_enabled` is true.** Existing funds and every default recommendation are unchanged. The rule never borrows and never sells shares you already hold. It only changes where the next buy goes.

Leave margin off while this rule is on. The two do not combine, and the app does not turn margin on for you.

### fallback_enabled

```json
"fallback_enabled": false
```

| Value | Behavior |
|-------|----------|
| omitted or `false` | Buys stay on this fund |
| `true` | New buys can route to `fallback_ticker` |

### fallback_drawdown_pct

How far down the fund must be before new buys leave it. A positive fraction. `0.60` means down 60% from the running peak or from cost basis, whichever is worse. Defaults to `0.60`.

```json
"fallback_drawdown_pct": 0.60
```

### fallback_ma_days

Length of the underlying moving average, in trading days. Defaults to `200`. New buys go to the 1x ticker when the latest underlying close is below that average. Buys come back to the leveraged fund only after the drawdown has healed **and** the underlying has closed back at or above the average.

```json
"fallback_ma_days": 200
```

The live fund page applies the drawdown test from the fund's own cost basis. The moving-average test runs when underlying closes are supplied (the path backtests). This app does not fetch a live underlying series for the fund page.

### fallback_ticker

Ticker that receives the routed buy.

```json
"fallback_ticker": "QQQ"
```

| Leveraged fund | 1x ticker |
|----------------|-----------|
| TQQQ | QQQ |
| SOXL | SOXX |
| SPXL | SPY (VOO is the same S&P 500 exposure) |

```json
"fallback_enabled": true,
"fallback_drawdown_pct": 0.60,
"fallback_ma_days": 200,
"fallback_ticker": "QQQ"
```

## Metadata

### audited

Last audit date.

```json
"audited": "2024-03-15"
```

- Records when fund was last verified against brokerage
- Helps track reconciliation status
- Format: YYYY-MM-DD

### cash_fund

Override the default cash fund.

```json
"cash_fund": "robinhood-cash"
```

- Only used when `manage_cash: false`
- Specifies which cash fund to use
- Default: `{platform}-cash`

## Example Configurations

### Conservative Long-Term Fund

```json
{
  "fund_size_usd": 50000,
  "target_apy": 0.12,
  "interval_days": 30,
  "input_min_usd": 500,
  "input_mid_usd": 750,
  "input_max_usd": 1000,
  "max_at_pct": -0.15,
  "min_profit_usd": 500,
  "accumulate": true,
  "start_date": "2024-01-01"
}
```

- Monthly contributions
- 12% target (market average)
- Small variance between tiers
- Takes profits slowly

### Aggressive Growth Fund

```json
{
  "fund_size_usd": 10000,
  "target_apy": 0.40,
  "interval_days": 7,
  "input_min_usd": 100,
  "input_mid_usd": 300,
  "input_max_usd": 800,
  "max_at_pct": -0.25,
  "min_profit_usd": 100,
  "accumulate": true,
  "start_date": "2024-01-01"
}
```

- Weekly trading
- 40% target (aggressive)
- Large variance between tiers (8x min to max)
- Quick profit-taking

### Swing Trading Fund

```json
{
  "fund_size_usd": 5000,
  "target_apy": 0.50,
  "interval_days": 3,
  "input_min_usd": 200,
  "input_mid_usd": 400,
  "input_max_usd": 1000,
  "max_at_pct": -0.20,
  "min_profit_usd": 50,
  "accumulate": false,
  "start_date": "2024-01-01"
}
```

- Every 3 days
- 50% target (very aggressive)
- `accumulate: false` = full liquidation when profitable
- Low profit threshold for quick exits

### Cash Fund

```json
{
  "fund_type": "cash",
  "fund_size_usd": 0,
  "status": "active",
  "start_date": "2024-01-01"
}
```

- `fund_type: cash` = no trading recommendations
- `fund_size_usd: 0` = balance tracked via entries
- Receives DEPOSIT/WITHDRAW actions from trading funds

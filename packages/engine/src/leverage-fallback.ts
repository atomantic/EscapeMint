/** Drawdown that routes new buys to the 1x fund. 0.60 = down 60%. */
export const DEFAULT_FALLBACK_DRAWDOWN = 0.6

/** Trading sessions in the underlying moving average. */
export const DEFAULT_FALLBACK_MA_DAYS = 200

/** Daily-reset leverage used for the synthetic 3x series. */
export const DEFAULT_LEVERAGE = 3

/**
 * Annual expense dragged from the synthetic leveraged fund.
 * About 0.9%/year, the ballpark gross expense of TQQQ / SOXL / SPXL.
 */
export const DEFAULT_LEVERAGE_EXPENSE_RATIO = 0.009

/** Sessions used to turn an annual expense into a daily drag. */
export const TRADING_DAYS_PER_YEAR = 252

/**
 * 1x ETF that replaces new buys in a daily-reset 3x fund.
 * SPXL's twin is SPY; VOO is the same S&P 500 exposure.
 */
export const LEVERAGED_FALLBACK_TICKERS: Readonly<Record<string, string>> = {
  TQQQ: 'QQQ',
  SOXL: 'SOXX',
  SPXL: 'SPY'
}

export function defaultFallbackTicker(ticker: string): string | null {
  return LEVERAGED_FALLBACK_TICKERS[ticker.trim().toUpperCase()] ?? null
}

export function simpleMovingAverage(values: readonly number[], length: number): number | null {
  if (!Number.isFinite(length) || length <= 0 || values.length < length) return null
  const start = values.length - length
  let sum = 0
  for (let i = start; i < values.length; i++) {
    const value = values[i]
    if (value === undefined || !Number.isFinite(value)) return null
    sum += value
  }
  return sum / length
}

export interface FallbackRuleConfig {
  enabled: boolean
  /** Positive fraction. Defaults to {@link DEFAULT_FALLBACK_DRAWDOWN}. */
  drawdownThreshold?: number
  /** Trading days. Defaults to {@link DEFAULT_FALLBACK_MA_DAYS}. */
  maDays?: number
  fallbackTicker?: string
}

export interface FallbackObservation {
  /** How far the leveraged price is below its running peak, as a positive fraction. */
  drawdownFromPeak?: number
  /** How far the position is below its cost basis, as a positive fraction. */
  drawdownFromCost?: number
  /** Underlying closes, oldest first, including the latest close. */
  underlyingCloses?: readonly number[]
}

export type FallbackReason =
  | 'disabled'
  | 'drawdown'
  | 'below_ma'
  | 'drawdown_and_below_ma'
  | 'inactive'

export interface FallbackDecision {
  /** True when a new buy should go to the 1x fund. */
  active: boolean
  routeTicker: string | null
  reason: FallbackReason
  /** Drawdown actually compared to the threshold (the worse of peak and cost). */
  drawdown: number
  movingAverage: number | null
  underlyingClose: number | null
  belowMovingAverage: boolean
}

/**
 * Decide whether a new buy belongs in the leveraged fund or its 1x equivalent.
 *
 * The rule is off unless `enabled` is set. While it is on, a buy is routed to
 * the 1x ticker when the leveraged fund is down by at least the threshold
 * (from its peak or from cost basis) or the underlying close is below its
 * moving average. Buys return to the leveraged fund only when both have
 * cleared: the drawdown is back inside the threshold and the underlying has
 * closed back above its average.
 *
 * The rule never borrows. It only chooses where the next cash buy goes.
 */
export function evaluateFallback(
  rule: FallbackRuleConfig | undefined,
  observation: FallbackObservation
): FallbackDecision {
  const fromPeak = observation.drawdownFromPeak ?? 0
  const fromCost = observation.drawdownFromCost ?? 0
  const drawdown = Math.max(fromPeak, fromCost, 0)
  const closes = observation.underlyingCloses
  const underlyingClose = closes && closes.length > 0 ? closes[closes.length - 1] ?? null : null
  const maDays = rule?.maDays ?? DEFAULT_FALLBACK_MA_DAYS
  const movingAverage = closes ? simpleMovingAverage(closes, maDays) : null
  const belowMovingAverage =
    movingAverage !== null && underlyingClose !== null && underlyingClose < movingAverage

  const inactive: FallbackDecision = {
    active: false,
    routeTicker: null,
    reason: rule?.enabled ? 'inactive' : 'disabled',
    drawdown,
    movingAverage,
    underlyingClose,
    belowMovingAverage
  }

  if (!rule?.enabled) return inactive

  const threshold = rule.drawdownThreshold ?? DEFAULT_FALLBACK_DRAWDOWN
  const deepDrawdown = drawdown >= threshold
  if (!deepDrawdown && !belowMovingAverage) return inactive

  const ticker = rule.fallbackTicker?.trim().toUpperCase() || null
  let reason: FallbackReason = 'drawdown'
  if (deepDrawdown && belowMovingAverage) reason = 'drawdown_and_below_ma'
  else if (belowMovingAverage) reason = 'below_ma'

  return {
    active: true,
    routeTicker: ticker,
    reason,
    drawdown,
    movingAverage,
    underlyingClose,
    belowMovingAverage
  }
}

export function maxDrawdown(values: readonly number[]): {
  drawdown: number
  peakIndex: number
  troughIndex: number
} {
  let peak = -Infinity
  let peakIndex = 0
  let maxDd = 0
  let ddPeak = 0
  let troughIndex = 0
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0
    if (value > peak) {
      peak = value
      peakIndex = i
    }
    const dd = peak > 0 ? (peak - value) / peak : 0
    if (dd > maxDd) {
      maxDd = dd
      ddPeak = peakIndex
      troughIndex = i
    }
  }
  return { drawdown: maxDd, peakIndex: ddPeak, troughIndex }
}

/**
 * Daily-reset leveraged price path.
 *
 * Each session: `leverage * underlying return − expense/252`.
 * A result at or below zero wipes the fund. It stays at zero afterwards,
 * which is the closure/liquidation case: the rebound in the index never
 * comes back to holders of the leveraged shares.
 */
export function syntheticLeveragedPrices(
  underlyingCloses: readonly number[],
  options?: {
    leverage?: number
    expenseRatio?: number
    initialPrice?: number
    /**
     * Once the price is this far below its running peak (0.99 = down 99%),
     * freeze it. That models an issuer closing the fund and locking in the loss.
     */
    closeAfterDrawdown?: number
  }
): number[] {
  const leverage = options?.leverage ?? DEFAULT_LEVERAGE
  const expenseRatio = options?.expenseRatio ?? DEFAULT_LEVERAGE_EXPENSE_RATIO
  const dailyExpense = expenseRatio / TRADING_DAYS_PER_YEAR
  const initial = options?.initialPrice ?? 100
  if (underlyingCloses.length === 0) return []

  const closeAfter = options?.closeAfterDrawdown
  const prices: number[] = [initial]
  let peak = initial
  let frozen = false
  for (let i = 1; i < underlyingCloses.length; i++) {
    const prevUnderlying = underlyingCloses[i - 1]
    const underlying = underlyingCloses[i]
    const last = prices[i - 1]
    if (prevUnderlying === undefined || underlying === undefined || last === undefined) break
    if (frozen || last <= 0 || prevUnderlying <= 0) {
      prices.push(last <= 0 || prevUnderlying <= 0 ? 0 : last)
      continue
    }
    const underlyingReturn = underlying / prevUnderlying - 1
    const leveragedReturn = leverage * underlyingReturn - dailyExpense
    const next = last * (1 + leveragedReturn)
    const price = next > 0 && Number.isFinite(next) ? next : 0
    if (price > peak) peak = price
    if (closeAfter !== undefined && peak > 0 && (peak - price) / peak >= closeAfter) {
      frozen = true
    }
    prices.push(price)
  }
  return prices
}

/** What a +r/−r round trip leaves of a $1 price, before and after leverage. */
export function roundTripRemainder(dayReturn: number, leverage = DEFAULT_LEVERAGE, expenseRatio = 0): {
  underlying: number
  leveraged: number
} {
  const dailyExpense = expenseRatio / TRADING_DAYS_PER_YEAR
  const up = 1 + leverage * dayReturn - dailyExpense
  const down = 1 - leverage * dayReturn - dailyExpense
  return {
    underlying: (1 + dayReturn) * (1 - dayReturn),
    leveraged: Math.max(0, up) * Math.max(0, down)
  }
}

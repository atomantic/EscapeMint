import {
  DEFAULT_FALLBACK_DRAWDOWN,
  DEFAULT_FALLBACK_MA_DAYS,
  DEFAULT_LEVERAGE,
  DEFAULT_LEVERAGE_EXPENSE_RATIO,
  TRADING_DAYS_PER_YEAR,
  evaluateFallback,
  maxDrawdown,
  syntheticLeveragedPrices
} from './leverage-fallback.js'
import { computeLimit } from './recommendation.js'
import type { FundState, SubFundConfig } from './types.js'

export interface PathCashFlow {
  date: string
  /** Negative for money contributed, positive for the ending value. */
  amount: number
}

export interface PathStrategyResult {
  finalValue: number
  cash: number
  leveragedValue: number
  fallbackValue: number
  totalContributed: number
  /** Money-weighted annualized return. */
  irr: number
  /** Time-weighted annualized return, with contributions taken out. */
  cagr: number
  maxDrawdown: number
  maxDrawdownDate: string
  troughValue: number
  buysInLeveraged: number
  buysInFallback: number
  dollarsInLeveraged: number
  dollarsInFallback: number
  /** Always false. The path never borrows. */
  usedMargin: boolean
  equity: number[]
}

export interface LeveragePathComparison {
  leveragedPrices: number[]
  /** Peak-to-trough decline of the synthetic 3x price. */
  leveragedPriceMaxDrawdown: number
  leveragedPriceTroughDate: string
  only3x: PathStrategyResult
  fallback: PathStrategyResult
  /** Buy-and-hold of the benchmark on the same external contributions. */
  benchmark: PathStrategyResult
  chart: Array<{ date: string; only3x: number; fallback: number; benchmark: number }>
}

export interface ScaledBuyingTiers {
  inputMin: number
  inputMid: number
  inputMax: number
  /** Negative fraction, same convention as `SubFundConfig.max_at_pct`. */
  maxAtPct: number
}

export interface LeveragePathInput {
  dates: readonly string[]
  /** Underlying index closes. One per date. The synthetic 3x path is built from these. */
  underlyingCloses: readonly number[]
  /**
   * 1x prices, one per date.
   * Defaults to the underlying closes, which is right when the 1x fund is the index itself.
   */
  fallbackCloses?: readonly number[]
  benchmarkCloses: readonly number[]
  /** Closes before the first date, oldest first, so the moving average exists on day one. */
  underlyingWarmup?: readonly number[]
  weeklyContribution?: number
  contributionEvery?: number
  /** Opening cash, counted as a contribution on the first date. */
  initialCash?: number
  drawdownThreshold?: number
  maDays?: number
  leverage?: number
  expenseRatio?: number
  /** Freeze the synthetic fund once its drawdown crosses this level. See syntheticLeveragedPrices. */
  closeAfterDrawdown?: number
  /**
   * Buy size follows min/mid/max from the leveraged sleeve's loss versus cost.
   * Spending never exceeds cash. Omit to invest each contribution in full that day.
   */
  scaledBuying?: ScaledBuyingTiers
}

const SCALED_BASE_CONFIG: SubFundConfig = {
  fund_size_usd: 0,
  target_apy: 0.1,
  interval_days: 5,
  input_min_usd: 100,
  input_mid_usd: 200,
  input_max_usd: 400,
  max_at_pct: -0.25,
  min_profit_usd: 0,
  cash_apy: 0,
  margin_apr: 0,
  margin_access_usd: 0,
  margin_enabled: false,
  accumulate: true,
  manage_cash: true
}

function scaledBuyAmount(tiers: ScaledBuyingTiers, cost: number, value: number, cash: number): number {
  const state: FundState = {
    cash_available_usd: cash,
    expected_target_usd: 0,
    actual_value_usd: value,
    start_input_usd: cost,
    gain_usd: value - cost,
    gain_pct: cost > 0 ? value / cost - 1 : 0,
    target_diff_usd: 0,
    cash_interest_usd: 0,
    realized_gains_usd: 0
  }
  const limit = computeLimit(
    {
      ...SCALED_BASE_CONFIG,
      input_min_usd: tiers.inputMin,
      input_mid_usd: tiers.inputMid,
      input_max_usd: tiers.inputMax,
      max_at_pct: tiers.maxAtPct,
      margin_access_usd: 0,
      margin_enabled: false
    },
    state
  )
  return Math.min(Math.max(limit, 0), Math.max(cash, 0))
}

/** Money-weighted annualized return. Newton, then a bracket search. */
export function xirr(flows: readonly PathCashFlow[]): number {
  if (flows.length < 2) return 0
  const first = flows[0]
  if (!first) return 0
  const t0 = Date.parse(`${first.date}T00:00:00Z`)
  const yearFrac = (date: string) =>
    (Date.parse(`${date}T00:00:00Z`) - t0) / (365.25 * 24 * 60 * 60 * 1000)

  const npv = (rate: number) => {
    let sum = 0
    for (const flow of flows) {
      sum += flow.amount / Math.pow(1 + rate, yearFrac(flow.date))
    }
    return sum
  }

  let rate = 0.1
  for (let i = 0; i < 60; i++) {
    let derivative = 0
    for (const flow of flows) {
      const y = yearFrac(flow.date)
      derivative += -y * flow.amount / Math.pow(1 + rate, y + 1)
    }
    if (derivative === 0 || !Number.isFinite(derivative)) break
    const next = rate - npv(rate) / derivative
    if (!Number.isFinite(next)) break
    if (Math.abs(next - rate) < 1e-9) return next
    rate = next > -0.999999 ? next : -0.999999
  }
  if (Number.isFinite(rate) && Math.abs(npv(rate)) < 1e-4) return rate

  let low = -0.999999
  let high = 10
  let npvLow = npv(low)
  let npvHigh = npv(high)
  for (let i = 0; i < 20 && npvLow * npvHigh > 0; i++) {
    high = high * 2 + 1
    npvHigh = npv(high)
  }
  if (npvLow * npvHigh > 0) return Number.isFinite(rate) ? rate : 0
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2
    const value = npv(mid)
    if (Math.abs(value) < 1e-8 || high - low < 1e-10) return mid
    if (npvLow * value < 0) {
      high = mid
    } else {
      low = mid
      npvLow = value
    }
  }
  return (low + high) / 2
}

function timeWeightedCagr(equity: readonly number[], contributions: readonly number[]): number {
  if (equity.length < 2) return 0
  let growth = 1
  let sessions = 0
  for (let i = 1; i < equity.length; i++) {
    const previous = equity[i - 1] ?? 0
    const current = equity[i] ?? 0
    const deposit = contributions[i] ?? 0
    if (previous <= 0) continue
    const ret = (current - deposit) / previous - 1
    if (!Number.isFinite(ret) || ret <= -1) return -1
    growth *= 1 + ret
    sessions += 1
  }
  if (sessions === 0) return 0
  return Math.pow(growth, TRADING_DAYS_PER_YEAR / sessions) - 1
}

function depositOn(index: number, every: number, weekly: number, initialCash: number): number {
  if (index === 0) return initialCash > 0 ? initialCash : weekly
  if (index % every === 0) return weekly
  return 0
}

interface SimState {
  cash: number
  levShares: number
  levCost: number
  fbShares: number
  fbCost: number
  contributed: number
  buysInLeveraged: number
  buysInFallback: number
  dollarsInLeveraged: number
  dollarsInFallback: number
  peakEquity: number
  maxDrawdown: number
  maxDrawdownDate: string
  troughValue: number
  equity: number[]
  deposits: number[]
  flows: PathCashFlow[]
}

function simulate(
  input: LeveragePathInput,
  leveragedPrices: readonly number[],
  useFallback: boolean
): PathStrategyResult {
  const dates = input.dates
  const fallbackCloses = input.fallbackCloses ?? input.underlyingCloses
  const firstDate = dates[0] ?? ''
  const every = input.contributionEvery ?? 5
  const weekly = input.weeklyContribution ?? 100
  const initialCash = input.initialCash ?? 0
  const threshold = input.drawdownThreshold ?? DEFAULT_FALLBACK_DRAWDOWN
  const maDays = input.maDays ?? DEFAULT_FALLBACK_MA_DAYS
  const history = (input.underlyingWarmup ?? []).slice()
  let peakPrice = leveragedPrices[0] ?? 0

  const book: SimState = {
    cash: 0,
    levShares: 0,
    levCost: 0,
    fbShares: 0,
    fbCost: 0,
    contributed: 0,
    buysInLeveraged: 0,
    buysInFallback: 0,
    dollarsInLeveraged: 0,
    dollarsInFallback: 0,
    peakEquity: 0,
    maxDrawdown: 0,
    maxDrawdownDate: firstDate,
    troughValue: 0,
    equity: [],
    deposits: [],
    flows: []
  }

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i] ?? firstDate
    const levPrice = leveragedPrices[i] ?? 0
    const fbPrice = fallbackCloses[i] ?? 0
    history.push(input.underlyingCloses[i] ?? 0)
    if (levPrice > peakPrice) peakPrice = levPrice
    const drawdownFromPeak = peakPrice > 0 ? (peakPrice - levPrice) / peakPrice : 0

    const deposit = depositOn(i, every, weekly, initialCash)
    book.deposits.push(deposit)
    if (deposit > 0) {
      book.cash += deposit
      book.contributed += deposit
      book.flows.push({ date, amount: -deposit })
    }

    const spend = input.scaledBuying
      ? scaledBuyAmount(input.scaledBuying, book.levCost, book.levShares * levPrice, book.cash)
      : deposit

    const decision = useFallback
      ? evaluateFallback(
        { enabled: true, drawdownThreshold: threshold, maDays, fallbackTicker: '1X' },
        { drawdownFromPeak, underlyingCloses: history }
      )
      : null
    const routeToFallback = decision?.active === true
    const price = routeToFallback ? fbPrice : levPrice
    if (spend > 0 && price > 0) {
      const shares = spend / price
      if (routeToFallback) {
        book.fbShares += shares
        book.fbCost += spend
        book.buysInFallback += 1
        book.dollarsInFallback += spend
      } else {
        book.levShares += shares
        book.levCost += spend
        book.buysInLeveraged += 1
        book.dollarsInLeveraged += spend
      }
      book.cash -= spend
    }

    const equity = book.cash + book.levShares * levPrice + book.fbShares * fbPrice
    book.equity.push(equity)
    if (equity > book.peakEquity) book.peakEquity = equity
    const dd = book.peakEquity > 0 ? (book.peakEquity - equity) / book.peakEquity : 0
    if (dd >= book.maxDrawdown) {
      book.maxDrawdown = dd
      book.maxDrawdownDate = date
      book.troughValue = equity
    }
  }

  const lastDate = dates[dates.length - 1] ?? firstDate
  const lastEquity = book.equity[book.equity.length - 1] ?? 0
  const lastLev = leveragedPrices[leveragedPrices.length - 1] ?? 0
  const lastFb = fallbackCloses[fallbackCloses.length - 1] ?? 0
  book.flows.push({ date: lastDate, amount: lastEquity })

  return {
    finalValue: lastEquity,
    cash: book.cash,
    leveragedValue: book.levShares * lastLev,
    fallbackValue: book.fbShares * lastFb,
    totalContributed: book.contributed,
    irr: xirr(book.flows),
    cagr: timeWeightedCagr(book.equity, book.deposits),
    maxDrawdown: book.maxDrawdown,
    maxDrawdownDate: book.maxDrawdownDate,
    troughValue: book.troughValue,
    buysInLeveraged: book.buysInLeveraged,
    buysInFallback: book.buysInFallback,
    dollarsInLeveraged: book.dollarsInLeveraged,
    dollarsInFallback: book.dollarsInFallback,
    usedMargin: false,
    equity: book.equity
  }
}

function simulateBenchmark(input: LeveragePathInput): PathStrategyResult {
  const dates = input.dates
  const firstDate = dates[0] ?? ''
  const every = input.contributionEvery ?? 5
  const weekly = input.weeklyContribution ?? 100
  const initialCash = input.initialCash ?? 0
  let shares = 0
  let cash = 0
  let contributed = 0
  const equity: number[] = []
  const deposits: number[] = []
  const flows: PathCashFlow[] = []
  let peak = 0
  let maxDd = 0
  let maxDdDate = firstDate
  let trough = 0

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i] ?? firstDate
    const price = input.benchmarkCloses[i] ?? 0
    const deposit = depositOn(i, every, weekly, initialCash)
    deposits.push(deposit)
    if (deposit > 0) {
      contributed += deposit
      flows.push({ date, amount: -deposit })
      if (price > 0) shares += deposit / price
      else cash += deposit
    }
    const value = cash + shares * price
    equity.push(value)
    if (value > peak) peak = value
    const dd = peak > 0 ? (peak - value) / peak : 0
    if (dd >= maxDd) {
      maxDd = dd
      maxDdDate = date
      trough = value
    }
  }

  const lastDate = dates[dates.length - 1] ?? firstDate
  const last = equity[equity.length - 1] ?? 0
  flows.push({ date: lastDate, amount: last })
  return {
    finalValue: last,
    cash,
    leveragedValue: 0,
    fallbackValue: last - cash,
    totalContributed: contributed,
    irr: xirr(flows),
    cagr: timeWeightedCagr(equity, deposits),
    maxDrawdown: maxDd,
    maxDrawdownDate: maxDdDate,
    troughValue: trough,
    buysInLeveraged: 0,
    buysInFallback: 0,
    dollarsInLeveraged: 0,
    dollarsInFallback: contributed - cash,
    usedMargin: false,
    equity
  }
}

/**
 * Same external cash, three destinations, no margin:
 * synthetic 3x only, 3x with new buys routed to 1x by the fallback rule,
 * and buy-and-hold of the benchmark.
 */
export function compareLeveragePaths(input: LeveragePathInput): LeveragePathComparison {
  if (input.dates.length === 0) {
    throw new Error('compareLeveragePaths requires at least one date')
  }
  if (input.dates.length !== input.underlyingCloses.length) {
    throw new Error('dates and underlyingCloses must be the same length')
  }
  if (input.dates.length !== input.benchmarkCloses.length) {
    throw new Error('dates and benchmarkCloses must be the same length')
  }
  const fallbackCloses = input.fallbackCloses ?? input.underlyingCloses
  if (fallbackCloses.length !== input.dates.length) {
    throw new Error('fallbackCloses must be the same length as dates')
  }

  const leveragedPrices = syntheticLeveragedPrices(input.underlyingCloses, {
    leverage: input.leverage ?? DEFAULT_LEVERAGE,
    expenseRatio: input.expenseRatio ?? DEFAULT_LEVERAGE_EXPENSE_RATIO,
    ...(input.closeAfterDrawdown !== undefined
      ? { closeAfterDrawdown: input.closeAfterDrawdown }
      : {})
  })
  const priceDd = maxDrawdown(leveragedPrices)
  const only3x = simulate(input, leveragedPrices, false)
  const fallback = simulate(input, leveragedPrices, true)
  const benchmark = simulateBenchmark(input)

  const chart: LeveragePathComparison['chart'] = []
  const step = Math.max(1, input.contributionEvery ?? 5)
  for (let i = 0; i < input.dates.length; i += step) {
    const date = input.dates[i]
    if (!date) continue
    chart.push({
      date,
      only3x: only3x.equity[i] ?? 0,
      fallback: fallback.equity[i] ?? 0,
      benchmark: benchmark.equity[i] ?? 0
    })
  }
  const last = input.dates.length - 1
  const lastDate = input.dates[last]
  if (lastDate && chart[chart.length - 1]?.date !== lastDate) {
    chart.push({
      date: lastDate,
      only3x: only3x.equity[last] ?? 0,
      fallback: fallback.equity[last] ?? 0,
      benchmark: benchmark.equity[last] ?? 0
    })
  }

  return {
    leveragedPrices,
    leveragedPriceMaxDrawdown: priceDd.drawdown,
    leveragedPriceTroughDate: input.dates[priceDd.troughIndex] ?? '',
    only3x,
    fallback,
    benchmark,
    chart
  }
}

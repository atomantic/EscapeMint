import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareLeveragePaths,
  computeRecommendation,
  defaultFallbackTicker,
  evaluateFallback,
  roundTripRemainder,
  syntheticLeveragedPrices,
  type SubFundConfig,
  type FundState
} from '../src/index.js'

interface DailySeries {
  symbol: string
  start: string
  end: string
  dates: string[]
  closes: number[]
}

interface Fixture {
  source: string
  notes: string[]
  ndx: DailySeries
  qqq: DailySeries
  sox: DailySeries
  soxx: DailySeries
  vtsmx: DailySeries
  vti: DailySeries
}

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/underlying-daily.json'), 'utf8')
) as Fixture

const SCALED = { inputMin: 100, inputMid: 250, inputMax: 500, maxAtPct: -0.25 }
const INITIAL_CASH = 10_000
const WEEKLY = 100

function asMap(series: DailySeries): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < series.dates.length; i++) {
    const date = series.dates[i]
    const close = series.closes[i]
    if (date !== undefined && close !== undefined) map.set(date, close)
  }
  return map
}

function sliceSeries(series: DailySeries, start: string, end: string) {
  const dates: string[] = []
  const closes: number[] = []
  const warmup: number[] = []
  for (let i = 0; i < series.dates.length; i++) {
    const date = series.dates[i]
    const close = series.closes[i]
    if (date === undefined || close === undefined) continue
    if (date < start) warmup.push(close)
    else if (date <= end) {
      dates.push(date)
      closes.push(close)
    }
  }
  return { dates, closes, warmup: warmup.slice(-260) }
}

/** Prefer VTI's own return once it has a previous close; otherwise VTSMX. */
function chainTotalMarket(dates: readonly string[], vti: Map<string, number>, vtsmx: Map<string, number>): number[] {
  const levels: number[] = []
  let level = 100
  for (let i = 0; i < dates.length; i++) {
    if (i > 0) {
      const prev = dates[i - 1]
      const date = dates[i]
      const v0 = prev ? vti.get(prev) : undefined
      const v1 = date ? vti.get(date) : undefined
      const s0 = prev ? vtsmx.get(prev) : undefined
      const s1 = date ? vtsmx.get(date) : undefined
      let ret = 0
      if (v0 !== undefined && v1 !== undefined && v0 > 0) ret = v1 / v0 - 1
      else if (s0 !== undefined && s1 !== undefined && s0 > 0) ret = s1 / s0 - 1
      level *= 1 + ret
    }
    levels.push(level)
  }
  return levels
}

function align(dates: readonly string[], map: Map<string, number>): number[] {
  const out: number[] = []
  let last: number | undefined
  for (const date of dates) {
    const value = map.get(date)
    if (value !== undefined) last = value
    if (last === undefined) throw new Error(`no aligned price on ${date}`)
    out.push(last)
  }
  return out
}

const baseConfig: SubFundConfig = {
  fund_size_usd: 10000,
  target_apy: 0.3,
  interval_days: 7,
  input_min_usd: 100,
  input_mid_usd: 200,
  input_max_usd: 400,
  max_at_pct: -0.25,
  min_profit_usd: 100,
  cash_apy: 0.04,
  margin_apr: 0,
  margin_access_usd: 0,
  margin_enabled: false,
  accumulate: true
}

function state(overrides: Partial<FundState> = {}): FundState {
  return {
    cash_available_usd: 5000,
    expected_target_usd: 1000,
    actual_value_usd: 1000,
    start_input_usd: 1000,
    gain_usd: 0,
    gain_pct: 0,
    target_diff_usd: 0,
    cash_interest_usd: 0,
    realized_gains_usd: 0,
    ...overrides
  }
}

describe('1x fallback rule', () => {
  it('maps the 3x funds onto 1x equivalents and stays off by default', () => {
    expect(defaultFallbackTicker('tqqq')).toBe('QQQ')
    expect(defaultFallbackTicker('SOXL')).toBe('SOXX')
    expect(defaultFallbackTicker('SPXL')).toBe('SPY')
    expect(defaultFallbackTicker('VTI')).toBeNull()

    const decision = evaluateFallback({ enabled: false, fallbackTicker: 'QQQ' }, {
      drawdownFromPeak: 0.9,
      underlyingCloses: Array.from({ length: 200 }, () => 50)
    })
    expect(decision.active).toBe(false)
    expect(decision.reason).toBe('disabled')
  })

  it('routes on a 60% drawdown or a close below the 200-day average, and rotates back when both clear', () => {
    const below = Array.from({ length: 199 }, () => 100).concat(90)
    const down = evaluateFallback(
      { enabled: true, fallbackTicker: 'QQQ' },
      { drawdownFromPeak: 0.1, underlyingCloses: below }
    )
    expect(down.active).toBe(true)
    expect(down.reason).toBe('below_ma')
    expect(down.routeTicker).toBe('QQQ')

    const deep = evaluateFallback(
      { enabled: true, drawdownThreshold: 0.6, fallbackTicker: 'SOXX' },
      { drawdownFromCost: 0.6, underlyingCloses: Array.from({ length: 200 }, () => 100) }
    )
    expect(deep.active).toBe(true)
    expect(deep.reason).toBe('drawdown')

    const recovered = evaluateFallback(
      { enabled: true, fallbackTicker: 'SPY' },
      { drawdownFromPeak: 0.59, underlyingCloses: Array.from({ length: 200 }, () => 100).concat(101) }
    )
    expect(recovered.active).toBe(false)
    expect(recovered.reason).toBe('inactive')
  })

  it('does not change an ordinary recommendation unless the rule is enabled', () => {
    const losing = state({ gain_usd: -700, gain_pct: -0.7, actual_value_usd: 300, start_input_usd: 1000 })
    const untouched = computeRecommendation(baseConfig, losing)
    expect(untouched?.action).toBe('BUY')
    expect(untouched?.route_ticker).toBeUndefined()
    expect(untouched?.amount).toBe(400)

    const routed = computeRecommendation(
      { ...baseConfig, fallback_enabled: true, fallback_ticker: 'QQQ' },
      losing
    )
    expect(routed?.action).toBe('BUY')
    expect(routed?.amount).toBe(400)
    expect(routed?.route_ticker).toBe('QQQ')
    expect(routed?.explanation.reasoning).toContain('Do not use margin')

    const custom = computeRecommendation(
      { ...baseConfig, fallback_enabled: true, fallback_ticker: 'VOO', fallback_drawdown_pct: 0.8 },
      losing
    )
    expect(custom?.route_ticker).toBeUndefined()
  })

  it('uses the moving average when underlying closes are supplied', () => {
    const flat = state()
    const closes = Array.from({ length: 199 }, () => 100).concat(90)
    const routed = computeRecommendation(
      { ...baseConfig, fallback_enabled: true, fallback_ticker: 'QQQ', fallback_ma_days: 200 },
      flat,
      { underlyingCloses: closes }
    )
    expect(routed?.route_ticker).toBe('QQQ')
    expect(routed?.explanation.reasoning).toContain('200-day')
  })
})

describe('synthetic 3x path', () => {
  it('shows volatility decay on a round trip that the underlying almost survives', () => {
    const decay = roundTripRemainder(0.1, 3, 0)
    expect(decay.underlying).toBeCloseTo(0.99, 10)
    expect(decay.leveraged).toBeCloseTo(0.91, 10)
    expect(decay.leveraged).toBeLessThan(decay.underlying)
  })

  it('stress-tests a theoretical one-day drop of one third, which zeroes the 3x price', () => {
    const calm = Array.from({ length: 20 }, () => 100)
    const wiped = syntheticLeveragedPrices([...calm, 100 * (2 / 3)])
    expect(wiped[wiped.length - 1]).toBe(0)

    const almost = syntheticLeveragedPrices([...calm, 67])
    const left = almost[almost.length - 1] ?? 1
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(2)
  })
})

describe('1999-2012 path versus VTI', () => {
  const vti = asMap(fixture.vti)
  const vtsmx = asMap(fixture.vtsmx)

  function runPair(underlying: DailySeries, fallback: DailySeries | null, start: string) {
    const sliced = sliceSeries(underlying, start, '2012-12-31')
    const fallbackCloses = fallback ? align(sliced.dates, asMap(fallback)) : sliced.closes
    const benchmarkCloses = chainTotalMarket(sliced.dates, vti, vtsmx)
    const shared = {
      dates: sliced.dates,
      underlyingCloses: sliced.closes,
      fallbackCloses,
      benchmarkCloses,
      underlyingWarmup: sliced.warmup,
      weeklyContribution: WEEKLY,
      contributionEvery: 5,
      initialCash: INITIAL_CASH
    }
    const flat = compareLeveragePaths(shared)
    const scaled = compareLeveragePaths({ ...shared, scaledBuying: SCALED })
    const closed = compareLeveragePaths({ ...shared, closeAfterDrawdown: 0.99 })
    return { flat, scaled, closed }
  }

  it('builds a Nasdaq-100 3x from real QQQ-era daily returns and compares the fallback', () => {
    expect(fixture.qqq.dates[0]).toBe('1999-03-10')
    const { flat, scaled, closed } = runPair(fixture.ndx, fixture.qqq, '1999-03-10')

    expect(flat.leveragedPriceMaxDrawdown).toBeCloseTo(0.999674, 5)
    expect(flat.leveragedPriceTroughDate).toBe('2009-03-09')
    expect(flat.only3x.totalContributed).toBe(79500)
    expect(flat.fallback.totalContributed).toBe(79500)
    expect(flat.benchmark.totalContributed).toBe(79500)
    expect(flat.only3x.finalValue).toBeCloseTo(98634.62, 0)
    expect(flat.fallback.finalValue).toBeCloseTo(100975.93, 0)
    expect(flat.benchmark.finalValue).toBeCloseTo(100925.18, 0)
    expect(flat.only3x.irr).toBeCloseTo(0.02725, 4)
    expect(flat.fallback.irr).toBeCloseTo(0.03015, 4)
    expect(flat.benchmark.irr).toBeCloseTo(0.03009, 4)
    expect(flat.only3x.cagr).toBeCloseTo(-0.2335, 3)
    expect(flat.benchmark.cagr).toBeCloseTo(0.0166, 3)
    expect(flat.only3x.maxDrawdown).toBeCloseTo(0.98919, 4)
    expect(flat.fallback.maxDrawdown).toBeCloseTo(0.97223, 4)
    expect(flat.benchmark.maxDrawdown).toBeCloseTo(0.50970, 4)
    expect(flat.only3x.maxDrawdownDate).toBe('2001-09-21')
    expect(flat.benchmark.maxDrawdownDate).toBe('2009-03-09')
    expect(flat.fallback.dollarsInFallback).toBe(63600)
    expect(flat.only3x.dollarsInFallback).toBe(0)
    expect(flat.only3x.usedMargin).toBe(false)
    expect(flat.fallback.usedMargin).toBe(false)
    expect(flat.benchmark.usedMargin).toBe(false)
    expect(scaled.only3x.usedMargin).toBe(false)
    expect(scaled.fallback.finalValue).toBeCloseTo(100972, 0)
    expect(scaled.only3x.finalValue).toBeCloseTo(98630.37, 0)
    expect(scaled.fallback.maxDrawdown).toBeLessThan(scaled.only3x.maxDrawdown)
    // Issuer closure: freeze the 3x once it is 99% off its peak. The rebound does not arrive.
    expect(closed.only3x.finalValue).toBeCloseTo(60445.53, 0)
    expect(closed.fallback.finalValue).toBeCloseTo(101474.61, 0)
    expect(closed.benchmark.finalValue).toBeCloseTo(100925.18, 0)
    expect(closed.fallback.finalValue).toBeGreaterThan(closed.only3x.finalValue * 1.5)
    expect(closed.fallback.usedMargin).toBe(false)
  })

  it('builds a semiconductor 3x from the PHLX index and compares the fallback', () => {
    expect(fixture.sox.dates[0] < '1999-01-04').toBe(true)
    expect(fixture.soxx.dates[0]).toBe('2001-07-13')
    const { flat, scaled, closed } = runPair(fixture.sox, null, '1999-01-04')

    expect(flat.leveragedPriceMaxDrawdown).toBeCloseTo(0.999993, 5)
    expect(flat.leveragedPriceTroughDate).toBe('2008-11-20')
    expect(flat.only3x.totalContributed).toBe(80400)
    expect(flat.fallback.totalContributed).toBe(80400)
    expect(flat.benchmark.totalContributed).toBe(80400)
    expect(flat.only3x.finalValue).toBeCloseTo(22393.57, 0)
    expect(flat.fallback.finalValue).toBeCloseTo(60819.07, 0)
    expect(flat.benchmark.finalValue).toBeCloseTo(102554.52, 0)
    expect(flat.fallback.finalValue).toBeGreaterThan(flat.only3x.finalValue * 2)
    expect(flat.only3x.irr).toBeCloseTo(-0.1968, 3)
    expect(flat.fallback.irr).toBeCloseTo(-0.0366, 3)
    expect(flat.benchmark.irr).toBeCloseTo(0.0303, 3)
    expect(flat.only3x.maxDrawdown).toBeCloseTo(0.99779, 4)
    expect(flat.fallback.maxDrawdown).toBeCloseTo(0.98714, 4)
    expect(flat.benchmark.maxDrawdown).toBeCloseTo(0.51102, 4)
    expect(flat.only3x.usedMargin).toBe(false)
    expect(flat.fallback.usedMargin).toBe(false)
    expect(scaled.fallback.maxDrawdown).toBeLessThan(scaled.only3x.maxDrawdown)
    expect(scaled.fallback.usedMargin).toBe(false)
    expect(closed.fallback.usedMargin).toBe(false)
  })

  it('keeps later contributions in the 1x fund after a theoretical one-day wipeout', () => {
    const calm = Array.from({ length: 210 }, () => 100)
    // One-third drop wipes the 3x fund. The index then climbs back; the 3x price stays at 0.
    const recovery = Array.from({ length: 20 }, (_, i) => (100 * 2) / 3 + (100 / 3) * ((i + 1) / 20))
    const underlying = [...calm, (100 * 2) / 3, ...recovery]
    const dates = underlying.map((_, index) => {
      const day = new Date(Date.UTC(2001, 0, 1))
      day.setUTCDate(day.getUTCDate() + index)
      return day.toISOString().slice(0, 10)
    })
    const result = compareLeveragePaths({
      dates,
      underlyingCloses: underlying,
      benchmarkCloses: underlying,
      underlyingWarmup: Array.from({ length: 200 }, () => 100),
      weeklyContribution: 100,
      contributionEvery: 5,
      initialCash: 0
    })
    expect(result.leveragedPrices[result.leveragedPrices.length - 1]).toBe(0)
    expect(result.leveragedPriceMaxDrawdown).toBeGreaterThan(0.99)
    expect(result.only3x.leveragedValue).toBe(0)
    expect(result.fallback.fallbackValue).toBeGreaterThan(0)
    expect(result.fallback.finalValue).toBeGreaterThan(result.only3x.finalValue)
    expect(result.only3x.usedMargin).toBe(false)
    expect(result.fallback.usedMargin).toBe(false)
    expect(result.only3x.finalValue).toBeCloseTo(500, 0)
    expect(result.fallback.finalValue).toBeCloseTo(612.42, 0)
    expect(result.benchmark.finalValue).toBeCloseTo(4812.42, 0)
    expect(result.only3x.maxDrawdown).toBeCloseTo(0.9761, 3)
    expect(result.benchmark.maxDrawdown).toBeCloseTo(0.3095, 3)
  })
})

/**
 * Build the intro-guide chart for the 1999-2012 leveraged path.
 * Uses the same engine function and Yahoo Finance daily fixture as the tests.
 *
 * Run: npx tsx scripts/build-path-risk-chart.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareLeveragePaths } from '../packages/engine/src/leverage-path.ts'

interface DailySeries {
  symbol: string
  dates: string[]
  closes: number[]
}

interface Fixture {
  source: string
  ndx: DailySeries
  qqq: DailySeries
  vti: DailySeries
  vtsmx: DailySeries
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(
  readFileSync(join(root, 'packages/engine/test/fixtures/underlying-daily.json'), 'utf8')
) as Fixture

function asMap(series: DailySeries): Map<string, number> {
  const map = new Map<string, number>()
  series.dates.forEach((date, index) => {
    const close = series.closes[index]
    if (close !== undefined) map.set(date, close)
  })
  return map
}

const ndx = fixture.ndx
const dates: string[] = []
const underlying: number[] = []
const warmup: number[] = []
for (let i = 0; i < ndx.dates.length; i++) {
  const date = ndx.dates[i]
  const close = ndx.closes[i]
  if (date === undefined || close === undefined) continue
  if (date < '1999-03-10') warmup.push(close)
  else if (date <= '2012-12-31') {
    dates.push(date)
    underlying.push(close)
  }
}

const qqq = asMap(fixture.qqq)
let lastQqq = qqq.get(dates[0] ?? '') ?? 0
const fallbackCloses = dates.map(date => {
  const value = qqq.get(date)
  if (value !== undefined) lastQqq = value
  return lastQqq
})

const vti = asMap(fixture.vti)
const vtsmx = asMap(fixture.vtsmx)
const benchmark: number[] = []
let level = 100
for (let i = 0; i < dates.length; i++) {
  if (i > 0) {
    const prev = dates[i - 1] ?? ''
    const date = dates[i] ?? ''
    const v0 = vti.get(prev)
    const v1 = vti.get(date)
    const s0 = vtsmx.get(prev)
    const s1 = vtsmx.get(date)
    let ret = 0
    if (v0 !== undefined && v1 !== undefined && v0 > 0) ret = v1 / v0 - 1
    else if (s0 !== undefined && s1 !== undefined && s0 > 0) ret = s1 / s0 - 1
    level *= 1 + ret
  }
  benchmark.push(level)
}

const result = compareLeveragePaths({
  dates,
  underlyingCloses: underlying,
  fallbackCloses,
  benchmarkCloses: benchmark,
  underlyingWarmup: warmup.slice(-260),
  weeklyContribution: 100,
  contributionEvery: 5,
  initialCash: 10000
})

const round = (value: number) => Math.round(value * 100) / 100
const chart = {
  source: fixture.source,
  scenario: 'Synthetic Nasdaq-100 3x (daily reset, 0.9%/year expense) vs QQQ fallback vs VTI, 1999-03-10 to 2012-12-31',
  contribution: '$10,000 on the first session, then $100 every 5 trading days. No margin.',
  summary: {
    contributed: result.only3x.totalContributed,
    priceMaxDrawdown: result.leveragedPriceMaxDrawdown,
    priceTroughDate: result.leveragedPriceTroughDate,
    only3x: {
      finalValue: round(result.only3x.finalValue),
      irr: result.only3x.irr,
      cagr: result.only3x.cagr,
      maxDrawdown: result.only3x.maxDrawdown
    },
    fallback: {
      finalValue: round(result.fallback.finalValue),
      irr: result.fallback.irr,
      cagr: result.fallback.cagr,
      maxDrawdown: result.fallback.maxDrawdown
    },
    vti: {
      finalValue: round(result.benchmark.finalValue),
      irr: result.benchmark.irr,
      cagr: result.benchmark.cagr,
      maxDrawdown: result.benchmark.maxDrawdown
    }
  },
  points: result.chart.map(point => ({
    date: point.date,
    only3x: round(point.only3x),
    fallback: round(point.fallback),
    vti: round(point.benchmark)
  }))
}

const out = join(root, 'pages/src/data/path-risk-chart.json')
writeFileSync(out, JSON.stringify(chart))
console.log(`Wrote ${chart.points.length} points to ${out}`)
console.log(JSON.stringify(chart.summary, null, 2))

/**
 * Fetch real prices for the leveraged-ETF path-risk work.
 *
 * Source: Yahoo Finance chart API
 *   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 * Unadjusted session close (`indicators.quote.close`), which is split-adjusted
 * by Yahoo but not dividend-adjusted. Daily-reset leverage tracks the price
 * index, so dividend-adjusted closes are not used for the synthetic 3x series.
 *
 * Writes:
 *   packages/server/src/data/{qqq,soxx,soxl}-weekly.json
 *     Wednesday OHLCV in the same shape as tqqq-weekly.json, aligned to that file's dates
 *   pages/public/data and packages/web/public/data
 *     HistoricalData documents consumed by the intro and backtest
 *   packages/engine/test/fixtures/underlying-daily.json
 *     Daily closes from 1998-01-01 through 2012-12-31 for the path-risk tests
 *
 * Run: npx tsx scripts/fetch-leverage-sample-data.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

interface Ohlcv {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface YahooSeries {
  symbol: string
  bars: Ohlcv[]
}

const SOURCE =
  'Yahoo Finance chart API (query1.finance.yahoo.com/v8/finance/chart), session close. Retrieved 2026-10-25.'

async function fetchYahoo(symbol: string, period1: number, period2: number): Promise<YahooSeries> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`
  process.stdout.write(`Fetching ${symbol}...\n`)
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EscapeMint/1.0; research)'
    }
  })
  if (!response.ok) {
    throw new Error(`${symbol}: Yahoo Finance ${response.status} ${response.statusText}`)
  }
  const json = await response.json() as {
    chart?: {
      result?: Array<{
        timestamp?: number[]
        indicators?: { quote?: Array<Record<string, Array<number | null>>> }
      }>
      error?: { description?: string }
    }
  }
  const result = json.chart?.result?.[0]
  if (!result?.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error(`${symbol}: ${json.chart?.error?.description ?? 'empty chart result'}`)
  }
  const quote = result.indicators.quote[0]
  const bars: Ohlcv[] = []
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = quote.close?.[i]
    const open = quote.open?.[i]
    const high = quote.high?.[i]
    const low = quote.low?.[i]
    const ts = result.timestamp[i]
    if (close == null || open == null || high == null || low == null || ts == null) continue
    const date = new Date(ts * 1000).toISOString().slice(0, 10)
    bars.push({
      date,
      open,
      high,
      low,
      close,
      volume: quote.volume?.[i] ?? 0
    })
  }
  bars.sort((a, b) => a.date.localeCompare(b.date))
  process.stdout.write(`  ${symbol}: ${bars.length} sessions ${bars[0]?.date ?? '?'} → ${bars.at(-1)?.date ?? '?'}\n`)
  return { symbol, bars }
}

function nearestBar(bars: Ohlcv[], date: string): Ohlcv | undefined {
  const exact = bars.find(bar => bar.date === date)
  if (exact) return exact
  const target = Date.parse(`${date}T00:00:00Z`)
  let best: Ohlcv | undefined
  let bestDiff = Infinity
  for (const bar of bars) {
    const diff = Math.abs(Date.parse(`${bar.date}T00:00:00Z`) - target)
    if (diff < bestDiff && diff <= 4 * 24 * 60 * 60 * 1000) {
      bestDiff = diff
      best = bar
    }
  }
  return best
}

function minDailyReturn(bars: Ohlcv[]): { date: string; ret: number } | null {
  let worst: { date: string; ret: number } | null = null
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]
    const cur = bars[i]
    if (!prev || !cur || prev.close <= 0) continue
    const ret = cur.close / prev.close - 1
    if (!worst || ret < worst.ret) worst = { date: cur.date, ret }
  }
  return worst
}

function writeHistorical(ticker: string, name: string, prices: Array<{ date: string; value: number }>) {
  const doc = {
    ticker,
    name,
    type: 'stock' as const,
    startDate: prices[0]?.date ?? '',
    endDate: prices.at(-1)?.date ?? '',
    dataPoints: prices.length,
    source: SOURCE,
    prices
  }
  const body = JSON.stringify(doc, null, 2)
  for (const dir of [
    join(root, 'pages/public/data'),
    join(root, 'packages/web/public/data')
  ]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ticker.toLowerCase()}-weekly.json`), body)
  }
}

async function main() {
  const dailyStart = Math.floor(Date.UTC(1998, 0, 1) / 1000)
  const dailyEnd = Math.floor(Date.UTC(2013, 0, 1) / 1000)
  const recentStart = Math.floor(Date.UTC(2020, 11, 1) / 1000)
  const recentEnd = Math.floor(Date.UTC(2026, 0, 23) / 1000)

  const [ndx, qqq, sox, soxx, soxl, vtsmx, vti, qqqRecent, soxxRecent, soxlRecent] = await Promise.all([
    fetchYahoo('^NDX', dailyStart, dailyEnd),
    fetchYahoo('QQQ', dailyStart, dailyEnd),
    fetchYahoo('^SOX', dailyStart, dailyEnd),
    fetchYahoo('SOXX', dailyStart, dailyEnd),
    fetchYahoo('SOXL', dailyStart, dailyEnd),
    fetchYahoo('VTSMX', dailyStart, dailyEnd),
    fetchYahoo('VTI', dailyStart, dailyEnd),
    fetchYahoo('QQQ', recentStart, recentEnd),
    fetchYahoo('SOXX', recentStart, recentEnd),
    fetchYahoo('SOXL', recentStart, recentEnd)
  ])

  for (const series of [ndx, qqq, sox, soxx, vtsmx, vti]) {
    const worst = minDailyReturn(series.bars)
    if (worst) {
      process.stdout.write(`  worst day ${series.symbol}: ${(worst.ret * 100).toFixed(2)}% on ${worst.date}\n`)
    }
  }

  const calendar: Array<{ date: string }> = JSON.parse(
    readFileSync(join(root, 'packages/server/src/data/tqqq-weekly.json'), 'utf8')
  )
  const serverDir = join(root, 'packages/server/src/data')
  const weeklySpecs = [
    { file: 'qqq-weekly.json', series: qqqRecent, ticker: 'QQQ', name: 'Invesco QQQ Trust' },
    { file: 'soxx-weekly.json', series: soxxRecent, ticker: 'SOXX', name: 'iShares Semiconductor ETF' },
    { file: 'soxl-weekly.json', series: soxlRecent, ticker: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares' }
  ]
  for (const spec of weeklySpecs) {
    const rows: Ohlcv[] = []
    const missing: string[] = []
    for (const point of calendar) {
      const bar = nearestBar(spec.series.bars, point.date)
      if (!bar) {
        missing.push(point.date)
        continue
      }
      rows.push({ ...bar, date: point.date })
    }
    if (missing.length > 0) {
      throw new Error(`${spec.ticker} missing ${missing.length} weeks, first ${missing[0]}`)
    }
    writeFileSync(join(serverDir, spec.file), JSON.stringify(rows, null, 2))
    writeHistorical(
      spec.ticker,
      spec.name,
      rows.map(row => ({ date: row.date, value: row.close }))
    )
    process.stdout.write(`Wrote ${spec.ticker}: ${rows.length} weekly bars ${rows[0]?.date} → ${rows.at(-1)?.date}\n`)
  }

  const clip = (bars: Ohlcv[]) => bars.filter(bar => bar.date >= '1998-01-01' && bar.date <= '2012-12-31')
  const pack = (series: YahooSeries) => {
    const bars = clip(series.bars)
    return {
      symbol: series.symbol,
      start: bars[0]?.date ?? '',
      end: bars.at(-1)?.date ?? '',
      dates: bars.map(bar => bar.date),
      closes: bars.map(bar => bar.close)
    }
  }

  const fixture = {
    source: SOURCE,
    notes: [
      'Daily session closes used to build synthetic 3x series and the 1x fallback backtests.',
      '^NDX is the Nasdaq-100 price index (TQQQ underlying). QQQ is the 1x ETF.',
      '^SOX is the PHLX Semiconductor Sector Index. SOXX (1x ETF) listed 2001-07-10, so 1999-2001 uses the index.',
      'VTI listed 2001-05-24. VTSMX is the Vanguard Total Stock Market mutual fund (same portfolio, listed 1992) used before VTI exists.',
      'Closes are Yahoo session closes (split-adjusted, not dividend-adjusted).'
    ],
    ndx: pack(ndx),
    qqq: pack(qqq),
    sox: pack(sox),
    soxx: pack(soxx),
    vtsmx: pack(vtsmx),
    vti: pack(vti),
    soxlFirst: soxl.bars[0]?.date ?? null
  }
  const fixtureDir = join(root, 'packages/engine/test/fixtures')
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(join(fixtureDir, 'underlying-daily.json'), JSON.stringify(fixture))
  process.stdout.write(`Wrote daily fixture (${Object.keys(fixture).length} series fields)\n`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPXL_DIVIDENDS, TQQQ_DIVIDENDS, SPY_DIVIDENDS, BRGNX_DIVIDENDS, VTI_DIVIDENDS, GLD_DIVIDENDS, SLV_DIVIDENDS, type DividendPayment } from '../../packages/server/src/data/dividends.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface OHLCVPoint {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface PricePoint {
  date: string
  value: number
}

interface HistoricalData {
  ticker: string
  name: string
  type: 'stock' | 'crypto'
  startDate: string
  endDate: string
  dataPoints: number
  prices: PricePoint[]
  dividends?: DividendPayment[]
  source?: string
}

const YAHOO_SESSION_CLOSE_SOURCE =
  'Yahoo Finance chart API (query1.finance.yahoo.com/v8/finance/chart), session close. Retrieved 2026-10-25.'

async function loadOHLCVData(jsonPath: string): Promise<PricePoint[]> {
  const content = await readFile(jsonPath, 'utf-8')
  const ohlcvData: OHLCVPoint[] = JSON.parse(content)

  return ohlcvData
    .filter(p => p.close > 0 && p.date)
    .map(p => ({
      date: p.date,
      value: p.close
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

async function buildHistoricalData() {
  const serverDataDir = resolve(__dirname, '../../packages/server/src/data')
  const outputDir = resolve(__dirname, '../public/data')

  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Process SPXL (3x S&P 500)
  console.log('Processing SPXL data from server weekly data...')
  const spxlPrices = await loadOHLCVData(resolve(serverDataDir, 'spxl-weekly.json'))
  if (spxlPrices.length === 0) {
    throw new Error('No valid SPXL data found')
  }

  const spxlData: HistoricalData = {
    ticker: 'SPXL',
    name: 'Direxion Daily S&P 500 Bull 3X Shares',
    type: 'stock',
    startDate: spxlPrices[0].date,
    endDate: spxlPrices[spxlPrices.length - 1].date,
    dataPoints: spxlPrices.length,
    prices: spxlPrices,
    dividends: SPXL_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'spxl-weekly.json'),
    JSON.stringify(spxlData, null, 2)
  )
  console.log(`✓ SPXL: ${spxlData.dataPoints} points (${spxlData.startDate} to ${spxlData.endDate})`)

  // Process SPY (S&P 500)
  console.log('Processing SPY data from server weekly data...')
  const spyPrices = await loadOHLCVData(resolve(serverDataDir, 'spy-weekly.json'))
  if (spyPrices.length === 0) {
    throw new Error('No valid SPY data found')
  }

  const spyData: HistoricalData = {
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    type: 'stock',
    startDate: spyPrices[0].date,
    endDate: spyPrices[spyPrices.length - 1].date,
    dataPoints: spyPrices.length,
    prices: spyPrices,
    dividends: SPY_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'spy-weekly.json'),
    JSON.stringify(spyData, null, 2)
  )
  console.log(`✓ SPY: ${spyData.dataPoints} points (${spyData.startDate} to ${spyData.endDate})`)

  // Process VTI (Total US Stock Market)
  console.log('Processing VTI data from server weekly data...')
  const vtiPrices = await loadOHLCVData(resolve(serverDataDir, 'vti-weekly.json'))
  if (vtiPrices.length === 0) {
    throw new Error('No valid VTI data found')
  }

  const vtiData: HistoricalData = {
    ticker: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    type: 'stock',
    startDate: vtiPrices[0].date,
    endDate: vtiPrices[vtiPrices.length - 1].date,
    dataPoints: vtiPrices.length,
    prices: vtiPrices,
    dividends: VTI_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'vti-weekly.json'),
    JSON.stringify(vtiData, null, 2)
  )
  console.log(`✓ VTI: ${vtiData.dataPoints} points (${vtiData.startDate} to ${vtiData.endDate})`)

  // Process TQQQ (3x NASDAQ)
  console.log('Processing TQQQ data from server weekly data...')
  const tqqqPrices = await loadOHLCVData(resolve(serverDataDir, 'tqqq-weekly.json'))
  if (tqqqPrices.length === 0) {
    throw new Error('No valid TQQQ data found')
  }

  const tqqqData: HistoricalData = {
    ticker: 'TQQQ',
    name: 'ProShares UltraPro QQQ',
    type: 'stock',
    startDate: tqqqPrices[0].date,
    endDate: tqqqPrices[tqqqPrices.length - 1].date,
    dataPoints: tqqqPrices.length,
    prices: tqqqPrices,
    dividends: TQQQ_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'tqqq-weekly.json'),
    JSON.stringify(tqqqData, null, 2)
  )
  console.log(`✓ TQQQ: ${tqqqData.dataPoints} points (${tqqqData.startDate} to ${tqqqData.endDate})`)

  // Process BRGNX (Russell 1000 - SPXL comparison baseline)
  console.log('Processing BRGNX data from server weekly data...')
  const brgnxPrices = await loadOHLCVData(resolve(serverDataDir, 'brgnx-weekly.json'))
  if (brgnxPrices.length === 0) {
    throw new Error('No valid BRGNX data found')
  }

  const brgnxData: HistoricalData = {
    ticker: 'BRGNX',
    name: 'BlackRock Russell 1000 Index Fund',
    type: 'stock',
    startDate: brgnxPrices[0].date,
    endDate: brgnxPrices[brgnxPrices.length - 1].date,
    dataPoints: brgnxPrices.length,
    prices: brgnxPrices,
    dividends: BRGNX_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'brgnx-weekly.json'),
    JSON.stringify(brgnxData, null, 2)
  )
  console.log(`✓ BRGNX: ${brgnxData.dataPoints} points (${brgnxData.startDate} to ${brgnxData.endDate})`)

  // Process BTC
  console.log('Processing BTC data from server weekly data...')
  const btcPrices = await loadOHLCVData(resolve(serverDataDir, 'btcusd-weekly.json'))
  if (btcPrices.length === 0) {
    throw new Error('No valid BTC data found')
  }

  const btcData: HistoricalData = {
    ticker: 'BTC',
    name: 'Bitcoin',
    type: 'crypto',
    startDate: btcPrices[0].date,
    endDate: btcPrices[btcPrices.length - 1].date,
    dataPoints: btcPrices.length,
    prices: btcPrices
  }
  await writeFile(
    resolve(outputDir, 'btc-weekly.json'),
    JSON.stringify(btcData, null, 2)
  )
  console.log(`✓ BTC: ${btcData.dataPoints} points (${btcData.startDate} to ${btcData.endDate})`)

  // Process GLD (Gold ETF)
  console.log('Processing GLD data from server weekly data...')
  const gldPrices = await loadOHLCVData(resolve(serverDataDir, 'gld-weekly.json'))
  if (gldPrices.length === 0) {
    throw new Error('No valid GLD data found')
  }

  const gldData: HistoricalData = {
    ticker: 'GLD',
    name: 'SPDR Gold Shares',
    type: 'stock',
    startDate: gldPrices[0].date,
    endDate: gldPrices[gldPrices.length - 1].date,
    dataPoints: gldPrices.length,
    prices: gldPrices,
    dividends: GLD_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'gld-weekly.json'),
    JSON.stringify(gldData, null, 2)
  )
  console.log(`✓ GLD: ${gldData.dataPoints} points (${gldData.startDate} to ${gldData.endDate})`)

  // Process SLV (Silver ETF)
  console.log('Processing SLV data from server weekly data...')
  const slvPrices = await loadOHLCVData(resolve(serverDataDir, 'slv-weekly.json'))
  if (slvPrices.length === 0) {
    throw new Error('No valid SLV data found')
  }

  const slvData: HistoricalData = {
    ticker: 'SLV',
    name: 'iShares Silver Trust',
    type: 'stock',
    startDate: slvPrices[0].date,
    endDate: slvPrices[slvPrices.length - 1].date,
    dataPoints: slvPrices.length,
    prices: slvPrices,
    dividends: SLV_DIVIDENDS
  }
  await writeFile(
    resolve(outputDir, 'slv-weekly.json'),
    JSON.stringify(slvData, null, 2)
  )
  console.log(`✓ SLV: ${slvData.dataPoints} points (${slvData.startDate} to ${slvData.endDate})`)

  const priceOnly = [
    { file: 'qqq-weekly.json', ticker: 'QQQ', name: 'Invesco QQQ Trust' },
    { file: 'soxx-weekly.json', ticker: 'SOXX', name: 'iShares Semiconductor ETF' },
    { file: 'soxl-weekly.json', ticker: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares' }
  ]
  for (const spec of priceOnly) {
    console.log(`Processing ${spec.ticker} data from server weekly data...`)
    const prices = await loadOHLCVData(resolve(serverDataDir, spec.file))
    const first = prices[0]
    const last = prices[prices.length - 1]
    if (!first || !last) throw new Error(`No valid ${spec.ticker} data found`)
    const data: HistoricalData = {
      ticker: spec.ticker,
      name: spec.name,
      type: 'stock',
      startDate: first.date,
      endDate: last.date,
      dataPoints: prices.length,
      prices,
      source: YAHOO_SESSION_CLOSE_SOURCE
    }
    const body = JSON.stringify(data, null, 2)
    await writeFile(resolve(outputDir, spec.file), body)
    await writeFile(resolve(__dirname, '../../packages/web/public/data', spec.file), body)
    console.log(`✓ ${spec.ticker}: ${data.dataPoints} points (${data.startDate} to ${data.endDate})`)
  }

  console.log('\n✓ Historical data built successfully!')
}

buildHistoricalData().catch((error) => {
  console.error('Error building historical data:', error)
  process.exit(1)
})

import type { HistoricalData, PricePoint, DateRange, DividendPayment } from './types'

function findNearestPrice(prices: PricePoint[], targetDate: string): number | undefined {
  const exact = prices.find(p => p.date === targetDate)
  if (exact) return exact.value

  const target = new Date(targetDate).getTime()
  let nearest: PricePoint | undefined
  let minDiff = Infinity

  for (const p of prices) {
    const diff = Math.abs(new Date(p.date).getTime() - target)
    if (diff < minDiff && diff <= 7 * 24 * 60 * 60 * 1000) {
      minDiff = diff
      nearest = p
    }
  }

  return nearest?.value
}

function buildPriceMap(prices: PricePoint[]): (date: string) => number | undefined {
  const exactMap = new Map(prices.map(p => [p.date, p.value]))
  return (date: string) => {
    const exact = exactMap.get(date)
    if (exact !== undefined) return exact
    return findNearestPrice(prices, date)
  }
}

export interface Allocation {
  SPXL: number
  VTI: number
  BRGNX: number
  TQQQ: number
  BTC: number
  GLD: number
  SLV: number
}

export interface BlendedPriceResult {
  prices: PricePoint[]
  startingPrices: {
    SPXL: number
    VTI: number
    BRGNX: number
    TQQQ: number
    BTC: number
    GLD: number
    SLV: number
  }
  dividends: {
    SPXL: DividendPayment[]
    VTI: DividendPayment[]
    BRGNX: DividendPayment[]
    TQQQ: DividendPayment[]
    GLD: DividendPayment[]
    SLV: DividendPayment[]
  }
}

export function blendPricesWithDividends(
  historicalData: Record<string, HistoricalData>,
  allocation: Allocation,
  dateRange: DateRange
): BlendedPriceResult {
  const spxl = historicalData['SPXL']!.prices
  const vti = historicalData['VTI']!.prices
  const brgnx = historicalData['BRGNX']!.prices
  const tqqq = historicalData['TQQQ']!.prices
  const btc = historicalData['BTC']!.prices
  const gld = historicalData['GLD']!.prices
  const slv = historicalData['SLV']!.prices

  const spxlMap = new Map(spxl.map(p => [p.date, p.value]))
  const vtiLookup = buildPriceMap(vti)
  const brgnxMap = new Map(brgnx.map(p => [p.date, p.value]))
  const tqqqMap = new Map(tqqq.map(p => [p.date, p.value]))
  const btcMap = new Map(btc.map(p => [p.date, p.value]))
  const gldMap = new Map(gld.map(p => [p.date, p.value]))
  const slvMap = new Map(slv.map(p => [p.date, p.value]))

  const dates = spxl
    .map(p => p.date)
    .filter(d => d >= dateRange.start && d <= dateRange.end)

  if (dates.length === 0) {
    return {
      prices: [],
      startingPrices: { SPXL: 1, VTI: 1, BRGNX: 1, TQQQ: 1, BTC: 1, GLD: 1, SLV: 1 },
      dividends: { SPXL: [], VTI: [], BRGNX: [], TQQQ: [], GLD: [], SLV: [] }
    }
  }

  const firstDate = dates[0]!
  const spxlStart = spxlMap.get(firstDate) || 1
  const vtiStart = vtiLookup(firstDate) || 1
  const brgnxStart = brgnxMap.get(firstDate) || 1
  const tqqqStart = tqqqMap.get(firstDate) || 1
  const btcStart = btcMap.get(firstDate) || 1
  const gldStart = gldMap.get(firstDate) || 1
  const slvStart = slvMap.get(firstDate) || 1

  const spxlDividends = (historicalData['SPXL']!.dividends || [])
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const vtiDividends = (historicalData['VTI']!.dividends || [])
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const brgnxDividends = (historicalData['BRGNX']!.dividends || [])
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const tqqqDividends = (historicalData['TQQQ']!.dividends || [])
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const gldDividends = (historicalData['GLD']!.dividends || [])
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const slvDividends = (historicalData['SLV']!.dividends || [])
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)

  const prices = dates.map(date => {
    const spxlNorm = ((spxlMap.get(date) || 0) / spxlStart) * 100
    const vtiNorm = ((vtiLookup(date) || 0) / vtiStart) * 100
    const brgnxNorm = ((brgnxMap.get(date) || 0) / brgnxStart) * 100
    const tqqqNorm = ((tqqqMap.get(date) || 0) / tqqqStart) * 100
    const btcNorm = ((btcMap.get(date) || 0) / btcStart) * 100
    const gldNorm = ((gldMap.get(date) || 0) / gldStart) * 100
    const slvNorm = ((slvMap.get(date) || 0) / slvStart) * 100

    const blendedValue =
      (spxlNorm * allocation.SPXL) +
      (vtiNorm * allocation.VTI) +
      (brgnxNorm * allocation.BRGNX) +
      (tqqqNorm * allocation.TQQQ) +
      (btcNorm * allocation.BTC) +
      (gldNorm * allocation.GLD) +
      (slvNorm * allocation.SLV)

    return { date, value: blendedValue }
  })

  return {
    prices,
    startingPrices: {
      SPXL: spxlStart,
      VTI: vtiStart,
      BRGNX: brgnxStart,
      TQQQ: tqqqStart,
      BTC: btcStart,
      GLD: gldStart,
      SLV: slvStart
    },
    dividends: {
      SPXL: spxlDividends,
      VTI: vtiDividends,
      BRGNX: brgnxDividends,
      TQQQ: tqqqDividends,
      GLD: gldDividends,
      SLV: slvDividends
    }
  }
}

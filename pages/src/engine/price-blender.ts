import type { HistoricalData, PricePoint, DateRange, DividendPayment } from '../data/types'

// Helper to find the nearest price for a date when exact match doesn't exist
// This handles cases where different assets have different weekly intervals
function findNearestPrice(prices: PricePoint[], targetDate: string): number | undefined {
  // First try exact match
  const exact = prices.find(p => p.date === targetDate)
  if (exact) return exact.value

  // Find nearest date within 7 days
  const target = new Date(targetDate).getTime()
  let nearest: PricePoint | undefined
  let minDiff = Infinity

  for (const p of prices) {
    const diff = Math.abs(new Date(p.date).getTime() - target)
    if (diff < minDiff && diff <= 7 * 24 * 60 * 60 * 1000) { // within 7 days
      minDiff = diff
      nearest = p
    }
  }

  return nearest?.value
}

// Build a map that also supports nearest-date lookup
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
  QQQ?: number
  SOXX?: number
  SOXL?: number
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
    QQQ: number
    SOXX: number
    SOXL: number
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

export function blendPrices(
  historicalData: Record<string, HistoricalData>,
  allocation: Allocation,
  dateRange: DateRange
): PricePoint[] {
  return blendPricesWithDividends(historicalData, allocation, dateRange).prices
}

export function blendPricesWithDividends(
  historicalData: Record<string, HistoricalData>,
  allocation: Allocation,
  dateRange: DateRange
): BlendedPriceResult {
  const spxl = historicalData.SPXL.prices
  const vti = historicalData.VTI.prices
  const brgnx = historicalData.BRGNX.prices
  const tqqq = historicalData.TQQQ.prices
  const btc = historicalData.BTC.prices
  const gld = historicalData.GLD.prices
  const slv = historicalData.SLV.prices
  const qqq = historicalData.QQQ?.prices ?? []
  const soxx = historicalData.SOXX?.prices ?? []
  const soxl = historicalData.SOXL?.prices ?? []

  // Build date lookup maps for fast access
  // Use exact match for most assets, but VTI needs nearest-date lookup
  // because its weekly interval is offset from the others
  const spxlMap = new Map(spxl.map(p => [p.date, p.value]))
  const vtiLookup = buildPriceMap(vti) // VTI uses nearest-date for misaligned data
  const brgnxMap = new Map(brgnx.map(p => [p.date, p.value]))
  const tqqqMap = new Map(tqqq.map(p => [p.date, p.value]))
  const btcMap = new Map(btc.map(p => [p.date, p.value]))
  const gldMap = new Map(gld.map(p => [p.date, p.value]))
  const slvMap = new Map(slv.map(p => [p.date, p.value]))
  const qqqMap = new Map(qqq.map(p => [p.date, p.value]))
  const soxxMap = new Map(soxx.map(p => [p.date, p.value]))
  const soxlMap = new Map(soxl.map(p => [p.date, p.value]))

  // Get all dates in range (use SPXL as reference, it has most complete data)
  const dates = spxl
    .map(p => p.date)
    .filter(d => d >= dateRange.start && d <= dateRange.end)

  if (dates.length === 0) {
    return {
      prices: [],
      startingPrices: { SPXL: 1, VTI: 1, BRGNX: 1, TQQQ: 1, BTC: 1, GLD: 1, SLV: 1, QQQ: 1, SOXX: 1, SOXL: 1 },
      dividends: { SPXL: [], VTI: [], BRGNX: [], TQQQ: [], GLD: [], SLV: [] }
    }
  }

  // Get starting values for normalization
  const firstDate = dates[0]
  const spxlStart = spxlMap.get(firstDate) || 1
  const vtiStart = vtiLookup(firstDate) || 1
  const brgnxStart = brgnxMap.get(firstDate) || 1
  const tqqqStart = tqqqMap.get(firstDate) || 1
  const btcStart = btcMap.get(firstDate) || 1
  const gldStart = gldMap.get(firstDate) || 1
  const slvStart = slvMap.get(firstDate) || 1
  const qqqStart = qqqMap.get(firstDate) || 1
  const soxxStart = soxxMap.get(firstDate) || 1
  const soxlStart = soxlMap.get(firstDate) || 1

  // Filter dividends to date range
  const spxlDividendsRaw = historicalData.SPXL.dividends || []
  const vtiDividendsRaw = historicalData.VTI.dividends || []
  const brgnxDividendsRaw = historicalData.BRGNX.dividends || []
  const tqqqDividendsRaw = historicalData.TQQQ.dividends || []
  const gldDividendsRaw = historicalData.GLD.dividends || []
  const slvDividendsRaw = historicalData.SLV.dividends || []

  const spxlDividends = spxlDividendsRaw
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const vtiDividends = vtiDividendsRaw
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const brgnxDividends = brgnxDividendsRaw
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const tqqqDividends = tqqqDividendsRaw
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const gldDividends = gldDividendsRaw
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)
  const slvDividends = slvDividendsRaw
    .filter(d => d.exDate >= dateRange.start && d.exDate <= dateRange.end)

  // Debug: Log dividend filtering
  console.log('Price blender dividend filtering:', {
    spxlRaw: spxlDividendsRaw.length,
    vtiRaw: vtiDividendsRaw.length,
    brgnxRaw: brgnxDividendsRaw.length,
    tqqqRaw: tqqqDividendsRaw.length,
    gldRaw: gldDividendsRaw.length,
    slvRaw: slvDividendsRaw.length,
    dateRange,
    spxlFiltered: spxlDividends.length,
    vtiFiltered: vtiDividends.length,
    brgnxFiltered: brgnxDividends.length,
    tqqqFiltered: tqqqDividends.length,
    gldFiltered: gldDividends.length,
    slvFiltered: slvDividends.length
  })

  // Blend prices by allocation, normalizing each asset to start at 100
  const prices = dates.map(date => {
    // Normalize each asset (start value = 100)
    const spxlNorm = ((spxlMap.get(date) || 0) / spxlStart) * 100
    const vtiNorm = ((vtiLookup(date) || 0) / vtiStart) * 100
    const brgnxNorm = ((brgnxMap.get(date) || 0) / brgnxStart) * 100
    const tqqqNorm = ((tqqqMap.get(date) || 0) / tqqqStart) * 100
    const btcNorm = ((btcMap.get(date) || 0) / btcStart) * 100
    const gldNorm = ((gldMap.get(date) || 0) / gldStart) * 100
    const slvNorm = ((slvMap.get(date) || 0) / slvStart) * 100
    const qqqNorm = ((qqqMap.get(date) || 0) / qqqStart) * 100
    const soxxNorm = ((soxxMap.get(date) || 0) / soxxStart) * 100
    const soxlNorm = ((soxlMap.get(date) || 0) / soxlStart) * 100

    // Calculate weighted blend
    const blendedValue =
      (spxlNorm * allocation.SPXL) +
      (vtiNorm * allocation.VTI) +
      (brgnxNorm * allocation.BRGNX) +
      (tqqqNorm * allocation.TQQQ) +
      (btcNorm * allocation.BTC) +
      (gldNorm * allocation.GLD) +
      (slvNorm * allocation.SLV) +
      (qqqNorm * (allocation.QQQ ?? 0)) +
      (soxxNorm * (allocation.SOXX ?? 0)) +
      (soxlNorm * (allocation.SOXL ?? 0))

    return {
      date,
      value: blendedValue
    }
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
      SLV: slvStart,
      QQQ: qqqStart,
      SOXX: soxxStart,
      SOXL: soxlStart
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

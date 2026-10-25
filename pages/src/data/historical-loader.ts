import type { HistoricalData } from './types'

// Disable caching during development to ensure fresh data
let cachedData: Record<string, HistoricalData> | null = null
const DISABLE_CACHE = true

export async function loadHistoricalData(): Promise<Record<string, HistoricalData>> {
  if (cachedData && !DISABLE_CACHE) {
    console.log('Using cached data, dividends:', {
      spxl: cachedData.SPXL.dividends?.length,
      tqqq: cachedData.TQQQ.dividends?.length
    })
    return cachedData
  }

  try {
    // Use Vite's base URL for correct path in production
    const base = import.meta.env.BASE_URL
    // Add cache-busting timestamp to ensure fresh data
    const cacheBust = `?t=${Date.now()}`
    const [spxl, spy, vti, brgnx, tqqq, btc, gld, slv, qqq, soxx, soxl] = await Promise.all([
      fetch(`${base}data/spxl-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load SPXL data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/spy-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load SPY data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/vti-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load VTI data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/brgnx-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load BRGNX data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/tqqq-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load TQQQ data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/btc-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load BTC data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/gld-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load GLD data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/slv-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load SLV data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/qqq-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load QQQ data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/soxx-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load SOXX data: ${r.statusText}`)
        return r.json()
      }),
      fetch(`${base}data/soxl-weekly.json${cacheBust}`).then(r => {
        if (!r.ok) throw new Error(`Failed to load SOXL data: ${r.statusText}`)
        return r.json()
      })
    ])

    // Debug: Log raw fetched data
    console.log('=== HISTORICAL DATA LOADED ===')
    console.log('SPXL dividends:', spxl.dividends?.length ?? 0, spxl.dividends?.slice(0, 3))
    console.log('SPY dividends:', spy.dividends?.length ?? 0, spy.dividends?.slice(0, 3))
    console.log('VTI dividends:', vti.dividends?.length ?? 0, vti.dividends?.slice(0, 3))
    console.log('TQQQ dividends:', tqqq.dividends?.length ?? 0, tqqq.dividends?.slice(0, 3))
    console.log('GLD dividends:', gld.dividends?.length ?? 0, gld.dividends?.slice(0, 3))
    console.log('SLV dividends:', slv.dividends?.length ?? 0, slv.dividends?.slice(0, 3))

    cachedData = {
      SPXL: spxl as HistoricalData,
      SPY: spy as HistoricalData,
      VTI: vti as HistoricalData,
      BRGNX: brgnx as HistoricalData,
      TQQQ: tqqq as HistoricalData,
      BTC: btc as HistoricalData,
      GLD: gld as HistoricalData,
      SLV: slv as HistoricalData,
      QQQ: qqq as HistoricalData,
      SOXX: soxx as HistoricalData,
      SOXL: soxl as HistoricalData
    }

    // Debug: Log loaded dividend data
    console.log('Loaded historical data with dividends:', {
      SPXL: {
        dividendCount: spxl.dividends?.length ?? 0,
        firstDividend: spxl.dividends?.[0],
        priceCount: spxl.prices?.length ?? 0
      },
      SPY: {
        dividendCount: spy.dividends?.length ?? 0,
        firstDividend: spy.dividends?.[0],
        priceCount: spy.prices?.length ?? 0
      },
      TQQQ: {
        dividendCount: tqqq.dividends?.length ?? 0,
        firstDividend: tqqq.dividends?.[0],
        priceCount: tqqq.prices?.length ?? 0
      }
    })

    return cachedData
  } catch (error) {
    console.error('Error loading historical data:', error)
    throw error
  }
}

export function clearCache() {
  cachedData = null
}

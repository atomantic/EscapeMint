/// <reference types="vite/client" />
import type { HistoricalData } from './types'

let cachedData: Record<string, HistoricalData> | null = null

export async function loadHistoricalData(): Promise<Record<string, HistoricalData>> {
  if (cachedData) return cachedData

  const base = import.meta.env.BASE_URL
  const [spxl, spy, vti, brgnx, tqqq, btc, gld, slv] = await Promise.all([
    fetch(`${base}data/spxl-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load SPXL data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/spy-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load SPY data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/vti-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load VTI data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/brgnx-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load BRGNX data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/tqqq-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load TQQQ data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/btc-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load BTC data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/gld-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load GLD data: ${r.statusText}`)
      return r.json()
    }),
    fetch(`${base}data/slv-weekly.json`).then(r => {
      if (!r.ok) throw new Error(`Failed to load SLV data: ${r.statusText}`)
      return r.json()
    })
  ])

  cachedData = {
    SPXL: spxl as HistoricalData,
    SPY: spy as HistoricalData,
    VTI: vti as HistoricalData,
    BRGNX: brgnx as HistoricalData,
    TQQQ: tqqq as HistoricalData,
    BTC: btc as HistoricalData,
    GLD: gld as HistoricalData,
    SLV: slv as HistoricalData
  }

  return cachedData
}

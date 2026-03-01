import { useState, useEffect, useCallback } from 'react'
import { loadHistoricalData } from '../backtest/historical-loader'
import type { HistoricalData, DateRange } from '../backtest/types'
import type { ScenarioConfig } from '../backtest/backtest'
import { BacktestView } from '../backtest/BacktestView'
import { DateRangePicker } from '../backtest/DateRangePicker'

const STORAGE_KEY_ACCUMULATE = 'escapemint-backtest-accumulate'
const STORAGE_KEY_HARVEST = 'escapemint-backtest-harvest'
const STORAGE_KEY_LAST_MODE = 'escapemint-backtest-last-mode'

function getDefaultAccumulateConfig(): ScenarioConfig {
  return {
    id: 'backtest',
    name: 'DCA Backtest',
    spxlPct: 0,
    vtiPct: 5,
    brgnxPct: 0,
    tqqqPct: 15,
    btcPct: 70,
    gldPct: 5,
    slvPct: 5,
    initialCash: 10000,
    weeklyDCA: 100,
    targetAPY: 0.25,
    minProfitUSD: 1000,
    accumulate: true,
    inputMin: 100,
    inputMid: 100,
    inputMax: 100,
    maxAtPct: -0.25,
    marginAccessUSD: 0,
    marginAPR: 0.05,
    cashAPY: 0.04
  }
}

function getDefaultHarvestConfig(): ScenarioConfig {
  return {
    id: 'backtest',
    name: 'DCA Backtest',
    spxlPct: 0,
    vtiPct: 5,
    brgnxPct: 0,
    tqqqPct: 15,
    btcPct: 70,
    gldPct: 5,
    slvPct: 5,
    initialCash: 10000,
    weeklyDCA: 100,
    targetAPY: 0.40,
    minProfitUSD: 1000,
    accumulate: false,
    inputMin: 100,
    inputMid: 200,
    inputMax: 250,
    maxAtPct: -0.25,
    marginAccessUSD: 0,
    marginAPR: 0.05,
    cashAPY: 0.04
  }
}

export type PresetName = 'TQQQ' | 'SPXL' | 'VTI' | 'BRGNX' | 'BTC' | 'GLD' | 'SLV' | 'Blend'

export interface Preset {
  name: PresetName
  label: string
  getConfig: (accumulate: boolean, base: ScenarioConfig) => Partial<ScenarioConfig>
}

export const PRESETS: Preset[] = [
  {
    name: 'TQQQ',
    label: 'TQQQ',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 100,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      targetAPY: accumulate ? 0.20 : 0.52,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 350
    })
  },
  {
    name: 'SPXL',
    label: 'SPXL',
    getConfig: (accumulate, _base) => ({
      spxlPct: 100,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 200
    })
  },
  {
    name: 'VTI',
    label: 'VTI',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 100,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },
  {
    name: 'BRGNX',
    label: 'BRGNX',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 100,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },
  {
    name: 'BTC',
    label: 'BTC',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 100,
      gldPct: 0,
      slvPct: 0,
      targetAPY: accumulate ? 0.30 : 0.80,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 200
    })
  },
  {
    name: 'GLD',
    label: 'GLD',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 100,
      slvPct: 0,
      targetAPY: 0.08,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },
  {
    name: 'SLV',
    label: 'SLV',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 100,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },
  {
    name: 'Blend',
    label: 'Blend',
    getConfig: (accumulate, _base) => {
      const defaults = getDefaultConfig(accumulate)
      return {
        spxlPct: defaults.spxlPct,
        vtiPct: defaults.vtiPct,
        brgnxPct: defaults.brgnxPct,
        tqqqPct: defaults.tqqqPct,
        btcPct: defaults.btcPct,
        gldPct: defaults.gldPct,
        slvPct: defaults.slvPct,
        targetAPY: defaults.targetAPY,
        inputMin: defaults.inputMin,
        inputMid: defaults.inputMid,
        inputMax: defaults.inputMax
      }
    }
  }
]

function getDefaultConfig(accumulate: boolean): ScenarioConfig {
  return accumulate ? getDefaultAccumulateConfig() : getDefaultHarvestConfig()
}

function getStorageKey(accumulate: boolean): string {
  return accumulate ? STORAGE_KEY_ACCUMULATE : STORAGE_KEY_HARVEST
}

function loadLastMode(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY_LAST_MODE)
  return stored === 'harvest' ? false : true
}

function saveLastMode(accumulate: boolean): void {
  localStorage.setItem(STORAGE_KEY_LAST_MODE, accumulate ? 'accumulate' : 'harvest')
}

function loadStoredConfig(accumulate: boolean): ScenarioConfig {
  const storageKey = getStorageKey(accumulate)
  const stored = localStorage.getItem(storageKey)
  if (stored) {
    const parsed = (() => { try { return JSON.parse(stored) } catch { return null } })()
    if (parsed) return { ...getDefaultConfig(accumulate), ...parsed, accumulate }
  }
  return getDefaultConfig(accumulate)
}

function saveConfig(config: ScenarioConfig): void {
  const storageKey = getStorageKey(config.accumulate)
  localStorage.setItem(storageKey, JSON.stringify(config))
  saveLastMode(config.accumulate)
}

export function Backtest() {
  const [historicalData, setHistoricalData] = useState<Record<string, HistoricalData> | null>(null)
  const [config, setConfig] = useState<ScenarioConfig>(() => {
    const lastMode = loadLastMode()
    return loadStoredConfig(lastMode)
  })
  const [availableRange, setAvailableRange] = useState<DateRange | null>(null)
  const [selectedRange, setSelectedRange] = useState<DateRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const handleConfigChange = useCallback((newConfig: ScenarioConfig) => {
    if (newConfig.accumulate !== config.accumulate) {
      saveConfig(config)
      const otherModeConfig = loadStoredConfig(newConfig.accumulate)
      setConfig(otherModeConfig)
      saveLastMode(newConfig.accumulate)
    } else {
      setConfig(newConfig)
      saveConfig(newConfig)
    }
  }, [config])

  const handleApplyPreset = useCallback((presetName: PresetName) => {
    const preset = PRESETS.find(p => p.name === presetName)
    if (!preset) return
    const updates = preset.getConfig(config.accumulate, config)
    const newConfig = { ...config, ...updates }
    setConfig(newConfig)
    saveConfig(newConfig)
  }, [config])

  useEffect(() => {
    loadHistoricalData()
      .then(data => {
        setHistoricalData(data)

        const startDates = Object.values(data).map(d => d.startDate)
        const endDates = Object.values(data).map(d => d.endDate)

        const available: DateRange = {
          start: startDates.sort()[startDates.length - 1]!,
          end: endDates.sort()[0]!
        }

        setAvailableRange(available)
        setSelectedRange(available)
        setLoading(false)
      })
      .catch(err => {
        console.error('Failed to load historical data:', err)
        setError(err.message || 'Failed to load historical data')
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-slate-400">Loading historical data...</p>
        </div>
      </div>
    )
  }

  if (error || !historicalData || !availableRange || !selectedRange) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center max-w-md">
          <div className="text-red-500 text-6xl mb-4">!</div>
          <h1 className="text-2xl font-bold mb-2">Error Loading Data</h1>
          <p className="text-slate-400 mb-4">{error || 'Failed to load historical data'}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="text-white overflow-x-hidden">
      {/* Header + Date Range */}
      <div className="mb-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
          <div>
            <h1 className="text-lg font-bold">Backtest</h1>
            <p className="text-xs text-slate-500">Bet long on the future to build a money tree</p>
          </div>
          <DateRangePicker
            availableRange={availableRange}
            selectedRange={selectedRange}
            onChange={setSelectedRange}
          />
        </div>
      </div>

      {/* Main Content */}
      <BacktestView
        config={config}
        historicalData={historicalData}
        dateRange={selectedRange}
        onChange={handleConfigChange}
        onApplyPreset={handleApplyPreset}
        presets={PRESETS}
      />
    </div>
  )
}

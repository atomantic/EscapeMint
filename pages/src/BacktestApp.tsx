import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { loadHistoricalData } from './data/historical-loader'
import type { HistoricalData, DateRange } from './data/types'
import type { ScenarioConfig } from './engine/backtest'
import { BacktestView } from './components/BacktestView'
import { DateRangePicker } from './components/DateRangePicker'

// Separate storage keys for each mode
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
    qqqPct: 0,
    soxxPct: 0,
    soxlPct: 0,
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
    qqqPct: 0,
    soxxPct: 0,
    soxlPct: 0,
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

// Preset configurations for each mode
export type PresetName = 'TQQQ' | 'SPXL' | 'VTI' | 'BRGNX' | 'BTC' | 'GLD' | 'SLV' | 'QQQ' | 'SOXX' | 'SOXL' | 'Blend'

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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
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
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 0,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },

  {
    name: 'QQQ',
    label: 'QQQ',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      qqqPct: 100,
      soxxPct: 0,
      soxlPct: 0,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },
  {
    name: 'SOXX',
    label: 'SOXX',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      qqqPct: 0,
      soxxPct: 100,
      soxlPct: 0,
      targetAPY: 0.10,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 150
    })
  },
  {
    name: 'SOXL',
    label: 'SOXL',
    getConfig: (accumulate, _base) => ({
      spxlPct: 0,
      vtiPct: 0,
      brgnxPct: 0,
      tqqqPct: 0,
      btcPct: 0,
      gldPct: 0,
      slvPct: 0,
      qqqPct: 0,
      soxxPct: 0,
      soxlPct: 100,
      targetAPY: accumulate ? 0.20 : 0.40,
      inputMin: 100,
      inputMid: 100,
      inputMax: accumulate ? 100 : 250
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
        qqqPct: defaults.qqqPct ?? 0,
        soxxPct: defaults.soxxPct ?? 0,
        soxlPct: defaults.soxlPct ?? 0,
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
  // Default to accumulate mode if no preference saved
  return stored === 'harvest' ? false : true
}

function saveLastMode(accumulate: boolean): void {
  localStorage.setItem(STORAGE_KEY_LAST_MODE, accumulate ? 'accumulate' : 'harvest')
}

function loadStoredConfig(accumulate: boolean): ScenarioConfig {
  const storageKey = getStorageKey(accumulate)
  const stored = localStorage.getItem(storageKey)
  if (stored) {
    const parsed = JSON.parse(stored)
    // Merge with defaults to handle any new fields, ensure mode matches
    return { ...getDefaultConfig(accumulate), ...parsed, accumulate }
  }
  return getDefaultConfig(accumulate)
}

function saveConfig(config: ScenarioConfig): void {
  const storageKey = getStorageKey(config.accumulate)
  localStorage.setItem(storageKey, JSON.stringify(config))
  saveLastMode(config.accumulate)
}

export function BacktestApp() {
  const [historicalData, setHistoricalData] = useState<Record<string, HistoricalData> | null>(null)
  // Initialize with last used mode
  const [config, setConfig] = useState<ScenarioConfig>(() => {
    const lastMode = loadLastMode()
    return loadStoredConfig(lastMode)
  })
  const [availableRange, setAvailableRange] = useState<DateRange | null>(null)
  const [selectedRange, setSelectedRange] = useState<DateRange | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const handleConfigChange = useCallback((newConfig: ScenarioConfig) => {
    // Check if mode is being toggled
    if (newConfig.accumulate !== config.accumulate) {
      // Save current config to its mode-specific storage
      saveConfig(config)
      // Load the other mode's config (or defaults if none saved)
      const otherModeConfig = loadStoredConfig(newConfig.accumulate)
      setConfig(otherModeConfig)
      saveLastMode(newConfig.accumulate)
    } else {
      // Normal config update within the same mode
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

        // Calculate available date range (overlap of all three assets)
        const startDates = Object.values(data).map(d => d.startDate)
        const endDates = Object.values(data).map(d => d.endDate)

        const available: DateRange = {
          start: startDates.sort()[startDates.length - 1], // Latest start
          end: endDates.sort()[0] // Earliest end
        }

        setAvailableRange(available)
        // Default to full available range
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
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-slate-400">Loading historical data...</p>
        </div>
      </div>
    )
  }

  if (error || !historicalData || !availableRange || !selectedRange) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
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
    <div className="min-h-screen bg-slate-950 text-white overflow-x-hidden">
      {/* Header + Date Range - Responsive */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 sm:px-6 py-2">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold">EscapeMint Backtest</h1>
                <Link
                  to="/intro"
                  className="hidden sm:inline text-xs text-blue-400 hover:text-blue-300 transition-colors whitespace-nowrap"
                >
                  Learn How It Works
                </Link>
              </div>
              <p className="text-xs text-slate-500">Bet long on the future to build a money tree</p>
              <Link
                to="/intro"
                className="sm:hidden text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Learn How It Works
              </Link>
            </div>
            <DateRangePicker
              availableRange={availableRange}
              selectedRange={selectedRange}
              onChange={setSelectedRange}
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 sm:px-6 py-4 overflow-x-hidden">
        <BacktestView
          config={config}
          historicalData={historicalData}
          dateRange={selectedRange}
          onChange={handleConfigChange}
          onApplyPreset={handleApplyPreset}
          presets={PRESETS}
        />
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 mt-12">
        <div className="container mx-auto px-4 sm:px-6 py-6 text-center text-sm text-slate-500">
          <p>Historical data: SPXL (3x Russell 1000), VTI (Total US Market), BRGNX (Russell 1000), TQQQ (3x NASDAQ), BTC (Bitcoin), GLD (Gold), SLV (Silver)</p>
          <p className="mt-1">All calculations run in-browser using EscapeMint engine</p>
          <p className="mt-2">
            <a
              href="https://github.com/atomantic/EscapeMint"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 transition-colors"
            >
              View on GitHub
            </a>
          </p>
        </div>
      </footer>
    </div>
  )
}

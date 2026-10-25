import { useState } from 'react'
import type { ScenarioConfig } from '../engine/backtest'
import { PieBuilder } from './PieBuilder'
import { formatCurrency } from '../utils/format'

interface Props {
  config: ScenarioConfig
  onChange: (config: ScenarioConfig) => void
}

export function ScenarioConfiguration({ config, onChange }: Props) {
  const [isExpanded, setIsExpanded] = useState(false)

  const updateConfig = (updates: Partial<ScenarioConfig>) => {
    onChange({ ...config, ...updates })
  }

  return (
    <div className="mt-4 bg-slate-800/50 rounded-lg border border-slate-700">
      {/* Header - Always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-700/30 transition-colors rounded-lg"
      >
        <span className="text-sm font-medium text-slate-300">Configuration</span>
        <svg
          className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expandable content */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-6">
          {/* Allocation */}
          <section>
            <PieBuilder
              spxlPct={config.spxlPct}
              vtiPct={config.vtiPct}
              brgnxPct={config.brgnxPct}
              tqqqPct={config.tqqqPct}
              btcPct={config.btcPct}
              gldPct={config.gldPct}
              slvPct={config.slvPct}
              qqqPct={config.qqqPct ?? 0}
              soxxPct={config.soxxPct ?? 0}
              soxlPct={config.soxlPct ?? 0}
              onChange={(allocation) => updateConfig(allocation)}
            />
          </section>

          {/* Fund Setup */}
          <section>
            <h4 className="text-xs font-medium text-slate-300 mb-3">Fund Setup</h4>
            <div className="space-y-3">
              <NumberSlider
                label="Initial Cash"
                value={config.initialCash}
                min={1000}
                max={100000}
                step={1000}
                format={formatCurrency}
                onChange={(v) => updateConfig({ initialCash: v })}
              />

              <NumberSlider
                label="Weekly DCA"
                value={config.weeklyDCA}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ weeklyDCA: v })}
              />
            </div>
          </section>

          {/* DCA Strategy */}
          <section>
            <h4 className="text-xs font-medium text-slate-300 mb-3">DCA Strategy</h4>
            <div className="space-y-3">
              <NumberSlider
                label="Target APY"
                value={config.targetAPY * 100}
                min={0}
                max={50}
                step={1}
                format={(v) => `${v}%`}
                onChange={(v) => updateConfig({ targetAPY: v / 100 })}
              />

              <NumberSlider
                label="Min Profit Threshold"
                value={config.minProfitUSD}
                min={0}
                max={5000}
                step={50}
                format={formatCurrency}
                onChange={(v) => updateConfig({ minProfitUSD: v })}
              />

              <div>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.accumulate}
                    onChange={(e) => updateConfig({ accumulate: e.target.checked })}
                    className="w-4 h-4 rounded bg-slate-700 border-slate-600"
                  />
                  Accumulate Mode
                  <span className="text-slate-500 text-xs">
                    ({config.accumulate ? 'compound gains' : 'harvest profits'})
                  </span>
                </label>
              </div>
            </div>
          </section>

          {/* DCA Tiers */}
          <section>
            <h4 className="text-xs font-medium text-slate-300 mb-3">DCA Tiers</h4>
            <div className="space-y-3">
              <NumberSlider
                label="Input Min (at/above target)"
                value={config.inputMin}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ inputMin: v })}
              />

              <NumberSlider
                label="Input Mid (below target)"
                value={config.inputMid}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ inputMid: v })}
              />

              <NumberSlider
                label="Input Max (significant loss)"
                value={config.inputMax}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ inputMax: v })}
              />

              <NumberSlider
                label="Max Loss Threshold"
                value={Math.abs(config.maxAtPct) * 100}
                min={10}
                max={50}
                step={5}
                format={(v) => `-${v}%`}
                onChange={(v) => updateConfig({ maxAtPct: -(v / 100) })}
              />
            </div>
          </section>

          {/* Margin (Optional) */}
          <section>
            <h4 className="text-xs font-medium text-slate-300 mb-3">Margin (Optional)</h4>
            <div className="space-y-3">
              <NumberSlider
                label="Margin Access"
                value={config.marginAccessUSD}
                min={0}
                max={100000}
                step={1000}
                format={formatCurrency}
                onChange={(v) => updateConfig({ marginAccessUSD: v })}
              />

              {config.marginAccessUSD > 0 && (
                <>
                  <NumberSlider
                    label="Margin APR"
                    value={config.marginAPR * 100}
                    min={0}
                    max={15}
                    step={0.5}
                    format={(v) => `${v}%`}
                    onChange={(v) => updateConfig({ marginAPR: v / 100 })}
                  />

                  <NumberSlider
                    label="Cash Interest Rate"
                    value={config.cashAPY * 100}
                    min={0}
                    max={10}
                    step={0.5}
                    format={(v) => `${v}%`}
                    onChange={(v) => updateConfig({ cashAPY: v / 100 })}
                  />
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

interface NumberSliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
}

function NumberSlider({ label, value, min, max, step, format, onChange }: NumberSliderProps) {
  // Round value to step precision to avoid floating point display errors
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0
  const roundedValue = Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals)
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300 font-mono">{format(roundedValue)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={roundedValue}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-slate-700"
      />
    </div>
  )
}

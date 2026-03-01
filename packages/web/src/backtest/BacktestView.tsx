import { useMemo, useState, useEffect, useRef } from 'react'
import * as d3 from 'd3'
import type { HistoricalData, DateRange } from './types'
import { runBacktest, type ScenarioConfig, type BacktestResult, type TimeSeriesPoint } from './backtest'
import type { Preset, PresetName } from '../pages/Backtest'
import { EntriesTable } from './EntriesTable'
import { PieBuilder } from './PieBuilder'
import { formatCurrency, formatPercent, formatPercentSigned, formatCurrencyCompact } from './format'
import {
  ValueAndFundSizeChart,
  StackedAreaChart,
  type ChartTimeSeriesPoint
} from '../components/FundCharts'

interface Props {
  config: ScenarioConfig
  historicalData: Record<string, HistoricalData>
  dateRange: DateRange
  onChange: (config: ScenarioConfig) => void
  onApplyPreset: (presetName: PresetName) => void
  presets: Preset[]
}

interface ExtendedChartPoint extends ChartTimeSeriesPoint {
  realizedGain: number
  liquidGain: number
  realizedAPY: number
  unrealizedAPY: number
  liquidAPY: number
}

function toChartTimeSeries(
  timeSeries: TimeSeriesPoint[],
  result: BacktestResult,
  initialCash: number
): ExtendedChartPoint[] {
  let cumulativeExtracted = 0
  let soldCostBasis = 0

  return timeSeries.map((point, index) => {
    if (point.action === 'SELL' && point.amount) {
      cumulativeExtracted += point.amount
    }

    const invested = Math.max(0, point.invested)
    const unrealizedGain = point.equity - invested

    soldCostBasis = point.totalInvested - invested

    const realizedGain = (cumulativeExtracted - soldCostBasis) + point.sumCashInterest + point.sumDividends
    const liquidGain = point.fundSize - initialCash

    const daysElapsed = index > 0
      ? Math.floor((new Date(point.date).getTime() - new Date(timeSeries[0]!.date).getTime()) / (1000 * 60 * 60 * 24))
      : 0
    const yearsElapsed = daysElapsed / 365

    const liquidAPY = yearsElapsed > 0 && initialCash > 0 ? liquidGain / initialCash / yearsElapsed : 0
    const realizedAPY = yearsElapsed > 0 && initialCash > 0 ? realizedGain / initialCash / yearsElapsed : 0
    const unrealizedAPY = yearsElapsed > 0 && initialCash > 0 ? unrealizedGain / initialCash / yearsElapsed : 0

    return {
      date: new Date(point.date),
      value: point.equity,
      startInput: invested,
      fundSize: point.fundSize,
      cashAvailable: point.cash,
      cumulativeDividends: point.sumDividends,
      cumulativeExpenses: 0,
      realizedGains: cumulativeExtracted - (result.totalInvested - invested),
      cashInterest: point.sumCashInterest,
      unrealizedGain,
      capturedProfit: cumulativeExtracted,
      cashPct: point.fundSize > 0 ? point.cash / point.fundSize : 0,
      assetPct: point.fundSize > 0 ? invested / point.fundSize : 0,
      apy: liquidAPY,
      marginAvailable: 0,
      marginBorrowed: 0,
      expectedTarget: point.expectedTarget,
      realizedGain,
      liquidGain,
      realizedAPY,
      unrealizedAPY,
      liquidAPY
    }
  })
}

interface MultiLineChartProps {
  data: ExtendedChartPoint[]
  title: string
  series: { key: keyof ExtendedChartPoint; label: string; color: string }[]
  formatValue?: (v: number) => string
  resize: number
}

function MultiLineChart({ data, title, series, formatValue = formatCurrencyCompact, resize }: MultiLineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || data.length < 2) return

    const container = containerRef.current
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const rect = container.getBoundingClientRect()
    const width = rect.width
    const height = 160
    const margin = { top: 10, right: 10, bottom: 25, left: 50 }
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    const allValues = series.flatMap(s => data.map(d => d[s.key] as number))
    const yExtent = d3.extent(allValues) as [number, number]
    let yMin = yExtent[0]
    let yMax = yExtent[1]

    const yPadding = (yMax - yMin) * 0.1 || 1
    yMin -= yPadding
    yMax += yPadding

    const xScale = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, innerWidth])

    const yScale = d3.scaleLinear()
      .domain([yMin, yMax])
      .range([innerHeight, 0])

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(xScale).ticks(5).tickFormat(d => d3.timeFormat('%b \'%y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')

    g.append('g')
      .call(d3.axisLeft(yScale).ticks(5).tickFormat(d => formatValue(d as number)))
      .selectAll('text')
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')

    g.selectAll('.domain').attr('stroke', '#475569')
    g.selectAll('.tick line').attr('stroke', '#475569')

    if (yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yScale(0))
        .attr('y2', yScale(0))
        .attr('stroke', '#64748b')
        .attr('stroke-dasharray', '4,4')
        .attr('stroke-width', 1)
    }

    series.forEach(s => {
      const line = d3.line<ExtendedChartPoint>()
        .x(d => xScale(d.date))
        .y(d => yScale(d[s.key] as number))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', s.color)
        .attr('stroke-width', 1.5)
        .attr('d', line)
    })

    const tooltip = d3.select(container)
      .selectAll('.chart-tooltip')
      .data([null])
      .join('div')
      .attr('class', 'chart-tooltip')
      .style('position', 'absolute')
      .style('background', 'rgba(15, 23, 42, 0.95)')
      .style('border', '1px solid #334155')
      .style('border-radius', '4px')
      .style('padding', '6px 8px')
      .style('font-size', '10px')
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('z-index', 100)

    const overlay = g.append('rect')
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('fill', 'transparent')

    overlay.on('mousemove', (event) => {
      const [mx] = d3.pointer(event)
      const x0 = xScale.invert(mx)
      const bisect = d3.bisector<ExtendedChartPoint, Date>(d => d.date).left
      const idx = Math.min(bisect(data, x0), data.length - 1)
      const d = data[idx]!

      const tooltipContent = series.map(s =>
        `<div style="color: ${s.color}">${s.label}: ${formatValue(d[s.key] as number)}</div>`
      ).join('')

      tooltip
        .html(`<div style="color: #94a3b8; margin-bottom: 2px">${d3.timeFormat('%b %d, %Y')(d.date)}</div>${tooltipContent}`)
        .style('opacity', 1)
        .style('left', `${event.offsetX + 10}px`)
        .style('top', `${event.offsetY - 10}px`)
    })

    overlay.on('mouseleave', () => {
      tooltip.style('opacity', 0)
    })

  }, [data, series, formatValue, resize])

  return (
    <div ref={containerRef} className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px] relative">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-slate-300">{title}</h3>
        <div className="chart-legend flex gap-2">
          {series.map(s => (
            <span key={s.key} className="text-[10px] text-slate-400 flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <svg ref={svgRef} className="flex-1 w-full" />
    </div>
  )
}

function isPresetActive(config: ScenarioConfig, preset: Preset): boolean {
  const presetValues = preset.getConfig(config.accumulate, config)
  return (
    config.spxlPct === presetValues.spxlPct &&
    config.brgnxPct === presetValues.brgnxPct &&
    config.tqqqPct === presetValues.tqqqPct &&
    config.btcPct === presetValues.btcPct &&
    config.gldPct === presetValues.gldPct &&
    config.slvPct === presetValues.slvPct &&
    config.vtiPct === presetValues.vtiPct &&
    config.targetAPY === presetValues.targetAPY &&
    config.inputMin === presetValues.inputMin &&
    config.inputMid === presetValues.inputMid &&
    config.inputMax === presetValues.inputMax
  )
}

export function BacktestView({ config, historicalData, dateRange, onChange, onApplyPreset, presets }: Props) {
  const [resize, setResize] = useState(0)
  const chartsContainerRef = useRef<HTMLDivElement>(null)

  const result = useMemo(() => {
    return runBacktest(config, historicalData, dateRange)
  }, [config, historicalData, dateRange])

  const activePreset = useMemo(() => {
    return presets.find(preset => isPresetActive(config, preset))?.name ?? null
  }, [config, presets])

  const chartData = useMemo(() => {
    return toChartTimeSeries(result.timeSeries, result, config.initialCash)
  }, [result, config.initialCash])

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const debouncedResize = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => setResize(n => n + 1), 50)
    }

    const handleResize = () => debouncedResize()
    window.addEventListener('resize', handleResize)

    const timer1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setResize(n => n + 1)
      })
    })

    const container = chartsContainerRef.current
    let resizeObserver: ResizeObserver | null = null
    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        debouncedResize()
      })
      resizeObserver.observe(container)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      cancelAnimationFrame(timer1)
      if (debounceTimer) clearTimeout(debounceTimer)
      resizeObserver?.disconnect()
    }
  }, [])

  const updateConfig = (updates: Partial<ScenarioConfig>) => {
    onChange({ ...config, ...updates })
  }

  return (
    <div className="space-y-4">
      {/* Configuration Panel */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Allocation */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-2">Allocation</h3>
            <PieBuilder
              spxlPct={config.spxlPct}
              vtiPct={config.vtiPct}
              brgnxPct={config.brgnxPct}
              tqqqPct={config.tqqqPct}
              btcPct={config.btcPct}
              gldPct={config.gldPct}
              slvPct={config.slvPct}
              onChange={(spxlPct, vtiPct, brgnxPct, tqqqPct, btcPct, gldPct, slvPct) =>
                updateConfig({ spxlPct, vtiPct, brgnxPct, tqqqPct, btcPct, gldPct, slvPct })
              }
            />
          </div>

          {/* Strategy Settings */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-2">Strategy</h3>
            <div className="space-y-1.5">
              <SliderField
                label="Initial Cash"
                value={config.initialCash}
                min={1000}
                max={100000}
                step={1000}
                format={formatCurrency}
                onChange={(v) => updateConfig({ initialCash: v })}
              />
              <SliderField
                label="Target APY"
                value={config.targetAPY * 100}
                min={0}
                max={100}
                step={1}
                format={(v) => `${v}%`}
                onChange={(v) => updateConfig({ targetAPY: v / 100 })}
              />
              <SliderField
                label="Min Profit"
                value={config.minProfitUSD}
                min={0}
                max={5000}
                step={50}
                format={formatCurrency}
                onChange={(v) => updateConfig({ minProfitUSD: v })}
              />
              <SliderField
                label="Cash APY"
                value={config.cashAPY * 100}
                min={0}
                max={10}
                step={0.5}
                format={(v) => `${v}%`}
                onChange={(v) => updateConfig({ cashAPY: v / 100 })}
              />
            </div>
          </div>

          {/* DCA Tiers */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-2">DCA Tiers</h3>
            <div className="space-y-1.5">
              <SliderField
                label={`Min (\u2265 target)`}
                value={config.inputMin}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ inputMin: v })}
              />
              <SliderField
                label="Mid (< target)"
                value={config.inputMid}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ inputMid: v })}
              />
              <SliderField
                label={`Max (\u2264 ${Math.round(config.maxAtPct * 100)}%)`}
                value={config.inputMax}
                min={0}
                max={1000}
                step={10}
                format={formatCurrency}
                onChange={(v) => updateConfig({ inputMax: v })}
              />
              <SliderField
                label="Threshold"
                value={Math.abs(config.maxAtPct) * 100}
                min={10}
                max={50}
                step={5}
                format={(v) => `-${v}%`}
                onChange={(v) => updateConfig({ maxAtPct: -(v / 100) })}
              />
            </div>
          </div>

          {/* Mode Toggle */}
          <div>
            <h3 className="text-xs font-medium text-slate-400 mb-2">Fund Mode</h3>
            <div className="flex gap-1">
              <button
                onClick={() => updateConfig({ accumulate: true })}
                className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors cursor-pointer ${
                  config.accumulate
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                Accumulate
              </button>
              <button
                onClick={() => updateConfig({ accumulate: false })}
                className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors cursor-pointer ${
                  !config.accumulate
                    ? 'bg-orange-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                Harvest
              </button>
            </div>
            <p className="text-[10px] text-slate-500 mt-1.5 leading-tight">
              {config.accumulate
                ? 'Sell min DCA amount when over target + min profit.'
                : 'Close entire position to cash when over target + min profit.'}
              {' '}All proceeds stay in fund cash pool.
            </p>
            <div className="mt-2">
              <span className="text-[10px] text-slate-500 block mb-1">Presets</span>
              <div className="grid grid-cols-5 gap-1">
                {presets.map((preset) => {
                  const isActive = activePreset === preset.name
                  return (
                    <button
                      key={preset.name}
                      onClick={() => onApplyPreset(preset.name)}
                      className={`px-1 py-1 text-[10px] rounded transition-colors cursor-pointer ${
                        isActive
                          ? config.accumulate
                            ? 'bg-blue-600 text-white'
                            : 'bg-orange-600 text-white'
                          : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                      }`}
                    >
                      {preset.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics Panel */}
      <MetricsGrid result={result} initialCash={config.initialCash} />

      {/* Charts */}
      {chartData.length > 1 && (
        <div ref={chartsContainerRef} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ValueAndFundSizeChart
            data={chartData}
            title="Value & Allocation"
            manageCash={true}
            resize={resize}
          />
          <StackedAreaChart
            data={chartData}
            title="Captured Profit"
            series={[
              { key: 'capturedProfit', label: 'Extracted', color: '#3b82f6' },
              { key: 'cashInterest', label: 'Interest', color: '#06b6d4' },
              { key: 'cumulativeDividends', label: 'Dividends', color: '#10b981' }
            ]}
            resize={resize}
          />
          <MultiLineChart
            data={chartData}
            title="Gain Breakdown"
            series={[
              { key: 'liquidGain', label: 'Liquid', color: '#8b5cf6' },
              { key: 'unrealizedGain', label: 'Unrealized', color: '#f59e0b' },
              { key: 'realizedGain', label: 'Realized', color: '#10b981' }
            ]}
            resize={resize}
          />
          <MultiLineChart
            data={chartData}
            title="APY Breakdown"
            series={[
              { key: 'liquidAPY', label: 'Liquid', color: '#8b5cf6' },
              { key: 'unrealizedAPY', label: 'Unrealized', color: '#f59e0b' },
              { key: 'realizedAPY', label: 'Realized', color: '#10b981' }
            ]}
            formatValue={(v: number) => `${(v * 100).toFixed(1)}%`}
            resize={resize}
          />
        </div>
      )}

      {/* Entries Table */}
      <EntriesTable timeSeries={result.timeSeries} />
    </div>
  )
}

interface MetricsGridProps {
  result: BacktestResult
  initialCash: number
}

function MetricsGrid({ result, initialCash }: MetricsGridProps) {
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
    gap: '0.5rem'
  }

  return (
    <div style={gridStyle} className="metrics-grid-mobile">
      <MetricCard
        label="Final Value"
        value={formatCurrency(result.finalValue)}
        subtext={formatPercentSigned(result.liquidGain / initialCash)}
        color={result.liquidGain >= 0 ? 'green' : 'red'}
      />
      <MetricCard
        label="Liquid APY"
        value={formatPercent(result.liquidAPY)}
        subtext="annualized"
        color={result.liquidAPY >= 0 ? 'green' : 'red'}
      />
      <MetricCard
        label="Realized APY"
        value={formatPercent(result.realizedAPY)}
        subtext="from extractions"
        color={result.realizedAPY >= 0 ? 'green' : 'red'}
      />
      <MetricCard
        label="Unrealized Gain"
        value={formatCurrency(result.unrealizedGain)}
        subtext="paper gains"
        color={result.unrealizedGain >= 0 ? 'green' : 'red'}
      />
      <MetricCard
        label="Realized Gain"
        value={formatCurrency(result.realizedGain)}
        subtext="extracted profits"
        color={result.realizedGain >= 0 ? 'green' : 'red'}
      />
      <MetricCard
        label="Liquid P&L"
        value={formatCurrency(result.liquidGain)}
        subtext="total gain/loss"
        color={result.liquidGain >= 0 ? 'green' : 'red'}
      />
      <MetricCard
        label="Total Invested"
        value={formatCurrency(result.totalInvested)}
        subtext={`${result.totalBuys} buys`}
        color="blue"
      />
      <MetricCard
        label="Total Extracted"
        value={formatCurrency(result.totalExtracted)}
        subtext={`${result.totalSells} sells`}
        color="purple"
      />
    </div>
  )
}

interface MetricCardProps {
  label: string
  value: string
  subtext?: string
  color: 'green' | 'red' | 'yellow' | 'gray' | 'blue' | 'purple'
}

function MetricCard({ label, value, subtext, color }: MetricCardProps) {
  const colorClasses = {
    green: 'text-green-400',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    gray: 'text-slate-300',
    blue: 'text-blue-400',
    purple: 'text-purple-400'
  }

  return (
    <div className="metric-card bg-slate-800 rounded p-2 border border-slate-700">
      <div className="text-[10px] text-slate-400 whitespace-nowrap">{label}</div>
      <div className={`text-sm font-bold ${colorClasses[color]} whitespace-nowrap`}>{value}</div>
      {subtext && (
        <div className="text-[10px] text-slate-500 whitespace-nowrap">{subtext}</div>
      )}
    </div>
  )
}

interface SliderFieldProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
}

function SliderField({ label, value, min, max, step, format, onChange }: SliderFieldProps) {
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0
  const roundedValue = Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals)
  const pct = ((roundedValue - min) / (max - min)) * 100
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-slate-400 w-[85px] flex-shrink-0" title={label}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={roundedValue}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 cursor-pointer"
        style={{
          background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${pct}%, #334155 ${pct}%, #334155 100%)`,
          height: '6px',
          borderRadius: '3px'
        }}
      />
      <span className="text-[10px] text-slate-300 font-mono w-14 text-right">{format(roundedValue)}</span>
    </div>
  )
}

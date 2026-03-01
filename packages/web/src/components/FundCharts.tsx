import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import * as d3 from 'd3'
import type { FundEntry, FundConfig, ChartBounds } from '../api/funds'
import { updateFundConfig } from '../api/funds'
import { DerivativesCapturedProfitChart } from './DerivativesCapturedProfitChart'
import { DerivativesPriceChart } from './DerivativesPriceChart'
import { DerivativesMarginChart } from './DerivativesMarginChart'
import { DerivativesValueChart } from './DerivativesValueChart'
import { DerivativesBreakEvenPanel } from './DerivativesBreakEvenPanel'
import type { ComputedEntry } from './entriesTable'
import {
  isCashFund as checkIsCashFund,
  isDerivativesFund as checkIsDerivativesFund,
  getFundTypeFeatures
} from '@escapemint/engine'
import { SIDEBAR_TOGGLED_EVENT } from './Layout'
import { formatCurrencyCompact } from '../utils/format'

interface FundChartsProps {
  entries: FundEntry[]
  config: FundConfig
  fundId: string
  computedEntries?: ComputedEntry[] | undefined
  resize?: number | undefined
}

export interface ChartTimeSeriesPoint {
  date: Date
  value: number
  startInput: number
  fundSize: number
  cashAvailable: number
  cumulativeDividends: number
  cumulativeExpenses: number
  realizedGains: number
  cashInterest: number
  unrealizedGain: number
  capturedProfit: number
  cashPct: number
  assetPct: number
  apy: number
  marginAvailable: number
  marginBorrowed: number
  expectedTarget: number
}

// Alias for internal use
type TimeSeriesPoint = ChartTimeSeriesPoint

// Responsive chart margins based on container width
const getResponsiveMargin = (containerWidth: number) => ({
  top: 10,
  right: 10,
  bottom: 25,
  // Reduce left margin on narrow screens
  left: containerWidth < 300 ? 38 : containerWidth < 400 ? 45 : 50
})

// Responsive font size for axis labels
const getAxisFontSize = (containerWidth: number) =>
  containerWidth < 300 ? '8px' : containerWidth < 400 ? '9px' : '10px'

// Compute time series data from entries
function computeTimeSeries(entries: FundEntry[], config: FundConfig): TimeSeriesPoint[] {
  const sorted = [...entries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  const startDate = sorted.length > 0 ? new Date(sorted[0].date) : new Date()
  const result: TimeSeriesPoint[] = []
  const isCashFund = checkIsCashFund(config.fund_type)
  const targetApy = config.target_apy ?? 0

  let startInput = 0
  let costBasis = 0
  let totalSells = 0  // For dollar-based liquidation detection
  let cumulativeDividends = 0
  let cumulativeExpenses = 0
  let cumulativeCashInterest = 0
  let cumulativeDeposits = 0
  let cumulativeWithdrawals = 0
  let realizedGains = 0
  let sumShares = 0

  // Track buy trades with their dates for expected target calculation
  // Each buy compounds individually from its purchase date
  const buyTrades: { date: Date; amount: number }[] = []
  // In harvest mode, tracks reduction from partial sells
  // In accumulate mode, expected gain is NOT reduced by sells (it's based on invested principal)
  let expectedGainMultiplier = 1

  for (const entry of sorted) {
    const date = new Date(entry.date)

    // Track shares first - BUY adds, SELL subtracts
    if (entry.shares) {
      const sharesAbs = Math.abs(entry.shares)
      sumShares += entry.action === 'SELL' ? -sharesAbs : sharesAbs
    }

    // Track DEPOSIT/WITHDRAW for fund_size calculation
    if (entry.action === 'DEPOSIT' && entry.amount) {
      cumulativeDeposits += entry.amount
    } else if (entry.action === 'WITHDRAW' && entry.amount) {
      cumulativeWithdrawals += entry.amount
    }
    // Track buys and sells for investment tracking
    else if (entry.action === 'BUY' && entry.amount) {
      startInput += entry.amount
      costBasis += entry.amount
      // Track this buy for expected target calculation
      buyTrades.push({ date, amount: entry.amount })
    } else if (entry.action === 'SELL' && entry.amount) {
      totalSells += entry.amount
      // Calculate extracted profit using proper cost basis
      let extracted = 0
      // Check for full liquidation using multiple detection methods (matches engine)
      const hasShareTracking = entry.shares !== undefined && entry.shares !== 0
      const sharesLiquidated = hasShareTracking && Math.abs(sumShares) < 0.0001
      const valueLiquidated = entry.value > 0 && entry.value <= entry.amount + 0.01
      // In accumulate mode, partial sells don't reduce invested (they're profit extraction)
      // In harvest mode, all sells reduce invested
      const isAccumulate = config.accumulate
      // Dollar-based liquidation check - only applies in harvest mode where sells reduce invested.
      // In accumulate mode, totalSells can exceed costBasis without triggering liquidation
      // (the excess is profit extraction, not a full exit).
      const harvestModeLiquidated = !isAccumulate && totalSells >= costBasis
      const isFullLiquidation = sharesLiquidated || valueLiquidated || harvestModeLiquidated
      if (!isAccumulate || isFullLiquidation) {
        startInput -= entry.amount
      }

      if (isFullLiquidation) {
        // Full liquidation - extract remaining profit
        extracted = entry.amount - costBasis
        costBasis = 0
        totalSells = 0
        startInput = 0
        sumShares = 0
        // Reset expected target tracking
        buyTrades.length = 0
        expectedGainMultiplier = 1
      } else {
        // Partial sell
        if (isAccumulate) {
          // Accumulate mode: entire sell amount is profit extraction (cost basis unchanged)
          extracted = entry.amount
        } else {
          // Harvest mode: proportional cost basis
          const sellProportion = entry.amount / (entry.value + entry.amount)
          const costBasisReturned = costBasis * sellProportion
          extracted = entry.amount - costBasisReturned
          costBasis -= costBasisReturned
        }
        // In harvest mode, reduce expected gain for partial sells
        // In accumulate mode, expected gain is NOT reduced (based on invested principal)
        if (!isAccumulate) {
          // Use share-based fraction when available, else dollar-based
          if (hasShareTracking) {
            const sharesBeforeSell = sumShares + Math.abs(entry.shares!)
            const sellFraction = sharesBeforeSell > 0
              ? Math.abs(entry.shares!) / sharesBeforeSell
              : 1
            expectedGainMultiplier *= (1 - sellFraction)
          } else if (startInput > 0) {
            const sellFraction = Math.min(1, entry.amount / (startInput + entry.amount))
            expectedGainMultiplier *= (1 - sellFraction)
          }
        }
      }
      realizedGains += extracted
    }

    // Track dividends, expenses, and cash_interest (all positive in data)
    if (entry.dividend) cumulativeDividends += Math.abs(entry.dividend)
    if (entry.expense) cumulativeExpenses += Math.abs(entry.expense)
    if (entry.cash_interest) cumulativeCashInterest += Math.abs(entry.cash_interest)

    // Calculate fund_size differently for cash funds vs trading funds
    let fundSize: number
    if (isCashFund) {
      // Cash funds: fund_size equals the cash balance
      fundSize = entry.cash ?? entry.value ?? 0
    } else {
      // Trading funds: use manual override if set, otherwise calculate dynamically
      const calculatedFundSize = config.fund_size_usd
        + cumulativeDeposits - cumulativeWithdrawals
        + cumulativeDividends + cumulativeCashInterest - cumulativeExpenses
      fundSize = entry.fund_size ?? calculatedFundSize
    }

    // Calculate cash available and interest
    const manageCash = config.manage_cash !== false
    const daysElapsed = Math.max(0, (date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    const cashAvailable = manageCash && !isCashFund ? Math.max(0, fundSize - startInput) : 0
    // Use actual recorded cash interest for all fund types (matches table calculation)
    const cashInterest = cumulativeCashInterest

    // Post-action equity value (entry.value is pre-action)
    let postActionValue = entry.value
    if (entry.action === 'BUY' && entry.amount) {
      postActionValue = entry.value + entry.amount
    } else if (entry.action === 'SELL' && entry.amount) {
      postActionValue = Math.max(0, entry.value - entry.amount)
    }

    // Unrealized gain = post-action value - post-action investment
    const unrealizedGain = postActionValue - startInput

    // Captured profit calculation differs for cash funds vs trading funds
    // Matches table "realized" calculation: sumCashInterest + sumDividends + sumExtracted - sumExpenses
    const capturedProfit = isCashFund
      ? cumulativeCashInterest - cumulativeExpenses  // Cash fund: just interest - expenses
      : realizedGains + cumulativeDividends + cumulativeCashInterest - cumulativeExpenses  // Trading fund: gains + dividends + interest - expenses

    // Cash vs Asset percentages
    const total = fundSize
    const cashPct = total > 0 ? cashAvailable / total : 0
    const assetPct = total > 0 ? Math.min(1, startInput / total) : 0

    // APY calculation (simplified time-weighted)
    const yearsElapsed = daysElapsed / 365
    const totalReturn = postActionValue + cumulativeDividends - cumulativeExpenses + cumulativeCashInterest - startInput
    const apy = yearsElapsed > 0 && startInput > 0
      ? totalReturn / startInput / yearsElapsed
      : 0

    // Expected target calculation: each buy compounds from its purchase date
    // ExpectedTarget = startInput + Σ(buyAmount * ((1 + targetApy)^(daysSinceBuy/365) - 1)) * multiplier
    let expectedGain = 0
    if (targetApy > 0) {
      for (const buy of buyTrades) {
        const daysSinceBuy = Math.max(0, (date.getTime() - buy.date.getTime()) / (1000 * 60 * 60 * 24))
        const gain = buy.amount * (Math.pow(1 + targetApy, daysSinceBuy / 365) - 1)
        expectedGain += gain
      }
    }
    const expectedTarget = startInput + (expectedGain * expectedGainMultiplier)

    result.push({
      date,
      value: isCashFund ? (entry.cash ?? entry.value) : entry.value,  // For cash funds, use cash balance as value
      startInput,
      fundSize,
      cashAvailable,
      cumulativeDividends,
      cumulativeExpenses,
      realizedGains,
      cashInterest,
      unrealizedGain,
      capturedProfit,
      cashPct,
      assetPct,
      apy,
      marginAvailable: entry.margin_available ?? 0,
      marginBorrowed: entry.margin_borrowed ?? 0,
      expectedTarget
    })
  }

  return result
}

// Stacked Area Chart Component with hover tooltips
export function StackedAreaChart({
  data,
  title,
  series,
  resize
}: {
  data: TimeSeriesPoint[]
  title: string
  series: { key: keyof TimeSeriesPoint; label: string; color: string }[]
  resize?: number
}) {
  const ref = useRef<SVGSVGElement>(null)

  // Get latest values for legend display
  const latestData = useMemo(() => {
    if (data.length === 0) return null
    return data[data.length - 1]
  }, [data])

  useEffect(() => {
    if (!ref.current || data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const margin = getResponsiveMargin(containerWidth)
    const axisFontSize = getAxisFontSize(containerWidth)
    const width = containerWidth - margin.left - margin.right
    const height = ref.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    // Compute stacked values
    const stackedData = data.map(d => {
      let y0 = 0
      return series.map(s => {
        const y1 = y0 + Math.max(0, d[s.key] as number)
        const result = { y0, y1, data: d, value: d[s.key] as number }
        y0 = y1
        return result
      })
    })

    let yMax = d3.max(stackedData, d => d[d.length - 1]?.y1 ?? 0) ?? 0

    // Ensure a minimum range to avoid collapsed scale when all values are zero
    if (yMax === 0) {
      yMax = 1
    }

    const y = d3.scaleLinear()
      .domain([0, yMax])
      .nice()
      .range([height, 0])

    // Draw areas
    series.forEach((s, i) => {
      const area = d3.area<typeof stackedData[0][0]>()
        .x((_, j) => x(data[j]!.date))
        .y0(d => y(d.y0))
        .y1(d => y(d.y1))
        .curve(d3.curveMonotoneX)

      const seriesData = stackedData.map(d => d[i]!)

      g.append('path')
        .datum(seriesData)
        .attr('fill', s.color)
        .attr('d', area)
    })

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

    // Hover tooltip elements
    const focus = g.append('g').style('display', 'none')

    focus.append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')

    const tooltip = focus.append('g').attr('class', 'tooltip-group')

    tooltip.append('rect')
      .attr('class', 'tooltip-bg')
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('rx', 4)
      .attr('ry', 4)

    tooltip.append('text')
      .attr('class', 'tooltip-date')
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')
      .attr('text-anchor', 'middle')

    // Add text elements for each series
    series.forEach((s, i) => {
      tooltip.append('text')
        .attr('class', `tooltip-value-${i}`)
        .attr('fill', s.color)
        .attr('font-size', '10px')
        .attr('text-anchor', 'middle')
    })

    const bisect = d3.bisector<TimeSeriesPoint, Date>(d => d.date).left

    g.append('rect')
      .attr('class', 'overlay')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .on('mouseover', () => focus.style('display', null))
      .on('mouseout', () => focus.style('display', 'none'))
      .on('mousemove', function(event) {
        const [mouseX] = d3.pointer(event)
        const x0 = x.invert(mouseX)
        const i = bisect(data, x0, 1)
        const d0 = data[i - 1]
        const d1 = data[i]
        if (!d0) return

        const d = d1 && (x0.getTime() - d0.date.getTime() > d1.date.getTime() - x0.getTime()) ? d1 : d0
        const xPos = x(d.date)

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)

        const dateStr = d3.timeFormat('%b %d, %Y')(d.date)
        const tooltipGroup = focus.select('.tooltip-group')
        tooltipGroup.select('.tooltip-date').text(dateStr)

        let maxWidth = 0
        series.forEach((s, idx) => {
          const value = d[s.key] as number
          const text = `${s.label}: ${formatCurrencyCompact(value)}`
          const textEl = tooltipGroup.select(`.tooltip-value-${idx}`).text(text)
          const bbox = (textEl.node() as SVGTextElement).getBBox()
          maxWidth = Math.max(maxWidth, bbox.width)
        })

        const tooltipWidth = maxWidth + 16
        const tooltipHeight = 16 + series.length * 14
        const tooltipY = 10

        let tooltipX = xPos
        if (xPos + tooltipWidth / 2 > width) {
          tooltipX = width - tooltipWidth / 2
        } else if (xPos - tooltipWidth / 2 < 0) {
          tooltipX = tooltipWidth / 2
        }

        tooltipGroup.attr('transform', `translate(${tooltipX}, ${tooltipY})`)

        tooltipGroup.select('.tooltip-bg')
          .attr('x', -tooltipWidth / 2)
          .attr('y', 0)
          .attr('width', tooltipWidth)
          .attr('height', tooltipHeight)

        tooltipGroup.select('.tooltip-date')
          .attr('x', 0)
          .attr('y', 11)

        series.forEach((_, idx) => {
          tooltipGroup.select(`.tooltip-value-${idx}`)
            .attr('x', 0)
            .attr('y', 24 + idx * 14)
        })
      })

  }, [data, series, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 mb-2">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        <div className="chart-legend flex flex-wrap gap-x-2 gap-y-1 sm:gap-3">
          {series.map(s => (
            <span key={s.key} className="text-[9px] sm:text-[10px] text-slate-400 flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
              {s.label}{latestData && <span className="text-white ml-1">{formatCurrencyCompact(latestData[s.key] as number)}</span>}
            </span>
          ))}
        </div>
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

// Chart Settings Dropdown Component
function ChartSettings({
  bounds,
  onChange,
  isPercent = false
}: {
  bounds: ChartBounds
  onChange: (bounds: ChartBounds) => void
  isPercent?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  // Convert from decimal to percent for display if isPercent
  const toDisplay = useCallback((val: number | undefined) => {
    if (val === undefined) return ''
    return isPercent ? (val * 100).toString() : val.toString()
  }, [isPercent])
  const [localMin, setLocalMin] = useState(() => toDisplay(bounds.yMin))
  const [localMax, setLocalMax] = useState(() => toDisplay(bounds.yMax))
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLocalMin(toDisplay(bounds.yMin))
    setLocalMax(toDisplay(bounds.yMax))
  }, [bounds, toDisplay])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleApply = () => {
    const newBounds: ChartBounds = {}
    if (localMin !== '') {
      newBounds.yMin = isPercent ? parseFloat(localMin) / 100 : parseFloat(localMin)
    }
    if (localMax !== '') {
      newBounds.yMax = isPercent ? parseFloat(localMax) / 100 : parseFloat(localMax)
    }
    onChange(newBounds)
    setIsOpen(false)
  }

  const handleClear = () => {
    setLocalMin('')
    setLocalMax('')
    onChange({})
    setIsOpen(false)
  }

  const hasBounds = bounds.yMin !== undefined || bounds.yMax !== undefined

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`p-1 rounded hover:bg-slate-700 transition-colors ${hasBounds ? 'text-mint-400' : 'text-slate-500'}`}
        title="Configure Y-axis bounds"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
        </svg>
      </button>
      {isOpen && (
        <div className="absolute right-0 top-6 z-50 bg-slate-700 rounded-lg shadow-lg border border-slate-600 p-2 min-w-[160px]">
          <div className="text-[10px] text-slate-400 mb-1.5">Y-Axis Bounds</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-slate-400 w-8">Min:</label>
              <input
                type="number"
                value={localMin}
                onChange={(e) => setLocalMin(e.target.value)}
                placeholder="Auto"
                className="flex-1 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-white w-16"
              />
              {isPercent && <span className="text-[10px] text-slate-400">%</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-slate-400 w-8">Max:</label>
              <input
                type="number"
                value={localMax}
                onChange={(e) => setLocalMax(e.target.value)}
                placeholder="Auto"
                className="flex-1 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-white w-16"
              />
              {isPercent && <span className="text-[10px] text-slate-400">%</span>}
            </div>
          </div>
          <div className="flex gap-1.5 mt-2">
            <button
              type="button"
              onClick={handleClear}
              className="flex-1 px-2 py-1 text-[10px] bg-slate-600 text-white rounded hover:bg-slate-500"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="flex-1 px-2 py-1 text-[10px] bg-mint-600 text-white rounded hover:bg-mint-700"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Line/Area Chart Component with hover tooltips
export function AreaChart({
  data,
  title,
  valueKey,
  color = '#10b981',
  formatValue = formatCurrencyCompact,
  allowNegative = false,
  bounds = {},
  onBoundsChange,
  isPercent = false,
  resize
}: {
  data: TimeSeriesPoint[]
  title: string
  valueKey: keyof TimeSeriesPoint
  color?: string
  formatValue?: (v: number) => string
  allowNegative?: boolean
  bounds?: ChartBounds
  onBoundsChange?: (bounds: ChartBounds) => void
  isPercent?: boolean
  resize?: number
}) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!ref.current || data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const margin = getResponsiveMargin(containerWidth)
    const axisFontSize = getAxisFontSize(containerWidth)
    const width = containerWidth - margin.left - margin.right
    const height = ref.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    const values = data.map(d => ({ date: d.date, value: d[valueKey] as number }))

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    const yExtent = d3.extent(values, d => d.value) as [number, number]
    // Use custom bounds if provided, otherwise use data extent
    let yMin = bounds.yMin !== undefined ? bounds.yMin : (allowNegative ? yExtent[0] : Math.min(0, yExtent[0]))
    let yMax = bounds.yMax !== undefined ? bounds.yMax : yExtent[1]

    // Ensure a minimum range to avoid collapsed scale when all values are the same
    if (yMin === yMax) {
      const padding = Math.abs(yMin) * 0.1 || 1
      yMin = yMin - padding
      yMax = yMax + padding
    }

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Clip path to prevent drawing outside bounds
    // Coordinates are relative to the g element (already translated by margins)
    const clipId = `clip-${title.replace(/\s+/g, '-')}-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    const baseline = y(Math.max(yMin, Math.min(yMax, 0)))

    const area = d3.area<typeof values[0]>()
      .x(d => x(d.date))
      .y0(baseline)
      .y1(d => y(Math.max(yMin, Math.min(yMax, d.value))))
      .curve(d3.curveMonotoneX)

    const line = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(Math.max(yMin, Math.min(yMax, d.value))))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', `${color}33`)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', area)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 1.5)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', line)

    // Zero line if needed
    if (allowNegative && yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#64748b')
        .attr('stroke-dasharray', '3,3')
    }

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => formatValue(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

    // Hover tooltip elements
    const focus = g.append('g').style('display', 'none')

    // Vertical line
    focus.append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')

    // Circle on the line
    focus.append('circle')
      .attr('class', 'hover-circle')
      .attr('r', 4)
      .attr('fill', color)
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)

    // Tooltip background
    const tooltip = focus.append('g').attr('class', 'tooltip-group')

    tooltip.append('rect')
      .attr('class', 'tooltip-bg')
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('rx', 4)
      .attr('ry', 4)

    tooltip.append('text')
      .attr('class', 'tooltip-date')
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-value')
      .attr('fill', '#fff')
      .attr('font-size', '11px')
      .attr('font-weight', 'bold')
      .attr('text-anchor', 'middle')

    // Overlay for mouse events
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('class', 'overlay')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .on('mouseover', () => focus.style('display', null))
      .on('mouseout', () => focus.style('display', 'none'))
      .on('mousemove', function(event) {
        const [mouseX] = d3.pointer(event)
        const x0 = x.invert(mouseX)
        const i = bisect(values, x0, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        if (!d0) return

        const d = d1 && (x0.getTime() - d0.date.getTime() > d1.date.getTime() - x0.getTime()) ? d1 : d0
        const xPos = x(d.date)
        const yPos = y(Math.max(yMin, Math.min(yMax, d.value)))

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)
        focus.select('.hover-circle').attr('cx', xPos).attr('cy', yPos)

        const dateStr = d3.timeFormat('%b %d, %Y')(d.date)
        const valueStr = formatValue(d.value)

        const tooltipGroup = focus.select('.tooltip-group')
        const dateText = tooltipGroup.select('.tooltip-date').text(dateStr)
        const valueText = tooltipGroup.select('.tooltip-value').text(valueStr)

        // Calculate tooltip dimensions
        const dateBBox = (dateText.node() as SVGTextElement).getBBox()
        const valueBBox = (valueText.node() as SVGTextElement).getBBox()
        const tooltipWidth = Math.max(dateBBox.width, valueBBox.width) + 16
        const tooltipHeight = 32

        // Position tooltip (flip if near edge)
        let tooltipX = xPos
        const tooltipY = yPos - tooltipHeight - 10

        if (xPos + tooltipWidth / 2 > width) {
          tooltipX = width - tooltipWidth / 2
        } else if (xPos - tooltipWidth / 2 < 0) {
          tooltipX = tooltipWidth / 2
        }

        tooltipGroup.attr('transform', `translate(${tooltipX}, ${Math.max(0, tooltipY)})`)

        tooltipGroup.select('.tooltip-bg')
          .attr('x', -tooltipWidth / 2)
          .attr('y', 0)
          .attr('width', tooltipWidth)
          .attr('height', tooltipHeight)

        tooltipGroup.select('.tooltip-date')
          .attr('x', 0)
          .attr('y', 11)

        tooltipGroup.select('.tooltip-value')
          .attr('x', 0)
          .attr('y', 26)
      })

  }, [data, valueKey, color, formatValue, allowNegative, bounds, title, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        {onBoundsChange && (
          <ChartSettings bounds={bounds} onChange={onBoundsChange} isPercent={isPercent} />
        )}
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

// Combined Value & Fund Size Chart - shows fund allocation with asset value overlay
export function ValueAndFundSizeChart({
  data,
  title,
  manageCash = true,
  resize
}: {
  data: TimeSeriesPoint[]
  title: string
  manageCash?: boolean
  resize?: number
}) {
  const ref = useRef<SVGSVGElement>(null)

  // Check if we have target data to display (memoized for both useEffect and JSX)
  const hasTarget = useMemo(() => data.some(d => d.expectedTarget > 0), [data])

  // Get latest values for legend display
  const latestData = useMemo(() => {
    if (data.length === 0) return null
    return data[data.length - 1]
  }, [data])

  useEffect(() => {
    if (!ref.current || data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const margin = getResponsiveMargin(containerWidth)
    const axisFontSize = getAxisFontSize(containerWidth)
    const width = containerWidth - margin.left - margin.right
    const height = ref.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    // Y scale based on max of fund size, asset value, or target
    const yMax = d3.max(data, d => Math.max(d.fundSize, d.value, d.expectedTarget)) ?? 0
    const y = d3.scaleLinear()
      .domain([0, yMax || 1])
      .nice()
      .range([height, 0])

    // Stacked areas for fund allocation
    if (manageCash) {
      // Invested (bottom) + Cash (top)
      const investedArea = d3.area<TimeSeriesPoint>()
        .x(d => x(d.date))
        .y0(height)
        .y1(d => y(d.startInput))
        .curve(d3.curveMonotoneX)

      const cashArea = d3.area<TimeSeriesPoint>()
        .x(d => x(d.date))
        .y0(d => y(d.startInput))
        .y1(d => y(d.startInput + d.cashAvailable))
        .curve(d3.curveMonotoneX)

      // Draw invested area (bottom - purple)
      g.append('path')
        .datum(data)
        .attr('fill', '#8b5cf633')
        .attr('d', investedArea)

      // Draw cash area (top - green)
      g.append('path')
        .datum(data)
        .attr('fill', '#22c55e33')
        .attr('d', cashArea)
    } else {
      // No cash management - just show invested area from baseline
      const investedArea = d3.area<TimeSeriesPoint>()
        .x(d => x(d.date))
        .y0(height)
        .y1(d => y(d.startInput))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(data)
        .attr('fill', '#8b5cf633')
        .attr('d', investedArea)
    }

    // Asset value line (orange) - shows actual equity value
    const valueLine = d3.line<TimeSeriesPoint>()
      .x(d => x(d.date))
      .y(d => y(d.value))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 2)
      .attr('d', valueLine)

    // Target equity line (cyan/teal dashed) - shows expected value based on target APY
    if (hasTarget) {
      const targetLine = d3.line<TimeSeriesPoint>()
        .x(d => x(d.date))
        .y(d => y(d.expectedTarget))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', '#06b6d4')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4,3')
        .attr('d', targetLine)
    }

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

    // Hover tooltip elements
    const focus = g.append('g').style('display', 'none')

    focus.append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')

    // Circle for asset value
    focus.append('circle')
      .attr('class', 'hover-circle-value')
      .attr('r', 4)
      .attr('fill', '#f59e0b')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)

    const tooltip = focus.append('g').attr('class', 'tooltip-group')

    tooltip.append('rect')
      .attr('class', 'tooltip-bg')
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('rx', 4)
      .attr('ry', 4)

    tooltip.append('text')
      .attr('class', 'tooltip-date')
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-value')
      .attr('fill', '#f59e0b')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-invested')
      .attr('fill', '#8b5cf6')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

    if (manageCash) {
      tooltip.append('text')
        .attr('class', 'tooltip-cash')
        .attr('fill', '#22c55e')
        .attr('font-size', '10px')
        .attr('text-anchor', 'middle')
    }

    if (hasTarget) {
      tooltip.append('text')
        .attr('class', 'tooltip-target')
        .attr('fill', '#06b6d4')
        .attr('font-size', '10px')
        .attr('text-anchor', 'middle')
    }

    const bisect = d3.bisector<TimeSeriesPoint, Date>(d => d.date).left

    g.append('rect')
      .attr('class', 'overlay')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .on('mouseover', () => focus.style('display', null))
      .on('mouseout', () => focus.style('display', 'none'))
      .on('mousemove', function(event) {
        const [mouseX] = d3.pointer(event)
        const x0 = x.invert(mouseX)
        const i = bisect(data, x0, 1)
        const d0 = data[i - 1]
        const d1 = data[i]
        if (!d0) return

        const d = d1 && (x0.getTime() - d0.date.getTime() > d1.date.getTime() - x0.getTime()) ? d1 : d0
        const xPos = x(d.date)

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)
        focus.select('.hover-circle-value').attr('cx', xPos).attr('cy', y(d.value))

        const dateStr = d3.timeFormat('%b %d, %Y')(d.date)
        const tooltipGroup = focus.select('.tooltip-group')
        tooltipGroup.select('.tooltip-date').text(dateStr)
        tooltipGroup.select('.tooltip-value').text(`Value: ${formatCurrencyCompact(d.value)}`)
        tooltipGroup.select('.tooltip-invested').text(`Invested: ${formatCurrencyCompact(d.startInput)}`)
        if (manageCash) {
          tooltipGroup.select('.tooltip-cash').text(`Cash: ${formatCurrencyCompact(d.cashAvailable)}`)
        }
        if (hasTarget) {
          tooltipGroup.select('.tooltip-target').text(`Target: ${formatCurrencyCompact(d.expectedTarget)}`)
        }

        const tooltipWidth = 110
        let tooltipHeight = 46  // base: date + value + invested
        if (manageCash) tooltipHeight += 14
        if (hasTarget) tooltipHeight += 14
        const tooltipY = 10

        let tooltipX = xPos
        if (xPos + tooltipWidth / 2 > width) {
          tooltipX = width - tooltipWidth / 2
        } else if (xPos - tooltipWidth / 2 < 0) {
          tooltipX = tooltipWidth / 2
        }

        tooltipGroup.attr('transform', `translate(${tooltipX}, ${tooltipY})`)

        tooltipGroup.select('.tooltip-bg')
          .attr('x', -tooltipWidth / 2)
          .attr('y', 0)
          .attr('width', tooltipWidth)
          .attr('height', tooltipHeight)

        tooltipGroup.select('.tooltip-date')
          .attr('x', 0)
          .attr('y', 11)

        tooltipGroup.select('.tooltip-value')
          .attr('x', 0)
          .attr('y', 25)

        tooltipGroup.select('.tooltip-invested')
          .attr('x', 0)
          .attr('y', 39)

        let nextY = 53
        if (manageCash) {
          tooltipGroup.select('.tooltip-cash')
            .attr('x', 0)
            .attr('y', nextY)
          nextY += 14
        }
        if (hasTarget) {
          tooltipGroup.select('.tooltip-target')
            .attr('x', 0)
            .attr('y', nextY)
        }
      })

  }, [data, manageCash, hasTarget, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 mb-2">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        <div className="chart-legend flex flex-wrap gap-x-2 gap-y-1 sm:gap-3">
          <span className="text-[9px] sm:text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: '#f59e0b' }} />
            Value{latestData && <span className="text-white ml-1">{formatCurrencyCompact(latestData.value)}</span>}
          </span>
          <span className="text-[9px] sm:text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: '#8b5cf6' }} />
            Invested{latestData && <span className="text-white ml-1">{formatCurrencyCompact(latestData.startInput)}</span>}
          </span>
          {manageCash && (
            <span className="text-[9px] sm:text-[10px] text-slate-400 flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: '#22c55e' }} />
              Cash
            </span>
          )}
          {hasTarget && (
            <span className="text-[9px] sm:text-[10px] text-slate-400 flex items-center gap-1">
              <span className="w-2 h-0.5 rounded-sm flex-shrink-0" style={{ backgroundColor: '#06b6d4', borderTop: '1px dashed #06b6d4' }} />
              Target{latestData && <span className="text-white ml-1">{formatCurrencyCompact(latestData.expectedTarget)}</span>}
            </span>
          )}
        </div>
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

// Margin Chart Component - shows margin available with borrowed as inner filled area
export function MarginChart({
  data,
  title,
  resize
}: {
  data: TimeSeriesPoint[]
  title: string
  resize?: number
}) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!ref.current || data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const containerWidth = ref.current.clientWidth
    const margin = getResponsiveMargin(containerWidth)
    const axisFontSize = getAxisFontSize(containerWidth)
    const width = containerWidth - margin.left - margin.right
    const height = ref.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    // Y scale based on max margin available
    const yMax = d3.max(data, d => d.marginAvailable) ?? 0
    const y = d3.scaleLinear()
      .domain([0, yMax || 1])
      .nice()
      .range([height, 0])

    // Area for margin available (outer boundary)
    const availableArea = d3.area<TimeSeriesPoint>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.marginAvailable))
      .curve(d3.curveMonotoneX)

    // Area for margin borrowed (inner filled)
    const borrowedArea = d3.area<TimeSeriesPoint>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.marginBorrowed))
      .curve(d3.curveMonotoneX)

    // Draw available area first (background - green/unused)
    g.append('path')
      .datum(data)
      .attr('fill', '#22c55e33')
      .attr('d', availableArea)

    // Draw borrowed area on top (purple/used)
    g.append('path')
      .datum(data)
      .attr('fill', '#8b5cf6')
      .attr('d', borrowedArea)

    // Line for margin available boundary
    const availableLine = d3.line<TimeSeriesPoint>()
      .x(d => x(d.date))
      .y(d => y(d.marginAvailable))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#22c55e')
      .attr('stroke-width', 1.5)
      .attr('d', availableLine)

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

    // Hover tooltip elements
    const focus = g.append('g').style('display', 'none')

    focus.append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')

    const tooltip = focus.append('g').attr('class', 'tooltip-group')

    tooltip.append('rect')
      .attr('class', 'tooltip-bg')
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('rx', 4)
      .attr('ry', 4)

    tooltip.append('text')
      .attr('class', 'tooltip-date')
      .attr('fill', '#94a3b8')
      .attr('font-size', '9px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-available')
      .attr('fill', '#22c55e')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-borrowed')
      .attr('fill', '#8b5cf6')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

    const bisect = d3.bisector<TimeSeriesPoint, Date>(d => d.date).left

    g.append('rect')
      .attr('class', 'overlay')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .on('mouseover', () => focus.style('display', null))
      .on('mouseout', () => focus.style('display', 'none'))
      .on('mousemove', function(event) {
        const [mouseX] = d3.pointer(event)
        const x0 = x.invert(mouseX)
        const i = bisect(data, x0, 1)
        const d0 = data[i - 1]
        const d1 = data[i]
        if (!d0) return

        const d = d1 && (x0.getTime() - d0.date.getTime() > d1.date.getTime() - x0.getTime()) ? d1 : d0
        const xPos = x(d.date)

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)

        const dateStr = d3.timeFormat('%b %d, %Y')(d.date)
        const tooltipGroup = focus.select('.tooltip-group')
        tooltipGroup.select('.tooltip-date').text(dateStr)
        tooltipGroup.select('.tooltip-available').text(`Available: ${formatCurrencyCompact(d.marginAvailable)}`)
        tooltipGroup.select('.tooltip-borrowed').text(`Borrowed: ${formatCurrencyCompact(d.marginBorrowed)}`)

        const tooltipWidth = 120
        const tooltipHeight = 46
        const tooltipY = 10

        let tooltipX = xPos
        if (xPos + tooltipWidth / 2 > width) {
          tooltipX = width - tooltipWidth / 2
        } else if (xPos - tooltipWidth / 2 < 0) {
          tooltipX = tooltipWidth / 2
        }

        tooltipGroup.attr('transform', `translate(${tooltipX}, ${tooltipY})`)

        tooltipGroup.select('.tooltip-bg')
          .attr('x', -tooltipWidth / 2)
          .attr('y', 0)
          .attr('width', tooltipWidth)
          .attr('height', tooltipHeight)

        tooltipGroup.select('.tooltip-date')
          .attr('x', 0)
          .attr('y', 11)

        tooltipGroup.select('.tooltip-available')
          .attr('x', 0)
          .attr('y', 25)

        tooltipGroup.select('.tooltip-borrowed')
          .attr('x', 0)
          .attr('y', 39)
      })

  }, [data, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        <div className="chart-legend flex gap-2">
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#22c55e' }} />
            Available
          </span>
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#8b5cf6' }} />
            Borrowed
          </span>
        </div>
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

type ChartKey = 'value' | 'derivativesPrice'

interface ChartBoundsState {
  value: ChartBounds
  derivativesPrice: ChartBounds
}

export function FundCharts({ entries, config, fundId, computedEntries, resize: externalResize }: FundChartsProps) {
  const isDerivativesFund = checkIsDerivativesFund(config.fund_type)
  const features = getFundTypeFeatures(config.fund_type ?? 'stock')

  // For derivatives, use computedEntries which has proper state; for others use raw entries
  const timeSeries = useMemo(() => {
    if (isDerivativesFund && computedEntries && computedEntries.length > 0) {
      // Build time series from computed derivatives state
      return computedEntries.map(entry => ({
        date: new Date(entry.date),
        value: entry.derivEquity ?? 0,  // Equity = marginBalance + unrealized
        startInput: entry.derivCostBasis ?? 0,  // Cost basis (invested in position)
        fundSize: entry.derivMarginBalance ?? 0,  // Margin balance (cash)
        cashAvailable: entry.derivAvailableFunds ?? ((entry.derivMarginBalance ?? 0) - (entry.derivMarginLocked ?? 0)),  // marginBalance - marginLocked
        cumulativeDividends: 0,
        cumulativeExpenses: -(entry.derivSumFees ?? 0),
        realizedGains: entry.derivRealized ?? 0,
        cashInterest: entry.derivSumInterest ?? 0,
        unrealizedGain: entry.derivUnrealized ?? 0,
        capturedProfit: entry.derivRealized ?? 0,
        cashPct: 0,
        assetPct: 0,
        apy: entry.realizedApy ?? 0,
        marginAvailable: entry.derivAvailableFunds ?? 0,
        marginBorrowed: 0,
        expectedTarget: 0  // Derivatives don't use target APY
      }))
    }
    return computeTimeSeries(entries, config)
  }, [entries, config, isDerivativesFund, computedEntries])
  const [chartResize, setChartResize] = useState(0)

  // Resize handler for charts - listens for window resize and sidebar toggle
  useEffect(() => {
    const handleResize = () => setChartResize(n => n + 1)
    window.addEventListener('resize', handleResize)
    window.addEventListener(SIDEBAR_TOGGLED_EVENT, handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener(SIDEBAR_TOGGLED_EVENT, handleResize)
    }
  }, [])

  // Use external resize signal if provided, otherwise use internal
  const effectiveResize = externalResize ?? chartResize

  // Initialize state from config.chart_bounds
  const [chartBounds, setChartBounds] = useState<ChartBoundsState>(() => ({
    value: config.chart_bounds?.value ?? {},
    derivativesPrice: config.chart_bounds?.derivativesPrice ?? {}
  }))

  // Sync with config when it changes externally
  useEffect(() => {
    setChartBounds({
      value: config.chart_bounds?.value ?? {},
      derivativesPrice: config.chart_bounds?.derivativesPrice ?? {}
    })
  }, [config.chart_bounds])

  const updateBounds = useCallback((chart: ChartKey) => async (bounds: ChartBounds) => {
    // Update local state immediately
    setChartBounds(prev => ({ ...prev, [chart]: bounds }))

    // Build new chart_bounds object
    const newChartBounds: Record<string, ChartBounds> = {
      ...config.chart_bounds,
      [chart]: bounds
    }

    // Remove empty bounds entries
    for (const key of Object.keys(newChartBounds)) {
      const b = newChartBounds[key]
      if (b && b.yMin === undefined && b.yMax === undefined) {
        delete newChartBounds[key]
      }
    }

    // Save to API - only include chart_bounds if there are values
    const configUpdate: Partial<FundConfig> = {}
    if (Object.keys(newChartBounds).length > 0) {
      configUpdate.chart_bounds = newChartBounds
    }
    await updateFundConfig(fundId, configUpdate)
    // Don't call onConfigUpdate - local state is already correct and we don't want to trigger a full reload
  }, [fundId, config.chart_bounds])

  if (timeSeries.length < 2) {
    return null
  }

  const isCashFund = checkIsCashFund(config.fund_type)
  const hasMarginData = timeSeries.some(d => d.marginAvailable > 0 || d.marginBorrowed > 0)

  const manageCash = config.manage_cash !== false

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* Combined Value & Allocation for trading funds, Balance for cash funds */}
      {/* Derivatives have their own DerivativesValueChart */}
      {isCashFund ? (
        <AreaChart
          data={timeSeries}
          title="Balance Over Time"
          valueKey="value"
          color="#f59e0b"
          bounds={chartBounds.value}
          onBoundsChange={updateBounds('value')}
          resize={effectiveResize}
        />
      ) : !isDerivativesFund ? (
        <ValueAndFundSizeChart
          data={timeSeries}
          title="Value & Allocation"
          manageCash={manageCash}
          resize={effectiveResize}
        />
      ) : null}

      {/* Captured Profit - different chart for derivatives vs stock/crypto */}
      {features.allowsTrading && !isDerivativesFund && (
        <StackedAreaChart
          data={timeSeries}
          title="Captured Profit"
          series={[
            ...(features.supportsDividends ? [{ key: 'cumulativeDividends' as const, label: 'Dividends', color: '#fbbf24' }] : []),
            ...(manageCash ? [{ key: 'cashInterest' as const, label: 'Cash Int', color: '#86efac' }] : []),
            { key: 'realizedGains', label: 'Extracted', color: '#3b82f6' }
          ]}
          resize={effectiveResize}
        />
      )}

      {/* Derivatives Charts */}
      {isDerivativesFund && computedEntries && (
        <>
          <DerivativesValueChart
            entries={computedEntries}
            resize={effectiveResize}
          />
          <DerivativesPriceChart
            entries={computedEntries}
            resize={effectiveResize}
            bounds={chartBounds.derivativesPrice}
            onBoundsChange={updateBounds('derivativesPrice')}
          />
          <DerivativesMarginChart
            entries={computedEntries}
            resize={effectiveResize}
          />
          <DerivativesCapturedProfitChart
            entries={computedEntries}
            resize={effectiveResize}
          />
          <DerivativesBreakEvenPanel
            entries={entries}
            computedEntries={computedEntries}
            contractMultiplier={config.contract_multiplier ?? 0.01}
            maintenanceMarginRate={config.maintenance_margin_rate ?? 0.20}
          />
        </>
      )}

      {/* Margin chart for cash funds if they have margin data */}
      {isCashFund && hasMarginData && (
        <MarginChart
          data={timeSeries}
          title="Margin"
          resize={effectiveResize}
        />
      )}

    </div>
  )
}

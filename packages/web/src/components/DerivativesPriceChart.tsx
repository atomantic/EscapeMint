import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import type { ComputedEntry } from './entriesTable'
import type { ChartBounds } from '../api/funds'
import { formatCurrencyCompact } from '../utils/format'

interface DerivativesPriceChartProps {
  entries: ComputedEntry[]
  resize?: number
  bounds?: ChartBounds
  onBoundsChange?: (bounds: ChartBounds) => void
}

interface ChartDataPoint {
  date: Date
  avgEntry: number
  liquidationPrice: number
  position: number
}

// Prepare data from computed entries
function prepareChartData(entries: ComputedEntry[]): ChartDataPoint[] {
  // Sort by date and get last entry per date (most recent state for that date)
  const byDate = new Map<string, ComputedEntry>()

  for (const entry of entries) {
    // Keep the last entry for each date (entries are already sorted, last has cumulative values)
    byDate.set(entry.date, entry)
  }

  const result: ChartDataPoint[] = []
  for (const [dateStr, entry] of byDate) {
    const avgEntry = entry.derivAvgEntry ?? 0
    const liquidationPrice = entry.derivLiquidationPrice ?? 0
    const position = entry.derivPosition ?? 0

    // Only include points where there's an open position
    if (position > 0 && avgEntry > 0) {
      result.push({
        date: new Date(dateStr),
        avgEntry,
        liquidationPrice,
        position
      })
    }
  }

  return result.sort((a, b) => a.date.getTime() - b.date.getTime())
}

// Chart Settings Dropdown Component
function ChartSettings({
  bounds,
  onChange
}: {
  bounds: ChartBounds
  onChange: (bounds: ChartBounds) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const toDisplay = useCallback((val: number | undefined) => {
    if (val === undefined) return ''
    return val.toString()
  }, [])
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
      newBounds.yMin = parseFloat(localMin)
    }
    if (localMax !== '') {
      newBounds.yMax = parseFloat(localMax)
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

export function DerivativesPriceChart({ entries, resize, bounds = {}, onBoundsChange }: DerivativesPriceChartProps) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!ref.current) return

    const data = prepareChartData(entries)
    if (data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const margin = { top: 10, right: 10, bottom: 25, left: 65 }
    const width = ref.current.clientWidth - margin.left - margin.right
    const height = ref.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // X scale - time
    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    // Y scale - price (include both positive and negative liquidation prices)
    const allPrices = data.flatMap(d => [d.avgEntry, d.liquidationPrice])
    const [dataMin, dataMax] = d3.extent(allPrices) as [number, number]

    // Use custom bounds if provided, otherwise use data extent with padding
    const padding = (dataMax - dataMin) * 0.1 || 1000
    let yMin = bounds.yMin !== undefined ? bounds.yMin : dataMin - padding
    let yMax = bounds.yMax !== undefined ? bounds.yMax : dataMax + padding

    // Ensure a minimum range to avoid collapsed scale
    if (yMin === yMax) {
      const pad = Math.abs(yMin) * 0.1 || 1000
      yMin = yMin - pad
      yMax = yMax + pad
    }

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Clip path
    const clipId = `price-clip-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // Zero line if Y range spans across zero
    const [yDomainMin, yDomainMax] = y.domain()
    if (yDomainMin !== undefined && yDomainMax !== undefined && yDomainMin < 0 && yDomainMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#64748b')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3,3')
    }

    // Clamp helper for values outside bounds
    const clamp = (val: number) => Math.max(yMin, Math.min(yMax, val))

    // Avg Entry Price line (amber)
    const avgEntryLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.avgEntry)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 2)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', avgEntryLine)

    // Liquidation Price line (color based on negative/positive)
    const liqPriceLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.liquidationPrice)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#22c55e')  // Green for safe (negative = over-collateralized)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', liqPriceLine)

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d => d3.timeFormat('%b %d')(d as Date)))
      .call(g => g.select('.domain').attr('stroke', '#475569'))
      .call(g => g.selectAll('.tick line').attr('stroke', '#475569'))
      .call(g => g.selectAll('.tick text').attr('fill', '#94a3b8').style('font-size', '10px'))

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(d => formatCurrencyCompact(d as number)))
      .call(g => g.select('.domain').attr('stroke', '#475569'))
      .call(g => g.selectAll('.tick line').attr('stroke', '#475569'))
      .call(g => g.selectAll('.tick text').attr('fill', '#94a3b8').style('font-size', '10px'))

    // Interactive hover
    const focus = g.append('g').style('display', 'none')

    // Vertical line
    focus.append('line')
      .attr('class', 'focus-line')
      .attr('stroke', '#94a3b8')
      .attr('stroke-dasharray', '3,3')
      .attr('y1', 0)
      .attr('y2', height)

    // Tooltip background
    const tooltip = focus.append('g').attr('class', 'tooltip')
    tooltip.append('rect')
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('rx', 4)
      .attr('ry', 4)

    const tooltipText = tooltip.append('text')
      .attr('fill', '#e2e8f0')
      .style('font-size', '11px')

    // Overlay for mouse events
    g.append('rect')
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .attr('width', width)
      .attr('height', height)
      .on('mouseover', () => focus.style('display', null))
      .on('mouseout', () => focus.style('display', 'none'))
      .on('mousemove', (event: MouseEvent) => {
        const [mouseX] = d3.pointer(event)
        const x0 = x.invert(mouseX)

        // Find closest data point
        const bisect = d3.bisector<ChartDataPoint, Date>(d => d.date).left
        const i = bisect(data, x0, 1)
        const d0 = data[i - 1]
        const d1 = data[i]
        if (!d0 && !d1) return

        // Select closest data point - if only one exists, use it; otherwise pick nearest
        const d = !d0 ? d1 : !d1 ? d0 : (x0.getTime() - d0.date.getTime() > d1.date.getTime() - x0.getTime()) ? d1 : d0
        if (!d) return

        const xPos = x(d.date)
        focus.select('.focus-line').attr('x1', xPos).attr('x2', xPos)

        // Build tooltip content
        const lines = [
          d3.timeFormat('%b %d, %Y')(d.date),
          `Avg Entry: ${formatCurrencyCompact(d.avgEntry)}`,
          `Liq Price: ${formatCurrencyCompact(d.liquidationPrice)}`,
          `Position: ${d.position} contracts`
        ]

        tooltipText.selectAll('tspan').remove()
        lines.forEach((line, idx) => {
          tooltipText.append('tspan')
            .attr('x', 8)
            .attr('dy', idx === 0 ? '1.2em' : '1.4em')
            .text(line)
        })

        // Size and position tooltip
        const bbox = tooltipText.node()?.getBBox()
        if (bbox) {
          tooltip.select('rect')
            .attr('width', bbox.width + 16)
            .attr('height', bbox.height + 12)
            .attr('y', 2)

          // Position tooltip
          let tooltipX = xPos + 10
          if (tooltipX + bbox.width + 16 > width) {
            tooltipX = xPos - bbox.width - 26
          }
          tooltip.attr('transform', `translate(${tooltipX},${Math.min(height - bbox.height - 20, Math.max(0, y(d.avgEntry) - bbox.height / 2))})`)
        }
      })

  }, [entries, resize, bounds])

  if (entries.length < 2) {
    return null
  }

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-white">Price & Liquidation</h3>
        <div className="chart-legend flex items-center gap-3">
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#f59e0b' }} />
            Avg Entry
          </span>
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-0.5" style={{ backgroundColor: '#22c55e' }} />
            Liq Price
          </span>
          {onBoundsChange && (
            <ChartSettings bounds={bounds} onChange={onBoundsChange} />
          )}
        </div>
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

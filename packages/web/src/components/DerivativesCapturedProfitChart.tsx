import { useEffect, useRef } from 'react'
import * as d3 from 'd3'
import type { ComputedEntry } from './entriesTable'
import { formatCurrencyCompact } from '../utils/format'

interface DerivativesCapturedProfitChartProps {
  entries: ComputedEntry[]
  resize?: number
}

interface ChartDataPoint {
  date: Date
  realized: number
  funding: number
  interest: number
  rebates: number
  fees: number  // Will be shown as negative
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
    const realized = entry.derivRealized ?? 0
    const funding = entry.derivCumFunding ?? 0
    const interest = entry.derivCumInterest ?? 0
    const rebates = entry.derivCumRebates ?? 0
    const fees = entry.derivCumFees ?? 0  // Positive in data, will negate for display

    result.push({
      date: new Date(dateStr),
      realized,
      funding,
      interest,
      rebates,
      fees
    })
  }

  return result.sort((a, b) => a.date.getTime() - b.date.getTime())
}

const SERIES = [
  { key: 'realized' as const, label: 'Realized', color: '#22c55e' },  // Green
  { key: 'funding' as const, label: 'Funding', color: '#3b82f6' },    // Blue
  { key: 'interest' as const, label: 'Interest', color: '#8b5cf6' },  // Purple
  { key: 'rebates' as const, label: 'Rebates', color: '#06b6d4' },    // Cyan
  { key: 'fees' as const, label: 'Fees', color: '#ef4444' }           // Red (shown negative)
]

export function DerivativesCapturedProfitChart({ entries, resize }: DerivativesCapturedProfitChartProps) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!ref.current) return

    const data = prepareChartData(entries)
    if (data.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const margin = { top: 10, right: 10, bottom: 25, left: 55 }
    const width = ref.current.clientWidth - margin.left - margin.right
    const height = ref.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    // Calculate Y extent including negative fees
    let yMin = 0
    let yMax = 0
    for (const d of data) {
      // Positive components
      yMax = Math.max(yMax, d.realized, d.funding, d.interest, d.rebates)
      // Negative components (fees shown as negative)
      yMin = Math.min(yMin, -d.fees, d.funding)  // Funding can be negative too
    }

    // Add padding
    const padding = (yMax - yMin) * 0.1
    yMin = yMin - padding
    yMax = yMax + padding

    // Ensure we have a reasonable scale
    if (yMin === yMax) {
      yMin = -1
      yMax = 1
    }

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Draw zero baseline
    if (yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#64748b')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,4')
    }

    // Draw each series as a line
    const drawLine = (key: keyof ChartDataPoint, color: string, negate = false) => {
      const line = d3.line<ChartDataPoint>()
        .x(d => x(d.date))
        .y(d => y(negate ? -(d[key] as number) : (d[key] as number)))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 1.5)
        .attr('d', line)
    }

    // Draw lines for each series (fees negated to show as deduction)
    drawLine('realized', '#22c55e')
    drawLine('funding', '#3b82f6')
    drawLine('interest', '#8b5cf6')
    drawLine('rebates', '#06b6d4')
    drawLine('fees', '#ef4444', true)  // Negate fees to show as negative

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '9px')

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '9px')

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

    // Hover tooltip
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

    // Add text for each series
    SERIES.forEach((s, i) => {
      tooltip.append('text')
        .attr('class', `tooltip-value-${i}`)
        .attr('fill', s.color)
        .attr('font-size', '10px')
        .attr('text-anchor', 'middle')
    })

    const bisect = d3.bisector<ChartDataPoint, Date>(d => d.date).left

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
        SERIES.forEach((s, idx) => {
          // Show fees as negative in tooltip
          const value = s.key === 'fees' ? -d.fees : d[s.key]
          const text = `${s.label}: ${formatCurrencyCompact(value)}`
          const textEl = tooltipGroup.select(`.tooltip-value-${idx}`).text(text)
          const bbox = (textEl.node() as SVGTextElement).getBBox()
          maxWidth = Math.max(maxWidth, bbox.width)
        })

        const tooltipWidth = maxWidth + 16
        const tooltipHeight = 16 + SERIES.length * 14
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

        SERIES.forEach((_, idx) => {
          tooltipGroup.select(`.tooltip-value-${idx}`)
            .attr('x', 0)
            .attr('y', 24 + idx * 14)
        })
      })

  }, [entries, resize])

  if (entries.length < 2) {
    return null
  }

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-white">Captured Profit</h3>
        <div className="chart-legend flex gap-2 flex-wrap">
          {SERIES.map(s => (
            <span key={s.key} className="text-[10px] text-slate-400 flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

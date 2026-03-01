import { useEffect, useRef } from 'react'
import * as d3 from 'd3'
import type { ComputedEntry } from './entriesTable'
import { formatCurrencyCompact } from '../utils/format'

interface DerivativesValueChartProps {
  entries: ComputedEntry[]
  resize?: number
}

interface ChartDataPoint {
  date: Date
  notionalValue: number    // Total position exposure (position * multiplier * avgEntry)
  costBasis: number        // What was paid for the position
  positionValue: number    // Current position value (costBasis + unrealized)
  unrealized: number       // Unrealized P&L
}

// Prepare data from computed entries
function prepareChartData(entries: ComputedEntry[]): ChartDataPoint[] {
  // Sort by date and get last entry per date
  const byDate = new Map<string, ComputedEntry>()

  for (const entry of entries) {
    byDate.set(entry.date, entry)
  }

  const result: ChartDataPoint[] = []
  for (const [dateStr, entry] of byDate) {
    const notionalValue = entry.derivNotionalValue ?? 0
    const costBasis = entry.derivCostBasis ?? 0
    const unrealized = entry.derivUnrealized ?? 0
    // Position value = what we paid + unrealized gain/loss
    const positionValue = costBasis + unrealized

    // Only include if there's position data
    if (notionalValue > 0 || costBasis > 0) {
      result.push({
        date: new Date(dateStr),
        notionalValue,
        costBasis,
        positionValue,
        unrealized
      })
    }
  }

  return result.sort((a, b) => a.date.getTime() - b.date.getTime())
}

export function DerivativesValueChart({ entries, resize }: DerivativesValueChartProps) {
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

    // Y scale - dollar amounts
    const allValues = data.flatMap(d => [d.notionalValue, d.costBasis, d.positionValue])
    const [minVal, maxVal] = d3.extent(allValues) as [number, number]
    const padding = (maxVal - minVal) * 0.1 || 1000
    const y = d3.scaleLinear()
      .domain([Math.max(0, minVal - padding), maxVal + padding])
      .nice()
      .range([height, 0])

    // Clip path
    const clipId = `value-clip-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // Notional Value area (light fill)
    const notionalArea = d3.area<ChartDataPoint>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.notionalValue))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'rgba(139, 92, 246, 0.15)')  // Purple
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', notionalArea)

    // Cost Basis area (overlaid)
    const costBasisArea = d3.area<ChartDataPoint>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.costBasis))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'rgba(59, 130, 246, 0.2)')  // Blue
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', costBasisArea)

    // Notional Value line (purple)
    const notionalLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(d.notionalValue))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#8b5cf6')
      .attr('stroke-width', 2)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', notionalLine)

    // Cost Basis line (blue, dashed)
    const costBasisLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(d.costBasis))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#3b82f6')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', costBasisLine)

    // Position Value line (green)
    const positionValueLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(d.positionValue))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#22c55e')
      .attr('stroke-width', 2)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', positionValueLine)

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

    focus.append('line')
      .attr('class', 'focus-line')
      .attr('stroke', '#94a3b8')
      .attr('stroke-dasharray', '3,3')
      .attr('y1', 0)
      .attr('y2', height)

    const tooltip = focus.append('g').attr('class', 'tooltip')
    tooltip.append('rect')
      .attr('fill', '#1e293b')
      .attr('stroke', '#475569')
      .attr('rx', 4)
      .attr('ry', 4)

    const tooltipText = tooltip.append('text')
      .attr('fill', '#e2e8f0')
      .style('font-size', '11px')

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

        const lines = [
          d3.timeFormat('%b %d, %Y')(d.date),
          `Notional: ${formatCurrencyCompact(d.notionalValue)}`,
          `Cost Basis: ${formatCurrencyCompact(d.costBasis)}`,
          `Position Value: ${formatCurrencyCompact(d.positionValue)}`,
          `Unrealized: ${d.unrealized >= 0 ? '+' : ''}${formatCurrencyCompact(d.unrealized)}`
        ]

        tooltipText.selectAll('tspan').remove()
        lines.forEach((line, idx) => {
          tooltipText.append('tspan')
            .attr('x', 8)
            .attr('dy', idx === 0 ? '1.2em' : '1.4em')
            .text(line)
        })

        const bbox = tooltipText.node()?.getBBox()
        if (bbox) {
          tooltip.select('rect')
            .attr('width', bbox.width + 16)
            .attr('height', bbox.height + 12)
            .attr('y', 2)

          let tooltipX = xPos + 10
          if (tooltipX + bbox.width + 16 > width) {
            tooltipX = xPos - bbox.width - 26
          }
          tooltip.attr('transform', `translate(${tooltipX},${Math.min(height - bbox.height - 20, 10)})`)
        }
      })

  }, [entries, resize])

  if (entries.length < 2) {
    return null
  }

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col h-[200px]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-white">Value & Allocation</h3>
        <div className="chart-legend flex gap-3">
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#8b5cf6' }} />
            Notional
          </span>
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-0.5" style={{ backgroundColor: '#3b82f6' }} />
            Cost Basis
          </span>
          <span className="text-[10px] text-slate-400 flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#22c55e' }} />
            Position Value
          </span>
        </div>
      </div>
      <svg ref={ref} className="w-full flex-1 min-h-[100px]" style={{ overflow: 'visible' }} />
    </div>
  )
}

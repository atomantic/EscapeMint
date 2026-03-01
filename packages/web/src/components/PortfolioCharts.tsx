import { useEffect, useRef, useState, memo } from 'react'
import * as d3 from 'd3'
import type { TimeSeriesPoint, AllocationData } from '../api/funds'
import { formatCurrencyCompact, formatPercentSimple } from '../utils/format'
import { CategoryBarChart, type CategoryChartData, type MarginInfo } from './CategoryBarChart'

interface PortfolioChartsProps {
  timeSeries: TimeSeriesPoint[]
  allocations: AllocationData[]
  totals: {
    totalCurrentValue: number
    totalCurrentCash: number
    totalCurrentMarginAccess: number
    totalCurrentMarginBorrowed: number
  }
  aggregateTotals?: {
    totalGainUsd: number
    totalRealizedGains: number
    totalUnrealizedGains?: number
    totalValue: number
    totalStartInput: number
    realizedAPY?: number
    liquidAPY?: number
  }
  categoryAllocations?: CategoryChartData[]
  marginInfo?: MarginInfo
}

// Colors for pie charts
const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
]

// Responsive chart margins based on container width
const getResponsiveMargin = (containerWidth: number) => ({
  top: 10,
  right: 10,
  bottom: 20,
  // Reduce left margin on narrow screens (mobile = ~160-180px per chart in 2-col grid)
  left: containerWidth < 200 ? 32 : containerWidth < 300 ? 38 : 45
})

// Responsive font size for axis labels
const getAxisFontSize = (containerWidth: number) =>
  containerWidth < 200 ? '7px' : containerWidth < 300 ? '8px' : '9px'

// Mobile-friendly allocation list (replaces pie charts on small screens)
const AllocationList = memo(function AllocationList({ data, title, valueKey, showPlatformOnly = false }: {
  data: AllocationData[]
  title: string
  valueKey: 'value' | 'cash' | 'fundSize'
  showPlatformOnly?: boolean
}) {
  const sortedData = [...data]
    .filter(d => d[valueKey] > 0)
    .sort((a, b) => b[valueKey] - a[valueKey])

  const total = sortedData.reduce((sum, d) => sum + d[valueKey], 0)
  const maxValue = sortedData[0]?.[valueKey] ?? 1

  return (
    <div className="bg-slate-800 rounded-lg p-2 border border-slate-700">
      <h3 className="text-[10px] font-medium text-white mb-1.5">{title}</h3>
      <div className="chart-legend space-y-1.5">
        {sortedData.slice(0, 5).map((d, i) => {
          const pct = (d[valueKey] / total * 100)
          const barWidth = (d[valueKey] / maxValue * 100)
          const label = showPlatformOnly ? d.platform : `${d.platform}-${d.ticker}`
          return (
            <div key={d.id} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between text-[9px] mb-0.5">
                  <span className="text-slate-300 truncate">{label}</span>
                  <span className="text-slate-400 font-mono ml-1 flex-shrink-0">
                    {formatCurrencyCompact(d[valueKey])} ({pct.toFixed(0)}%)
                  </span>
                </div>
                <div className="h-1.5 bg-slate-700 rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm"
                    style={{
                      width: `${barWidth}%`,
                      backgroundColor: COLORS[i % COLORS.length]
                    }}
                  />
                </div>
              </div>
            </div>
          )
        })}
        {sortedData.length > 5 && (
          <div className="text-[8px] text-slate-500 text-center pt-0.5">
            +{sortedData.length - 5} more
          </div>
        )}
      </div>
    </div>
  )
})

// Pie Chart Component with side-by-side legend
const PieChart = memo(function PieChart({ data, title, valueKey }: { data: AllocationData[]; title: string; valueKey: 'value' | 'cash' | 'fundSize' }) {
  const ref = useRef<SVGSVGElement>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Sort data by value descending, take top 5 for legend
  const sortedData = [...data]
    .filter(d => d[valueKey] > 0)
    .sort((a, b) => b[valueKey] - a[valueKey])

  const legendData = sortedData.slice(0, 5)
  const total = sortedData.reduce((sum, d) => sum + d[valueKey], 0)
  const maxValue = legendData[0]?.[valueKey] ?? 1

  useEffect(() => {
    if (!ref.current || !chartContainerRef.current || sortedData.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    // Fixed size for pie chart in two-column layout
    const size = 100
    const width = size
    const height = size
    const radius = Math.min(width, height) / 2 - 5

    const g = svg
      .attr('width', width)
      .attr('height', height)
      .append('g')
      .attr('transform', `translate(${width / 2},${height / 2})`)

    const pieData = sortedData.map(d => ({ ...d, chartValue: d[valueKey] }))

    const pie = d3.pie<typeof pieData[0]>()
      .value(d => d.chartValue)
      .sort(null)

    const arc = d3.arc<d3.PieArcDatum<typeof pieData[0]>>()
      .innerRadius(0)
      .outerRadius(radius)

    const tooltip = d3.select(tooltipRef.current)

    const arcs = g.selectAll('arc')
      .data(pie(pieData))
      .enter()
      .append('g')

    arcs.append('path')
      .attr('d', arc)
      .attr('fill', (_, i) => COLORS[i % COLORS.length] ?? '#666')
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 1)
      .attr('cursor', 'pointer')
      .on('mouseover', function(_event, d) {
        const pct = (d.data.chartValue / total * 100).toFixed(1)
        tooltip
          .style('opacity', 1)
          .html(`<strong>${d.data.ticker}</strong><br/>${formatCurrencyCompact(d.data.chartValue)}<br/>${pct}%`)
        d3.select(this).attr('opacity', 0.8)
      })
      .on('mousemove', function(event) {
        tooltip
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', function() {
        tooltip.style('opacity', 0)
        d3.select(this).attr('opacity', 1)
      })

  }, [sortedData, valueKey, total])

  return (
    <div className="bg-slate-800 rounded-lg p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation snap-start">
      <h3 className="text-[9px] sm:text-[10px] md:text-xs font-medium text-white mb-1 truncate">{title}</h3>
      {/* Two-column layout: pie chart | legend */}
      <div className="flex items-start gap-2">
        {/* Pie chart */}
        <div ref={chartContainerRef} className="flex-shrink-0">
          <svg ref={ref} />
        </div>
        {/* Legend with filled bars */}
        <div className="flex-1 flex flex-col gap-1 min-w-0">
          {legendData.map((d, i) => {
            const pct = (d[valueKey] / total * 100)
            const barWidth = (d[valueKey] / maxValue * 100)
            const label = `${d.platform}-${d.ticker}`
            return (
              <div key={d.id} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-[8px] sm:text-[9px]">
                  <span className="text-slate-300 truncate" title={label}>{label}</span>
                  <span className="text-slate-400 font-mono ml-1 flex-shrink-0">{formatCurrencyCompact(d[valueKey])}</span>
                </div>
                {/* Filled bar indicator */}
                <div className="h-1.5 sm:h-2 bg-slate-700 rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm transition-all"
                    style={{
                      width: `${barWidth}%`,
                      backgroundColor: COLORS[i % COLORS.length]
                    }}
                  />
                </div>
                <span className="text-[7px] sm:text-[8px] text-slate-500">{pct.toFixed(1)}%</span>
              </div>
            )
          })}
        </div>
      </div>
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[180px]"
        style={{ opacity: 0 }}
      />
    </div>
  )
})

// Platform Pie Chart Component (shows just platform name in legend)
const PlatformPieChart = memo(function PlatformPieChart({ data, title, valueKey }: { data: AllocationData[]; title: string; valueKey: 'value' | 'cash' | 'fundSize' }) {
  const ref = useRef<SVGSVGElement>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Sort data by value descending, take top 5 for legend
  const sortedData = [...data]
    .filter(d => d[valueKey] > 0)
    .sort((a, b) => b[valueKey] - a[valueKey])

  const legendData = sortedData.slice(0, 5)
  const total = sortedData.reduce((sum, d) => sum + d[valueKey], 0)
  const maxValue = legendData[0]?.[valueKey] ?? 1

  useEffect(() => {
    if (!ref.current || !chartContainerRef.current || sortedData.length === 0) return

    const svg = d3.select(ref.current)
    svg.selectAll('*').remove()

    const size = 100
    const width = size
    const height = size
    const radius = Math.min(width, height) / 2 - 5

    const g = svg
      .attr('width', width)
      .attr('height', height)
      .append('g')
      .attr('transform', `translate(${width / 2},${height / 2})`)

    const pieData = sortedData.map(d => ({ ...d, chartValue: d[valueKey] }))

    const pie = d3.pie<typeof pieData[0]>()
      .value(d => d.chartValue)
      .sort(null)

    const arc = d3.arc<d3.PieArcDatum<typeof pieData[0]>>()
      .innerRadius(0)
      .outerRadius(radius)

    const tooltip = d3.select(tooltipRef.current)

    const arcs = g.selectAll('arc')
      .data(pie(pieData))
      .enter()
      .append('g')

    arcs.append('path')
      .attr('d', arc)
      .attr('fill', (_, i) => COLORS[i % COLORS.length] ?? '#666')
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 1)
      .attr('cursor', 'pointer')
      .on('mouseover', function(_event, d) {
        const pct = (d.data.chartValue / total * 100).toFixed(1)
        tooltip
          .style('opacity', 1)
          .html(`<strong>${d.data.platform}</strong><br/>${formatCurrencyCompact(d.data.chartValue)}<br/>${pct}%`)
        d3.select(this).attr('opacity', 0.8)
      })
      .on('mousemove', function(event) {
        tooltip
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', function() {
        tooltip.style('opacity', 0)
        d3.select(this).attr('opacity', 1)
      })

  }, [sortedData, valueKey, total])

  return (
    <div className="bg-slate-800 rounded-lg p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation snap-start">
      <h3 className="text-[9px] sm:text-[10px] md:text-xs font-medium text-white mb-1 truncate">{title}</h3>
      <div className="flex items-start gap-2">
        <div ref={chartContainerRef} className="flex-shrink-0">
          <svg ref={ref} />
        </div>
        <div className="flex-1 flex flex-col gap-1 min-w-0">
          {legendData.map((d, i) => {
            const pct = (d[valueKey] / total * 100)
            const barWidth = (d[valueKey] / maxValue * 100)
            return (
              <div key={d.id} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-[8px] sm:text-[9px]">
                  <span className="text-slate-300 truncate">{d.platform}</span>
                  <span className="text-slate-400 font-mono ml-1 flex-shrink-0">{formatCurrencyCompact(d[valueKey])}</span>
                </div>
                <div className="h-1.5 sm:h-2 bg-slate-700 rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm transition-all"
                    style={{
                      width: `${barWidth}%`,
                      backgroundColor: COLORS[i % COLORS.length]
                    }}
                  />
                </div>
                <span className="text-[7px] sm:text-[8px] text-slate-500">{pct.toFixed(1)}%</span>
              </div>
            )
          })}
        </div>
      </div>
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[180px]"
        style={{ opacity: 0 }}
      />
    </div>
  )
})

// Stacked Area Chart for Cash vs Asset
const StackedAreaChart = memo(function StackedAreaChart({ data, resize }: { data: TimeSeriesPoint[]; resize?: number }) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

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

    const values = data.map(d => {
      const total = d.totalValue + d.totalCash
      return {
        date: new Date(d.date),
        cashPct: total > 0 ? d.totalCash / total : 0,
        assetPct: total > 0 ? d.totalValue / total : 0,
        cash: d.totalCash,
        asset: d.totalValue
      }
    })

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    const y = d3.scaleLinear()
      .domain([0, 1])
      .range([height, 0])

    const stack = d3.stack<typeof values[0]>()
      .keys(['cashPct', 'assetPct'])

    const stackedData = stack(values)

    const area = d3.area<d3.SeriesPoint<typeof values[0]>>()
      .x(d => x(d.data.date))
      .y0(d => y(d[0]))
      .y1(d => y(d[1]))
      .curve(d3.curveMonotoneX)

    const colors = ['#10b981', '#8b5cf6']

    g.selectAll('path.area')
      .data(stackedData)
      .enter()
      .append('path')
      .attr('class', 'area')
      .attr('fill', (_, i) => colors[i] ?? '#666')
      .attr('d', area)

    // Tooltip and mouse tracking
    const tooltip = d3.select(tooltipRef.current)
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(values, date, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        if (!d0 || !d1) return
        const d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0
        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/>Cash: ${(d.cashPct * 100).toFixed(1)}% (${formatCurrencyCompact(d.cash)})<br/>Asset: ${(d.assetPct * 100).toFixed(1)}% (${formatCurrencyCompact(d.asset)})`)
        // Position tooltip - flip to left side if near right edge
        const tooltipWidth = 160
        const leftPos = event.pageX + tooltipWidth + 20 > window.innerWidth
          ? event.pageX - tooltipWidth - 10
          : event.pageX + 10
        tooltip
          .style('left', leftPos + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => `${((d as number) * 100).toFixed(0)}%`))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white mb-0.5">Cash vs Asset</h3>
      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[200px]"
        style={{ opacity: 0 }}
      />
      <div className="flex gap-1 xs:gap-1.5 sm:gap-2 mt-0.5 justify-center text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
        <span className="flex items-center gap-0.5 text-slate-400">
          <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500" />Cash
        </span>
        <span className="flex items-center gap-0.5 text-slate-400">
          <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-violet-500" />Asset
        </span>
      </div>
    </div>
  )
})

// Stacked Area Chart for Fund Liquid Value (Cash + Asset in absolute dollars)
const LiquidValueStackedChart = memo(function LiquidValueStackedChart({ data, resize }: { data: TimeSeriesPoint[]; resize?: number }) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

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

    const values = data.map(d => ({
      date: new Date(d.date),
      cash: d.totalCash,
      asset: d.totalValue,
      total: d.totalCash + d.totalValue
    }))

    const maxTotal = d3.max(values, d => d.total) ?? 0

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    const y = d3.scaleLinear()
      .domain([0, maxTotal * 1.05])
      .range([height, 0])

    const stack = d3.stack<typeof values[0]>()
      .keys(['cash', 'asset'])

    const stackedData = stack(values)

    const area = d3.area<d3.SeriesPoint<typeof values[0]>>()
      .x(d => x(d.data.date))
      .y0(d => y(d[0]))
      .y1(d => y(d[1]))
      .curve(d3.curveMonotoneX)

    const colors = ['#10b981', '#8b5cf6']

    g.selectAll('path.area')
      .data(stackedData)
      .enter()
      .append('path')
      .attr('class', 'area')
      .attr('fill', (_, i) => colors[i] ?? '#666')
      .attr('d', area)

    // Tooltip and mouse tracking
    const tooltip = d3.select(tooltipRef.current)
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(values, date, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        if (!d0 || !d1) return
        const d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0
        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/>Cash: ${formatCurrencyCompact(d.cash)}<br/>Assets: ${formatCurrencyCompact(d.asset)}<br/>Total: ${formatCurrencyCompact(d.total)}`)
        // Position tooltip - flip to left side if near right edge
        const tooltipWidth = 160
        const leftPos = event.pageX + tooltipWidth + 20 > window.innerWidth
          ? event.pageX - tooltipWidth - 10
          : event.pageX + 10
        tooltip
          .style('left', leftPos + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white mb-0.5">Fund Liquid Value</h3>
      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[200px]"
        style={{ opacity: 0 }}
      />
      <div className="flex gap-1 xs:gap-1.5 sm:gap-2 mt-0.5 justify-center text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
        <span className="flex items-center gap-0.5 text-slate-400">
          <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500" />Cash
        </span>
        <span className="flex items-center gap-0.5 text-slate-400">
          <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-violet-500" />Assets
        </span>
      </div>
    </div>
  )
})

// Portfolio Value & Allocation Chart (aggregate version)
const PortfolioValueAllocationChart = memo(function PortfolioValueAllocationChart({ data, resize }: { data: TimeSeriesPoint[]; resize?: number }) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Check if we have target data to display
  const hasTarget = data.some(d => (d.totalExpectedTarget ?? 0) > 0)

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

    const values = data.map(d => ({
      date: new Date(d.date),
      value: d.totalValue,
      invested: d.totalStartInput,
      fundSize: d.totalFundSize,
      target: d.totalExpectedTarget
    }))

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    // Y scale based on max of fund size, asset value, target, or invested
    // Use || 0 to handle undefined/NaN values that would break Math.max
    const yMax = d3.max(values, d => Math.max(
      d.fundSize || 0,
      d.value || 0,
      d.target || 0,
      d.invested || 0
    )) || 1
    const y = d3.scaleLinear()
      .domain([0, yMax * 1.05])
      .nice()
      .range([height, 0])

    // Invested area (purple)
    const investedArea = d3.area<typeof values[0]>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.invested))
      .curve(d3.curveMonotoneX)

    // Draw invested area (purple)
    g.append('path')
      .datum(values)
      .attr('fill', '#8b5cf633')
      .attr('d', investedArea)

    // Asset value line (orange)
    const valueLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(d.value))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 2)
      .attr('d', valueLine)

    // Target line (cyan dashed) - if target data exists
    if (hasTarget) {
      const targetLine = d3.line<typeof values[0]>()
        .x(d => x(d.date))
        .y(d => y(d.target || 0))
        .curve(d3.curveMonotoneX)

      g.append('path')
        .datum(values)
        .attr('fill', 'none')
        .attr('stroke', '#06b6d4')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4,3')
        .attr('d', targetLine)
    }

    // Tooltip and mouse tracking
    const tooltip = d3.select(tooltipRef.current)
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(values, date, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        if (!d0 || !d1) return
        const d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0
        const targetHtml = hasTarget ? `<br/><span style="color:#06b6d4">Target: ${formatCurrencyCompact(d.target)}</span>` : ''
        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/><span style="color:#f59e0b">Value: ${formatCurrencyCompact(d.value)}</span>${targetHtml}<br/><span style="color:#8b5cf6">Invested: ${formatCurrencyCompact(d.invested)}</span>`)
        const tooltipWidth = 160
        const leftPos = event.pageX + tooltipWidth + 20 > window.innerWidth
          ? event.pageX - tooltipWidth - 10
          : event.pageX + 10
        tooltip
          .style('left', leftPos + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, resize, hasTarget])

  // Get latest values for legend
  const latestData = data.length > 0 ? data[data.length - 1] : null

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white mb-0.5">Value & Allocation</h3>
      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[200px]"
        style={{ opacity: 0 }}
      />
      <div className="flex gap-1 xs:gap-1.5 sm:gap-2 mt-0.5 justify-center flex-wrap text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
        <span className="flex items-center gap-0.5 text-orange-400">
          <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-orange-500" />
          Value{latestData && <span className="text-white ml-0.5">{formatCurrencyCompact(latestData.totalValue)}</span>}
        </span>
        {hasTarget && (
          <span className="flex items-center gap-0.5 text-cyan-400">
            <span className="w-1 h-0.5 xs:w-1.5 xs:h-0.5 sm:w-1.5 sm:h-0.5 md:w-2 md:h-0.5 rounded-sm bg-cyan-500" style={{ borderTop: '1px dashed' }} />
            Target{latestData && <span className="text-white ml-0.5">{formatCurrencyCompact(latestData.totalExpectedTarget)}</span>}
          </span>
        )}
        <span className="flex items-center gap-0.5 text-violet-400">
          <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-violet-500" />
          Invested{latestData && <span className="text-white ml-0.5">{formatCurrencyCompact(latestData.totalStartInput)}</span>}
        </span>
      </div>
    </div>
  )
})

// Stacked Area Chart showing individual fund contributions to Total Fund Size
const FundsStackedAreaChart = memo(function FundsStackedAreaChart({ data, allocations, resize }: {
  data: TimeSeriesPoint[]
  allocations: AllocationData[]
  resize?: number
}) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Get fund IDs from allocations (sorted by fundSize descending for consistent stacking)
  const sortedAllocations = [...allocations].sort((a, b) => b.fundSize - a.fundSize)
  const fundIds = sortedAllocations.map(a => a.id)
  const fundLabels = sortedAllocations.reduce((acc, a) => {
    acc[a.id] = `${a.platform}-${a.ticker}`
    return acc
  }, {} as Record<string, string>)

  useEffect(() => {
    if (!ref.current || data.length === 0 || fundIds.length === 0) return

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

    // Transform data for D3 stack
    type StackDataPoint = { date: Date; [key: string]: number | Date }
    const stackData: StackDataPoint[] = data.map(d => ({
      date: new Date(d.date),
      ...d.fundBreakdown
    }))

    const x = d3.scaleTime()
      .domain(d3.extent(stackData, d => d.date) as [Date, Date])
      .range([0, width])

    // Create stack generator
    const stack = d3.stack<typeof stackData[0]>()
      .keys(fundIds)
      .value((d, key) => (d[key] as number) ?? 0)

    const stackedData = stack(stackData)

    const yMax = d3.max(stackedData, layer => d3.max(layer, d => d[1])) ?? 0

    const y = d3.scaleLinear()
      .domain([0, yMax * 1.05])
      .range([height, 0])

    const area = d3.area<d3.SeriesPoint<typeof stackData[0]>>()
      .x(d => x(d.data.date))
      .y0(d => y(d[0]))
      .y1(d => y(d[1]))
      .curve(d3.curveMonotoneX)

    // Draw stacked areas
    g.selectAll('path.fund-area')
      .data(stackedData)
      .enter()
      .append('path')
      .attr('class', 'fund-area')
      .attr('fill', (_, i) => COLORS[i % COLORS.length] ?? '#666')
      .attr('d', area)

    // Tooltip and mouse tracking
    const tooltip = d3.select(tooltipRef.current)
    const bisect = d3.bisector<typeof stackData[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(stackData, date, 1)
        const d0 = stackData[i - 1]
        const d1 = stackData[i]
        if (!d0 || !d1) return
        const d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0

        // Build tooltip with all fund values
        const total = fundIds.reduce((sum, id) => sum + ((d[id] as number) ?? 0), 0)
        const lines = fundIds
          .map((id, idx) => {
            const val = (d[id] as number) ?? 0
            if (val === 0) return null
            const color = COLORS[idx % COLORS.length]
            return `<span style="color:${color}">${fundLabels[id]}: ${formatCurrencyCompact(val)}</span>`
          })
          .filter(Boolean)
          .join('<br/>')

        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/>${lines}<br/><strong>Total: ${formatCurrencyCompact(total)}</strong>`)
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, fundIds, fundLabels, resize])

  // Show top 5 funds in legend
  const legendFunds = sortedAllocations.slice(0, 5)

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white mb-0.5">Total Fund Size</h3>
      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[250px]"
        style={{ opacity: 0 }}
      />
      <div className="flex flex-wrap gap-1 xs:gap-1.5 sm:gap-2 mt-0.5 justify-center text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
        {legendFunds.map((fund, i) => (
          <span key={fund.id} className="flex items-center gap-0.5 text-slate-400">
            <span
              className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            {fund.platform}-{fund.ticker}
          </span>
        ))}
        {allocations.length > 5 && (
          <span className="text-slate-500">+{allocations.length - 5} more</span>
        )}
      </div>
    </div>
  )
})

// Combined Realized + Unrealized + Liquid Gains Chart
const GainsChart = memo(function GainsChart({ data, currentRealized, currentUnrealized, currentLiquid, resize, storageKey = 'gains' }: {
  data: TimeSeriesPoint[]
  currentRealized: number
  currentUnrealized: number
  currentLiquid: number
  resize?: number
  storageKey?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)

  // Load bounds from localStorage
  const boundsKey = `escapemint-chart-bounds-${storageKey}`
  const [bounds, setBounds] = useState<{ yMin?: number; yMax?: number }>(() => {
    const stored = localStorage.getItem(boundsKey)
    return stored ? JSON.parse(stored) : {}
  })
  const [localMin, setLocalMin] = useState(bounds.yMin?.toString() ?? '')
  const [localMax, setLocalMax] = useState(bounds.yMax?.toString() ?? '')

  const saveBounds = () => {
    const newBounds: { yMin?: number; yMax?: number } = {}
    if (localMin && !isNaN(parseFloat(localMin))) newBounds.yMin = parseFloat(localMin)
    if (localMax && !isNaN(parseFloat(localMax))) newBounds.yMax = parseFloat(localMax)
    setBounds(newBounds)
    if (Object.keys(newBounds).length > 0) {
      localStorage.setItem(boundsKey, JSON.stringify(newBounds))
    } else {
      localStorage.removeItem(boundsKey)
    }
    setShowSettings(false)
  }

  const clearBounds = () => {
    setBounds({})
    setLocalMin('')
    setLocalMax('')
    localStorage.removeItem(boundsKey)
    setShowSettings(false)
  }

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

    const values = data.map(d => ({
      date: new Date(d.date),
      realized: d.totalRealizedGain ?? 0,
      unrealized: d.totalUnrealizedGain ?? 0,
      liquid: d.totalGainUsd ?? 0
    }))

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    // Calculate data-driven bounds
    const dataMin = Math.min(
      d3.min(values, d => Math.min(d.realized, d.unrealized, d.liquid)) ?? 0,
      0
    )
    const dataMax = Math.max(
      d3.max(values, d => Math.max(d.realized, d.unrealized, d.liquid)) ?? 0,
      0
    )

    // Apply user bounds if set, otherwise use data bounds with padding
    let yMin = bounds.yMin !== undefined ? bounds.yMin : dataMin * 1.1
    let yMax = bounds.yMax !== undefined ? bounds.yMax : dataMax * 1.1

    // Ensure yMin < yMax
    if (yMin >= yMax) {
      const padding = Math.abs(yMin) * 0.1 || 1000
      yMin = yMin - padding
      yMax = yMax + padding
    }

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Clamp function
    const clamp = (val: number) => Math.max(yMin, Math.min(yMax, val))

    const tooltip = d3.select(tooltipRef.current)

    // Zero line if gains cross zero
    if (yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#475569')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,4')
    }

    // Area fill for liquid gain (light blue)
    const liquidArea = d3.area<typeof values[0]>()
      .x(d => x(d.date))
      .y0(y(Math.max(0, yMin)))
      .y1(d => y(clamp(d.liquid)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', '#3b82f633')
      .attr('d', liquidArea)

    // Line for realized gain (green)
    const realizedLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.realized)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#10b981')
      .attr('stroke-width', 2)
      .attr('d', realizedLine)

    // Line for unrealized gain (orange/amber)
    const unrealizedLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.unrealized)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 2)
      .attr('d', unrealizedLine)

    // Line for liquid gain (blue)
    const liquidLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.liquid)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#3b82f6')
      .attr('stroke-width', 2)
      .attr('d', liquidLine)

    // Add current value dots at the end
    const lastDataPoint = values[values.length - 1]
    if (lastDataPoint) {
      // Realized dot
      g.append('circle')
        .attr('cx', x(lastDataPoint.date))
        .attr('cy', y(clamp(lastDataPoint.realized)))
        .attr('r', 4)
        .attr('fill', '#10b981')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)

      // Unrealized dot
      g.append('circle')
        .attr('cx', x(lastDataPoint.date))
        .attr('cy', y(clamp(lastDataPoint.unrealized)))
        .attr('r', 4)
        .attr('fill', '#f59e0b')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)

      // Liquid dot
      g.append('circle')
        .attr('cx', x(lastDataPoint.date))
        .attr('cy', y(clamp(lastDataPoint.liquid)))
        .attr('r', 4)
        .attr('fill', '#3b82f6')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)
    }

    // Invisible overlay for mouse tracking
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(values, date, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        // Handle edge cases - use whichever value is available
        let d: typeof values[0] | undefined
        if (d0 && d1) {
          d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0
        } else {
          d = d0 || d1
        }
        if (!d) return
        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/><span style="color:#10b981">Realized: ${formatCurrencyCompact(d.realized)}</span><br/><span style="color:#f59e0b">Unrealized: ${formatCurrencyCompact(d.unrealized)}</span><br/><span style="color:#3b82f6">Liquid: ${formatCurrencyCompact(d.liquid)}</span>`)
        // Position tooltip - flip to left side if near right edge
        const tooltipWidth = 150
        const leftPos = event.pageX + tooltipWidth + 20 > window.innerWidth
          ? event.pageX - tooltipWidth - 10
          : event.pageX + 10
        tooltip
          .style('left', leftPos + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, resize, bounds])

  const hasBounds = bounds.yMin !== undefined || bounds.yMax !== undefined

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1">
          <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white">Gain ($)</h3>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-0.5 rounded hover:bg-slate-700 ${hasBounds ? 'text-mint-400' : 'text-slate-500'}`}
            title="Chart settings"
          >
            <svg className="w-2.5 h-2.5 sm:w-3 sm:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
        <div className="flex gap-1 xs:gap-1.5 sm:gap-3 text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
          <span className="flex items-center gap-0.5 text-emerald-400" title="Realized" aria-label={`Realized: ${formatCurrencyCompact(currentRealized)}`}>
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500" aria-hidden="true" />
            <span className="hidden xs:inline text-slate-400">R:</span>
            {formatCurrencyCompact(currentRealized)}
          </span>
          <span className="flex items-center gap-0.5 text-amber-400" title="Unrealized" aria-label={`Unrealized: ${formatCurrencyCompact(currentUnrealized)}`}>
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-amber-500" aria-hidden="true" />
            <span className="hidden xs:inline text-slate-400">U:</span>
            {formatCurrencyCompact(currentUnrealized)}
          </span>
          <span className="flex items-center gap-0.5 text-blue-400" title="Liquid" aria-label={`Liquid: ${formatCurrencyCompact(currentLiquid)}`}>
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-blue-500" aria-hidden="true" />
            <span className="hidden xs:inline text-slate-400">L:</span>
            {formatCurrencyCompact(currentLiquid)}
          </span>
        </div>
      </div>

      {/* Settings popover */}
      {showSettings && (
        <div className="absolute top-8 left-0 z-50 bg-slate-900 border border-slate-600 rounded-lg p-2 shadow-xl">
          <div className="text-[9px] sm:text-xs text-slate-300 mb-2">Y-Axis Bounds</div>
          <div className="flex gap-2 items-center mb-2">
            <div className="flex flex-col gap-1">
              <label className="text-[8px] sm:text-[10px] text-slate-400">Min ($)</label>
              <input
                type="number"
                value={localMin}
                onChange={e => setLocalMin(e.target.value)}
                placeholder="Auto"
                className="w-20 px-1.5 py-1 text-[10px] sm:text-xs bg-slate-800 border border-slate-600 rounded text-white"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[8px] sm:text-[10px] text-slate-400">Max ($)</label>
              <input
                type="number"
                value={localMax}
                onChange={e => setLocalMax(e.target.value)}
                placeholder="Auto"
                className="w-20 px-1.5 py-1 text-[10px] sm:text-xs bg-slate-800 border border-slate-600 rounded text-white"
              />
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={saveBounds}
              className="px-2 py-1 text-[9px] sm:text-[10px] bg-mint-600 hover:bg-mint-500 text-white rounded"
            >
              Apply
            </button>
            <button
              onClick={clearBounds}
              className="px-2 py-1 text-[9px] sm:text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
            >
              Clear
            </button>
            <button
              onClick={() => setShowSettings(false)}
              className="px-2 py-1 text-[9px] sm:text-[10px] text-slate-400 hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[220px]"
        style={{ opacity: 0 }}
      />
    </div>
  )
})

// Combined Realized + Liquid APY Chart
const APYChart = memo(function APYChart({ data, currentRealizedAPY, currentLiquidAPY, resize, storageKey = 'apy' }: {
  data: TimeSeriesPoint[]
  currentRealizedAPY: number
  currentLiquidAPY: number
  resize?: number
  storageKey?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)

  // Load bounds from localStorage
  const boundsKey = `escapemint-chart-bounds-${storageKey}`
  const [bounds, setBounds] = useState<{ yMin?: number; yMax?: number }>(() => {
    const stored = localStorage.getItem(boundsKey)
    return stored ? JSON.parse(stored) : {}
  })
  const [localMin, setLocalMin] = useState(bounds.yMin?.toString() ?? '')
  const [localMax, setLocalMax] = useState(bounds.yMax?.toString() ?? '')

  const saveBounds = () => {
    const newBounds: { yMin?: number; yMax?: number } = {}
    if (localMin && !isNaN(parseFloat(localMin))) newBounds.yMin = parseFloat(localMin)
    if (localMax && !isNaN(parseFloat(localMax))) newBounds.yMax = parseFloat(localMax)
    setBounds(newBounds)
    if (Object.keys(newBounds).length > 0) {
      localStorage.setItem(boundsKey, JSON.stringify(newBounds))
    } else {
      localStorage.removeItem(boundsKey)
    }
    setShowSettings(false)
  }

  const clearBounds = () => {
    setBounds({})
    setLocalMin('')
    setLocalMax('')
    localStorage.removeItem(boundsKey)
    setShowSettings(false)
  }

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

    const values = data.map(d => ({
      date: new Date(d.date),
      realized: d.realizedAPY,
      unrealized: d.liquidAPY - d.realizedAPY,
      liquid: d.liquidAPY
    }))

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    // Calculate data-driven bounds
    const dataMin = Math.min(
      d3.min(values, d => Math.min(d.realized, d.unrealized, d.liquid)) ?? 0,
      0
    )
    const dataMax = Math.max(
      d3.max(values, d => Math.max(d.realized, d.unrealized, d.liquid)) ?? 0,
      0
    )

    // Apply user bounds if set, otherwise use data bounds with padding
    let yMin = bounds.yMin !== undefined ? bounds.yMin : dataMin * 1.1
    let yMax = bounds.yMax !== undefined ? bounds.yMax : dataMax * 1.1

    // Ensure yMin < yMax
    if (yMin >= yMax) {
      const padding = Math.abs(yMin) * 0.1 || 0.1
      yMin = yMin - padding
      yMax = yMax + padding
    }

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Clamp function
    const clamp = (val: number) => Math.max(yMin, Math.min(yMax, val))

    const tooltip = d3.select(tooltipRef.current)

    // Zero line if APY crosses zero
    if (yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#475569')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,4')
    }

    // Area fill for liquid APY (light blue)
    const liquidArea = d3.area<typeof values[0]>()
      .x(d => x(d.date))
      .y0(y(Math.max(0, yMin)))
      .y1(d => y(clamp(d.liquid)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', '#3b82f633')
      .attr('d', liquidArea)

    // Line for realized APY (green)
    const realizedLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.realized)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#10b981')
      .attr('stroke-width', 2)
      .attr('d', realizedLine)

    // Line for unrealized APY (orange)
    const unrealizedLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.unrealized)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#f97316')
      .attr('stroke-width', 2)
      .attr('d', unrealizedLine)

    // Line for liquid APY (blue)
    const liquidLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(clamp(d.liquid)))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#3b82f6')
      .attr('stroke-width', 2)
      .attr('d', liquidLine)

    // Add current value dots at the end
    const lastDataPoint = values[values.length - 1]
    if (lastDataPoint) {
      g.append('circle')
        .attr('cx', x(lastDataPoint.date))
        .attr('cy', y(clamp(lastDataPoint.realized)))
        .attr('r', 4)
        .attr('fill', '#10b981')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)

      g.append('circle')
        .attr('cx', x(lastDataPoint.date))
        .attr('cy', y(clamp(lastDataPoint.unrealized)))
        .attr('r', 4)
        .attr('fill', '#f97316')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)

      g.append('circle')
        .attr('cx', x(lastDataPoint.date))
        .attr('cy', y(clamp(lastDataPoint.liquid)))
        .attr('r', 4)
        .attr('fill', '#3b82f6')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)
    }

    // Invisible overlay for mouse tracking
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(values, date, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        if (!d0 || !d1) return
        const d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0
        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/><span style="color:#10b981">Realized: ${formatPercentSimple(d.realized)}</span><br/><span style="color:#f97316">Unrealized: ${formatPercentSimple(d.unrealized)}</span><br/><span style="color:#3b82f6">Liquid: ${formatPercentSimple(d.liquid)}</span>`)
        // Position tooltip - flip to left side if near right edge
        const tooltipWidth = 140
        const leftPos = event.pageX + tooltipWidth + 20 > window.innerWidth
          ? event.pageX - tooltipWidth - 10
          : event.pageX + 10
        tooltip
          .style('left', leftPos + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => formatPercentSimple(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, resize, bounds])

  const hasBounds = bounds.yMin !== undefined || bounds.yMax !== undefined

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1">
          <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white">APY</h3>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-0.5 rounded hover:bg-slate-700 ${hasBounds ? 'text-mint-400' : 'text-slate-500'}`}
            title="Chart settings"
          >
            <svg className="w-2.5 h-2.5 sm:w-3 sm:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
        <div className="flex gap-1 xs:gap-1.5 sm:gap-2 text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
          <span className="flex items-center gap-0.5 text-emerald-400">
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500" />
            {formatPercentSimple(currentRealizedAPY)}
          </span>
          <span className="flex items-center gap-0.5 text-orange-400">
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-orange-500" />
            {formatPercentSimple(currentLiquidAPY - currentRealizedAPY)}
          </span>
          <span className="flex items-center gap-0.5 text-blue-400">
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-blue-500" />
            {formatPercentSimple(currentLiquidAPY)}
          </span>
        </div>
      </div>

      {/* Settings popover */}
      {showSettings && (
        <div className="absolute top-8 left-0 z-50 bg-slate-900 border border-slate-600 rounded-lg p-2 shadow-xl">
          <div className="text-[9px] sm:text-xs text-slate-300 mb-2">Y-Axis Bounds (decimal, e.g., 0.5 = 50%)</div>
          <div className="flex gap-2 items-center mb-2">
            <div className="flex flex-col gap-1">
              <label className="text-[8px] sm:text-[10px] text-slate-400">Min</label>
              <input
                type="number"
                step="0.01"
                value={localMin}
                onChange={e => setLocalMin(e.target.value)}
                placeholder="Auto"
                className="w-20 px-1.5 py-1 text-[10px] sm:text-xs bg-slate-800 border border-slate-600 rounded text-white"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[8px] sm:text-[10px] text-slate-400">Max</label>
              <input
                type="number"
                step="0.01"
                value={localMax}
                onChange={e => setLocalMax(e.target.value)}
                placeholder="Auto"
                className="w-20 px-1.5 py-1 text-[10px] sm:text-xs bg-slate-800 border border-slate-600 rounded text-white"
              />
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={saveBounds}
              className="px-2 py-1 text-[9px] sm:text-[10px] bg-mint-600 hover:bg-mint-500 text-white rounded"
            >
              Apply
            </button>
            <button
              onClick={clearBounds}
              className="px-2 py-1 text-[9px] sm:text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 rounded"
            >
              Clear
            </button>
            <button
              onClick={() => setShowSettings(false)}
              className="px-2 py-1 text-[9px] sm:text-[10px] text-slate-400 hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[200px]"
        style={{ opacity: 0 }}
      />
    </div>
  )
})

// Combined Margin Access + Borrowed Chart
const MarginChart = memo(function MarginChart({ data, currentAccess, currentBorrowed, resize }: {
  data: TimeSeriesPoint[]
  currentAccess: number
  currentBorrowed: number
  resize?: number
}) {
  const ref = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

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

    const values = data.map(d => ({
      date: new Date(d.date),
      access: d.totalMarginAccess,
      borrowed: d.totalMarginBorrowed
    }))

    const x = d3.scaleTime()
      .domain(d3.extent(values, d => d.date) as [Date, Date])
      .range([0, width])

    const yMax = Math.max(
      d3.max(values, d => d.access) ?? 0,
      d3.max(values, d => d.borrowed) ?? 0
    )

    const y = d3.scaleLinear()
      .domain([0, yMax * 1.1])
      .nice()
      .range([height, 0])

    const tooltip = d3.select(tooltipRef.current)

    // Area fill for margin access (light green)
    const accessArea = d3.area<typeof values[0]>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.access))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', '#10b98133')
      .attr('d', accessArea)

    // Area fill for margin borrowed (light red)
    const borrowedArea = d3.area<typeof values[0]>()
      .x(d => x(d.date))
      .y0(height)
      .y1(d => y(d.borrowed))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', '#ef444433')
      .attr('d', borrowedArea)

    // Line for margin access
    const accessLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(d.access))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#10b981')
      .attr('stroke-width', 2)
      .attr('d', accessLine)

    // Line for margin borrowed
    const borrowedLine = d3.line<typeof values[0]>()
      .x(d => x(d.date))
      .y(d => y(d.borrowed))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(values)
      .attr('fill', 'none')
      .attr('stroke', '#ef4444')
      .attr('stroke-width', 2)
      .attr('d', borrowedLine)

    // Add current value dots at the end
    const lastPoint = values[values.length - 1]
    if (lastPoint) {
      // Access dot
      g.append('circle')
        .attr('cx', x(lastPoint.date))
        .attr('cy', y(lastPoint.access))
        .attr('r', 4)
        .attr('fill', '#10b981')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)

      // Borrowed dot
      g.append('circle')
        .attr('cx', x(lastPoint.date))
        .attr('cy', y(lastPoint.borrowed))
        .attr('r', 4)
        .attr('fill', '#ef4444')
        .attr('stroke', 'white')
        .attr('stroke-width', 1.5)
    }

    // Invisible overlay for mouse tracking
    const bisect = d3.bisector<typeof values[0], Date>(d => d.date).left

    g.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mouseover', () => tooltip.style('opacity', 1))
      .on('mousemove', function(event) {
        const [mx] = d3.pointer(event)
        const date = x.invert(mx)
        const i = bisect(values, date, 1)
        const d0 = values[i - 1]
        const d1 = values[i]
        if (!d0 || !d1) return
        const d = date.getTime() - d0.date.getTime() > d1.date.getTime() - date.getTime() ? d1 : d0
        tooltip
          .html(`<strong>${d3.timeFormat('%b %d, %Y')(d.date)}</strong><br/><span style="color:#10b981">Access: ${formatCurrencyCompact(d.access)}</span><br/><span style="color:#ef4444">Borrowed: ${formatCurrencyCompact(d.borrowed)}</span>`)
        // Position tooltip - flip to left side if near right edge
        const tooltipWidth = 140
        const leftPos = event.pageX + tooltipWidth + 20 > window.innerWidth
          ? event.pageX - tooltipWidth - 10
          : event.pageX + 10
        tooltip
          .style('left', leftPos + 'px')
          .style('top', (event.pageY - 10) + 'px')
      })
      .on('mouseout', () => tooltip.style('opacity', 0))

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(3).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(3).tickFormat(d => formatCurrencyCompact(d as number)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', axisFontSize)

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

  }, [data, resize])

  return (
    <div className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 relative touch-manipulation active:bg-slate-700/30">
      <div className="flex items-center justify-between mb-0.5">
        <h3 className="text-[8px] xs:text-[9px] sm:text-[10px] md:text-xs font-medium text-white">Margin</h3>
        <div className="flex gap-1 xs:gap-1.5 sm:gap-2 text-[6px] xs:text-[7px] sm:text-[8px] md:text-[9px]">
          <span className="flex items-center gap-0.5 text-emerald-400">
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500" />
            {formatCurrencyCompact(currentAccess)}
          </span>
          <span className="flex items-center gap-0.5 text-red-400">
            <span className="w-1 h-1 xs:w-1.5 xs:h-1.5 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 rounded-full bg-red-500" />
            {currentBorrowed > 0 ? '-' : ''}{formatCurrencyCompact(currentBorrowed)}
          </span>
        </div>
      </div>
      <svg ref={ref} className="w-full h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px]" style={{ overflow: 'visible' }} />
      <div
        ref={tooltipRef}
        className="fixed bg-slate-900 text-white text-[9px] xs:text-[10px] sm:text-xs px-1 xs:px-1.5 sm:px-2 py-0.5 sm:py-1 rounded shadow-lg pointer-events-none z-50 border border-slate-700 max-w-[200px]"
        style={{ opacity: 0 }}
      />
    </div>
  )
})

export const PortfolioCharts = memo(function PortfolioCharts({ timeSeries, allocations, totals, aggregateTotals, categoryAllocations, marginInfo }: PortfolioChartsProps) {
  const hasMarginAccess = totals.totalCurrentMarginAccess > 0
  const [resize, setResize] = useState(0)

  // Resize handler for charts
  useEffect(() => {
    const handleResize = () => setResize(n => n + 1)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Use aggregate totals for current values (consistent with header metrics)
  const currentLiquidGain = aggregateTotals?.totalGainUsd ?? timeSeries[timeSeries.length - 1]?.totalGainUsd ?? 0
  const currentRealizedGains = aggregateTotals?.totalRealizedGains ?? timeSeries[timeSeries.length - 1]?.totalRealizedGain ?? 0
  const currentUnrealizedGains = aggregateTotals?.totalUnrealizedGains ?? timeSeries[timeSeries.length - 1]?.totalUnrealizedGain ?? 0

  // Get current APY values from aggregateTotals (properly filtered) or fall back to time series
  const lastTimeSeriesPoint = timeSeries[timeSeries.length - 1]
  const currentRealizedAPY = aggregateTotals?.realizedAPY ?? lastTimeSeriesPoint?.realizedAPY ?? 0
  const currentLiquidAPY = aggregateTotals?.liquidAPY ?? lastTimeSeriesPoint?.liquidAPY ?? 0

  // Aggregate allocations by platform for Platform Allocation chart
  const platformAllocations: AllocationData[] = Object.values(
    allocations.reduce((acc, alloc) => {
      const platform = alloc.platform
      if (!acc[platform]) {
        acc[platform] = {
          id: platform,
          ticker: platform,
          platform: platform,
          value: 0,
          cash: 0,
          fundSize: 0,
          marginAccess: 0,
          marginBorrowed: 0
        }
      }
      acc[platform].value += alloc.value
      acc[platform].cash += alloc.cash
      acc[platform].fundSize += alloc.fundSize
      acc[platform].marginAccess += alloc.marginAccess
      acc[platform].marginBorrowed += alloc.marginBorrowed
      return acc
    }, {} as Record<string, AllocationData>)
  )

  return (
    <div className="space-y-1.5 xs:space-y-2 sm:space-y-3">
      {/* Mobile: Allocation Lists (compact, no pie charts) */}
      <div className="grid grid-cols-1 gap-1.5 sm:hidden">
        <AllocationList data={allocations} title="Fund Allocation" valueKey="fundSize" />
        {categoryAllocations && categoryAllocations.some(c => c.value > 0) && (
          <CategoryBarChart data={categoryAllocations} margin={marginInfo} title="Portfolio Allocation" />
        )}
        <AllocationList data={platformAllocations} title="Platform Allocation" valueKey="value" showPlatformOnly />
      </div>

      {/* Desktop: Pie Charts Row */}
      <div className="hidden sm:grid grid-cols-3 gap-2">
        <PieChart data={allocations} title="Fund Allocation" valueKey="fundSize" />
        {categoryAllocations && categoryAllocations.some(c => c.value > 0) ? (
          <CategoryBarChart data={categoryAllocations} margin={marginInfo} title="Portfolio Allocation" />
        ) : (
          <PieChart data={allocations} title="Asset Allocation" valueKey="value" />
        )}
        <PlatformPieChart data={platformAllocations} title="Platform Allocation" valueKey="value" />
      </div>

      {/* Time Series Charts - Row 1: Key metrics */}
      <div className="grid grid-cols-2 gap-1 xs:gap-1.5 sm:gap-2">
        <APYChart
          data={timeSeries}
          currentRealizedAPY={currentRealizedAPY}
          currentLiquidAPY={currentLiquidAPY}
          resize={resize}
        />
        <GainsChart
          data={timeSeries}
          currentRealized={currentRealizedGains}
          currentUnrealized={currentUnrealizedGains}
          currentLiquid={currentLiquidGain}
          resize={resize}
        />
      </div>

      {/* Time Series Charts - Row 2: Fund totals */}
      <div className="grid grid-cols-2 gap-1 xs:gap-1.5 sm:gap-2">
        <FundsStackedAreaChart
          data={timeSeries}
          allocations={allocations}
          resize={resize}
        />
        <LiquidValueStackedChart data={timeSeries} resize={resize} />
      </div>

      {/* Time Series Charts - Row 3: Value & Allocation, Margin, Cash vs Asset */}
      <div className={`grid ${hasMarginAccess ? 'grid-cols-3' : 'grid-cols-2'} gap-1 xs:gap-1.5 sm:gap-2`}>
        <PortfolioValueAllocationChart data={timeSeries} resize={resize} />
        {hasMarginAccess && (
          <MarginChart
            data={timeSeries}
            currentAccess={totals.totalCurrentMarginAccess}
            currentBorrowed={totals.totalCurrentMarginBorrowed}
            resize={resize}
          />
        )}
        <StackedAreaChart data={timeSeries} resize={resize} />
      </div>
    </div>
  )
})

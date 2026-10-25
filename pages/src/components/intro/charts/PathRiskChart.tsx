import { useEffect, useRef } from 'react'
import * as d3 from 'd3'
import chart from '../../../data/path-risk-chart.json'

interface Point {
  date: string
  only3x: number
  fallback: number
  vti: number
}

const points = chart.points as Point[]

const SERIES = [
  { key: 'only3x' as const, label: '3x only', color: '#ef4444' },
  { key: 'fallback' as const, label: '1x fallback', color: '#f59e0b' },
  { key: 'vti' as const, label: 'VTI', color: '#22c55e' }
]

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

export function PathRiskChart() {
  const svgRef = useRef<SVGSVGElement>(null)
  const summary = chart.summary

  useEffect(() => {
    if (!svgRef.current || points.length < 2) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = 640
    const height = 320
    const margin = { top: 16, right: 16, bottom: 36, left: 56 }
    const innerWidth = width - margin.left - margin.right
    const innerHeight = height - margin.top - margin.bottom

    const data = points.map(point => ({
      date: new Date(`${point.date}T00:00:00Z`),
      only3x: point.only3x,
      fallback: point.fallback,
      vti: point.vti
    }))

    const g = svg
      .attr('viewBox', `0 0 ${width} ${height}`)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, innerWidth])

    const y = d3.scaleLog()
      .domain([
        Math.max(100, d3.min(data, d => Math.min(d.only3x, d.fallback, d.vti))! * 0.8),
        d3.max(data, d => Math.max(d.only3x, d.fallback, d.vti))! * 1.15
      ])
      .range([innerHeight, 0])

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat(d => d3.timeFormat('%Y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '10px')

    g.append('g')
      .call(d3.axisLeft(y).ticks(5, '~s'))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '10px')

    g.selectAll('.domain, .tick line').attr('stroke', '#334155')

    const line = d3.line<(typeof data)[number]>()
      .x(d => x(d.date))
      .y(d => y(d.only3x))

    for (const series of SERIES) {
      g.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', series.color)
        .attr('stroke-width', 2)
        .attr('d', line.y(d => y(Math.max(d[series.key], 1))))
    }
  }, [])

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-2 text-xs text-slate-400">
        {SERIES.map(series => (
          <span key={series.key} className="flex items-center gap-1">
            <span className="w-3 h-0.5" style={{ backgroundColor: series.color }} />
            {series.label}
          </span>
        ))}
        <span>Log scale. Same deposits, no margin.</span>
      </div>
      <svg ref={svgRef} className="w-full h-auto" role="img" aria-label="1999 to 2012 portfolio value for 3x only, 1x fallback, and VTI" />
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Synthetic Nasdaq-100 3x price fell {(summary.priceMaxDrawdown * 100).toFixed(2)}% from its peak
        ({summary.priceTroughDate}). On {money(summary.contributed)} contributed:
        3x only {money(summary.only3x.finalValue)} (max drawdown {(summary.only3x.maxDrawdown * 100).toFixed(1)}%),
        fallback {money(summary.fallback.finalValue)} ({(summary.fallback.maxDrawdown * 100).toFixed(1)}%),
        VTI {money(summary.vti.finalValue)} ({(summary.vti.maxDrawdown * 100).toFixed(1)}%).
      </p>
    </div>
  )
}

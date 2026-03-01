import { useState, useMemo, useEffect, lazy, Suspense } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { FundCard } from '../components/FundCard'
import { AggregatePanel } from '../components/AggregatePanel'
import { PortfolioCharts } from '../components/PortfolioCharts'
import { CreateFundModal } from '../components/CreateFundModal'
import { WelcomePanel } from '../components/WelcomePanel'
import { ActionableFundsBanner } from '../components/ActionableFundsBanner'
import { useDashboard } from '../contexts/DashboardContext'
import type { FundSummary, AggregateMetrics, FundCategory } from '../api/funds'
import type { CategoryChartData } from '../components/CategoryBarChart'
import {
  FUND_CATEGORY_CONFIG,
  FUND_CATEGORIES,
  getEffectiveCategory
} from '@escapemint/engine'

// Lazy load the heavy ImportWizard component (3000+ lines)
const ImportWizard = lazy(() => import('../components/ImportWizard').then(m => ({ default: m.ImportWizard })))

// Skeleton for metrics panel
function MetricsPanelSkeleton() {
  return (
    <div className="bg-slate-800 rounded-lg p-3 sm:p-4 border border-slate-700 animate-pulse">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-20 bg-slate-700 rounded" />
            <div className="h-6 w-24 bg-slate-700 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// Skeleton for fund cards
function FundCardsSkeleton() {
  return (
    <div className="space-y-3 xs:space-y-4 sm:space-y-5">
      <div>
        <div className="h-4 w-24 bg-slate-700 rounded mb-2" />
        <div className="grid grid-cols-2 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 xs:gap-2 sm:gap-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="bg-slate-800 rounded-lg p-2 sm:p-3 border border-slate-700 animate-pulse">
              <div className="h-4 w-16 bg-slate-700 rounded mb-2" />
              <div className="h-6 w-20 bg-slate-700 rounded mb-1" />
              <div className="h-3 w-12 bg-slate-700 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Dashboard() {
  const { platform: urlPlatform } = useParams<{ platform?: string }>()
  const navigate = useNavigate()

  const {
    funds,
    metrics,
    history,
    fundsLoading,
    metricsLoading,
    historyLoading,
    refresh,
    connected
  } = useDashboard()

  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid')
  // Platform filter is driven by URL param
  const filterPlatform = urlPlatform ?? 'all'

  const handlePlatformChange = (platform: string) => {
    if (platform === 'all') {
      navigate('/')
    } else {
      navigate(`/dashboard/${platform}`)
    }
  }
  const [showCharts, setShowCharts] = useState(() => {
    const saved = localStorage.getItem('dashboard-showCharts')
    return saved !== null ? saved === 'true' : true
  })
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)

  // Persist showCharts preference to localStorage
  useEffect(() => {
    localStorage.setItem('dashboard-showCharts', String(showCharts))
  }, [showCharts])

  // Get unique platforms
  const platforms = useMemo(() => {
    if (!funds) return []
    return [...new Set(funds.map(f => f.platform))]
  }, [funds])

  // Filter funds
  const filteredFunds = useMemo(() => {
    if (!funds) return []
    return filterPlatform === 'all'
      ? funds
      : funds.filter(f => f.platform === filterPlatform)
  }, [funds, filterPlatform])

  // Group by platform and sort cash funds to top within each group
  const fundsByPlatform = useMemo(() => {
    const grouped = filteredFunds.reduce((acc, fund) => {
      const key = fund.platform
      if (!acc[key]) acc[key] = []
      acc[key].push(fund)
      return acc
    }, {} as Record<string, FundSummary[]>)

    // Sort each platform's funds: cash funds first, then by ticker
    for (const platform of Object.keys(grouped)) {
      grouped[platform]?.sort((a, b) => {
        const aIsCash = a.config.fund_type === 'cash'
        const bIsCash = b.config.fund_type === 'cash'
        if (aIsCash && !bIsCash) return -1
        if (!aIsCash && bIsCash) return 1
        return a.ticker.localeCompare(b.ticker)
      })
    }

    return grouped
  }, [filteredFunds])

  // Filter history data based on selected platform
  const filteredHistory = useMemo(() => {
    if (!history) return null
    if (filterPlatform === 'all') return history

    // Get fund IDs for the selected platform
    const platformFundIds = new Set(
      funds?.filter(f => f.platform === filterPlatform).map(f => f.id) ?? []
    )

    const filteredAllocations = history.currentAllocations.filter(a => a.platform === filterPlatform)

    // Filter time series - use per-fund breakdowns for accurate platform filtering
    // First pass: filter and sum per-fund values, excluding points with no platform data
    const rawFilteredTimeSeries = history.timeSeries
      .map(point => {
        // Filter fundBreakdown to only include funds from selected platform
        const filteredBreakdown: Record<string, number> = {}
        let filteredTotalValue = 0

        for (const [fundId, value] of Object.entries(point.fundBreakdown)) {
          if (platformFundIds.has(fundId)) {
            filteredBreakdown[fundId] = value
            filteredTotalValue += value
          }
        }

        // Skip points where the platform has no data
        if (Object.keys(filteredBreakdown).length === 0) {
          return null
        }

        // Sum realized gains from per-fund breakdown (accurate per-platform)
        let filteredRealizedGain = 0
        if (point.realizedGainBreakdown) {
          for (const [fundId, value] of Object.entries(point.realizedGainBreakdown)) {
            if (platformFundIds.has(fundId)) {
              filteredRealizedGain += value
            }
          }
        }

        // Sum unrealized gains from per-fund breakdown (accurate per-platform)
        let filteredUnrealizedGain = 0
        if (point.unrealizedGainBreakdown) {
          for (const [fundId, value] of Object.entries(point.unrealizedGainBreakdown)) {
            if (platformFundIds.has(fundId)) {
              filteredUnrealizedGain += value
            }
          }
        }

        // Calculate scaling ratio for values without per-fund breakdown
        const rawRatio = point.totalValue > 0 ? filteredTotalValue / point.totalValue : 0
        const ratio = Math.max(0, Math.min(1, rawRatio))

        // Scale other monetary values by ratio (for those without per-fund breakdown)
        const scaledStartInput = (point.totalStartInput ?? 0) * ratio

        // Liquid gain = realized + unrealized
        const filteredGainUsd = filteredRealizedGain + filteredUnrealizedGain

        return {
          ...point,
          fundBreakdown: filteredBreakdown,
          totalValue: filteredTotalValue,
          totalFundSize: point.totalFundSize * ratio,
          totalCash: point.totalCash * ratio,
          totalMarginBorrowed: point.totalMarginBorrowed * ratio,
          totalMarginAccess: point.totalMarginAccess * ratio,
          totalStartInput: scaledStartInput,
          totalDividends: point.totalDividends * ratio,
          totalExpenses: point.totalExpenses * ratio,
          totalCashInterest: point.totalCashInterest * ratio,
          totalRealizedGain: filteredRealizedGain,
          totalUnrealizedGain: filteredUnrealizedGain,
          totalGainUsd: filteredGainUsd,
          totalGainPct: scaledStartInput > 0 ? filteredGainUsd / scaledStartInput : 0,
          // APY will be calculated in second pass
          realizedAPY: 0,
          liquidAPY: 0
        }
      })
      .filter((point): point is NonNullable<typeof point> => point !== null)

    // Second pass: calculate APY using the filtered series' first date
    const firstFilteredDate = rawFilteredTimeSeries[0]?.date ? new Date(rawFilteredTimeSeries[0].date) : null
    // Minimum days required for meaningful annualized APY calculation
    const MIN_DAYS_FOR_APY = 7

    const filteredTimeSeries = rawFilteredTimeSeries.map(point => {
      const pointDate = new Date(point.date)
      const daysElapsed = firstFilteredDate
        ? Math.max(1, (pointDate.getTime() - firstFilteredDate.getTime()) / (1000 * 60 * 60 * 24))
        : 1
      // Only annualize APY after minimum days to avoid extreme values from small time windows
      const realizedAPY = point.totalStartInput > 0 && daysElapsed >= MIN_DAYS_FOR_APY
        ? Math.pow(1 + Math.max(-0.99, point.totalRealizedGain / point.totalStartInput), 365 / daysElapsed) - 1
        : 0
      const liquidAPY = point.totalStartInput > 0 && daysElapsed >= MIN_DAYS_FOR_APY
        ? Math.pow(1 + Math.max(-0.99, point.totalGainUsd / point.totalStartInput), 365 / daysElapsed) - 1
        : 0

      return { ...point, realizedAPY, liquidAPY }
    })

    // Calculate filtered aggregate totals
    // Note: APY values will be added from filteredMetrics when rendering
    const lastFilteredPoint = filteredTimeSeries[filteredTimeSeries.length - 1]
    const filteredAggregateTotals = {
      totalGainUsd: lastFilteredPoint?.totalGainUsd ?? 0,
      totalRealizedGains: lastFilteredPoint?.totalRealizedGain ?? 0,
      totalValue: filteredAllocations.reduce((sum, a) => sum + a.value, 0),
      totalStartInput: lastFilteredPoint?.totalStartInput ?? 0,
      realizedAPY: 0, // Will be overridden with correct value when rendering
      liquidAPY: 0    // Will be overridden with correct value when rendering
    }

    return {
      timeSeries: filteredTimeSeries,
      currentAllocations: filteredAllocations,
      totals: {
        totalCurrentValue: filteredAllocations.reduce((sum, a) => sum + a.value, 0),
        totalCurrentCash: filteredAllocations.reduce((sum, a) => sum + a.cash, 0),
        totalCurrentMarginAccess: filteredAllocations.reduce((sum, a) => sum + a.marginAccess, 0),
        totalCurrentMarginBorrowed: filteredAllocations.reduce((sum, a) => sum + a.marginBorrowed, 0)
      },
      aggregateTotals: filteredAggregateTotals
    }
  }, [history, filterPlatform, funds])

  // Calculate filtered metrics based on selected platform
  const filteredMetrics = useMemo((): AggregateMetrics | null => {
    if (!metrics) return null
    if (filterPlatform === 'all') return metrics

    const filteredFundMetrics = metrics.funds.filter(f => f.platform === filterPlatform)

    const totalFundSize = filteredFundMetrics.reduce((sum, f) => sum + f.fundSize, 0)
    const totalValue = filteredFundMetrics.reduce((sum, f) => sum + f.currentValue, 0)
    const totalStartInput = filteredFundMetrics.reduce((sum, f) => sum + f.startInput, 0)
    const totalTimeWeightedFundSize = filteredFundMetrics.reduce((sum, f) => sum + f.timeWeightedFundSize, 0)
    const totalDaysActive = filteredFundMetrics.reduce((sum, f) => sum + f.daysActive, 0)
    const totalRealizedGains = filteredFundMetrics.reduce((sum, f) => sum + f.realizedGains, 0)
    const totalUnrealizedGains = filteredFundMetrics.reduce((sum, f) => sum + f.unrealizedGains, 0)
    const activeFunds = filteredFundMetrics.filter(f => f.status !== 'closed').length
    const closedFunds = filteredFundMetrics.filter(f => f.status === 'closed').length

    const dollarsPerDay = totalTimeWeightedFundSize > 0 && totalDaysActive > 0
      ? totalTimeWeightedFundSize / totalDaysActive
      : 0

    let totalFundShares = 0
    const fundsWithShares = filteredFundMetrics.map(fund => {
      const fundShares = dollarsPerDay > 0 && fund.daysActive > 0
        ? (fund.timeWeightedFundSize / dollarsPerDay) * fund.daysActive
        : 0
      totalFundShares += fundShares
      return { ...fund, fundShares }
    })

    const fundsWithSharesPct = fundsWithShares.map(fund => ({
      ...fund,
      fundSharesPct: totalFundShares > 0 ? fund.fundShares / totalFundShares : 0
    }))

    const projectedAnnualReturn = fundsWithSharesPct
      .filter(f => f.currentValue > 0)
      .reduce((sum, f) => sum + f.projectedAnnualReturn, 0)

    // Liquid gain = realized + unrealized (not just value - startInput)
    const totalGainUsd = totalRealizedGains + totalUnrealizedGains
    const totalGainPct = totalStartInput > 0 ? totalGainUsd / totalStartInput : 0
    const unrealizedGainPct = totalStartInput > 0 ? totalUnrealizedGains / totalStartInput : 0

    // Dollar-weighted compound APY for filtered platform
    let totalDollarDays = 0
    let maxDaysActive = 0
    for (const fund of fundsWithSharesPct) {
      totalDollarDays += fund.timeWeightedFundSize * fund.daysActive
      if (fund.daysActive > maxDaysActive) maxDaysActive = fund.daysActive
    }
    const effectivePortfolioDays = maxDaysActive
    const avgCapital = effectivePortfolioDays > 0 ? totalDollarDays / effectivePortfolioDays : 0

    let aggregateRealizedAPY = 0
    if (avgCapital > 0 && effectivePortfolioDays > 0) {
      const totalReturn = Math.max(-0.99, totalRealizedGains / avgCapital)
      aggregateRealizedAPY = Math.pow(1 + totalReturn, 365 / effectivePortfolioDays) - 1
    }

    let aggregateLiquidAPY = 0
    if (avgCapital > 0 && effectivePortfolioDays > 0) {
      const liquidReturn = Math.max(-0.99, totalGainUsd / avgCapital)
      aggregateLiquidAPY = Math.pow(1 + liquidReturn, 365 / effectivePortfolioDays) - 1
    }

    return {
      ...metrics,
      totalFundSize,
      totalValue,
      totalStartInput,
      totalTimeWeightedFundSize,
      totalDaysActive,
      totalRealizedGains,
      totalUnrealizedGains,
      unrealizedGainPct,
      realizedAPY: aggregateRealizedAPY,
      liquidAPY: aggregateLiquidAPY,
      projectedAnnualReturn,
      totalGainUsd,
      totalGainPct,
      activeFunds,
      closedFunds,
      funds: fundsWithSharesPct
    }
  }, [metrics, filterPlatform])

  // Calculate category allocations for the portfolio chart
  const categoryAllocations = useMemo((): CategoryChartData[] => {
    if (!filteredHistory?.currentAllocations || !funds) return []

    // Build a map of fund ID to category info (single or multi-category)
    const fundCategoryInfo = new Map<string, {
      singleCategory?: FundCategory
      allocations?: Array<{ category: FundCategory; percentage: number }>
    }>()
    for (const fund of funds) {
      // Multi-category funds take precedence
      if (fund.config.category_allocations && fund.config.category_allocations.length > 0) {
        fundCategoryInfo.set(fund.id, {
          allocations: fund.config.category_allocations as Array<{ category: FundCategory; percentage: number }>
        })
      } else {
        const effectiveCategory = getEffectiveCategory(
          fund.config.category as FundCategory | undefined,
          fund.config.fund_type
        )
        fundCategoryInfo.set(fund.id, { singleCategory: effectiveCategory })
      }
    }

    // Sum values by category
    const categoryTotals: Record<FundCategory, number> = {
      liquidity: 0,
      yield: 0,
      sov: 0,
      volatility: 0
    }

    for (const alloc of filteredHistory.currentAllocations) {
      const info = fundCategoryInfo.get(alloc.id)
      if (!info) continue

      if (info.allocations) {
        // Multi-category fund: split value based on percentages
        for (const catAlloc of info.allocations) {
          categoryTotals[catAlloc.category] += alloc.value * (catAlloc.percentage / 100)
        }
      } else if (info.singleCategory) {
        // Single-category fund
        categoryTotals[info.singleCategory] += alloc.value
      }
    }

    // Calculate total for percentages
    const total = Object.values(categoryTotals).reduce((sum, v) => sum + v, 0)

    // Build the allocation array in the defined order
    return FUND_CATEGORIES.map(cat => {
      const config = FUND_CATEGORY_CONFIG[cat]
      return {
        category: cat,
        label: config.label,
        value: categoryTotals[cat],
        percentage: total > 0 ? (categoryTotals[cat] / total) * 100 : 0,
        color: config.color
      }
    })
  }, [filteredHistory, funds])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value)
  }

  const formatPercent = (value: number) => {
    return (value * 100).toFixed(2) + '%'
  }

  // Show welcome panel if no funds and not loading
  const showWelcome = !fundsLoading && funds && funds.length === 0

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="space-y-2 sm:space-y-3">
        {/* Title and Status Row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight">
              Dashboard
              {!connected && <span className="ml-2 text-red-400 text-xs sm:text-sm font-normal">(Offline)</span>}
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1 leading-tight">
              {filteredMetrics?.activeFunds ?? 0} active • {filteredMetrics?.closedFunds ?? 0} closed
              {filterPlatform !== 'all' && <span className="ml-1 text-mint-400 capitalize">({filterPlatform})</span>}
            </p>
          </div>
          {/* Charts toggle - visible on all screen sizes */}
          <div className="flex items-center gap-2 cursor-pointer touch-manipulation flex-shrink-0" onClick={() => setShowCharts(!showCharts)}>
            <span className="text-xs sm:text-sm text-slate-400">Charts</span>
            <div
              role="switch"
              aria-checked={showCharts}
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' || e.key === ' ' ? setShowCharts(!showCharts) : null}
              className={`relative rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-mint-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${showCharts ? 'bg-mint-600' : 'bg-slate-700'}`}
              style={{ width: 44, height: 24 }}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-lg transition-transform duration-200 ease-in-out ${showCharts ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </div>
          </div>
        </div>

        {/* Controls Row - Platform filter and Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={filterPlatform}
            onChange={e => handlePlatformChange(e.target.value)}
            className="px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg text-white flex-1 sm:flex-initial sm:min-w-[160px] touch-manipulation min-h-[40px]"
          >
            <option value="all">All Platforms</option>
            {platforms.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <div className="flex items-center gap-2 flex-1 sm:flex-initial">
            <button
              onClick={() => setShowCreateModal(true)}
              data-testid="create-fund"
              className="px-4 py-2 text-sm bg-mint-600 text-white rounded-lg hover:bg-mint-700 active:bg-mint-800 transition-colors font-medium whitespace-nowrap touch-manipulation min-h-[40px] flex-1 sm:flex-initial"
            >
              + Add Fund
            </button>
            <button
              onClick={() => setShowImportModal(true)}
              className="px-4 py-2 text-sm bg-slate-700 text-white rounded-lg hover:bg-slate-600 active:bg-slate-500 transition-colors font-medium touch-manipulation min-h-[40px] flex-1 sm:flex-initial"
            >
              Import
            </button>
          </div>
        </div>
      </div>

      {showWelcome ? (
        <WelcomePanel
          onCreateFund={() => setShowCreateModal(true)}
          onImport={() => setShowImportModal(true)}
        />
      ) : (
        <>
          {/* Actionable Funds Banner - shows funds due for action */}
          <ActionableFundsBanner />

          {/* Aggregate Metrics Panel - shows skeleton while loading */}
          {metricsLoading ? (
            <MetricsPanelSkeleton />
          ) : filteredMetrics ? (
            <AggregatePanel metrics={filteredMetrics} />
          ) : null}

          {/* Portfolio Charts - shows data as it arrives via WebSocket */}
          {showCharts && (
            historyLoading ? (
              <ChartsSkeleton />
            ) : filteredHistory && filteredHistory.currentAllocations.length > 0 ? (
              <PortfolioCharts
                timeSeries={filteredHistory.timeSeries}
                allocations={filteredHistory.currentAllocations}
                totals={filteredHistory.totals}
                aggregateTotals={{
                  ...filteredHistory.aggregateTotals,
                  // Use filteredMetrics values for current display (matches header widgets)
                  totalRealizedGains: filteredMetrics?.totalRealizedGains ?? filteredHistory.aggregateTotals.totalRealizedGains,
                  totalUnrealizedGains: filteredMetrics?.totalUnrealizedGains ?? 0,
                  totalGainUsd: filteredMetrics?.totalGainUsd ?? filteredHistory.aggregateTotals.totalGainUsd,
                  realizedAPY: filteredMetrics?.realizedAPY ?? 0,
                  liquidAPY: filteredMetrics?.liquidAPY ?? 0
                }}
                categoryAllocations={categoryAllocations}
                marginInfo={{
                  available: filteredHistory.totals.totalCurrentMarginAccess,
                  borrowed: filteredHistory.totals.totalCurrentMarginBorrowed
                }}
              />
            ) : null
          )}

          {/* View Mode Toggle */}
          <div className="flex justify-end">
            <div className="flex bg-slate-800 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('grid')}
                className={`px-2 xs:px-2.5 sm:px-3 py-1.5 text-[10px] xs:text-[11px] sm:text-sm rounded-md touch-manipulation min-h-[28px] xs:min-h-[32px] sm:min-h-[36px] ${viewMode === 'grid' ? 'bg-mint-600 text-white' : 'text-slate-400 hover:text-slate-300 active:text-slate-200'}`}
              >
                Grid
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-2 xs:px-2.5 sm:px-3 py-1.5 text-[10px] xs:text-[11px] sm:text-sm rounded-md touch-manipulation min-h-[28px] xs:min-h-[32px] sm:min-h-[36px] ${viewMode === 'table' ? 'bg-mint-600 text-white' : 'text-slate-400 hover:text-slate-300 active:text-slate-200'}`}
              >
                Table
              </button>
            </div>
          </div>

          {/* Funds List/Grid - shows skeleton while loading */}
          {fundsLoading ? (
            <FundCardsSkeleton />
          ) : viewMode === 'table' ? (
            <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-x-auto -mx-2 px-2 sm:mx-0 sm:px-0 scrollbar-thin scroll-fade-right">
              <table className="w-full text-left text-[10px] xs:text-xs sm:text-sm min-w-[260px]">
                <thead>
                  <tr className="border-b border-slate-700 text-slate-400">
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium">Fund</th>
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium hidden sm:table-cell">Platform</th>
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium text-right hidden md:table-cell">Fund Size</th>
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium text-right">Value</th>
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium text-right hidden lg:table-cell">Target APY</th>
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium text-right hidden lg:table-cell">Interval</th>
                    <th className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 font-medium text-right hidden xs:table-cell">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFunds.map(fund => (
                    <tr
                      key={fund.id}
                      className="border-b border-slate-700/50 hover:bg-slate-700/30 active:bg-slate-700/50 cursor-pointer touch-manipulation"
                      onClick={() => window.location.href = `/fund/${fund.id}`}
                    >
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3">
                        <span className="font-medium text-white uppercase text-[10px] xs:text-xs sm:text-sm">{fund.ticker}</span>
                        <span className="sm:hidden text-slate-500 text-[9px] xs:text-[10px] capitalize block mt-0.5">{fund.platform}</span>
                      </td>
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 text-slate-400 capitalize hidden sm:table-cell">{fund.platform}</td>
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 text-right text-white hidden md:table-cell">
                        {formatCurrency(fund.config.fund_size_usd)}
                      </td>
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 text-right">
                        <span className={fund.latestEquity?.value ? 'text-mint-400 font-medium' : 'text-slate-500'}>
                          {fund.latestEquity?.value ? formatCurrency(fund.latestEquity.value) : '-'}
                        </span>
                      </td>
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 text-right text-slate-300 hidden lg:table-cell">
                        {formatPercent(fund.config.target_apy)}
                      </td>
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 text-right text-slate-400 hidden lg:table-cell">
                        {fund.config.interval_days}d
                      </td>
                      <td className="px-2 xs:px-2.5 sm:px-3 py-2 xs:py-2.5 sm:py-3 text-right text-slate-400 hidden xs:table-cell">
                        {fund.entryCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-3 xs:space-y-4 sm:space-y-5">
              {Object.entries(fundsByPlatform).map(([platform, platformFunds]) => (
                <div key={platform}>
                  <Link
                    to={`/platform/${platform}`}
                    className="text-xs xs:text-sm sm:text-base font-semibold text-white mb-1.5 xs:mb-2 sm:mb-3 capitalize hover:text-mint-400 active:text-mint-500 transition-colors inline-block touch-manipulation"
                  >
                    {platform} →
                  </Link>
                  <div className="grid grid-cols-2 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 xs:gap-2 sm:gap-3">
                    {platformFunds.map(fund => {
                      const fundMetrics = filteredMetrics?.funds.find(f => f.id === fund.id)
                      const fundPath = `/fund/${fund.id}`
                      return (
                        <Link key={fund.id} to={fundPath} className="touch-manipulation">
                          <FundCard
                            fund={fund}
                            impactPct={fundMetrics?.fundSharesPct}
                            realizedAPY={fundMetrics?.realizedAPY}
                            liquidAPY={fundMetrics?.liquidAPY}
                            realizedGains={fundMetrics?.realizedGains}
                          />
                        </Link>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Create Fund Modal */}
      {showCreateModal && (
        <CreateFundModal
          onClose={() => setShowCreateModal(false)}
          onCreated={refresh}
        />
      )}

      {/* Import Wizard - lazy loaded */}
      {showImportModal && (
        <Suspense fallback={<div className="fixed inset-0 bg-slate-900/80 flex items-center justify-center z-50"><div className="animate-spin h-8 w-8 border-2 border-mint-500 border-t-transparent rounded-full" /></div>}>
          <ImportWizard
            onClose={() => setShowImportModal(false)}
            onImported={refresh}
          />
        </Suspense>
      )}
    </div>
  )
}

// Charts skeleton component
function ChartsSkeleton() {
  return (
    <div className="space-y-1.5 xs:space-y-2 sm:space-y-3">
      {/* Mobile: Allocation List Skeletons */}
      <div className="grid grid-cols-1 gap-1.5 sm:hidden">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-slate-800 rounded-lg p-2 border border-slate-700 animate-pulse">
            <div className="h-3 w-24 bg-slate-700 rounded mb-2" />
            <div className="space-y-2">
              {[1, 2, 3].map(j => (
                <div key={j} className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-slate-700 rounded-full flex-shrink-0" />
                  <div className="flex-1">
                    <div className="h-2 bg-slate-700 rounded mb-1" />
                    <div className="h-1.5 bg-slate-700/50 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: Pie Charts Row */}
      <div className="hidden sm:grid grid-cols-3 gap-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-slate-800 rounded-lg p-2 border border-slate-700 animate-pulse">
            <div className="h-2 w-24 bg-slate-700 rounded mb-1" />
            <div className="flex items-start gap-2">
              <div className="w-[100px] h-[100px] bg-slate-700/50 rounded-full flex-shrink-0" />
              <div className="flex-1 space-y-2">
                {[1, 2, 3].map(j => (
                  <div key={j} className="h-4 bg-slate-700 rounded" />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Time Series Rows */}
      {[1, 2, 3].map(row => (
        <div key={row} className="grid grid-cols-2 gap-1 xs:gap-1.5 sm:gap-2">
          {[1, 2].map(i => (
            <div key={i} className="bg-slate-800 rounded-lg p-1 xs:p-1.5 sm:p-2 border border-slate-700 animate-pulse">
              <div className="h-2 w-20 bg-slate-700 rounded mb-1" />
              <div className="h-[100px] xs:h-[110px] sm:h-[130px] md:h-[150px] bg-slate-700/50 rounded" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Dashboard Cache Service
 *
 * Caches computed dashboard data in memory for fast subsequent loads.
 * Invalidates cache when fund data changes.
 */

import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { readFund, entriesToCashFlows, type FundData } from '@escapemint/storage'
import {
  computeDerivativesEntriesState,
  computeExpectedTarget,
  computeTimeWeightedFundSize,
  computeCashFundTimeWeightedSize,
  getFundStartDate,
  type SubFundConfig,
  type Trade
} from '@escapemint/engine'
import { computeFundFinalMetrics } from '../utils/fund-metrics.js'
import { isTestPlatform } from '../utils/platforms.js'

const FUNDS_DIR = join(process.env['DATA_DIR'] ?? './data', 'funds')

// Cache entry with timestamp
interface CacheEntry<T> {
  data: T
  timestamp: number
  computing?: boolean
}

// Dashboard data types
export interface DashboardFundSummary {
  id: string
  platform: string
  ticker: string
  config: SubFundConfig
  entryCount: number
  latestEquity: { date: string; value: number } | null
  latestFundSize?: number
  firstEntryDate?: string | undefined
}

export interface DashboardMetrics {
  totalFundSize: number
  totalValue: number
  totalStartInput: number
  totalTimeWeightedFundSize: number
  totalDaysActive: number
  totalRealizedGains: number
  totalUnrealizedGains: number
  unrealizedGainPct: number
  realizedAPY: number
  liquidAPY: number
  projectedAnnualReturn: number
  totalGainUsd: number
  totalGainPct: number
  activeFunds: number
  closedFunds: number
  portfolioDays: number
  funds: FundMetrics[]
}

export interface FundMetrics {
  id: string
  platform: string
  ticker: string
  status: 'active' | 'closed'
  fundType: 'cash' | 'stock' | 'crypto' | 'derivatives'
  fundSize: number
  currentValue: number
  startInput: number
  daysActive: number
  timeWeightedFundSize: number
  realizedGains: number
  unrealizedGains: number
  realizedAPY: number
  liquidAPY: number
  projectedAnnualReturn: number
  gainUsd: number
  gainPct: number
  fundShares: number
  fundSharesPct: number
}

export interface TimeSeriesPoint {
  date: string
  totalFundSize: number
  totalValue: number
  totalCash: number
  totalMarginBorrowed: number
  totalMarginAccess: number
  totalStartInput: number
  totalDividends: number
  totalExpenses: number
  totalCashInterest: number
  totalRealizedGain: number
  totalUnrealizedGain: number
  totalExpectedTarget: number
  realizedAPY: number
  liquidAPY: number
  totalGainUsd: number
  totalGainPct: number
  fundBreakdown: Record<string, number>
  realizedGainBreakdown: Record<string, number>
  unrealizedGainBreakdown: Record<string, number>
}

export interface AllocationData {
  id: string
  ticker: string
  platform: string
  value: number
  cash: number
  fundSize: number
  marginAccess: number
  marginBorrowed: number
}

export interface DashboardHistory {
  timeSeries: TimeSeriesPoint[]
  currentAllocations: AllocationData[]
  totals: {
    totalCurrentValue: number
    totalCurrentCash: number
    totalCurrentMarginAccess: number
    totalCurrentMarginBorrowed: number
  }
  aggregateTotals: {
    totalGainUsd: number
    totalRealizedGains: number
    totalValue: number
    totalStartInput: number
  }
}

// Cache storage
const cache = {
  funds: null as CacheEntry<DashboardFundSummary[]> | null,
  metrics: null as CacheEntry<DashboardMetrics> | null,
  history: null as CacheEntry<DashboardHistory> | null,
  rawFunds: null as CacheEntry<FundData[]> | null
}

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000

// Event listeners for cache updates
type CacheListener = (event: string, data: unknown) => void
const listeners: Set<CacheListener> = new Set()

export function addCacheListener(listener: CacheListener): void {
  listeners.add(listener)
}

export function removeCacheListener(listener: CacheListener): void {
  listeners.delete(listener)
}

function notifyListeners(event: string, data: unknown): void {
  for (const listener of listeners) {
    listener(event, data)
  }
}

// Check if cache entry is valid
function isCacheValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  if (!entry) return false
  return Date.now() - entry.timestamp < CACHE_TTL
}

// Invalidate all caches
export function invalidateCache(): void {
  cache.funds = null
  cache.metrics = null
  cache.history = null
  cache.rawFunds = null
  notifyListeners('cache:invalidated', null)
}

// Load all fund files
// includeTest: true = show ONLY test funds, false = show ONLY non-test funds
async function loadAllFunds(includeTest = false): Promise<FundData[]> {
  // Check cache first
  if (isCacheValid(cache.rawFunds)) {
    const funds = cache.rawFunds.data
    // Filter based on test mode
    return funds.filter(f => includeTest ? isTestPlatform(f.platform) : !isTestPlatform(f.platform))
  }

  const files = await readdir(FUNDS_DIR)
  const tsvFiles = files.filter(f => f.endsWith('.tsv'))

  const funds: FundData[] = []
  for (const file of tsvFiles) {
    const fund = await readFund(join(FUNDS_DIR, file))
    if (fund) {
      funds.push(fund)
    }
  }

  // Cache raw funds
  cache.rawFunds = {
    data: funds,
    timestamp: Date.now()
  }

  // Filter based on test mode
  return funds.filter(f => includeTest ? isTestPlatform(f.platform) : !isTestPlatform(f.platform))
}

// Get fund summaries (fast, for fund list)
// includeTest: true = show ONLY test funds, false = show ONLY non-test funds
export async function getFundSummaries(includeTest = false): Promise<DashboardFundSummary[]> {
  // Load funds with the correct filter applied
  const funds = await loadAllFunds(includeTest)

  const summaries: DashboardFundSummary[] = funds.map(fund => {
    const sortedEntries = [...fund.entries].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )
    const latestEntry = sortedEntries[sortedEntries.length - 1]
    const firstEntry = sortedEntries[0]

    // Calculate actual fund size from latest entry or config
    const actualFundSize = latestEntry?.fund_size ?? fund.config.fund_size_usd

    return {
      id: fund.id,
      platform: fund.platform,
      ticker: fund.ticker,
      config: fund.config,
      entryCount: fund.entries.length,
      latestEquity: latestEntry ? { date: latestEntry.date, value: latestEntry.value } : null,
      latestFundSize: actualFundSize,
      firstEntryDate: firstEntry?.date
    }
  })

  return summaries
}

// Get aggregate metrics (medium complexity)
// includeTest: true = show ONLY test funds, false = show ONLY non-test funds
export async function getAggregateMetrics(includeTest = false): Promise<DashboardMetrics> {
  // Load funds with the correct filter applied
  const funds = await loadAllFunds(includeTest)
  const fundMetrics: FundMetrics[] = []

  let earliestDate: string | undefined
  let latestDate: string | undefined

  for (const fund of funds) {
    const metrics = computeFundMetrics(fund)
    if (metrics) {
      fundMetrics.push(metrics)
    }
    // Track earliest/latest entry dates for portfolioDays
    if (fund.entries.length > 0) {
      const sorted = [...fund.entries].sort((a, b) => a.date.localeCompare(b.date))
      const first = sorted[0]!.date
      const last = sorted[sorted.length - 1]!.date
      if (!earliestDate || first < earliestDate) earliestDate = first
      if (!latestDate || last > latestDate) latestDate = last
    }
  }

  const portfolioDays = earliestDate && latestDate
    ? Math.max(1, Math.floor((new Date(latestDate).getTime() - new Date(earliestDate).getTime()) / (24 * 60 * 60 * 1000)))
    : undefined

  return recalculateAggregates(fundMetrics, portfolioDays)
}

// Compute metrics for a single fund using the same logic as /aggregate endpoint
function computeFundMetrics(fund: FundData): FundMetrics | null {
  if (fund.entries.length === 0) return null

  const sortedEntries = [...fund.entries].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  const latestEntry = sortedEntries[sortedEntries.length - 1]!

  // Use computeFundFinalMetrics for accurate calculations (same as /aggregate endpoint)
  // This handles manage_cash=false correctly (uses netInvested instead of entry.fund_size)
  const finalMetrics = computeFundFinalMetrics(fund)

  // Use fundSize from finalMetrics for all funds (correctly handles manage_cash and derivatives)
  const actualFundSize = finalMetrics.fundSize
  // Calendar days between first and last entry (for share weighting, not for TWFS)
  const calendarDays = Math.max(1, Math.floor(
    (new Date(latestEntry.date).getTime() - new Date(sortedEntries[0]!.date).getTime()) / (24 * 60 * 60 * 1000)
  ))

  // Time-weighted AVERAGE fund size — reuse the engine's canonical implementation
  const fundStartDate = getFundStartDate(sortedEntries)
  const asOfDate = latestEntry.date
  const isCashFund = fund.config.fund_type === 'cash'

  let timeWeightedFundSize: number
  if (isCashFund) {
    const cashFlows = entriesToCashFlows(sortedEntries)
    timeWeightedFundSize = computeCashFundTimeWeightedSize(cashFlows, fundStartDate, asOfDate)
  } else {
    const trades: Trade[] = sortedEntries
      .filter(e => (e.action === 'BUY' || e.action === 'SELL') && e.amount)
      .map(e => ({
        date: e.date,
        amount_usd: Math.abs(e.amount!),
        type: e.action === 'BUY' ? 'buy' as const : 'sell' as const
      }))
    timeWeightedFundSize = computeTimeWeightedFundSize(trades, fundStartDate, asOfDate)
  }

  const isClosed = fund.config.status === 'closed'

  // Use APY from finalMetrics (proper TWAB and compound interest formula)
  const realizedAPY = finalMetrics.realizedApy
  const liquidAPY = finalMetrics.liquidApy

  // Projected annual return (based on realized APY - actual income, not paper gains)
  const projectedAnnualReturn = realizedAPY * actualFundSize

  // For cash funds, gain = interest earned only
  const gainUsd = isCashFund ? finalMetrics.realized : finalMetrics.liquidPnl
  const gainPct = finalMetrics.totalInvested > 0 ? gainUsd / finalMetrics.totalInvested : 0

  return {
    id: fund.id,
    platform: fund.platform,
    ticker: fund.ticker,
    status: isClosed ? 'closed' : 'active',
    fundType: (fund.config.fund_type ?? 'stock') as 'cash' | 'stock' | 'crypto' | 'derivatives',
    fundSize: actualFundSize,
    currentValue: finalMetrics.currentValue,
    startInput: finalMetrics.totalInvested,
    daysActive: calendarDays,
    timeWeightedFundSize,
    realizedGains: finalMetrics.realized,
    unrealizedGains: finalMetrics.unrealized,
    realizedAPY,
    liquidAPY,
    projectedAnnualReturn,
    gainUsd,
    gainPct,
    fundShares: 0, // Calculated in aggregation
    fundSharesPct: 0 // Calculated in aggregation
  }
}

// Recalculate aggregates from fund metrics
function recalculateAggregates(fundMetrics: FundMetrics[], portfolioDays?: number): DashboardMetrics {
  const totalFundSize = fundMetrics.reduce((sum, f) => sum + f.fundSize, 0)
  const totalValue = fundMetrics.reduce((sum, f) => sum + f.currentValue, 0)
  const totalStartInput = fundMetrics.reduce((sum, f) => sum + f.startInput, 0)
  const totalTimeWeightedFundSize = fundMetrics.reduce((sum, f) => sum + f.timeWeightedFundSize, 0)
  const totalDaysActive = fundMetrics.reduce((sum, f) => sum + f.daysActive, 0)
  const totalRealizedGains = fundMetrics.reduce((sum, f) => sum + f.realizedGains, 0)
  const totalUnrealizedGains = fundMetrics.reduce((sum, f) => sum + f.unrealizedGains, 0)
  const activeFunds = fundMetrics.filter(f => f.status !== 'closed').length
  const closedFunds = fundMetrics.filter(f => f.status === 'closed').length

  // Calculate fund shares
  const dollarsPerDay = totalTimeWeightedFundSize > 0 && totalDaysActive > 0
    ? totalTimeWeightedFundSize / totalDaysActive
    : 0

  let totalFundShares = 0
  const fundsWithShares = fundMetrics.map(fund => {
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

  // Dollar-weighted compound APY: annualize the portfolio-level return once
  let totalDollarDays = 0
  let maxDaysActive = 0
  for (const fund of fundsWithSharesPct) {
    totalDollarDays += fund.timeWeightedFundSize * fund.daysActive
    if (fund.daysActive > maxDaysActive) maxDaysActive = fund.daysActive
  }
  const effectivePortfolioDays = portfolioDays ?? maxDaysActive
  const avgCapital = effectivePortfolioDays > 0 ? totalDollarDays / effectivePortfolioDays : 0

  // Realized APY: compound formula
  let weightedRealizedAPY = 0
  if (avgCapital > 0 && effectivePortfolioDays > 0) {
    const totalReturn = Math.max(-0.99, totalRealizedGains / avgCapital)
    weightedRealizedAPY = Math.pow(1 + totalReturn, 365 / effectivePortfolioDays) - 1
  }

  // Total liquid gain = sum of each fund's liquidPnl (unrealized + realized)
  const totalGainUsd = fundMetrics.reduce((sum, f) => sum + f.gainUsd, 0)
  const totalGainPct = totalStartInput > 0 ? totalGainUsd / totalStartInput : 0

  // Liquid APY: compound formula
  let liquidAPY = 0
  if (avgCapital > 0 && effectivePortfolioDays > 0) {
    const liquidReturn = Math.max(-0.99, totalGainUsd / avgCapital)
    liquidAPY = Math.pow(1 + liquidReturn, 365 / effectivePortfolioDays) - 1
  }

  // Sum projected returns
  const projectedAnnualReturn = fundsWithSharesPct
    .filter(f => f.currentValue > 0)
    .reduce((sum, f) => sum + f.projectedAnnualReturn, 0)

  // Unrealized gain percentage
  const unrealizedGainPct = totalStartInput > 0 ? totalUnrealizedGains / totalStartInput : 0

  return {
    totalFundSize,
    totalValue,
    totalStartInput,
    totalTimeWeightedFundSize,
    totalDaysActive,
    totalRealizedGains,
    totalUnrealizedGains,
    unrealizedGainPct,
    realizedAPY: weightedRealizedAPY,
    liquidAPY,
    projectedAnnualReturn,
    totalGainUsd,
    totalGainPct,
    activeFunds,
    closedFunds,
    portfolioDays: effectivePortfolioDays,
    funds: fundsWithSharesPct
  }
}

// Get history (most expensive, computed last)
// includeTest: true = show ONLY test funds, false = show ONLY non-test funds
export async function getHistory(includeTest = false): Promise<DashboardHistory> {
  // Load funds with the correct filter applied
  const funds = await loadAllFunds(includeTest)

  // Build time series and allocations
  return computeHistory(funds)
}

// Compute history time series
function computeHistory(funds: FundData[]): DashboardHistory {
  // Collect all unique dates
  const allDates = new Set<string>()
  for (const fund of funds) {
    for (const entry of fund.entries) {
      allDates.add(entry.date)
    }
  }

  const sortedDates = [...allDates].sort()
  const lastDate = sortedDates[sortedDates.length - 1]
  const timeSeries: TimeSeriesPoint[] = []

  // Pre-compute derivatives state for each derivatives fund (matches REST API)
  type DerivState = { equity: number; costBasis: number; marginBalance: number; availableFunds: number; realizedPnl: number; unrealizedPnl: number; sumFunding: number; sumInterest: number; sumRebates: number; sumFees: number }
  const derivativesStateByFund = new Map<string, Map<string, DerivState>>()
  for (const fund of funds) {
    if (fund.config.fund_type === 'derivatives' && fund.entries.length > 0) {
      const contractMultiplier = fund.config.contract_multiplier ?? 0.01
      const maintenanceMarginRate = fund.config.maintenance_margin_rate ?? 0.20
      const initialMarginRate = fund.config.initial_margin_rate ?? 0.25
      const derivStates = computeDerivativesEntriesState(fund.entries, contractMultiplier, maintenanceMarginRate, undefined, initialMarginRate)
      const dateMap = new Map<string, DerivState>()
      for (const entry of derivStates) {
        dateMap.set(entry.date, {
          equity: entry.equity,
          costBasis: entry.costBasis,
          marginBalance: entry.marginBalance,
          unrealizedPnl: entry.unrealizedPnl,
          sumFunding: entry.sumFunding,
          sumRebates: entry.sumRebates,
          sumFees: entry.sumFees,
          availableFunds: entry.availableFunds,
          realizedPnl: entry.realizedPnl,
          sumInterest: entry.sumInterest
        })
      }
      derivativesStateByFund.set(fund.id, dateMap)
    }
  }

  // Track earliest start date for APY calculation
  let earliestStartDate: string | null = null
  for (const fund of funds) {
    const firstEntry = fund.entries[0]
    if (firstEntry && (!earliestStartDate || firstEntry.date < earliestStartDate)) {
      earliestStartDate = firstEntry.date
    }
  }

  for (const date of sortedDates) {
    let totalFundSize = 0
    let totalValue = 0
    let totalCash = 0
    let totalMarginBorrowed = 0
    let totalMarginAccess = 0
    let totalStartInput = 0
    let totalDividends = 0
    let totalExpenses = 0
    let totalCashInterest = 0
    let totalRealizedGain = 0
    let totalUnrealizedGain = 0
    let totalExpectedTarget = 0
    let totalGainUsd = 0
    const fundBreakdown: Record<string, number> = {}
    const realizedGainBreakdown: Record<string, number> = {}
    const unrealizedGainBreakdown: Record<string, number> = {}

    for (const fund of funds) {
      const entriesUpToDate = fund.entries.filter(e => e.date <= date)
      if (entriesUpToDate.length === 0) continue

      const sortedEntries = [...entriesUpToDate].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      )

      const isCashFund = fund.config.fund_type === 'cash'
      const isDerivativesFund = fund.config.fund_type === 'derivatives'

      // Handle derivatives funds specially (matches REST API)
      if (isDerivativesFund) {
        const derivDateMap = derivativesStateByFund.get(fund.id)
        let derivValue = 0
        let derivCostBasis = 0
        let derivAvailableFunds = 0
        let derivRealizedPnl = 0
        let derivUnrealizedPnl = 0
        let derivSumInterest = 0
        if (derivDateMap) {
          for (const entry of sortedEntries) {
            const state = derivDateMap.get(entry.date)
            if (state) {
              derivValue = state.equity
              derivCostBasis = state.costBasis
              derivAvailableFunds = state.availableFunds
              derivRealizedPnl = state.realizedPnl
              derivUnrealizedPnl = state.unrealizedPnl
              derivSumInterest = state.sumInterest
            }
          }
        }
        totalValue += derivValue
        totalFundSize += derivValue
        totalStartInput += derivCostBasis
        // Realized P&L already includes funding + interest + rebates - fees from the engine
        const derivRealized = derivRealizedPnl
        totalRealizedGain += derivRealized
        totalCashInterest += derivSumInterest
        totalCash += Math.max(0, derivAvailableFunds)
        fundBreakdown[fund.id] = derivValue
        // Unrealized = actual unrealized P&L on open positions (from state)
        totalUnrealizedGain += derivUnrealizedPnl
        // Track per-fund breakdown
        realizedGainBreakdown[fund.id] = derivRealized
        unrealizedGainBreakdown[fund.id] = derivUnrealizedPnl
        // Derivatives liquid gain = unrealized + realized
        totalGainUsd += derivUnrealizedPnl + derivRealized
      } else {
        // Cash and trading funds - use computeFundFinalMetrics for realized gains
        // For historical points, override the status to 'active' so closed funds
        // show their actual historical values (not forced to 0)
        const isLastDate = date === lastDate
        const configForSnapshot = isLastDate
          ? fund.config
          : { ...fund.config, status: 'active' as const }
        const fundSnapshot = {
          ...fund,
          config: configForSnapshot,
          entries: sortedEntries
        }
        const metrics = computeFundFinalMetrics(fundSnapshot)
        const latestEntry = sortedEntries[sortedEntries.length - 1]!

        totalFundSize += metrics.fundSize

        // For the final date, use post-action value (matches header widgets)
        // For historical dates, use entry value directly to avoid over-counting
        const valueForCalc = isLastDate ? metrics.currentValue : latestEntry.value
        totalValue += valueForCalc
        fundBreakdown[fund.id] = valueForCalc

        totalStartInput += metrics.totalInvested
        totalRealizedGain += metrics.realized
        totalCashInterest += metrics.sumCashInterest

        // Track per-fund realized gains
        realizedGainBreakdown[fund.id] = metrics.realized

        // Unrealized calculation
        if (!isCashFund) {
          // For final date: use metrics.unrealized (post-action value - cost basis)
          // For historical: use entry value - cost basis
          // Special case: if costBasis is 0, there are no open positions so unrealized is 0
          // (the position is fully closed, there's nothing to have unrealized gains on, even if currentValue > 0 from cash)
          const isFullyLiquidated = metrics.costBasis === 0
          const fundUnrealized = isFullyLiquidated ? 0 : (isLastDate ? metrics.unrealized : (latestEntry.value - metrics.costBasis))
          totalUnrealizedGain += fundUnrealized
          unrealizedGainBreakdown[fund.id] = fundUnrealized
          // Liquid = unrealized + realized
          totalGainUsd += fundUnrealized + metrics.realized
        } else {
          unrealizedGainBreakdown[fund.id] = 0
          // Cash funds: all gains are realized
          totalGainUsd += metrics.realized
        }

        // Track dividends and expenses
        totalDividends += metrics.sumDividends
        totalExpenses += metrics.sumExpenses

        // Cash - use computed cash from metrics
        totalCash += metrics.cash

        // Expected target for trading funds with target_apy
        if (!isCashFund && fund.config.target_apy > 0) {
          // Convert FundEntry[] to Trade[] for computeExpectedTarget
          const trades: Trade[] = sortedEntries
            .filter(e => e.action === 'BUY' || e.action === 'SELL')
            .map(e => {
              const trade: Trade = {
                date: e.date,
                amount_usd: e.amount ?? 0,
                type: e.action === 'BUY' ? 'buy' : 'sell',
                value: e.value
              }
              if (e.shares !== undefined) trade.shares = e.shares
              return trade
            })
          const expectedTarget = computeExpectedTarget(fund.config, trades, date)
          totalExpectedTarget += expectedTarget
        }
      }

      // Margin - still need to get from entry
      const latestForMargin = sortedEntries[sortedEntries.length - 1]
      if (latestForMargin?.margin_borrowed) {
        totalMarginBorrowed += latestForMargin.margin_borrowed
      }
      if (fund.config.margin_access_usd) {
        totalMarginAccess += fund.config.margin_access_usd
      }
    }

    // Calculate gains and APY
    // totalGainUsd was accumulated above and includes both unrealized + realized (full lifetime gain)
    const totalGainPct = totalStartInput > 0 ? totalGainUsd / totalStartInput : 0

    const daysActive = earliestStartDate
      ? Math.max(1, Math.floor((new Date(date).getTime() - new Date(earliestStartDate).getTime()) / (24 * 60 * 60 * 1000)))
      : 1

    const apyBase = Math.max(totalStartInput, totalFundSize * 0.1)
    const realizedAPY = apyBase > 0 && daysActive > 0
      ? Math.pow(1 + Math.max(-0.99, totalRealizedGain / apyBase), 365 / daysActive) - 1
      : 0
    const liquidAPY = apyBase > 0 && daysActive > 0
      ? Math.pow(1 + Math.max(-0.99, totalGainUsd / apyBase), 365 / daysActive) - 1
      : 0

    timeSeries.push({
      date,
      totalFundSize,
      totalValue,
      totalCash,
      totalMarginBorrowed,
      totalMarginAccess,
      totalStartInput,
      totalDividends,
      totalExpenses,
      totalCashInterest,
      totalRealizedGain,
      totalUnrealizedGain,
      totalExpectedTarget,
      realizedAPY,
      liquidAPY,
      totalGainUsd,
      totalGainPct,
      fundBreakdown,
      realizedGainBreakdown,
      unrealizedGainBreakdown
    })
  }

  // Current allocations
  const currentAllocations: AllocationData[] = []
  for (const fund of funds) {
    const latest = fund.entries[fund.entries.length - 1]
    if (!latest) continue

    const isCashFund = fund.config.fund_type === 'cash'
    const isDerivativesFund = fund.config.fund_type === 'derivatives'

    let value = latest.value
    let cash = 0
    let fundSize = latest.fund_size ?? fund.config.fund_size_usd

    if (isDerivativesFund) {
      // Use computed derivatives equity and available funds (matches REST API)
      const derivDateMap = derivativesStateByFund.get(fund.id)
      if (derivDateMap) {
        const state = derivDateMap.get(latest.date)
        if (state) {
          value = state.equity
          fundSize = state.equity  // Use equity as fund size for derivatives
          cash = Math.max(0, state.availableFunds)  // Available margin (not locked)
        }
      }
    } else if (isCashFund) {
      cash = latest.cash ?? latest.value
    } else {
      cash = latest.cash ?? 0
    }

    currentAllocations.push({
      id: fund.id,
      ticker: fund.ticker,
      platform: fund.platform,
      value,
      cash,
      fundSize,
      marginAccess: fund.config.margin_access_usd ?? 0,
      marginBorrowed: latest.margin_borrowed ?? 0
    })
  }

  const totals = recalculateTotals(currentAllocations)

  // Aggregate totals from latest time series point
  const lastPoint = timeSeries[timeSeries.length - 1]
  const aggregateTotals = {
    totalGainUsd: lastPoint?.totalGainUsd ?? 0,
    totalRealizedGains: lastPoint?.totalRealizedGain ?? 0,
    totalValue: lastPoint?.totalValue ?? 0,
    totalStartInput: lastPoint?.totalStartInput ?? 0
  }

  return {
    timeSeries,
    currentAllocations,
    totals,
    aggregateTotals
  }
}

function recalculateTotals(allocations: AllocationData[]) {
  return {
    totalCurrentValue: allocations.reduce((sum, a) => sum + a.value, 0),
    totalCurrentCash: allocations.reduce((sum, a) => sum + a.cash, 0),
    totalCurrentMarginAccess: allocations.reduce((sum, a) => sum + a.marginAccess, 0),
    totalCurrentMarginBorrowed: allocations.reduce((sum, a) => sum + a.marginBorrowed, 0)
  }
}

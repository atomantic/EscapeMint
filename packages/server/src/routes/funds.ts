import { Router } from 'express'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  readFund,
  writeFund,
  readAllFunds,
  appendEntry,
  deleteEntry,
  deleteFund,
  entriesToTrades,
  entriesToDividends,
  entriesToExpenses,
  entriesToCashInterest,
  entriesToCashFlows,
  getLatestEquity,
  type FundData,
  type FundEntry
} from '@escapemint/storage'
import {
  computeFundState,
  computeRecommendation,
  computeFundMetrics,
  computeAggregateMetrics,
  computeClosedFundMetrics,
  computeDerivativesEntriesState,
  computeExpectedTarget,
  type FundState
} from '@escapemint/engine'
import { notFound, badRequest } from '../middleware/error-handler.js'
import { computeFundFinalMetrics } from '../utils/fund-metrics.js'
import { parseLocalDate } from '../utils/calculations.js'
import { readPlatformsData, writePlatformsData, isTestPlatform } from '../utils/platforms.js'

export const fundsRouter: ReturnType<typeof Router> = Router()

const DATA_DIR = process.env['DATA_DIR'] ?? './data'
const FUNDS_DIR = join(DATA_DIR, 'funds')

/**
 * Computes the post-action equity value for an entry.
 * After a SELL action, the equity is reduced by the sell amount.
 * After a full liquidation, the equity is 0.
 */
function computePostActionEquity(entry: FundEntry): number {
  const action = entry.action?.toUpperCase()
  if (action === 'SELL' || action === 'CLOSE') {
    const sellAmount = entry.amount ?? 0
    // Check for full liquidation: selling everything or close to it
    if (entry.value > 0 && entry.value <= sellAmount + 0.01) {
      return 0
    }
    return Math.max(0, entry.value - sellAmount)
  }
  // For BUY/HOLD/other actions, equity stays the same at snapshot time
  return entry.value
}

/**
 * GET /funds - List all funds
 * Query params:
 *   - include_test: 'true' to include test platform funds (default: false)
 */
fundsRouter.get('/', async (req, res, next) => {
  const allFunds = await readAllFunds(FUNDS_DIR).catch(next)
  if (!allFunds) return

  const includeTest = req.query.include_test === 'true'
  const funds = includeTest
    ? allFunds.filter(f => isTestPlatform(f.platform))
    : allFunds.filter(f => !isTestPlatform(f.platform))

  res.json(funds.map(f => {
    const latest = getLatestEquity(f.entries)
    const isCashFund = f.config.fund_type === 'cash'
    const isDerivativesFund = f.config.fund_type === 'derivatives'
    const latestEntry = f.entries[f.entries.length - 1]
    const firstEntry = f.entries[0]

    const isClosed = f.config.status === 'closed'

    // Compute equity and size based on fund type
    let latestEquity = latest
    let derivativesMarginBalance: number | undefined
    if (isCashFund && latest && latestEntry?.cash !== undefined) {
      // For cash funds, use the cash field as the balance
      latestEquity = { date: latest.date, value: latestEntry.cash }
    } else if (isDerivativesFund && f.entries.length > 0) {
      // For derivatives funds, compute the derivatives state to get equity and margin
      const contractMultiplier = f.config.contract_multiplier ?? 0.01
      const maintenanceMarginRate = f.config.maintenance_margin_rate ?? 0.20
      const initialMarginRate = f.config.initial_margin_rate ?? 0.25
      const derivStates = computeDerivativesEntriesState(f.entries, contractMultiplier, maintenanceMarginRate, undefined, initialMarginRate)
      const lastState = derivStates[derivStates.length - 1]
      if (lastState) {
        latestEquity = { date: lastState.date, value: lastState.equity }
        derivativesMarginBalance = lastState.marginBalance
      }
    }

    // Get latest fund size from entries (falls back to config if not in entries)
    // Closed funds always have size = 0
    // Derivatives funds use marginBalance as their "size"
    const latestFundSize = isClosed ? 0
      : isDerivativesFund ? (derivativesMarginBalance ?? 0)
      : (latestEntry?.fund_size ?? f.config.fund_size_usd)

    return {
      id: f.id,
      platform: f.platform,
      ticker: f.ticker,
      config: f.config,
      entryCount: f.entries.length,
      latestEquity,
      latestFundSize,
      firstEntryDate: firstEntry?.date
    }
  }))
})

/**
 * GET /funds/aggregate - Get aggregate metrics across all funds
 * Query params:
 *   - include_test: 'true' to include test platform funds (default: false)
 */
fundsRouter.get('/aggregate', async (req, res, next) => {
  const allFunds = await readAllFunds(FUNDS_DIR).catch(next)
  if (!allFunds) return

  const includeTest = req.query.include_test === 'true'
  const funds = includeTest
    ? allFunds.filter(f => isTestPlatform(f.platform))
    : allFunds.filter(f => !isTestPlatform(f.platform))

  const today = new Date().toISOString().split('T')[0] as string
  const fundMetrics = []

  for (const fund of funds) {
    const trades = entriesToTrades(fund.entries)
    const dividends = entriesToDividends(fund.entries)
    const expenses = entriesToExpenses(fund.entries)
    const latest = getLatestEquity(fund.entries)

    const isCashFund = fund.config.fund_type === 'cash'
    const isDerivativesFund = fund.config.fund_type === 'derivatives'
    const latestEntry = fund.entries[fund.entries.length - 1]

    // Use actual fund_size from latest entry instead of config
    const actualFundSize = latestEntry?.fund_size ?? fund.config.fund_size_usd
    const configWithActualFundSize = { ...fund.config, fund_size_usd: actualFundSize }

    let state = null
    if (isDerivativesFund && fund.entries.length > 0) {
      // For derivatives, compute derivatives state and map to FundState-compatible object
      const contractMultiplier = fund.config.contract_multiplier ?? 0.01
      const maintenanceMarginRate = fund.config.maintenance_margin_rate ?? 0.20
      const initialMarginRate = fund.config.initial_margin_rate ?? 0.25
      const derivStates = computeDerivativesEntriesState(fund.entries, contractMultiplier, maintenanceMarginRate, undefined, initialMarginRate)
      const lastState = derivStates[derivStates.length - 1]

      if (lastState) {
        // Map derivatives state to FundState for metrics calculation
        // For derivatives: equity is the "value", costBasis is "start_input", realized + unrealized is gain
        state = {
          actual_value_usd: lastState.equity,
          start_input_usd: lastState.costBasis,
          realized_gains_usd: lastState.realizedPnl,
          gain_usd: lastState.unrealizedPnl + lastState.realizedPnl,
          gain_pct: lastState.costBasis > 0
            ? (lastState.unrealizedPnl + lastState.realizedPnl) / lastState.costBasis
            : 0,
          expected_target_usd: lastState.equity,
          target_diff_usd: 0,
          cash_interest_usd: lastState.sumInterest,
          cash_available_usd: lastState.marginBalance - lastState.costBasis
        }
      }
    } else {
      // For cash and stock/crypto funds, use the original logic
      const latestValue = isCashFund && latestEntry?.cash !== undefined
        ? latestEntry.cash
        : latest?.value

      if (latest && latestValue !== undefined) {
        state = computeFundState(
          configWithActualFundSize,
          trades,
          [],
          dividends,
          expenses,
          latestValue,
          latest.date
        )

        // For cash funds, override computed interest with actual cash_interest values from entries
        if (isCashFund && state) {
          const actualCashInterest = entriesToCashInterest(fund.entries)
          state.cash_interest_usd = actualCashInterest
          state.realized_gains_usd = actualCashInterest
          state.start_input_usd = state.actual_value_usd - actualCashInterest
          state.gain_usd = actualCashInterest
          state.gain_pct = state.start_input_usd > 0 ? actualCashInterest / state.start_input_usd : 0
        }
      }
    }

    const cashFlows = isCashFund ? entriesToCashFlows(fund.entries) : undefined
    const metrics = computeFundMetrics(
      fund.id,
      fund.platform,
      fund.ticker,
      configWithActualFundSize,
      trades,
      state,
      today,
      cashFlows
    )

    // Override with values from computeFundFinalMetrics which correctly handles
    // accumulate mode, pre-action entry values, and compound interest APY
    const finalMetrics = computeFundFinalMetrics(fund)
    metrics.realizedAPY = finalMetrics.realizedApy
    metrics.liquidAPY = finalMetrics.liquidApy
    metrics.realizedGains = finalMetrics.realized
    metrics.unrealizedGains = finalMetrics.unrealized
    metrics.currentValue = finalMetrics.currentValue

    // Recompute derived fields that depend on the overridden values
    metrics.gainUsd = isCashFund ? metrics.realizedGains : metrics.unrealizedGains
    metrics.gainPct = metrics.startInput > 0 ? metrics.gainUsd / metrics.startInput : 0
    metrics.projectedAnnualReturn = metrics.currentValue * metrics.realizedAPY

    fundMetrics.push(metrics)
  }

  // Compute portfolioDays from earliest first entry to latest last entry
  let earliestDate: string | undefined
  let latestDate: string | undefined
  for (const fund of funds) {
    if (fund.entries.length === 0) continue
    const sorted = [...fund.entries].sort((a, b) => a.date.localeCompare(b.date))
    const first = sorted[0]!.date
    const last = sorted[sorted.length - 1]!.date
    if (!earliestDate || first < earliestDate) earliestDate = first
    if (!latestDate || last > latestDate) latestDate = last
  }
  const portfolioDays = earliestDate && latestDate
    ? Math.max(1, Math.floor((new Date(latestDate).getTime() - new Date(earliestDate).getTime()) / (24 * 60 * 60 * 1000)))
    : undefined

  const aggregate = computeAggregateMetrics(fundMetrics, portfolioDays)
  res.json(aggregate)
})

/**
 * GET /funds/actionable - Get funds that are due for action
 * Returns funds where days since last entry >= interval_days
 * Sorted by priority (most overdue first)
 * Query params:
 *   - include_test: 'true' to include test platform funds (default: false)
 */
fundsRouter.get('/actionable', async (req, res, next) => {
  const allFunds = await readAllFunds(FUNDS_DIR).catch(next)
  if (!allFunds) return

  const includeTest = req.query.include_test === 'true'
  const funds = includeTest
    ? allFunds.filter(f => isTestPlatform(f.platform))
    : allFunds.filter(f => !isTestPlatform(f.platform))

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const actionableFunds = funds
    .filter(f => {
      // Skip closed funds
      if (f.config.status === 'closed') return false
      // Skip cash and derivatives funds - they don't use interval-based trading recommendations
      const fundType = f.config.fund_type ?? 'stock'
      if (fundType === 'cash' || fundType === 'derivatives') return false
      // Must have at least one entry
      if (f.entries.length === 0) return false
      return true
    })
    .map(f => {
      // Entries are stored in chronological order (appended to TSV files)
      const latestEntry = f.entries[f.entries.length - 1]
      const latestDate = latestEntry ? parseLocalDate(latestEntry.date) : null

      const daysSinceLastEntry = latestDate
        ? Math.floor((today.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24))
        : Infinity

      const intervalDays = f.config.interval_days ?? 7
      const daysOverdue = daysSinceLastEntry - intervalDays

      return {
        id: f.id,
        platform: f.platform,
        ticker: f.ticker,
        fundType: f.config.fund_type ?? 'stock',
        intervalDays,
        daysSinceLastEntry,
        daysOverdue,
        lastEntryDate: latestEntry?.date ?? null
      }
    })
    .filter(f => f.daysOverdue >= 0)  // Only include funds that are due or overdue
    .sort((a, b) => b.daysOverdue - a.daysOverdue)  // Most overdue first

  res.json({
    actionableFunds,
    count: actionableFunds.length,
    asOf: today.toISOString().split('T')[0]
  })
})

/**
 * GET /funds/history - Get historical aggregate metrics for charting
 * Returns time-series data for all funds
 * Query params:
 *   - include_test: 'true' to include test platform funds (default: false)
 */
fundsRouter.get('/history', async (req, res, next) => {
  const allFunds = await readAllFunds(FUNDS_DIR).catch(next)
  if (!allFunds) return

  const includeTest = req.query.include_test === 'true'
  const funds = includeTest
    ? allFunds.filter(f => isTestPlatform(f.platform))
    : allFunds.filter(f => !isTestPlatform(f.platform))

  // Pre-compute derivatives state for each derivatives fund
  // This gives us per-entry equity values
  const derivativesStateByFund = new Map<string, Map<string, { equity: number, costBasis: number, marginBalance: number, availableFunds: number, realizedPnl: number, unrealizedPnl: number, sumInterest: number }>>()
  for (const fund of funds) {
    if (fund.config.fund_type === 'derivatives' && fund.entries.length > 0) {
      const contractMultiplier = fund.config.contract_multiplier ?? 0.01
      const maintenanceMarginRate = fund.config.maintenance_margin_rate ?? 0.20
      const initialMarginRate = fund.config.initial_margin_rate ?? 0.25
      const derivStates = computeDerivativesEntriesState(fund.entries, contractMultiplier, maintenanceMarginRate, undefined, initialMarginRate)
      const dateMap = new Map<string, { equity: number, costBasis: number, marginBalance: number, availableFunds: number, realizedPnl: number, unrealizedPnl: number, sumInterest: number }>()
      for (const entry of derivStates) {
        dateMap.set(entry.date, {
          equity: entry.equity,
          costBasis: entry.costBasis,
          marginBalance: entry.marginBalance,
          availableFunds: entry.availableFunds,
          realizedPnl: entry.realizedPnl,
          unrealizedPnl: entry.unrealizedPnl,
          sumInterest: entry.sumInterest
        })
      }
      derivativesStateByFund.set(fund.id, dateMap)
    }
  }

  // Collect all unique dates across all funds
  const allDates = new Set<string>()
  for (const fund of funds) {
    for (const entry of fund.entries) {
      allDates.add(entry.date)
    }
  }
  const sortedDates = Array.from(allDates).sort()

  // Find the earliest fund start date for APY calculations (minimum entry date across all funds)
  const earliestStartDate = funds.reduce((earliest, fund) => {
    for (const entry of fund.entries) {
      if (!earliest || entry.date < earliest) earliest = entry.date
    }
    return earliest
  }, '' as string)

  // Build time series data
  interface TimeSeriesPoint {
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
    fundBreakdown: Record<string, number>  // Per-fund breakdown of fund sizes
  }

  const timeSeries: TimeSeriesPoint[] = []

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
    let totalGainUsd = 0  // Track gain per-fund (handles cash funds properly)
    const fundBreakdown: Record<string, number> = {}

    for (const fund of funds) {
      // Find the latest entry on or before this date
      const entriesUpToDate = fund.entries.filter(e => e.date <= date)
      if (entriesUpToDate.length === 0) continue

      const latestEntry = entriesUpToDate[entriesUpToDate.length - 1]
      if (!latestEntry) continue

      const isDerivativesFund = fund.config.fund_type === 'derivatives'
      const isCashFund = fund.config.fund_type === 'cash'

      // Use engine functions to compute fund state at this historical date
      // This ensures DRY - same calculations as aggregate endpoint
      if (isDerivativesFund) {
        const derivDateMap = derivativesStateByFund.get(fund.id)
        // Find the latest derivatives state on or before this date
        let derivValue = 0
        let derivCostBasis = 0
        let derivAvailableFunds = 0
        let derivRealizedPnl = 0
        let derivUnrealizedPnl = 0
        let derivSumInterest = 0
        if (derivDateMap) {
          for (const entry of entriesUpToDate) {
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
        // realizedPnl already includes funding, interest, rebates, and fees
        totalRealizedGain += derivRealizedPnl
        totalUnrealizedGain += derivUnrealizedPnl
        totalCashInterest += derivSumInterest
        totalCash += Math.max(0, derivAvailableFunds)
        fundBreakdown[fund.id] = derivValue
        // Derivatives liquid gain = realized P&L + unrealized P&L
        totalGainUsd += derivRealizedPnl + derivUnrealizedPnl
      } else {
        // For cash and trading funds, use engine's computeFundState
        const trades = entriesToTrades(entriesUpToDate)
        const dividends = entriesToDividends(entriesUpToDate)
        const expenses = entriesToExpenses(entriesUpToDate)

        // Get the equity value at this date
        const equityValue = isCashFund && latestEntry.cash !== undefined
          ? latestEntry.cash
          : latestEntry.value

        // Compute state using engine (same as aggregate endpoint)
        const actualFundSize = latestEntry.fund_size ?? fund.config.fund_size_usd
        const configWithActualFundSize = { ...fund.config, fund_size_usd: actualFundSize }
        const state = computeFundState(
          configWithActualFundSize,
          trades,
          [],
          dividends,
          expenses,
          equityValue,
          date
        )

        // For cash funds, override computed interest with actual cash_interest values from entries
        if (isCashFund) {
          const actualCashInterest = entriesToCashInterest(entriesUpToDate)
          state.cash_interest_usd = actualCashInterest
          state.realized_gains_usd = actualCashInterest
          state.start_input_usd = state.actual_value_usd - actualCashInterest
          state.gain_usd = actualCashInterest
          state.gain_pct = state.start_input_usd > 0 ? actualCashInterest / state.start_input_usd : 0
        }

        // Use actual_value_usd and start_input_usd from state (same as aggregate endpoint)
        totalValue += state.actual_value_usd
        totalStartInput += state.start_input_usd
        totalRealizedGain += state.realized_gains_usd
        totalCashInterest += state.cash_interest_usd
        totalFundSize += actualFundSize
        fundBreakdown[fund.id] = actualFundSize

        // For gain calculation, match computeFundMetrics logic:
        // Cash funds: gain = interest earned (realized only, not full balance)
        // Trading funds: gain = actual_value - start_input (total liquid gain)
        const fundGain = isCashFund ? state.realized_gains_usd : state.gain_usd
        totalGainUsd += fundGain

        // Unrealized gain for trading funds: total gain minus realized
        // Cash funds have no unrealized (all gains are realized as interest)
        if (!isCashFund) {
          totalUnrealizedGain += state.gain_usd - state.realized_gains_usd
        }

        // Expected target for trading funds with target_apy
        // Cash funds don't have target APY concept
        if (!isCashFund && fund.config.target_apy > 0) {
          const expectedTarget = computeExpectedTarget(fund.config, trades, date)
          totalExpectedTarget += expectedTarget
        }

        // Track dividends and expenses for display
        for (const entry of entriesUpToDate) {
          if (entry.dividend) totalDividends += Math.abs(entry.dividend)
          if (entry.expense) totalExpenses += Math.abs(entry.expense)
        }

        // Cash: use entry's cash field directly
        const cash = isCashFund
          ? (latestEntry.cash ?? latestEntry.value)
          : (latestEntry.cash ?? 0)
        totalCash += cash
      }

      // Margin borrowed
      if (latestEntry.margin_borrowed) {
        totalMarginBorrowed += latestEntry.margin_borrowed
      }

      // Margin access
      if (fund.config.margin_access_usd) {
        totalMarginAccess += fund.config.margin_access_usd
      }
    }

    // For chart display, use totalValue - totalStartInput to match aggregate endpoint
    // This is the "liquid gain if you sold everything" metric
    const totalGainUsdForChart = totalValue - totalStartInput
    const totalGainPct = totalStartInput > 0 ? totalGainUsdForChart / totalStartInput : 0

    // Calculate days active from earliest fund start date for proper annualization
    const daysActive = earliestStartDate
      ? Math.max(1, Math.floor((new Date(date).getTime() - new Date(earliestStartDate).getTime()) / (24 * 60 * 60 * 1000)))
      : 1

    // For APY calculation, use totalStartInput as base (cost basis of invested capital)
    // This prevents inflated APY from cash fund balances (which have startInput = 0)
    // Use a minimum base to prevent divide-by-small-number issues in early data
    const apyBase = Math.max(totalStartInput, totalFundSize * 0.1)

    // Realized APY: annualized return on invested capital
    const realizedAPY = apyBase > 0 && daysActive > 0
      ? (totalRealizedGain / apyBase) * (365 / daysActive)
      : 0

    // Liquid APY: annualized total gain on invested capital
    // Use per-fund accumulated gain (totalGainUsd) which handles cash funds properly
    const liquidAPY = apyBase > 0 && daysActive > 0
      ? (totalGainUsd / apyBase) * (365 / daysActive)
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
      totalGainUsd: totalGainUsdForChart,  // Use totalValue - totalStartInput to match aggregate
      totalGainPct,
      fundBreakdown
    })
  }

  // Calculate current allocation data for pie charts
  interface AllocationData {
    id: string
    ticker: string
    platform: string
    value: number
    cash: number
    fundSize: number
    marginAccess: number
    marginBorrowed: number
  }

  const currentAllocations: AllocationData[] = []
  let totalCurrentValue = 0
  let totalCurrentCash = 0
  let totalCurrentMarginAccess = 0
  let totalCurrentMarginBorrowed = 0

  for (const fund of funds) {
    const latest = fund.entries[fund.entries.length - 1]
    if (!latest) continue

    const isDerivativesFund = fund.config.fund_type === 'derivatives'

    let value = latest.value
    let cash = 0
    let fundSize = latest.fund_size ?? fund.config.fund_size_usd

    if (isDerivativesFund) {
      // Use computed derivatives equity and available funds
      const derivDateMap = derivativesStateByFund.get(fund.id)
      if (derivDateMap) {
        const state = derivDateMap.get(latest.date)
        if (state) {
          value = state.equity
          fundSize = state.equity  // Use equity as fund size for derivatives
          cash = Math.max(0, state.availableFunds)  // Available margin (not locked)
        }
      }
    } else {
      // Cash: use entry's cash field directly
      // For cash funds, cash field = balance; for others, only count if explicitly set
      const isCashFund = fund.config.fund_type === 'cash'
      cash = isCashFund
        ? (latest.cash ?? latest.value)
        : (latest.cash ?? 0)
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

    totalCurrentValue += value
    totalCurrentCash += cash

    if (fund.config.margin_access_usd) {
      totalCurrentMarginAccess += fund.config.margin_access_usd
    }
    if (latest.margin_borrowed) {
      totalCurrentMarginBorrowed += latest.margin_borrowed
    }
  }

  // Compute aggregate metrics using the same engine functions as /aggregate endpoint
  // This ensures consistent values for current gains
  const today = new Date().toISOString().split('T')[0] as string
  const fundMetricsForAggregate = []

  for (const fund of funds) {
    const trades = entriesToTrades(fund.entries)
    const dividends = entriesToDividends(fund.entries)
    const expenses = entriesToExpenses(fund.entries)
    const latest = getLatestEquity(fund.entries)

    const isCashFund = fund.config.fund_type === 'cash'
    const isDerivativesFund = fund.config.fund_type === 'derivatives'
    const latestEntry = fund.entries[fund.entries.length - 1]

    const actualFundSize = latestEntry?.fund_size ?? fund.config.fund_size_usd
    const configWithActualFundSize = { ...fund.config, fund_size_usd: actualFundSize }

    let state = null
    if (isDerivativesFund && fund.entries.length > 0) {
      const derivDateMap = derivativesStateByFund.get(fund.id)
      if (derivDateMap && latestEntry) {
        const lastState = derivDateMap.get(latestEntry.date)
        if (lastState) {
          state = {
            actual_value_usd: lastState.equity,
            start_input_usd: lastState.costBasis,
            realized_gains_usd: lastState.realizedPnl,
            gain_usd: (lastState.equity - lastState.costBasis) + lastState.realizedPnl,
            gain_pct: lastState.costBasis > 0
              ? ((lastState.equity - lastState.costBasis) + lastState.realizedPnl) / lastState.costBasis
              : 0,
            expected_target_usd: lastState.equity,
            target_diff_usd: 0,
            cash_interest_usd: lastState.sumInterest,
            cash_available_usd: lastState.marginBalance - lastState.costBasis
          }
        }
      }
    } else {
      const latestValue = isCashFund && latestEntry?.cash !== undefined
        ? latestEntry.cash
        : latest?.value

      if (latest && latestValue !== undefined) {
        state = computeFundState(
          configWithActualFundSize,
          trades,
          [],
          dividends,
          expenses,
          latestValue,
          latest.date
        )

        // For cash funds, override computed interest with actual cash_interest values from entries
        if (isCashFund && state) {
          const actualCashInterest = entriesToCashInterest(fund.entries)
          state.cash_interest_usd = actualCashInterest
          state.realized_gains_usd = actualCashInterest
          state.start_input_usd = state.actual_value_usd - actualCashInterest
          state.gain_usd = actualCashInterest
          state.gain_pct = state.start_input_usd > 0 ? actualCashInterest / state.start_input_usd : 0
        }
      }
    }

    const cashFlowsForMetrics = isCashFund ? entriesToCashFlows(fund.entries) : undefined
    const metrics = computeFundMetrics(
      fund.id,
      fund.platform,
      fund.ticker,
      configWithActualFundSize,
      trades,
      state,
      today,
      cashFlowsForMetrics
    )

    // Override with values from computeFundFinalMetrics which correctly handles
    // accumulate mode, pre-action entry values, and compound interest APY
    const finalMetrics = computeFundFinalMetrics(fund)
    metrics.realizedAPY = finalMetrics.realizedApy
    metrics.liquidAPY = finalMetrics.liquidApy
    metrics.realizedGains = finalMetrics.realized
    metrics.unrealizedGains = finalMetrics.unrealized
    metrics.currentValue = finalMetrics.currentValue

    // Recompute derived fields that depend on the overridden values
    metrics.gainUsd = isCashFund ? metrics.realizedGains : metrics.unrealizedGains
    metrics.gainPct = metrics.startInput > 0 ? metrics.gainUsd / metrics.startInput : 0
    metrics.projectedAnnualReturn = metrics.currentValue * metrics.realizedAPY

    fundMetricsForAggregate.push(metrics)
  }

  // Compute portfolioDays from earliest first entry to latest last entry
  let histEarliestDate: string | undefined
  let histLatestDate: string | undefined
  for (const fund of funds) {
    if (fund.entries.length === 0) continue
    const sorted = [...fund.entries].sort((a, b) => a.date.localeCompare(b.date))
    const first = sorted[0]!.date
    const last = sorted[sorted.length - 1]!.date
    if (!histEarliestDate || first < histEarliestDate) histEarliestDate = first
    if (!histLatestDate || last > histLatestDate) histLatestDate = last
  }
  const histPortfolioDays = histEarliestDate && histLatestDate
    ? Math.max(1, Math.floor((new Date(histLatestDate).getTime() - new Date(histEarliestDate).getTime()) / (24 * 60 * 60 * 1000)))
    : undefined

  const aggregate = computeAggregateMetrics(fundMetricsForAggregate, histPortfolioDays)

  res.json({
    timeSeries,
    currentAllocations,
    totals: {
      totalCurrentValue,
      totalCurrentCash,
      totalCurrentMarginAccess,
      totalCurrentMarginBorrowed
    },
    aggregateTotals: {
      totalGainUsd: aggregate.totalGainUsd,
      totalRealizedGains: aggregate.totalRealizedGains,
      totalValue: aggregate.totalValue,
      totalStartInput: aggregate.totalStartInput
    }
  })
})

/**
 * GET /funds/:id - Get fund details with all entries
 */
fundsRouter.get('/:id', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }
  res.json(fund)
})

/**
 * GET /funds/:id/state - Get computed state and recommendation
 * Query params:
 *   - markPrice: Optional current market price for live calculations (derivatives funds)
 */
fundsRouter.get('/:id/state', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const markPriceStr = typeof req.query.markPrice === 'string' ? req.query.markPrice : undefined
  const markPrice = markPriceStr ? parseFloat(markPriceStr) : undefined
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  const trades = entriesToTrades(fund.entries)
  const dividends = entriesToDividends(fund.entries)
  const expenses = entriesToExpenses(fund.entries)

  // Get the full latest entry (not just equity)
  const latestEntry = fund.entries.length > 0 ? fund.entries[fund.entries.length - 1] : null

  if (!latestEntry) {
    // For funds with no entries, return initial state based on fund_size
    const initialState = fund.config.fund_size_usd > 0 ? {
      fund_size_usd: fund.config.fund_size_usd,
      equity_usd: fund.config.fund_size_usd,
      cash_available_usd: fund.config.fund_size_usd,
      invested_usd: 0,
      realized_gains_usd: 0,
      unrealized_gains_usd: 0,
      total_gains_usd: 0,
      total_roi_pct: 0,
      margin_borrowed_usd: 0,
      equity_pct: 100
    } : null

    return res.json({
      fund,
      state: initialState,
      recommendation: null,
      closedMetrics: null,
      margin_available: 0,
      cash_available: fund.config.fund_size_usd,
      message: initialState ? 'Initial state' : 'No entries yet'
    })
  }

  // Use actual fund_size from latest entry instead of config
  const actualFundSize = latestEntry.fund_size ?? fund.config.fund_size_usd
  const configWithActualFundSize = { ...fund.config, fund_size_usd: actualFundSize }

  // Calculate invested amount (total buys - total sells, accounting for full liquidations)
  let _totalBuys = 0
  let _totalSells = 0
  let sumShares = 0
  const hasShareTracking = fund.entries.some(e => e.shares !== undefined && e.shares !== 0)
  const sortedEntries = [...fund.entries].sort((a, b) => a.date.localeCompare(b.date))

  for (const entry of sortedEntries) {
    // Track shares for full liquidation detection
    if (entry.shares) {
      const sharesAbs = Math.abs(entry.shares)
      sumShares += entry.action === 'SELL' ? -sharesAbs : sharesAbs
    }

    if (entry.action === 'BUY' && entry.amount) {
      _totalBuys += entry.amount
    } else if (entry.action === 'SELL' && entry.amount) {
      // Check for full liquidation
      // Only use value-based liquidation when value > 0 (value=0 means
      // "unknown" for imported entries, not "position is worthless")
      const isFullLiquidation = hasShareTracking
        ? Math.abs(sumShares) < 0.0001
        : entry.value > 0 && entry.value <= entry.amount + 0.01

      if (isFullLiquidation) {
        // Reset on full liquidation
        _totalBuys = 0
        _totalSells = 0
        sumShares = 0
      } else {
        _totalSells += entry.amount
      }
    }
  }

  const manageCash = fund.config.manage_cash ?? true
  const isDerivativesFund = fund.config.fund_type === 'derivatives'

  // For derivatives funds, compute state differently (don't use computeFundState)
  let state
  if (isDerivativesFund) {
    const contractMultiplier = fund.config.contract_multiplier ?? 0.01
    const maintenanceMarginRate = fund.config.maintenance_margin_rate ?? 0.20
    const initialMarginRate = fund.config.initial_margin_rate ?? 0.25
    const derivStates = computeDerivativesEntriesState(fund.entries, contractMultiplier, maintenanceMarginRate, undefined, initialMarginRate)
    const lastState = derivStates[derivStates.length - 1]

    if (lastState) {
      // Add dividends and subtract expenses (funding payments via dividend/expense fields in HOLD entries)
      const totalDividends = dividends.reduce((sum, d) => sum + d.amount_usd, 0)
      const totalExpenses = expenses.reduce((sum, e) => sum + e.amount_usd, 0)
      // Get actual cash interest from entries (not from sumInterest which is for INTEREST actions)
      const actualCashInterest = entriesToCashInterest(fund.entries)

      // Realized P&L includes: trading P&L + dividends - expenses + cash interest
      const adjustedRealizedPnl = lastState.realizedPnl + totalDividends - totalExpenses + actualCashInterest

      // For derivatives: actual_value_usd represents current position value (notional), not total equity
      // Current position value = cost basis + unrealized P&L
      const currentPositionValue = lastState.costBasis + lastState.unrealizedPnl

      state = {
        actual_value_usd: currentPositionValue,
        start_input_usd: lastState.costBasis,
        realized_gains_usd: adjustedRealizedPnl,
        gain_usd: lastState.unrealizedPnl + adjustedRealizedPnl,
        gain_pct: lastState.costBasis > 0
          ? (lastState.unrealizedPnl + adjustedRealizedPnl) / lastState.costBasis
          : 0,
        expected_target_usd: currentPositionValue,
        target_diff_usd: 0,
        cash_interest_usd: actualCashInterest,
        // Cash available = margin balance - locked margin - expenses + dividends + interest
        cash_available_usd: lastState.marginBalance - lastState.costBasis - totalExpenses + totalDividends + actualCashInterest
      }
    } else {
      // No state computed - provide default empty state
      state = {
        actual_value_usd: 0,
        start_input_usd: 0,
        realized_gains_usd: 0,
        gain_usd: 0,
        gain_pct: 0,
        expected_target_usd: 0,
        target_diff_usd: 0,
        cash_interest_usd: 0,
        cash_available_usd: 0
      }
    }
  } else {
    // For non-derivatives funds, use computeFundState
    state = computeFundState(
      configWithActualFundSize,
      trades,
      [],  // cashflows not stored in entries
      dividends,
      expenses,
      latestEntry.value,
      latestEntry.date
    )
  }

  // For cash funds, override computed interest with actual cash_interest values from entries
  if (fund.config.fund_type === 'cash' && state) {
    const actualCashInterest = entriesToCashInterest(fund.entries)
    const expenses = entriesToExpenses(fund.entries)
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount_usd, 0)
    // Recalculate all gain-related fields to be consistent with explicit cash_interest values
    // Realized gains = interest - expenses
    state.cash_interest_usd = actualCashInterest
    state.realized_gains_usd = actualCashInterest - totalExpenses
    state.start_input_usd = state.actual_value_usd - (actualCashInterest - totalExpenses)
    state.gain_usd = actualCashInterest - totalExpenses
    state.gain_pct = state.start_input_usd > 0 ? (actualCashInterest - totalExpenses) / state.start_input_usd : 0
  }

  // Calculate post-action cash (cash available AFTER the latest entry's action)
  // Entry.cash is pre-action cash; we need to adjust for the action taken
  let cashAvailable: number
  let cashSource: string | null = null  // Track where cash comes from
  if (!manageCash) {
    // Fund doesn't manage its own cash - look up platform cash fund
    const cashFundId = fund.config.cash_fund ?? `${fund.platform.toLowerCase()}-cash`
    const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)

    // Try to read the platform cash fund
    const cashFundData = await readFund(cashFundPath).catch(() => null)
    if (cashFundData && cashFundData.entries.length > 0) {
      // Calculate cash balance from the cash fund
      const cashFundLatest = cashFundData.entries[cashFundData.entries.length - 1]
      // Use 'cash' field (post-action balance) for current available cash
      cashAvailable = cashFundLatest?.cash ?? cashFundLatest?.value ?? 0
      cashSource = cashFundId
    } else {
      // No platform cash fund found - fall back to 0
      cashAvailable = 0
    }
  } else if (latestEntry.cash !== undefined && latestEntry.cash !== null) {
    // Manual tracked cash - adjust for the action to get post-action cash
    let postActionCash = latestEntry.cash
    if (latestEntry.action === 'BUY' && latestEntry.amount) {
      postActionCash = latestEntry.cash - latestEntry.amount
    } else if (latestEntry.action === 'SELL' && latestEntry.amount) {
      postActionCash = latestEntry.cash + latestEntry.amount
    }
    cashAvailable = Math.max(0, postActionCash)
  } else {
    // Latest entry has no cash - look back to find most recent entry with cash
    // then apply subsequent actions to compute current cash
    let foundCash: number | null = null
    let foundIdx = -1
    for (let i = sortedEntries.length - 1; i >= 0; i--) {
      const entry = sortedEntries[i]
      if (entry && entry.cash !== undefined && entry.cash !== null) {
        foundCash = entry.cash
        foundIdx = i
        break
      }
    }

    if (foundCash !== null) {
      // Apply the action from the entry where we found cash, plus all subsequent entries
      let runningCash = foundCash
      for (let i = foundIdx; i < sortedEntries.length; i++) {
        const entry = sortedEntries[i]
        if (!entry) continue
        // Apply action to cash
        if (entry.action === 'BUY' && entry.amount) {
          runningCash -= entry.amount
        } else if (entry.action === 'SELL' && entry.amount) {
          runningCash += entry.amount
        }
        // Add cash interest if present
        if (entry.cash_interest) {
          runningCash += entry.cash_interest
        }
      }
      cashAvailable = Math.max(0, runningCash)
    } else {
      // No tracked cash found - use engine's computed value
      cashAvailable = state.cash_available_usd
    }
  }

  // Get margin info from the appropriate source
  let marginAvailable = 0
  let marginBorrowed = 0
  if (!manageCash && cashSource) {
    // For trading funds, get margin from the cash fund
    const cashFundPath = join(FUNDS_DIR, `${cashSource}.tsv`)
    const cashFundData = await readFund(cashFundPath).catch(() => null)
    if (cashFundData && cashFundData.entries.length > 0) {
      const cashFundLatest = cashFundData.entries[cashFundData.entries.length - 1]
      marginAvailable = cashFundLatest?.margin_available ?? 0
      marginBorrowed = cashFundLatest?.margin_borrowed ?? 0
    }
  } else {
    // For cash funds or funds managing their own cash, get from latest entry
    marginAvailable = latestEntry.margin_available ?? 0
    marginBorrowed = latestEntry.margin_borrowed ?? 0
  }

  const correctedState: FundState = { ...state, cash_available_usd: cashAvailable }

  // Skip recommendation for cash funds and derivatives funds - they don't need trading recommendations
  const isCashFund = fund.config.fund_type === 'cash'
  // For recommendation, use POST-action equity (after SELL, equity is reduced)
  const postActionEquity = computePostActionEquity(latestEntry)

  // For M1 platform with margin enabled, add margin_available to cash for recommendation calculation
  let effectiveCash = cashAvailable
  const platformId = fund.platform.toLowerCase()
  if (platformId === 'm1' && fund.config.margin_enabled) {
    effectiveCash = cashAvailable + marginAvailable
  }

  const stateForRecommendation: FundState = { ...correctedState, actual_value_usd: postActionEquity, cash_available_usd: effectiveCash }
  const recommendation = (isCashFund || isDerivativesFund) ? null : computeRecommendation(configWithActualFundSize, stateForRecommendation)

  // Compute closed fund metrics if fund is closed
  let closedMetrics = null
  const isClosed = fund.config.status === 'closed'
  if (isClosed && fund.entries.length > 0) {
    const firstEntry = fund.entries[0]
    const lastEntry = fund.entries[fund.entries.length - 1]
    if (firstEntry && lastEntry) {
      const cashInterest = entriesToCashInterest(fund.entries)

      closedMetrics = computeClosedFundMetrics(
        trades,
        dividends,
        expenses,
        cashInterest,
        firstEntry.date,
        lastEntry.date
      )
    }
  }

  // Compute derivatives state for derivatives funds
  let derivativesEntriesState = null

  if (isDerivativesFund) {
    const contractMultiplier = fund.config.contract_multiplier ?? 0.01
    const maintenanceMarginRate = fund.config.maintenance_margin_rate ?? 0.20
    const initialMarginRate = fund.config.initial_margin_rate ?? 0.25

    // Unrealized P&L is calculated at each entry using the BTC price at that snapshot
    // (derived from the trade price: btcPrice = contractPrice / contractMultiplier)
    // If markPrice is provided, the final entry will use it for live calculations
    derivativesEntriesState = computeDerivativesEntriesState(
      fund.entries,
      contractMultiplier,
      maintenanceMarginRate,
      markPrice,
      initialMarginRate
    )
  }

  res.json({
    fund: { id: fund.id, platform: fund.platform, ticker: fund.ticker, config: fund.config },
    state: correctedState,
    recommendation,
    closedMetrics,
    margin_available: marginAvailable,
    margin_borrowed: marginBorrowed,
    cash_available: cashAvailable,
    cash_source: cashSource,  // null if from own fund, fund ID if from shared cash fund
    fund_size: actualFundSize,
    derivativesEntriesState  // Computed derivatives state (only for derivatives funds)
  })
})

/**
 * POST /funds - Create a new fund
 *
 * Auto-creates a platform cash fund if one doesn't exist.
 * Trading funds are automatically set to manage_cash=false since
 * cash is managed at the platform level.
 */
fundsRouter.post('/', async (req, res, next) => {
  const { platform, ticker, config, initialEntry } = req.body as {
    platform: string
    ticker: string
    config: FundData['config']
    initialEntry?: FundEntry
  }

  if (!platform) return next(badRequest('platform is required'))
  if (!ticker) return next(badRequest('ticker is required'))
  if (!config) return next(badRequest('config is required'))

  const platformId = platform.toLowerCase()
  const tickerLower = ticker.toLowerCase()
  const id = `${platformId}-${tickerLower}`
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  // Check if fund already exists (prevent duplicate tickers on same platform)
  if (existsSync(filePath)) {
    return next(badRequest(`Fund with ticker '${tickerLower}' already exists on platform '${platformId}'`))
  }

  // Check if this is a cash fund being created
  const isCashFund = config.fund_type === 'cash' || tickerLower === 'cash'

  // If creating a trading fund, auto-create cash fund if it doesn't exist
  let cashFundCreated = false
  if (!isCashFund) {
    const cashFundId = `${platformId}-cash`
    const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)

    if (!existsSync(cashFundPath)) {
      // Get or create platform config
      const platformsData = await readPlatformsData()
      const platformConfig = platformsData[platformId] ?? { name: platform }

      // Set platform to manage cash at platform level with auto-sync enabled
      platformConfig.manage_cash = true
      platformConfig.auto_sync_cash = true
      platformsData[platformId] = platformConfig
      await writePlatformsData(platformsData)

      // Create the cash fund
      const cashFundConfig: FundData['config'] = {
        fund_type: 'cash',
        status: 'active',
        fund_size_usd: 0,
        target_apy: 0.04,
        interval_days: 1,
        input_min_usd: 0,
        input_mid_usd: 0,
        input_max_usd: 0,
        max_at_pct: 0,
        min_profit_usd: 0,
        cash_apy: 0.04,
        margin_apr: 0,
        margin_access_usd: 0,
        accumulate: true,
        manage_cash: true
      }

      const cashFundData: FundData = {
        id: cashFundId,
        platform: platformId,
        ticker: 'cash',
        config: cashFundConfig,
        entries: []
      }

      await writeFund(cashFundPath, cashFundData)
      cashFundCreated = true
    }

    // Trading funds default to not managing their own cash (use platform cash fund)
    // But respect explicit manage_cash=true if set
    if (config.manage_cash !== true) {
      config.manage_cash = false
    }
  }

  const fund: FundData = {
    id,
    platform,
    ticker,
    config,
    entries: initialEntry ? [initialEntry] : []
  }

  await writeFund(filePath, fund).catch(next)
  res.status(201).json({
    ...fund,
    cashFundCreated
  })
})

/**
 * PUT /funds/:id - Update fund config, platform, and/or ticker
 */
fundsRouter.put('/:id', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  const { config, platform, ticker } = req.body as {
    config?: Partial<FundData['config']>
    platform?: string
    ticker?: string
  }

  // Update config if provided
  if (config) {
    fund.config = { ...fund.config, ...config }
    // Handle clearing of optional fields (empty string means delete)
    if (config.audited === '') {
      delete fund.config.audited
    }
  }

  // Check if rename is needed (platform or ticker change)
  const newPlatform = platform ? platform.toLowerCase().replace(/[^a-z0-9-]/g, '-') : fund.platform.toLowerCase()
  const newTicker = ticker ? ticker.toLowerCase().replace(/[^a-z0-9-]/g, '-') : fund.ticker.toLowerCase()
  const needsRename = newPlatform !== fund.platform.toLowerCase() || newTicker !== fund.ticker.toLowerCase()

  if (needsRename) {
    const newId = `${newPlatform}-${newTicker}`
    const newPath = join(FUNDS_DIR, `${newId}.tsv`)
    const newConfigPath = join(FUNDS_DIR, `${newId}.json`)
    const oldConfigPath = join(FUNDS_DIR, `${id}.json`)

    if (existsSync(newPath)) {
      return next(badRequest(`Cannot rename: fund ${newId} already exists`))
    }

    // Write updated fund data first (this creates both TSV and JSON at old paths)
    await writeFund(filePath, fund).catch(next)

    // Rename both files
    await rename(filePath, newPath).catch(next)
    if (existsSync(oldConfigPath)) {
      await rename(oldConfigPath, newConfigPath).catch(next)
    }

    // Return the updated fund with new id/platform/ticker
    const renamedFund = await readFund(newPath).catch(next)
    if (!renamedFund) {
      return next(notFound('Fund after rename'))
    }

    return res.json(renamedFund)
  }

  await writeFund(filePath, fund).catch(next)
  res.json(fund)
})

/**
 * POST /funds/:id/preview - Preview recommendation for a hypothetical equity value
 */
fundsRouter.post('/:id/preview', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  const { equity_value_usd, date } = req.body as { equity_value_usd: number; date?: string }
  if (equity_value_usd === undefined) {
    return next(badRequest('equity_value_usd is required'))
  }

  const snapshotDate = date ?? new Date().toISOString().split('T')[0] as string

  // For historical dates, only consider entries on or before the snapshot date
  // Sort entries by date first
  const sortedEntries = [...fund.entries].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  )
  const entriesUpToDate = sortedEntries.filter(e => e.date <= snapshotDate)
  const precedingEntry = entriesUpToDate[entriesUpToDate.length - 1]

  const trades = entriesToTrades(entriesUpToDate)
  const dividends = entriesToDividends(entriesUpToDate)
  const expenses = entriesToExpenses(entriesUpToDate)

  // Use fund_size from preceding entry if available, otherwise from config
  const actualFundSize = precedingEntry?.fund_size ?? fund.config.fund_size_usd
  const configWithActualFundSize = { ...fund.config, fund_size_usd: actualFundSize }

  // Calculate invested amount with full liquidation reset (same as FundDetail.tsx)
  // Only consider entries up to the snapshot date
  let _totalBuys = 0
  let _totalSells = 0
  let sumShares = 0
  for (const entry of entriesUpToDate) {
    // Track shares first - BUY adds, SELL subtracts
    if (entry.shares) {
      const sharesAbs = Math.abs(entry.shares)
      sumShares += entry.action === 'SELL' ? -sharesAbs : sharesAbs
    }

    if (entry.action === 'BUY' && entry.amount) {
      _totalBuys += entry.amount
    } else if (entry.action === 'SELL' && entry.amount) {
      _totalSells += entry.amount
      // Check for full liquidation
      // Use sumShares check if fund has share tracking, otherwise fall back to value-based check
      // Only use value-based liquidation when value > 0 (value=0 means
      // "unknown" for imported entries, not "position is worthless")
      const hasShareTracking = entry.shares !== undefined && entry.shares !== 0
      const isFullLiquidation = hasShareTracking
        ? Math.abs(sumShares) < 0.0001
        : entry.value > 0 && entry.value <= entry.amount + 0.01
      if (isFullLiquidation) {
        _totalBuys = 0
        _totalSells = 0
        sumShares = 0
      }
    }
  }
  const manageCash = fund.config.manage_cash ?? true

  const state = computeFundState(
    configWithActualFundSize,
    trades,
    [],
    dividends,
    expenses,
    equity_value_usd,
    snapshotDate
  )

  // For cash funds, override computed interest with actual cash_interest values from entries
  const isCashFund = fund.config.fund_type === 'cash'
  if (isCashFund) {
    const actualCashInterest = entriesToCashInterest(entriesUpToDate)
    state.cash_interest_usd = actualCashInterest
    state.realized_gains_usd = actualCashInterest
  }

  // Calculate cash available and margin info
  let correctedCashAvailable: number
  let marginAvailable = 0

  if (!manageCash) {
    // Fund doesn't manage its own cash - look up platform cash fund
    const cashFundId = fund.config.cash_fund ?? `${fund.platform.toLowerCase()}-cash`
    const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)

    const cashFundData = await readFund(cashFundPath).catch(() => null)
    if (cashFundData && cashFundData.entries.length > 0) {
      // Get entries up to the snapshot date
      const cashEntries = cashFundData.entries
        .filter(e => e.date <= snapshotDate)
        .sort((a, b) => a.date.localeCompare(b.date))
      const cashFundLatest = cashEntries[cashEntries.length - 1]
      // Use 'cash' field (post-action balance) for current available cash
      correctedCashAvailable = cashFundLatest?.cash ?? cashFundLatest?.value ?? 0
      marginAvailable = cashFundLatest?.margin_available ?? 0
    } else {
      correctedCashAvailable = 0
    }
  } else {
    correctedCashAvailable = state.cash_available_usd
    marginAvailable = precedingEntry?.margin_available ?? 0
  }

  const correctedState = { ...state, cash_available_usd: correctedCashAvailable }

  // Skip recommendation for cash funds - they don't need trading recommendations
  // isCashFund already declared above

  // For M1 platform with margin enabled, add margin_available to cash for recommendation calculation
  let effectiveCash = correctedCashAvailable
  const platformId = fund.platform.toLowerCase()
  if (platformId === 'm1' && fund.config.margin_enabled && marginAvailable > 0) {
    effectiveCash = correctedCashAvailable + marginAvailable
  }

  const stateForRecommendation = { ...correctedState, cash_available_usd: effectiveCash }
  const recommendation = isCashFund ? null : computeRecommendation(configWithActualFundSize, stateForRecommendation)

  res.json({
    state: correctedState,
    recommendation,
    margin_available: marginAvailable,
    fund_size: actualFundSize
  })
})

/**
 * POST /funds/:id/entries - Add an entry to fund
 *
 * For trading funds, cash is managed at the platform level.
 * DEPOSIT/WITHDRAW actions should be made to the platform cash fund.
 */
fundsRouter.post('/:id/entries', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  const entry = req.body as FundEntry
  if (!entry.date) return next(badRequest('date is required'))
  if (entry.value === undefined) return next(badRequest('value is required'))

  // Enforce cash isolation for trading funds that don't manage their own cash
  const isCashFund = fund.config.fund_type === 'cash'
  const manageCashSelf = fund.config.manage_cash === true
  if (!isCashFund && !manageCashSelf) {
    // Clear cash field - trading funds that don't manage their own cash
    delete entry.cash

    // Reject DEPOSIT/WITHDRAW actions - these should go to cash fund
    if (entry.action === 'DEPOSIT' || entry.action === 'WITHDRAW') {
      const cashFundId = `${fund.platform.toLowerCase()}-cash`
      return next(badRequest(
        `Trading funds cannot have DEPOSIT/WITHDRAW actions. ` +
        `Use the cash fund (${cashFundId}) for deposits and withdrawals.`
      ))
    }
  }

  // Auto-calculate fund_size if not provided
  const manageCash = fund.config.manage_cash !== false
  if (!entry.fund_size) {
    if (!manageCash) {
      // Non-cash managing funds: fund_size = invested amount
      // Calculate invested from all entries including the new one
      const allEntries = [...fund.entries, entry].sort((a, b) =>
        new Date(a.date).getTime() - new Date(b.date).getTime()
      )
      let invested = 0
      let sumShares = 0
      for (const e of allEntries) {
        if (e.date > entry.date) break // Only consider entries up to this one
        // Track shares for liquidation detection
        if (e.shares) {
          const sharesAbs = Math.abs(e.shares)
          sumShares += e.action === 'SELL' ? -sharesAbs : sharesAbs
        }
        if (e.action === 'BUY' && e.amount) {
          invested += e.amount
        } else if (e.action === 'SELL' && e.amount) {
          invested -= e.amount
          // Check for full liquidation
          const hasShareTracking = e.shares !== undefined && e.shares !== 0
          const isFullLiquidation = hasShareTracking
            ? Math.abs(sumShares) < 0.0001
            : (e.value !== undefined && e.value > 0 && e.value <= e.amount + 0.01)
          if (isFullLiquidation) {
            invested = 0
            sumShares = 0
          }
        }
      }
      entry.fund_size = Math.max(0, invested)
    } else {
      // Cash managing funds: fund_size based on deposits/withdrawals
      const sortedEntries = [...fund.entries].sort((a, b) =>
        new Date(a.date).getTime() - new Date(b.date).getTime()
      )
      const entriesBefore = sortedEntries.filter(e => e.date < entry.date)
      const prevEntry = entriesBefore[entriesBefore.length - 1]
      // For derivatives funds, margin balance starts at 0 (not fund_size_usd)
      // fund_size_usd for derivatives represents max position size, not initial balance
      const isDerivativesFund = fund.config.fund_type === 'derivatives'
      const prevFundSize = prevEntry?.fund_size ?? (isDerivativesFund ? 0 : fund.config.fund_size_usd)

      // Check for deposit in notes (format: "Deposit: $X")
      let depositAmount = 0
      let withdrawalAmount = 0
      if (entry.notes) {
        const depositMatch = entry.notes.match(/Deposit:\s*\$?([\d.]+)/)
        if (depositMatch) depositAmount = parseFloat(depositMatch[1] ?? '0') || 0
        const withdrawalMatch = entry.notes.match(/Withdrawal:\s*\$?([\d.]+)/)
        if (withdrawalMatch) withdrawalAmount = parseFloat(withdrawalMatch[1] ?? '0') || 0
      }
      // Also check for DEPOSIT/WITHDRAW actions
      if (entry.action === 'DEPOSIT' && entry.amount) depositAmount = entry.amount
      if (entry.action === 'WITHDRAW' && entry.amount) withdrawalAmount = entry.amount

      const adjustment = depositAmount - withdrawalAmount
      if (adjustment !== 0) {
        entry.fund_size = prevFundSize + adjustment
      } else {
        // Carry forward previous fund_size
        entry.fund_size = prevFundSize
      }
    }
  }

  // For cash funds, auto-calculate value and cash from signed amount
  // Amount is signed: positive = deposit, negative = withdraw
  // DEPOSIT/WITHDRAW actions are normalized to signed amounts with HOLD action
  if (isCashFund) {
    const sortedEntries = [...fund.entries].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
    )
    const entriesBefore = sortedEntries.filter(e => e.date < entry.date)
    const prevEntry = entriesBefore[entriesBefore.length - 1]
    // Previous balance is from cash field, or value, or 0 if first entry
    const prevBalance = prevEntry?.cash ?? prevEntry?.value ?? 0

    // Normalize DEPOSIT/WITHDRAW actions to signed amounts
    if (entry.action === 'DEPOSIT' && entry.amount) {
      entry.amount = Math.abs(entry.amount)  // Ensure positive
      entry.action = 'HOLD'
    } else if (entry.action === 'WITHDRAW' && entry.amount) {
      entry.amount = -Math.abs(entry.amount)  // Ensure negative
      entry.action = 'HOLD'
    }

    // Calculate new balance from signed amount
    let newBalance = prevBalance
    if (entry.amount) {
      newBalance = prevBalance + entry.amount  // amount is signed
    }
    // Add cash interest if provided
    if (entry.cash_interest) {
      newBalance += entry.cash_interest
    }
    // Subtract expense if provided
    if (entry.expense) {
      newBalance -= entry.expense
    }

    entry.value = Math.round(newBalance * 100) / 100
    entry.cash = entry.value
    entry.fund_size = entry.value  // Cash fund size tracks the balance
  }

  // For M1 platform non-cash funds: calculate initial margin borrowed BEFORE appending entry
  // This ensures margin_borrowed is saved with the trading fund entry.
  // Note: Additional margin may be borrowed during cash auto-sync (lines ~1430-1500) if
  // multiple same-day trades cause cash to go negative. This is intentional - the initial
  // calculation here captures the shortfall for THIS trade, while auto-sync handles
  // aggregate same-day cash flow.
  if (!isCashFund && fund.platform.toLowerCase() === 'm1' && entry.action === 'BUY' && entry.amount && entry.amount > 0) {
    const cashFundId = `${fund.platform.toLowerCase()}-cash`
    const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)
    const cashFundData = await readFund(cashFundPath).catch(() => null)

    if (cashFundData && cashFundData.entries.length > 0) {
      // Get current cash balance based only on entries strictly before this trade date.
      // Same-day entries are intentionally excluded here - they'll be handled by the
      // auto-sync logic which merges same-day transactions.
      const entriesBefore = cashFundData.entries.filter(e => e.date < entry.date)
      const prevEntry = entriesBefore[entriesBefore.length - 1]
      const currentCashBalance = prevEntry?.cash ?? prevEntry?.value ?? 0

      // Get available margin from previous entry or config
      const prevMarginAvailable = prevEntry?.margin_available ?? cashFundData.config.margin_access_usd ?? 0

      // If purchase exceeds cash, calculate margin borrowed (only if margin is available)
      if (entry.amount > currentCashBalance) {
        const borrowAmount = Math.min(entry.amount - currentCashBalance, prevMarginAvailable)
        // Add to existing margin_borrowed if any, or set it
        entry.margin_borrowed = (entry.margin_borrowed ?? 0) + borrowAmount
      }
    }
  }

  await appendEntry(filePath, entry).catch(next)

  // Auto-sync to cash fund for platforms with auto_sync_cash enabled
  // (defaults to true for robinhood)
  let cashSyncResult: { action: string; amount: number; cashFundId: string; combined?: boolean } | null = null
  if (!isCashFund) {
    const platformId = fund.platform.toLowerCase()
    const platformsData = await readPlatformsData()
    const platformConfig = platformsData[platformId]
    // Default auto_sync_cash to true for robinhood
    const autoSyncCash = platformConfig?.auto_sync_cash ?? (platformId === 'robinhood')

    if (autoSyncCash) {
      const cashFundId = `${platformId}-cash`
      const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)
      const cashFundData = await readFund(cashFundPath).catch(() => null)

      if (cashFundData) {
        // Calculate the cash change from this trade
        let cashChange = 0
        let changeType: 'deposit' | 'withdraw' | null = null
        const notesParts: string[] = []

        // BUY → WITHDRAW from cash (money goes to buy assets)
        if (entry.action === 'BUY' && entry.amount && entry.amount > 0) {
          // Check if margin was borrowed (calculated before entry was appended)
          if (entry.margin_borrowed && entry.margin_borrowed > 0) {
            // Cap margin borrowed to entry amount to prevent negative cashWithdrawal
            const marginBorrowed = Math.min(entry.margin_borrowed, entry.amount)
            const cashWithdrawal = entry.amount - marginBorrowed
            cashChange = -cashWithdrawal
            notesParts.push(`Buy ${fund.ticker.toUpperCase()}${entry.shares ? ` (${entry.shares} shares)` : ''} | Margin borrowed: $${marginBorrowed.toFixed(2)}`)
          } else {
            // Normal withdrawal - no margin borrowed
            cashChange -= entry.amount
            notesParts.push(`Buy ${fund.ticker.toUpperCase()}${entry.shares ? ` (${entry.shares} shares)` : ''}`)
          }
          changeType = 'withdraw'
        }

        // SELL → DEPOSIT to cash (money comes from selling assets)
        if (entry.action === 'SELL' && entry.amount && entry.amount > 0) {
          cashChange += entry.amount
          changeType = 'deposit'
          notesParts.push(`Sell ${fund.ticker.toUpperCase()}${entry.shares ? ` (${entry.shares} shares)` : ''}`)
        }

        // Dividend → DEPOSIT to cash
        if (entry.dividend && entry.dividend > 0) {
          cashChange += entry.dividend
          if (!changeType) changeType = 'deposit'
          notesParts.push(`Dividend ${fund.ticker.toUpperCase()} $${entry.dividend.toFixed(2)}`)
        }

        // Only proceed if there's a cash change
        if (cashChange !== 0) {
          // Check if there's already an entry for the same date
          const existingEntryIndex = cashFundData.entries.findIndex(e => e.date === entry.date)
          const round2 = (n: number) => Math.round(n * 100) / 100

          if (existingEntryIndex >= 0) {
            // Update existing same-day entry - just add the signed amount
            const existingEntry = cashFundData.entries[existingEntryIndex]!
            const existingValue = existingEntry.value ?? existingEntry.cash ?? 0
            const existingAmount = existingEntry.amount ?? 0

            // Apply the change (cashChange is already signed: positive=deposit, negative=withdraw)
            let newValue = round2(existingValue + cashChange)
            let newAmount = round2(existingAmount + cashChange)
            let additionalMarginBorrowed = 0

            // For M1 platform: prevent cash from going negative by borrowing from margin
            if (platformId === 'm1' && newValue < 0) {
              const prevMarginAvailableForExisting = existingEntry.margin_available ?? 0
              // Cap the effective margin borrow to the amount that is actually available
              additionalMarginBorrowed = Math.min(-newValue, prevMarginAvailableForExisting)
              newValue = round2(newValue + additionalMarginBorrowed)  // Add what we can borrow back

              // Adjust the amount to reflect only what was withdrawn from cash.
              // When cash goes negative and margin is borrowed to cover it, the entire existing
              // cash balance is withdrawn; the margin portion funds only the shortfall.
              newAmount = round2(existingAmount - existingValue)
            }

            existingEntry.value = newValue
            existingEntry.cash = newValue
            existingEntry.fund_size = newValue
            existingEntry.amount = newAmount
            existingEntry.action = 'HOLD'

            // Update margin tracking - use user-provided value if available
            const prevMarginAvailable = existingEntry.margin_available ?? 0
            const prevMarginBorrowed = existingEntry.margin_borrowed ?? 0
            const marginBorrowedNow = (entry.margin_borrowed ?? 0) + additionalMarginBorrowed

            // If user provided margin_available in the trading fund entry, use that
            // Otherwise, calculate it (previous - borrowed)
            existingEntry.margin_available = entry.margin_available !== undefined && entry.margin_available !== null
              ? entry.margin_available
              : prevMarginAvailable - marginBorrowedNow
            existingEntry.margin_borrowed = prevMarginBorrowed + marginBorrowedNow

            // Append to notes
            const autoNote = `Auto: ${notesParts.join(', ')}`
            existingEntry.notes = existingEntry.notes
              ? `${existingEntry.notes} | ${autoNote}`
              : autoNote

            // Write updated fund data
            await writeFund(cashFundPath, cashFundData)

            cashSyncResult = {
              action: cashChange > 0 ? 'DEPOSIT' : 'WITHDRAW',
              amount: Math.abs(cashChange),
              cashFundId,
              combined: true
            }
          } else {
            // No existing entry for this date, create new one
            // Get previous cash balance (from latest entry before this date)
            const entriesBefore = cashFundData.entries.filter(e => e.date < entry.date)
            const prevEntry = entriesBefore.length > 0
              ? entriesBefore[entriesBefore.length - 1]
              : cashFundData.entries[cashFundData.entries.length - 1]
            const prevBalance = prevEntry?.cash ?? prevEntry?.value ?? 0

            // Get margin info - use user-provided value if available, otherwise calculate
            const prevMarginAvailable = prevEntry?.margin_available ?? cashFundData.config.margin_access_usd ?? 0
            const prevMarginBorrowed = prevEntry?.margin_borrowed ?? 0
            // marginBorrowedNow may already include margin from the initial calculation (lines 1329-1351)
            // which handles shortfall based on previous day's balance. This is the first phase of margin calc.
            const marginBorrowedNow = entry.margin_borrowed ?? 0

            let newBalance = round2(prevBalance + cashChange)
            let actualCashChange = cashChange
            let additionalMarginBorrowed = 0

            // For M1 platform: prevent cash from going negative by borrowing from margin
            // This is the second phase of margin calc, handling same-day aggregate cash flow.
            // additionalMarginBorrowed covers shortfalls from multiple same-day trades that
            // weren't captured in the initial per-trade calculation.
            if (platformId === 'm1' && newBalance < 0) {
              // Cap the effective margin borrow to the amount that is actually available
              additionalMarginBorrowed = Math.min(-newBalance, prevMarginAvailable)
              newBalance = round2(newBalance + additionalMarginBorrowed)  // Add what we can borrow back
              // Adjust the cash change amount to reflect only what was withdrawn from cash.
              // When cash goes negative and margin is borrowed to cover it, all previous cash is consumed.
              actualCashChange = -prevBalance
            }

            // Total margin is the sum of initial margin (from trading fund entry) and additional margin
            // (from same-day cash flow). These are separate and complementary, not double-counted.
            const totalMarginBorrowed = marginBorrowedNow + additionalMarginBorrowed

            // If user provided margin_available in the trading fund entry, use that
            // Otherwise, calculate it (previous - borrowed)
            const newMarginAvailable = entry.margin_available !== undefined && entry.margin_available !== null
              ? entry.margin_available
              : prevMarginAvailable - totalMarginBorrowed

            const newCashEntry: FundEntry = {
              date: entry.date,
              value: newBalance,
              cash: newBalance,
              action: 'HOLD',
              amount: round2(actualCashChange),  // Signed amount: positive=deposit, negative=withdraw
              fund_size: newBalance,
              margin_available: newMarginAvailable,
              margin_borrowed: prevMarginBorrowed + totalMarginBorrowed,
              notes: `Auto: ${notesParts.join(', ')}`
            }

            await appendEntry(cashFundPath, newCashEntry).catch(() => {})

            cashSyncResult = {
              action: cashChange > 0 ? 'DEPOSIT' : 'WITHDRAW',
              amount: Math.abs(cashChange),
              cashFundId
            }
          }
        }
      }
    }
  }

  // Re-read to get updated fund
  const updated = await readFund(filePath).catch(next)
  if (!updated) {
    return next(notFound('Fund'))
  }

  // Compute state using trades BEFORE this entry's action for accurate gain display
  // The equity value entered represents portfolio value at snapshot time, before BUY/SELL executes
  const tradesBeforeAction = entriesToTrades(fund.entries) // fund.entries is before the new entry
  const dividends = entriesToDividends(updated.entries)
  const expenses = entriesToExpenses(updated.entries)

  // Use actual fund_size from new entry instead of config
  const actualFundSize = entry.fund_size ?? updated.config.fund_size_usd
  const configWithActualFundSize = { ...updated.config, fund_size_usd: actualFundSize }

  // Compute state with pre-action trades so gain reflects equity vs previous invested
  const state = computeFundState(
    configWithActualFundSize,
    tradesBeforeAction,
    [],
    dividends,
    expenses,
    entry.value,
    entry.date
  )

  // For cash funds, override computed interest with actual cash_interest values from entries
  if (isCashFund) {
    const actualCashInterest = entriesToCashInterest(updated.entries)
    state.cash_interest_usd = actualCashInterest
    state.realized_gains_usd = actualCashInterest
    state.start_input_usd = state.actual_value_usd - actualCashInterest
    state.gain_usd = actualCashInterest
    state.gain_pct = state.start_input_usd > 0 ? actualCashInterest / state.start_input_usd : 0
  }

  // Correct cash_available for funds that don't manage their own cash
  const manageCashSelf2 = updated.config.manage_cash === true
  let correctedCashAvailable = state.cash_available_usd
  if (!manageCashSelf2 && updated.config.fund_type !== 'cash') {
    // Look up platform cash fund
    const cashFundId = updated.config.cash_fund ?? `${updated.platform.toLowerCase()}-cash`
    const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)
    const cashFundData = await readFund(cashFundPath).catch(() => null)
    if (cashFundData && cashFundData.entries.length > 0) {
      const cashFundLatest = cashFundData.entries[cashFundData.entries.length - 1]
      correctedCashAvailable = cashFundLatest?.cash ?? cashFundLatest?.value ?? 0
    } else {
      correctedCashAvailable = 0
    }
  }
  const correctedState = { ...state, cash_available_usd: correctedCashAvailable }

  // Get margin info from the appropriate source (needed for recommendation calculation)
  let marginAvailable = 0
  let marginBorrowed = 0
  if (isCashFund) {
    // For cash funds, get from the entry itself
    marginAvailable = entry.margin_available ?? 0
    marginBorrowed = entry.margin_borrowed ?? 0
  } else if (!manageCashSelf2) {
    // For trading funds, get from the cash fund
    const cashFundId = updated.config.cash_fund ?? `${updated.platform.toLowerCase()}-cash`
    const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)
    const cashFundData = await readFund(cashFundPath).catch(() => null)
    if (cashFundData && cashFundData.entries.length > 0) {
      const cashFundLatest = cashFundData.entries[cashFundData.entries.length - 1]
      marginAvailable = cashFundLatest?.margin_available ?? 0
      marginBorrowed = cashFundLatest?.margin_borrowed ?? 0
    }
  }

  // Compute recommendation using post-action state (includes new entry's action)
  // This tells the user what to do NEXT after this action
  // Skip recommendation for cash funds - they don't need trading recommendations
  let recommendation = null
  if (!isCashFund) {
    const tradesAfterAction = entriesToTrades(updated.entries)
    // Use POST-action equity for recommendation (after SELL, equity is reduced)
    const postActionEquity = computePostActionEquity(entry)
    const stateForRecommendation = computeFundState(
      configWithActualFundSize,
      tradesAfterAction,
      [],
      dividends,
      expenses,
      postActionEquity,
      entry.date
    )

    // For M1 platform with margin enabled, add margin_available to cash for recommendation calculation
    let effectiveCash = correctedCashAvailable
    const platformId = updated.platform.toLowerCase()
    if (platformId === 'm1' && updated.config.margin_enabled) {
      effectiveCash = correctedCashAvailable + marginAvailable
    }

    const stateForRecommendationWithMargin = { ...stateForRecommendation, cash_available_usd: effectiveCash }
    recommendation = computeRecommendation(configWithActualFundSize, stateForRecommendationWithMargin)
  }

  res.status(201).json({
    entry,
    state: correctedState,
    recommendation,
    margin_available: marginAvailable,
    margin_borrowed: marginBorrowed,
    cashSync: cashSyncResult  // Included if auto-sync created an entry in cash fund
  })
})

/**
 * PUT /funds/:id/entries/:entryIndex - Update an entry
 */
fundsRouter.put('/:id/entries/:entryIndex', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const entryIndex = parseInt(req.params['entryIndex'] ?? '', 10)
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  if (isNaN(entryIndex)) return next(badRequest('Invalid entry index'))

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  if (entryIndex < 0 || entryIndex >= fund.entries.length) {
    return next(badRequest(`Entry index out of bounds: ${entryIndex}`))
  }

  const entry = req.body as FundEntry
  if (!entry.date) return next(badRequest('date is required'))
  if (entry.value === undefined) return next(badRequest('value is required'))

  // For cash funds, ensure cash field matches value (Cash Balance in UI maps to value)
  const isCashFund = fund.config.fund_type === 'cash'
  if (isCashFund) {
    entry.cash = entry.value
  }

  // Calculate fund_size change to propagate to subsequent entries
  const oldEntry = fund.entries[entryIndex]
  const oldFundSize = oldEntry?.fund_size ?? 0
  const newFundSize = entry.fund_size ?? 0
  const fundSizeDelta = newFundSize - oldFundSize

  // Update the entry
  fund.entries[entryIndex] = entry

  // Propagate fund_size changes to all subsequent entries
  if (entry.fund_size !== undefined && entry.fund_size > 0) {
    const entryDate = new Date(entry.date)
    for (let i = 0; i < fund.entries.length; i++) {
      if (i === entryIndex) continue
      const e = fund.entries[i]
      if (!e) continue
      const eDate = new Date(e.date)
      // Update entries after this one (by date)
      if (eDate > entryDate) {
        if (e.fund_size !== undefined && e.fund_size > 0) {
          // Entry has explicit fund_size - apply delta
          e.fund_size = e.fund_size + fundSizeDelta
        } else {
          // Entry doesn't have fund_size - set it to match current entry's fund_size
          e.fund_size = entry.fund_size
        }
      }
    }
  }

  // Write the entire fund with propagated changes
  await writeFund(filePath, fund).catch(next)

  // Auto-sync cash fund when editing entries for platforms with auto_sync_cash enabled
  // Use 'amount' field for consistency with POST endpoint (not 'delta')
  let cashSyncResult: { action: string; amount: number; cashFundId: string } | null = null
  if (!isCashFund && oldEntry) {
    const platformId = fund.platform.toLowerCase()
    const platformsData = await readPlatformsData()
    const platformConfig = platformsData[platformId]
    const autoSyncCash = platformConfig?.auto_sync_cash ?? (platformId === 'robinhood')

    if (autoSyncCash) {
      const cashFundId = `${platformId}-cash`
      const cashFundPath = join(FUNDS_DIR, `${cashFundId}.tsv`)
      const cashFundData = await readFund(cashFundPath).catch(() => null)

      if (cashFundData) {
        // Calculate cash delta based on old vs new entry
        // BUY: increases amount = more cash withdrawn (negative delta)
        // SELL: increases amount = more cash deposited (positive delta)
        const round2 = (n: number) => Math.round(n * 100) / 100

        const oldAction = oldEntry.action?.toUpperCase()
        const newAction = entry.action?.toUpperCase()
        const oldAmount = oldEntry.amount ?? 0
        const newAmount = entry.amount ?? 0
        const oldDividend = oldEntry.dividend ?? 0
        const newDividend = entry.dividend ?? 0
        const oldMarginBorrowed = oldEntry.margin_borrowed ?? 0
        const newMarginBorrowed = entry.margin_borrowed ?? 0
        const oldDate = oldEntry.date
        const newDate = entry.date

        // Calculate old cash effect (what was applied to cash fund)
        // For BUY: only the non-margin portion affects cash (amount - margin_borrowed)
        let oldCashEffect = 0
        if (oldAction === 'BUY') oldCashEffect = -(oldAmount - oldMarginBorrowed)
        else if (oldAction === 'SELL') oldCashEffect = oldAmount
        oldCashEffect += oldDividend

        // Calculate new cash effect (what should be applied)
        let newCashEffect = 0
        if (newAction === 'BUY') newCashEffect = -(newAmount - newMarginBorrowed)
        else if (newAction === 'SELL') newCashEffect = newAmount
        newCashEffect += newDividend

        // The delta is the difference
        const cashDelta = round2(newCashEffect - oldCashEffect)

        // Helper to remove auto notes for this ticker from a notes string (case-insensitive)
        const tickerUpper = fund.ticker.toUpperCase()
        // Escape regex metacharacters in ticker so it's treated literally in the pattern
        const escapedTicker = tickerUpper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const removeAutoNote = (notes: string | undefined): string => {
          if (!notes) return ''
          // Match auto notes at beginning or after pipe, capturing the ticker case-insensitively
          return notes
            .replace(
              new RegExp(
                `(^\\s*Auto:[^|]*${escapedTicker}[^|]*(\\s*\\|\\s*)?)|(\\s*\\|\\s*Auto:[^|]*${escapedTicker}[^|]*)`,
                'gi'
              ),
              ''
            )
            .trim()
        }

        // Helper to create auto note - matches POST endpoint format with dividend support
        const createAutoNote = (cashEffect: number, dividendDelta: number): string => {
          const parts: string[] = []

          // Trade component (Buy/Sell) - only if there's a non-dividend cash effect
          const tradeEffect = cashEffect - dividendDelta
          if (tradeEffect !== 0) {
            const noteAction = tradeEffect > 0 ? 'Sell' : 'Buy'
            parts.push(`${noteAction} ${tickerUpper}${entry.shares ? ` (${entry.shares} shares)` : ''}`)
          }

          // Dividend component, if dividend changed
          if (dividendDelta !== 0) {
            const sign = dividendDelta < 0 ? '-' : ''
            const amount = Math.abs(dividendDelta).toFixed(2)
            parts.push(`Dividend ${tickerUpper} ${sign}$${amount}`)
          }

          return parts.length > 0 ? `Auto: ${parts.join(', ')}` : ''
        }

        // Helper to append auto note to existing notes
        const appendAutoNote = (existingNotes: string | undefined, autoNote: string): string => {
          // If there's no new auto note content, just return existing notes with old auto notes removed
          if (!autoNote) {
            return removeAutoNote(existingNotes)
          }
          const cleaned = removeAutoNote(existingNotes)
          return cleaned ? `${cleaned} | ${autoNote}` : autoNote
        }

        // Helper to apply margin adjustment for M1 platform when cash goes negative
        const applyMarginAdjustment = (cashEntry: FundEntry): void => {
          if (platformId !== 'm1') return
          const currentCash = cashEntry.cash ?? 0
          if (currentCash >= 0) return

          const deficit = -currentCash
          const prevMarginAvailable = cashEntry.margin_available ?? 0
          const prevMarginBorrowed = cashEntry.margin_borrowed ?? 0

          // Borrow at most the available margin to cover the deficit
          const borrow = Math.min(deficit, prevMarginAvailable)
          if (borrow > 0) {
            cashEntry.cash = round2(currentCash + borrow)
            cashEntry.value = cashEntry.cash
            cashEntry.margin_available = round2(prevMarginAvailable - borrow)
            cashEntry.margin_borrowed = round2(prevMarginBorrowed + borrow)
          }
        }

        // Calculate dividend delta for note generation
        const dividendDelta = round2(newDividend - oldDividend)

        // Only proceed if there's a cash change
        if (cashDelta !== 0) {
          // Track whether old entry was found (affects propagation when missing)
          let oldEntryFound = true

          // Determine which dates need to be excluded from propagation
          // (they were already directly updated)
          const excludeFromPropagation = new Set<string>()

          // Handle date change - if date changed, need to update old and new date entries
          if (oldDate !== newDate) {
            // Remove effect from old date entry
            const oldDateEntryIndex = cashFundData.entries.findIndex(e => e.date === oldDate)
            if (oldDateEntryIndex >= 0) {
              const oldDateEntry = cashFundData.entries[oldDateEntryIndex]!
              oldDateEntry.value = round2((oldDateEntry.value ?? 0) - oldCashEffect)
              oldDateEntry.cash = oldDateEntry.value
              oldDateEntry.fund_size = oldDateEntry.value
              oldDateEntry.amount = round2((oldDateEntry.amount ?? 0) - oldCashEffect)
              // Remove auto notes for this ticker
              oldDateEntry.notes = removeAutoNote(oldDateEntry.notes)

              // If this entry is now effectively empty (no amount and no meaningful notes), remove it
              const hasNotes = typeof oldDateEntry.notes === 'string' && oldDateEntry.notes.trim().length > 0
              if ((oldDateEntry.amount ?? 0) === 0 && !hasNotes) {
                cashFundData.entries.splice(oldDateEntryIndex, 1)
              } else {
                applyMarginAdjustment(oldDateEntry)
              }
              excludeFromPropagation.add(oldDate)
            } else {
              // Old cash entry doesn't exist - track this for propagation adjustment
              oldEntryFound = false
            }

            // Add effect to new date entry (or create one if it doesn't exist)
            const newDateEntryIndex = cashFundData.entries.findIndex(e => e.date === newDate)
            if (newDateEntryIndex >= 0) {
              const newDateEntry = cashFundData.entries[newDateEntryIndex]!
              // Use cashDelta because existing value already includes cascaded effects from old dates
              newDateEntry.value = round2((newDateEntry.value ?? 0) + cashDelta)
              newDateEntry.cash = newDateEntry.value
              newDateEntry.fund_size = newDateEntry.value
              newDateEntry.amount = round2((newDateEntry.amount ?? 0) + cashDelta)
              newDateEntry.notes = appendAutoNote(newDateEntry.notes, createAutoNote(newCashEffect, dividendDelta))
              applyMarginAdjustment(newDateEntry)
              excludeFromPropagation.add(newDate)
            } else {
              // Create new cash entry for the new date
              // Get previous cash balance from latest entry before this date
              // If newDate is before all entries, use config defaults instead
              const entriesBefore = cashFundData.entries.filter(e => e.date < newDate)
              const prevEntry = entriesBefore.length > 0
                ? entriesBefore.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]
                : undefined
              const prevBalance = prevEntry?.cash ?? prevEntry?.value ?? cashFundData.config.fund_size_usd ?? 0
              const prevMarginAvailable = prevEntry?.margin_available ?? cashFundData.config.margin_access_usd ?? 0
              const prevMarginBorrowed = prevEntry?.margin_borrowed ?? 0
              const newBalance = round2(prevBalance + newCashEffect)

              const newCashEntry: FundEntry = {
                date: newDate,
                value: newBalance,
                cash: newBalance,
                action: 'HOLD',
                amount: round2(newCashEffect),
                fund_size: newBalance,
                margin_available: prevMarginAvailable,
                margin_borrowed: prevMarginBorrowed,
                notes: createAutoNote(newCashEffect, dividendDelta)
              }
              applyMarginAdjustment(newCashEntry)
              cashFundData.entries.push(newCashEntry)
              excludeFromPropagation.add(newDate)
            }
          } else {
            // Same date - apply the delta and update notes for action changes
            const cashEntryIndex = cashFundData.entries.findIndex(e => e.date === entry.date)
            if (cashEntryIndex >= 0) {
              const cashEntry = cashFundData.entries[cashEntryIndex]!
              cashEntry.value = round2((cashEntry.value ?? 0) + cashDelta)
              cashEntry.cash = cashEntry.value
              cashEntry.fund_size = cashEntry.value
              cashEntry.amount = round2((cashEntry.amount ?? 0) + cashDelta)
              // Update notes to reflect the new action (in case action type changed)
              cashEntry.notes = appendAutoNote(cashEntry.notes, createAutoNote(newCashEffect, dividendDelta))
              applyMarginAdjustment(cashEntry)
              excludeFromPropagation.add(entry.date)
            } else {
              // No existing cash entry for this date - create one with full newCashEffect
              // (not cashDelta, since there's no old effect to remove)
              // If entry.date is before all entries, use config defaults instead
              const entriesBefore = cashFundData.entries.filter(e => e.date < entry.date)
              const prevEntry = entriesBefore.length > 0
                ? entriesBefore.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]
                : undefined
              const prevBalance = prevEntry?.cash ?? prevEntry?.value ?? cashFundData.config.fund_size_usd ?? 0
              const prevMarginAvailable = prevEntry?.margin_available ?? cashFundData.config.margin_access_usd ?? 0
              const prevMarginBorrowed = prevEntry?.margin_borrowed ?? 0
              // Use newCashEffect for balance since there's no previous cash entry to delta from
              const newBalance = round2(prevBalance + newCashEffect)

              const newCashEntry: FundEntry = {
                date: entry.date,
                value: newBalance,
                cash: newBalance,
                action: 'HOLD',
                amount: round2(newCashEffect),
                fund_size: newBalance,
                margin_available: prevMarginAvailable,
                margin_borrowed: prevMarginBorrowed,
                notes: createAutoNote(newCashEffect, dividendDelta)
              }
              applyMarginAdjustment(newCashEntry)
              cashFundData.entries.push(newCashEntry)
              excludeFromPropagation.add(entry.date)
            }
          }

          // Propagate cash changes to all subsequent entries
          // Calculate the effective running delta:
          // - If old entry was found and removed: delta = newCashEffect - oldCashEffect = cashDelta
          // - If old entry was NOT found: delta = newCashEffect only (no old effect to remove)
          const runningDelta = oldEntryFound ? cashDelta : round2(newCashEffect)
          // If old entry was found, start propagation from the earlier date
          // If old entry was NOT found, only propagate from the new date
          const affectedDate = oldEntryFound ? (oldDate < newDate ? oldDate : newDate) : newDate
          const sortedCashEntries = [...cashFundData.entries].sort((a, b) =>
            new Date(a.date).getTime() - new Date(b.date).getTime()
          )

          for (const cashEntry of sortedCashEntries) {
            // Apply cumulative delta to entries after the affected date
            // Skip entries that were directly updated above to avoid double-application
            if (cashEntry.date > affectedDate && !excludeFromPropagation.has(cashEntry.date)) {
              cashEntry.value = round2((cashEntry.value ?? 0) + runningDelta)
              cashEntry.cash = cashEntry.value
              cashEntry.fund_size = cashEntry.value
              applyMarginAdjustment(cashEntry)
            }
          }

          const writeResult = await writeFund(cashFundPath, cashFundData).catch((err: Error) => err)
          if (writeResult instanceof Error) {
            return next(writeResult)
          }

          cashSyncResult = {
            action: cashDelta > 0 ? 'DEPOSIT' : 'WITHDRAW',
            amount: Math.abs(cashDelta),
            cashFundId
          }
        }
      }
    }
  }

  // Re-read to get updated fund
  const updated = await readFund(filePath).catch(next)
  if (!updated) {
    return next(notFound('Fund'))
  }

  res.json({ entry, fund: updated, cashSync: cashSyncResult })
})

/**
 * DELETE /funds/:id/entries/:entryIndex - Delete an entry
 */
fundsRouter.delete('/:id/entries/:entryIndex', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const entryIndex = parseInt(req.params['entryIndex'] ?? '', 10)
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  if (isNaN(entryIndex)) return next(badRequest('Invalid entry index'))

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  if (entryIndex < 0 || entryIndex >= fund.entries.length) {
    return next(badRequest(`Entry index out of bounds: ${entryIndex}`))
  }

  await deleteEntry(filePath, entryIndex).catch(next)

  // Re-read to get updated fund
  const updated = await readFund(filePath).catch(next)
  if (!updated) {
    return next(notFound('Fund'))
  }

  res.json({ fund: updated })
})

/**
 * POST /funds/:id/recalculate - Recalculate fund_size for all entries
 *
 * Recalculates fund_size based on:
 * - Initial fund_size_usd from config
 * - + cumulative BUYs
 * - + DEPOSITs
 * - - WITHDRAWs
 * - + dividends (if dividend_reinvest)
 * - + cash_interest (if interest_reinvest)
 * - - expenses (if expense_from_fund)
 *
 * For accumulate mode: SELLs don't reduce fund_size unless full position exit
 * For harvest mode: SELLs reduce fund_size (harvest gains)
 */
fundsRouter.post('/:id/recalculate', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  const config = fund.config
  const isAccumulate = config.accumulate
  const dividendReinvest = config.dividend_reinvest !== false
  const interestReinvest = config.interest_reinvest !== false
  const expenseFromFund = config.expense_from_fund !== false
  const manageCash = config.manage_cash !== false

  // Sort entries by date
  const sorted = [...fund.entries].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  let sumBuys = 0
  let sumSells = 0
  let sumDeposits = 0
  let sumWithdrawals = 0
  let sumDividends = 0
  let sumCashInterest = 0
  let sumExpenses = 0
  let sumShares = 0
  // For manage_cash=true: fund_size starts from config (target allocation + deposits/withdrawals)
  // For manage_cash=false: fund_size = net invested only (BUYs - SELLs), starts from 0
  let baseFundSize = manageCash ? config.fund_size_usd : 0

  // Recalculate fund_size and equity for each entry
  for (const entry of sorted) {
    // Track shares FIRST - BUY adds, SELL subtracts
    if (entry.shares) {
      const sharesAbs = Math.abs(entry.shares)
      sumShares += entry.action === 'SELL' ? -sharesAbs : sharesAbs
    }

    // Recalculate equity AFTER updating shares: equity = sumShares × price
    // This represents portfolio value after this entry's action
    if (entry.price && entry.price > 0) {
      entry.value = Math.round(sumShares * entry.price * 100) / 100
    }

    // Check for full liquidation (sumShares should be ~0 after a full sell)
    const isFullLiquidation = entry.action === 'SELL' && Math.abs(sumShares) < 0.0001

    // Track action amounts
    if (entry.action === 'BUY' && entry.amount) {
      sumBuys += entry.amount
    } else if (entry.action === 'SELL' && entry.amount) {
      if (!isAccumulate || isFullLiquidation) {
        sumSells += entry.amount
      }
      // For accumulate mode partial sells, fund_size stays the same (profit extraction)
    } else if (entry.action === 'DEPOSIT' && entry.amount) {
      sumDeposits += entry.amount
    } else if (entry.action === 'WITHDRAW' && entry.amount) {
      sumWithdrawals += entry.amount
    }

    // Track dividends, interest, expenses (all stored as positive values)
    if (entry.dividend) {
      sumDividends += dividendReinvest ? Math.abs(entry.dividend) : 0
    }
    if (entry.cash_interest) {
      sumCashInterest += interestReinvest ? Math.abs(entry.cash_interest) : 0
    }
    if (entry.expense) {
      sumExpenses += expenseFromFund ? Math.abs(entry.expense) : 0
    }

    // Calculate new fund_size
    const newFundSize = baseFundSize
      + sumBuys
      - sumSells
      + sumDeposits
      - sumWithdrawals
      + sumDividends
      + sumCashInterest
      - sumExpenses

    entry.fund_size = Math.max(0, newFundSize)

    // After full liquidation, reset all cumulative values for fresh start
    if (isFullLiquidation) {
      sumBuys = 0
      sumSells = 0
      sumDeposits = 0
      sumWithdrawals = 0
      sumDividends = 0
      sumCashInterest = 0
      sumExpenses = 0
      sumShares = 0
      baseFundSize = 0 // After liquidation, start from 0
    }
  }

  // Re-sort back to original order (by index in original array)
  // Actually, we need to update the original entries array
  // Create a map of date -> recalculated values
  const recalcMap = new Map<string, { fund_size: number; value: number }>()
  for (const entry of sorted) {
    // Use date + action + shares as key (since value may have changed)
    const key = `${entry.date}|${entry.action}|${entry.shares}`
    recalcMap.set(key, {
      fund_size: entry.fund_size ?? 0,
      value: entry.value
    })
  }

  // Update original entries
  for (const entry of fund.entries) {
    const key = `${entry.date}|${entry.action}|${entry.shares}`
    const recalculated = recalcMap.get(key)
    if (recalculated) {
      entry.fund_size = recalculated.fund_size
      entry.value = recalculated.value
    }
  }

  // Write the updated fund
  await writeFund(filePath, fund).catch(next)

  // Re-read to get updated fund
  const updated = await readFund(filePath).catch(next)
  if (!updated) {
    return next(notFound('Fund'))
  }

  res.json({
    message: `Recalculated fund_size for ${fund.entries.length} entries`,
    fund: updated
  })
})

/**
 * DELETE /funds/:id - Delete a fund (both TSV and JSON config)
 */
fundsRouter.delete('/:id', async (req, res, next) => {
  const id = req.params['id'] ?? ''
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  const fund = await readFund(filePath).catch(next)
  if (!fund) {
    return next(notFound('Fund'))
  }

  await deleteFund(filePath).catch(next)

  res.status(204).send()
})

// Numeric columns that can be interpolated
const INTERPOLATABLE_COLUMNS = ['margin_available', 'margin_borrowed', 'fund_size', 'value'] as const
type InterpolatableColumn = typeof INTERPOLATABLE_COLUMNS[number]

/**
 * POST /funds/:id/interpolate
 * Interpolate missing values for a specified column based on surrounding known values.
 * Uses linear interpolation by date.
 * Request body: { column: 'margin_available' | 'margin_borrowed' | 'fund_size' | 'value' }
 */
fundsRouter.post('/:id/interpolate', async (req, res, next) => {
  const { id } = req.params
  const { column } = req.body as { column?: string }
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  // Validate column
  if (!column || !INTERPOLATABLE_COLUMNS.includes(column as InterpolatableColumn)) {
    return res.status(400).json({
      error: `Invalid column. Must be one of: ${INTERPOLATABLE_COLUMNS.join(', ')}`
    })
  }

  const col = column as InterpolatableColumn

  // Read the fund
  const fund = await readFund(filePath).catch(next)
  if (!fund) return

  if (fund.entries.length === 0) {
    return res.json({ success: true, message: 'No entries to interpolate', interpolated: 0 })
  }

  // Sort entries by date for interpolation
  const sorted = [...fund.entries].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  // Find entries with known values for the specified column
  const knownIndices: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    const val = sorted[i]![col]
    if (val !== undefined && val !== null && !isNaN(Number(val))) {
      knownIndices.push(i)
    }
  }

  if (knownIndices.length === 0) {
    return res.json({ success: true, message: `No ${column} values to interpolate from`, interpolated: 0 })
  }

  let interpolated = 0

  // Interpolate missing values
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!
    const existingVal = entry[col]
    if (existingVal !== undefined && existingVal !== null && !isNaN(Number(existingVal))) {
      continue // Already has a value
    }

    const entryTime = new Date(entry.date).getTime()

    // Find surrounding known values
    let prevKnown: { idx: number; time: number; value: number } | null = null
    let nextKnown: { idx: number; time: number; value: number } | null = null

    for (const ki of knownIndices) {
      const knownEntry = sorted[ki]!
      const knownTime = new Date(knownEntry.date).getTime()
      const knownValue = Number(knownEntry[col])

      if (knownTime <= entryTime) {
        prevKnown = { idx: ki, time: knownTime, value: knownValue }
      }
      if (knownTime > entryTime && !nextKnown) {
        nextKnown = { idx: ki, time: knownTime, value: knownValue }
        break
      }
    }

    // Interpolate
    let interpolatedValue: number | null = null
    if (prevKnown && nextKnown) {
      // Linear interpolation
      const timeDiff = nextKnown.time - prevKnown.time
      const valueDiff = nextKnown.value - prevKnown.value
      const entryTimeDiff = entryTime - prevKnown.time
      interpolatedValue = prevKnown.value + (valueDiff * entryTimeDiff / timeDiff)
    } else if (prevKnown && !nextKnown) {
      // Use previous value (extrapolate forward)
      interpolatedValue = prevKnown.value
    } else if (!prevKnown && nextKnown) {
      // Use next value (extrapolate backward)
      interpolatedValue = nextKnown.value
    }

    if (interpolatedValue !== null) {
      ;(entry as unknown as Record<string, unknown>)[col] = Math.round(interpolatedValue * 100) / 100
      interpolated++
    }
  }

  // Update original entries with interpolated values
  const sortedMap = new Map<string, number | undefined>()
  for (const entry of sorted) {
    const key = `${entry.date}|${entry.action ?? ''}|${entry.amount ?? ''}|${entry.notes ?? ''}`
    sortedMap.set(key, entry[col] as number | undefined)
  }

  for (const entry of fund.entries) {
    const key = `${entry.date}|${entry.action ?? ''}|${entry.amount ?? ''}|${entry.notes ?? ''}`
    const interpolatedValue = sortedMap.get(key)
    if (interpolatedValue !== undefined) {
      ;(entry as unknown as Record<string, unknown>)[col] = interpolatedValue
    }
  }

  // Write back the fund
  await writeFund(filePath, fund).catch(next)

  res.json({
    success: true,
    message: `Interpolated ${interpolated} ${column} values`,
    interpolated,
    column,
    totalEntries: fund.entries.length,
    knownValues: knownIndices.length
  })
})

/**
 * POST /funds/:id/sync-from-subfunds
 * For cash funds, sync trading activity from related sub-funds.
 * Creates WITHDRAW entries for BUYs and DEPOSIT entries for SELLs/dividends.
 */
fundsRouter.post('/:id/sync-from-subfunds', async (req, res, next) => {
  const { id } = req.params
  const filePath = join(FUNDS_DIR, `${id}.tsv`)

  // Read the cash fund
  const cashFund = await readFund(filePath).catch(next)
  if (!cashFund) {
    return next(notFound('Fund'))
  }

  // Verify this is a cash fund
  if (cashFund.config.fund_type !== 'cash') {
    return res.status(400).json({
      error: 'This endpoint is only for cash funds'
    })
  }

  // Extract platform from fund ID (e.g., robinhood-cash -> robinhood)
  const platform = cashFund.platform.toLowerCase()

  // Find all sub-funds for this platform
  const allFunds = await readAllFunds(FUNDS_DIR)
  const subFunds = allFunds.filter(f =>
    f.platform.toLowerCase() === platform &&
    f.config.fund_type !== 'cash' &&
    f.id !== id
  )

  if (subFunds.length === 0) {
    return res.json({
      success: true,
      message: 'No sub-funds found for this platform',
      added: 0,
      skipped: 0
    })
  }

  // Build a set of existing entries to avoid duplicates
  // Key: date|action|amount|notes_prefix
  const existingKeys = new Set<string>()
  for (const entry of cashFund.entries) {
    const notesPrefix = entry.notes?.substring(0, 50) ?? ''
    const key = `${entry.date}|${entry.action}|${entry.amount?.toFixed(2)}|${notesPrefix}`
    existingKeys.add(key)
  }

  const newEntries: FundEntry[] = []
  let skipped = 0

  for (const subFund of subFunds) {
    for (const entry of subFund.entries) {
      // Skip entries without amounts
      if (!entry.amount || entry.amount === 0) continue

      let cashEntry: FundEntry | null = null

      if (entry.action === 'BUY') {
        // BUY in sub-fund = negative amount (money leaving cash)
        cashEntry = {
          date: entry.date,
          value: 0, // Will be recalculated
          action: 'HOLD',
          amount: -Math.abs(entry.amount),  // Negative = withdraw
          notes: `Trade: Buy ${subFund.ticker.toUpperCase()} (${entry.shares ?? ''} shares @ $${entry.price ?? ''})`
        }
      } else if (entry.action === 'SELL') {
        // SELL in sub-fund = positive amount (money entering cash)
        cashEntry = {
          date: entry.date,
          value: 0, // Will be recalculated
          action: 'HOLD',
          amount: Math.abs(entry.amount),  // Positive = deposit
          notes: `Trade: Sell ${subFund.ticker.toUpperCase()} (${entry.shares ?? ''} shares @ $${entry.price ?? ''})`
        }
      }

      // Also capture dividends (positive = money in)
      if (entry.dividend && entry.dividend > 0) {
        const divEntry: FundEntry = {
          date: entry.date,
          value: 0,
          action: 'HOLD',
          amount: Math.abs(entry.dividend),  // Positive = deposit
          notes: `Dividend: ${subFund.ticker.toUpperCase()}`
        }
        const divNotesPrefix = divEntry.notes?.substring(0, 50) ?? ''
        const divKey = `${divEntry.date}|${divEntry.action}|${divEntry.amount?.toFixed(2)}|${divNotesPrefix}`
        if (!existingKeys.has(divKey)) {
          newEntries.push(divEntry)
          existingKeys.add(divKey)
        } else {
          skipped++
        }
      }

      if (cashEntry) {
        const notesPrefix = cashEntry.notes?.substring(0, 50) ?? ''
        const key = `${cashEntry.date}|${cashEntry.action}|${cashEntry.amount?.toFixed(2)}|${notesPrefix}`
        if (!existingKeys.has(key)) {
          newEntries.push(cashEntry)
          existingKeys.add(key)
        } else {
          skipped++
        }
      }
    }
  }

  // Add new entries to the fund
  for (const entry of newEntries) {
    cashFund.entries.push(entry)
  }

  // Sort entries by date
  cashFund.entries.sort((a, b) => a.date.localeCompare(b.date))

  // Recalculate running balance using signed amounts
  let runningBalance = 0
  for (const entry of cashFund.entries) {
    // Amount is signed: positive = deposit, negative = withdraw
    if (entry.amount) {
      runningBalance += entry.amount
    }
    if (entry.cash_interest) {
      runningBalance += entry.cash_interest
    }
    if (entry.expense) {
      runningBalance -= entry.expense
    }

    entry.value = Math.round(runningBalance * 100) / 100
    entry.cash = entry.value
    entry.fund_size = entry.value
  }

  // Write back the updated fund
  await writeFund(filePath, cashFund).catch(next)

  res.json({
    success: true,
    message: `Synced trading activity from ${subFunds.length} sub-funds`,
    added: newEntries.length,
    skipped,
    subFundsSynced: subFunds.map(f => f.id),
    finalBalance: runningBalance
  })
})

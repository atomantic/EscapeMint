import type { SubFundConfig, Trade, CashFlow, FundState, FundType, FundCategory } from './types.js'
import { isCashFund as checkIsCashFund } from './fund-type-config.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DAYS_PER_YEAR = 365

/**
 * Derives fund start date from the first entry.
 * Falls back to today if no entries exist.
 */
export function getFundStartDate(entries: { date: string }[]): string {
  if (entries.length === 0) return new Date().toISOString().slice(0, 10)
  let earliest = entries[0]!.date
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.date < earliest) earliest = entries[i]!.date
  }
  return earliest
}

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY)
}

export interface FundMetrics {
  id: string
  platform: string
  ticker: string
  status: 'active' | 'closed'
  fundType: FundType
  category?: FundCategory
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

export interface AggregateMetrics {
  totalFundSize: number
  totalValue: number
  totalStartInput: number
  totalTimeWeightedFundSize: number
  totalDaysActive: number
  totalRealizedGains: number
  totalUnrealizedGains: number
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

/**
 * Computes time-weighted fund size for a single fund.
 *
 * Time-weighted fund size accounts for when capital was deployed.
 * If fund started at $1000 and grew to $5000 over time through deposits,
 * the time-weighted size gives proper weight to each contribution.
 */
export function computeTimeWeightedFundSize(
  trades: Trade[],
  startDate: string,
  asOfDate: string
): number {
  const totalDays = daysBetween(startDate, asOfDate)
  if (totalDays <= 0) return 0

  // Sort trades by date
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  let cumulativeInvestment = 0
  let weightedSum = 0
  let lastDate = startDate

  for (const trade of sortedTrades) {
    if (daysBetween(trade.date, asOfDate) < 0) continue
    if (daysBetween(startDate, trade.date) < 0) continue

    // Add time-weighted value for the period before this trade
    const periodDays = daysBetween(lastDate, trade.date)
    if (periodDays > 0) {
      weightedSum += cumulativeInvestment * periodDays
    }

    // Update cumulative investment
    if (trade.type === 'buy') {
      cumulativeInvestment += trade.amount_usd
    } else {
      cumulativeInvestment -= trade.amount_usd
    }
    cumulativeInvestment = Math.max(0, cumulativeInvestment)
    lastDate = trade.date
  }

  // Add final period to asOfDate
  const finalDays = daysBetween(lastDate, asOfDate)
  if (finalDays > 0) {
    weightedSum += cumulativeInvestment * finalDays
  }

  return weightedSum / totalDays
}

/**
 * Computes time-weighted fund size for a cash fund.
 *
 * Cash funds use DEPOSIT/WITHDRAW instead of BUY/SELL.
 * The balance (deposits - withdrawals) represents the capital deployed.
 */
export function computeCashFundTimeWeightedSize(
  cashFlows: CashFlow[],
  startDate: string,
  asOfDate: string
): number {
  const totalDays = daysBetween(startDate, asOfDate)
  if (totalDays <= 0) return 0

  // Sort cash flows by date
  const sortedFlows = [...cashFlows].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  let balance = 0
  let weightedSum = 0
  let lastDate = startDate

  for (const flow of sortedFlows) {
    if (daysBetween(flow.date, asOfDate) < 0) continue
    if (daysBetween(startDate, flow.date) < 0) continue

    // Add time-weighted value for the period before this flow
    const periodDays = daysBetween(lastDate, flow.date)
    if (periodDays > 0) {
      weightedSum += balance * periodDays
    }

    // Update balance
    if (flow.type === 'deposit') {
      balance += flow.amount_usd
    } else {
      balance -= flow.amount_usd
    }
    balance = Math.max(0, balance)
    lastDate = flow.date
  }

  // Add final period to asOfDate
  const finalDays = daysBetween(lastDate, asOfDate)
  if (finalDays > 0) {
    weightedSum += balance * finalDays
  }

  return weightedSum / totalDays
}

/**
 * Computes realized APY for a fund.
 *
 * Realized APY = (Realized Gains / Time-Weighted Fund Size) * (365 / Days Active)
 *
 * This gives an annualized return based on actual gains realized from:
 * - Cash interest
 * - Dividends
 * - Sell profits
 * - Less expenses
 */
export function computeRealizedAPY(
  realizedGains: number,
  timeWeightedFundSize: number,
  daysActive: number
): number {
  if (timeWeightedFundSize <= 0 || daysActive <= 0) return 0
  return (realizedGains / timeWeightedFundSize) * (DAYS_PER_YEAR / daysActive)
}

/**
 * Computes liquid APY for a fund.
 *
 * Liquid APY = (Unrealized Gain / Time-Weighted Fund Size) * (365 / Days Active)
 *
 * This gives an annualized return based on current unrealized gains
 * (what you would realize if you liquidated the position now).
 */
export function computeLiquidAPY(
  gainUsd: number,
  timeWeightedFundSize: number,
  daysActive: number
): number {
  if (timeWeightedFundSize <= 0 || daysActive <= 0) return 0
  return (gainUsd / timeWeightedFundSize) * (DAYS_PER_YEAR / daysActive)
}

/**
 * Computes projected annual return for a fund.
 *
 * Uses realized APY to project what a full year would return
 * on the current fund value.
 */
export function computeProjectedAnnualReturn(
  currentValue: number,
  realizedAPY: number
): number {
  return currentValue * realizedAPY
}

/**
 * Computes metrics for a single fund.
 *
 * For cash funds (fund_type === 'cash'), uses cashFlows for TWFS calculation
 * and treats the current balance as currentValue.
 */
export function computeFundMetrics(
  id: string,
  platform: string,
  ticker: string,
  config: SubFundConfig,
  trades: Trade[],
  state: FundState | null,
  asOfDate: string,
  cashFlows?: CashFlow[]
): FundMetrics {
  const isCashFund = checkIsCashFund(config.fund_type)

  // Derive start date from earliest of trades, cashFlows, and config fallback
  const candidateDates: string[] = []
  if (cashFlows && cashFlows.length > 0) {
    candidateDates.push(getFundStartDate(cashFlows))
  }
  if (trades.length > 0) {
    candidateDates.push(getFundStartDate(trades))
  }
  if (config.start_date) {
    candidateDates.push(config.start_date)
  }
  candidateDates.push(asOfDate)
  const startDate = candidateDates.reduce((earliest, d) => (d < earliest ? d : earliest))

  const daysActive = Math.max(1, daysBetween(startDate, asOfDate))

  // For cash funds, use cash flows for TWFS; for trading funds, use trades
  const timeWeightedFundSize = isCashFund && cashFlows
    ? computeCashFundTimeWeightedSize(cashFlows, startDate, asOfDate)
    : computeTimeWeightedFundSize(trades, startDate, asOfDate)

  const realizedGains = state?.realized_gains_usd ?? 0
  const realizedAPY = computeRealizedAPY(realizedGains, timeWeightedFundSize, daysActive)

  // For cash funds, currentValue is the cash balance (from state or computed from flows)
  const currentValue = state?.actual_value_usd ?? 0
  const projectedAnnualReturn = computeProjectedAnnualReturn(currentValue, realizedAPY)

  // Unrealized gains = paper gain on positions (value - cost basis)
  // For cash funds: no unrealized (all gains are realized as interest)
  // For trading funds: unrealized = value - start_input (the paper gain on positions)
  const unrealizedGains = isCashFund ? 0 : (state?.gain_usd ?? 0)

  // Liquid gain = total gain if we sold everything now
  // For cash funds: liquid = realized (just interest, no assets to sell)
  // For trading funds: liquid = unrealized + realized (paper gain + dividends/interest)
  const liquidGain = unrealizedGains + realizedGains
  const liquidAPY = computeLiquidAPY(liquidGain, timeWeightedFundSize, daysActive)

  // gainUsd stores the component relevant to fund type for backward compatibility
  const gainUsd = isCashFund ? realizedGains : unrealizedGains

  return {
    id,
    platform,
    ticker,
    status: config.status ?? 'active',
    fundType: config.fund_type ?? 'stock',
    ...(config.category && { category: config.category }),
    fundSize: config.fund_size_usd,
    currentValue,
    startInput: state?.start_input_usd ?? 0,
    daysActive,
    timeWeightedFundSize,
    realizedGains,
    unrealizedGains,
    realizedAPY,
    liquidAPY,
    projectedAnnualReturn,
    gainUsd,
    gainPct: state?.gain_pct ?? 0,
    fundShares: 0,
    fundSharesPct: 0
  }
}

/**
 * Computes aggregate metrics across all funds.
 *
 * Fund shares calculation (from spreadsheet):
 * Fund Shares = TWFS / (TotalTWFS / TotalDays) * DaysActive
 *             = TWFS * TotalDays * DaysActive / TotalTWFS
 *
 * This weights each sub-fund by both its time-weighted capital and duration,
 * giving larger impact to funds with more capital deployed for longer.
 */
export function computeAggregateMetrics(fundMetrics: FundMetrics[], portfolioDays?: number): AggregateMetrics {
  let totalFundSize = 0
  let totalValue = 0
  let totalStartInput = 0
  let totalTimeWeightedFundSize = 0
  let totalDaysActive = 0
  let totalRealizedGains = 0
  let totalUnrealizedGains = 0
  let activeFunds = 0
  let closedFunds = 0

  // First pass: compute totals
  for (const fund of fundMetrics) {
    totalFundSize += fund.fundSize
    totalValue += fund.currentValue
    totalStartInput += fund.startInput
    totalTimeWeightedFundSize += fund.timeWeightedFundSize
    totalDaysActive += fund.daysActive
    totalRealizedGains += fund.realizedGains
    totalUnrealizedGains += fund.unrealizedGains

    if (fund.status === 'closed') {
      closedFunds++
    } else {
      activeFunds++
    }
  }

  // Second pass: calculate fund shares for each fund
  // Fund Shares = TWFS * TotalDays / TotalTWFS * DaysActive
  // This matches the spreadsheet formula: B4/($U4/$U6)*B6
  const dollarsPerDay = totalTimeWeightedFundSize > 0 && totalDaysActive > 0
    ? totalTimeWeightedFundSize / totalDaysActive
    : 0

  let totalFundShares = 0
  const fundsWithShares = fundMetrics.map(fund => {
    // Only calculate shares for funds with positive metrics
    const fundShares = dollarsPerDay > 0 && fund.daysActive > 0
      ? (fund.timeWeightedFundSize / dollarsPerDay) * fund.daysActive
      : 0
    totalFundShares += fundShares
    return { ...fund, fundShares }
  })

  // Third pass: calculate fund shares percentage
  const fundsWithSharesPct = fundsWithShares.map(fund => ({
    ...fund,
    fundSharesPct: totalFundShares > 0 ? fund.fundShares / totalFundShares : 0
  }))

  // Dollar-weighted compound APY: annualize the portfolio-level return once
  // totalDollarDays = sum(TWFS_i * daysActive_i) represents total capital-time deployed
  let totalDollarDays = 0
  let maxDaysActive = 0
  for (const fund of fundsWithSharesPct) {
    totalDollarDays += fund.timeWeightedFundSize * fund.daysActive
    if (fund.daysActive > maxDaysActive) maxDaysActive = fund.daysActive
  }
  const effectivePortfolioDays = portfolioDays ?? maxDaysActive
  const avgCapital = effectivePortfolioDays > 0 ? totalDollarDays / effectivePortfolioDays : 0

  // Realized APY: compound formula from total realized gains over dollar-weighted avg capital
  let weightedRealizedAPY = 0
  if (avgCapital > 0 && effectivePortfolioDays > 0) {
    const totalReturn = Math.max(-0.99, totalRealizedGains / avgCapital)
    weightedRealizedAPY = Math.pow(1 + totalReturn, DAYS_PER_YEAR / effectivePortfolioDays) - 1
  }

  // Liquid APY: compound formula from total gain (realized + unrealized)
  const totalGainUsd = totalRealizedGains + totalUnrealizedGains
  let aggregateLiquidAPY = 0
  if (avgCapital > 0 && effectivePortfolioDays > 0) {
    const liquidReturn = Math.max(-0.99, totalGainUsd / avgCapital)
    aggregateLiquidAPY = Math.pow(1 + liquidReturn, DAYS_PER_YEAR / effectivePortfolioDays) - 1
  }

  // Projected annual return is sum of all active funds' projections
  const projectedAnnualReturn = fundsWithSharesPct
    .filter(f => f.status !== 'closed' && f.currentValue > 0)
    .reduce((sum, f) => sum + f.projectedAnnualReturn, 0)

  const totalGainPct = totalStartInput > 0 ? (totalValue / totalStartInput - 1) : 0

  return {
    totalFundSize,
    totalValue,
    totalStartInput,
    totalTimeWeightedFundSize,
    totalDaysActive,
    totalRealizedGains,
    totalUnrealizedGains,
    realizedAPY: weightedRealizedAPY,
    liquidAPY: aggregateLiquidAPY,
    projectedAnnualReturn,
    totalGainUsd,
    totalGainPct,
    activeFunds,
    closedFunds,
    portfolioDays: effectivePortfolioDays,
    funds: fundsWithSharesPct
  }
}

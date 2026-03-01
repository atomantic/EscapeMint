import type { SubFundConfig, Trade, CashFlow, Dividend, Expense, FundState, ClosedFundMetrics } from './types.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DAYS_PER_YEAR = 365

function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY)
}

/**
 * Track cumulative shares: BUY adds, SELL subtracts.
 */
function trackShares(trade: Trade, currentShares: number): number {
  if (trade.shares === undefined) return currentShares
  const sharesAbs = Math.abs(trade.shares)
  return currentShares + (trade.type === 'sell' ? -sharesAbs : sharesAbs)
}

/**
 * Detect full position liquidation using multiple methods:
 * - Share-based: net shares near zero
 * - Value-based: remaining value is dust compared to sale
 * - Dollar-based: total sells >= total buys
 */
function detectFullLiquidation(
  trade: Trade,
  sumShares: number,
  totalBuys: number,
  totalSells: number
): boolean {
  const hasShareTracking = trade.shares !== undefined && trade.shares !== 0
  const shareBasedLiquidation = hasShareTracking && Math.abs(sumShares) < 0.0001
  // Only use value-based liquidation when value > 0 (value=0 means
  // "unknown" for imported entries, not "position is worthless")
  const valueBasedLiquidation = trade.value !== undefined && trade.value > 0 && trade.value <= trade.amount_usd + 0.01
  const dollarBasedLiquidation = totalSells >= totalBuys
  return shareBasedLiquidation || valueBasedLiquidation || dollarBasedLiquidation
}

/**
 * Computes the total amount currently invested (start input / cost basis).
 * This is the sum of all buys minus the sum of all sells, with liquidation detection.
 * When position is fully liquidated (based on shares or value), totals are reset.
 *
 * In accumulate mode, partial sells are profit extraction and don't reduce cost basis.
 * In harvest mode, partial sells reduce cost basis proportionally.
 */
export function computeStartInput(trades: Trade[], asOfDate: string, config?: SubFundConfig): number {
  let totalBuys = 0
  let totalSells = 0
  let sumShares = 0
  const isAccumulateMode = config?.accumulate === true

  // Sort trades by date to process in chronological order
  const sortedTrades = [...trades].sort((a, b) => a.date.localeCompare(b.date))

  for (const trade of sortedTrades) {
    if (daysBetween(trade.date, asOfDate) < 0) continue // Skip future

    sumShares = trackShares(trade, sumShares)

    if (trade.type === 'buy') {
      totalBuys += trade.amount_usd
    } else {
      totalSells += trade.amount_usd
      const hasShareTracking = trade.shares !== undefined && trade.shares !== 0
      if (detectFullLiquidation(trade, sumShares, totalBuys, totalSells)) {
        totalBuys = 0
        totalSells = 0
        sumShares = 0
      } else if (!isAccumulateMode && hasShareTracking && totalBuys > 0) {
        // Harvest mode: reduce cost basis proportionally
        // In accumulate mode, partial sells are profit extraction (cost basis unchanged)
        // sumShares is AFTER the sell, so add back shares to get pre-sell total
        const sharesBeforeSell = sumShares + Math.abs(trade.shares!)
        const sellFraction = sharesBeforeSell > 0
          ? Math.abs(trade.shares!) / sharesBeforeSell
          : 1
        // Reduce cost basis proportionally, not by sale proceeds
        const costBasisSold = totalBuys * sellFraction
        totalBuys = totalBuys - costBasisSold
        totalSells = 0 // Reset sells since we're tracking proportionally
      } else if (isAccumulateMode) {
        // Accumulate mode: partial sells don't affect cost basis
        // Reset totalSells since we're not tracking them against cost basis
        totalSells = 0
      }
    }
  }

  return Math.max(0, totalBuys - totalSells)
}

/**
 * Computes the expected target value based on compounding each trade.
 *
 * Uses periodic compounding (not continuous):
 * ExpectedGain = Σ(Trade_i * ((1 + TargetAPY)^(DaysElapsed_i / 365) - 1))
 * ExpectedTarget = StartInput + ExpectedGain
 *
 * When selling, the expected gain is proportionally reduced based on
 * the fraction of the position being sold. Full liquidation resets everything.
 */
export function computeExpectedTarget(
  config: SubFundConfig,
  trades: Trade[],
  asOfDate: string
): number {
  const { target_apy } = config

  let startInput = 0
  let expectedGain = 0
  let totalBuys = 0
  let totalSells = 0
  let sumShares = 0

  // Sort trades by date to process in chronological order
  const sortedTrades = [...trades].sort((a, b) => a.date.localeCompare(b.date))

  for (const trade of sortedTrades) {
    const tradeDays = daysBetween(trade.date, asOfDate)
    if (tradeDays < 0) continue // Skip future trades

    sumShares = trackShares(trade, sumShares)

    if (trade.type === 'buy') {
      totalBuys += trade.amount_usd
      startInput += trade.amount_usd
      // Each buy compounds from its trade date
      const gain = trade.amount_usd * (Math.pow(1 + target_apy, tradeDays / DAYS_PER_YEAR) - 1)
      expectedGain += gain
    } else {
      totalSells += trade.amount_usd
      const hasShareTracking = trade.shares !== undefined && trade.shares !== 0
      if (detectFullLiquidation(trade, sumShares, totalBuys, totalSells)) {
        startInput = 0
        expectedGain = 0
        totalBuys = 0
        totalSells = 0
        sumShares = 0
      } else {
        // In accumulate mode, partial sells are profit extraction only -
        // principal remains invested, so don't reduce startInput or expectedGain.
        // Expected target represents what invested capital SHOULD grow to at target APY.
        // In harvest mode, reduce both proportionally (closing out position).
        const isAccumulateMode = config.accumulate === true
        if (isAccumulateMode) {
          // Accumulate mode: partial sells don't affect expected target
          // Reset totalSells so they don't accumulate toward liquidation threshold
          totalSells = 0
        } else if (startInput > 0) {
          // Harvest mode: reduce expected gain and startInput proportionally
          let sellFraction: number
          if (hasShareTracking) {
            const sharesBeforeSell = sumShares + Math.abs(trade.shares!)
            sellFraction = sharesBeforeSell > 0
              ? Math.abs(trade.shares!) / sharesBeforeSell
              : 1
          } else {
            sellFraction = Math.min(1, trade.amount_usd / startInput)
          }
          expectedGain *= (1 - sellFraction)
          startInput = Math.max(0, startInput * (1 - sellFraction))
        }
      }
    }
  }

  return startInput + expectedGain
}

/**
 * Computes the available cash in the pool.
 *
 * Cash = FundSize - StartInput + Deposits - Withdrawals
 *        + Dividends (if dividend_reinvest=true)
 *        + Interest (if interest_reinvest=true)
 *        - Expenses (if expense_from_fund=true)
 */
export function computeCashAvailable(
  config: SubFundConfig,
  trades: Trade[],
  cashflows: CashFlow[],
  dividends: Dividend[],
  expenses: Expense[],
  asOfDate: string
): number {
  const startInput = computeStartInput(trades, asOfDate, config)
  let cash = config.fund_size_usd - startInput

  // Apply external cash flows (deposits/withdrawals to the fund)
  for (const cf of cashflows) {
    if (daysBetween(cf.date, asOfDate) < 0) continue // Skip future
    if (cf.type === 'deposit') {
      cash += cf.amount_usd
    } else {
      cash -= cf.amount_usd
    }
  }

  // Default config behaviors (all default to true if not specified)
  const dividendReinvest = config.dividend_reinvest !== false
  const interestReinvest = config.interest_reinvest !== false
  const expenseFromFund = config.expense_from_fund !== false

  // Add dividends to cash if reinvesting
  if (dividendReinvest) {
    for (const div of dividends) {
      if (daysBetween(div.date, asOfDate) < 0) continue // Skip future
      cash += div.amount_usd
    }
  }

  // Add interest to cash if reinvesting
  if (interestReinvest) {
    cash += computeCashInterest(config, trades, cashflows, asOfDate)
  }

  // Subtract expenses from cash if paid from fund
  if (expenseFromFund) {
    for (const exp of expenses) {
      if (daysBetween(exp.date, asOfDate) < 0) continue // Skip future
      cash -= exp.amount_usd
    }
  }

  return Math.max(0, cash)
}

/**
 * Computes cumulative cash interest earned on idle cash.
 * Interest accrues on the cash balance between each event date.
 */
export function computeCashInterest(
  config: SubFundConfig,
  trades: Trade[],
  cashflows: CashFlow[],
  asOfDate: string
): number {
  const { cash_apy, fund_size_usd } = config

  // Collect all events sorted by date
  const events: { date: string; type: 'trade' | 'cashflow'; amount: number; sign: number }[] = []

  for (const trade of trades) {
    events.push({
      date: trade.date,
      type: 'trade',
      amount: trade.amount_usd,
      sign: trade.type === 'buy' ? -1 : 1 // Buy decreases cash, sell increases
    })
  }

  for (const cf of cashflows) {
    events.push({
      date: cf.date,
      type: 'cashflow',
      amount: cf.amount_usd,
      sign: cf.type === 'deposit' ? 1 : -1
    })
  }

  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  let totalInterest = 0
  let currentCash = fund_size_usd
  // Use config start_date if available, otherwise first event date (or asOfDate if no events)
  // Cash interest accrues from fund start (when cash was deployed), not first trade
  let lastDate: string = config.start_date
    ?? (events.length > 0 ? events[0]!.date : asOfDate)

  for (const event of events) {
    if (daysBetween(event.date, asOfDate) < 0) continue
    if (daysBetween(lastDate, event.date) < 0) continue

    // Calculate interest on cash balance for this period
    const periodDays = daysBetween(lastDate, event.date)
    if (periodDays > 0 && currentCash > 0) {
      const periodInterest = currentCash * (Math.pow(1 + cash_apy, periodDays / DAYS_PER_YEAR) - 1)
      totalInterest += periodInterest
    }

    // Update cash balance
    currentCash += event.sign * event.amount
    currentCash = Math.max(0, currentCash)
    lastDate = event.date
  }

  // Interest from last event to asOfDate
  const finalDays = daysBetween(lastDate, asOfDate)
  if (finalDays > 0 && currentCash > 0) {
    const finalInterest = currentCash * (Math.pow(1 + cash_apy, finalDays / DAYS_PER_YEAR) - 1)
    totalInterest += finalInterest
  }

  return totalInterest
}

/**
 * Computes cumulative realized gains.
 * Realized gains include ALL profits extracted or earned:
 * - Sell profits (sell proceeds minus proportional cost basis)
 * - All dividends received
 * - All cash interest earned
 * - Minus expenses (if paid from fund)
 *
 * For sell profit calculation:
 * - Uses running cost basis tracking
 * - Full liquidation (total sells >= total buys): profit = sells - buys
 * - Partial sells: estimates profit proportionally
 */
export function computeRealizedGains(
  config: SubFundConfig,
  trades: Trade[],
  cashflows: CashFlow[],
  dividends: Dividend[],
  expenses: Expense[],
  asOfDate: string
): number {
  let realized = 0

  // Sort trades by date
  const sortedTrades = [...trades].sort((a, b) => a.date.localeCompare(b.date))

  // Track cumulative buys and sells for profit calculation
  let totalBuys = 0
  let totalSells = 0
  let cycleProfit = 0

  for (const trade of sortedTrades) {
    if (daysBetween(trade.date, asOfDate) < 0) continue // Skip future

    if (trade.type === 'buy') {
      totalBuys += trade.amount_usd
    } else {
      totalSells += trade.amount_usd

      // Check for full liquidation (sells >= buys means position fully closed)
      if (totalSells >= totalBuys) {
        // Full cycle complete - profit is difference
        cycleProfit = totalSells - totalBuys
        realized += cycleProfit
        // Reset for next cycle
        totalBuys = 0
        totalSells = 0
        cycleProfit = 0
      }
    }
  }

  // For any remaining position (partial sells that didn't trigger liquidation),
  // we have unrealized gains, not realized. So no additional profit added here.
  // The profit from partial sells is captured when the position is eventually liquidated.

  // Add ALL cash interest (regardless of reinvest setting)
  realized += computeCashInterest(config, trades, cashflows, asOfDate)

  // Add ALL dividends (regardless of reinvest setting)
  for (const div of dividends) {
    if (daysBetween(div.date, asOfDate) < 0) continue
    realized += div.amount_usd
  }

  // Subtract expenses if paid from fund
  const expenseFromFund = config.expense_from_fund !== false
  if (expenseFromFund) {
    for (const exp of expenses) {
      if (daysBetween(exp.date, asOfDate) < 0) continue
      realized -= exp.amount_usd
    }
  }

  return realized
}

/**
 * Computes the complete fund state at a given date.
 */
export function computeFundState(
  config: SubFundConfig,
  trades: Trade[],
  cashflows: CashFlow[],
  dividends: Dividend[],
  expenses: Expense[],
  actualValue: number,
  asOfDate: string
): FundState {
  // Cash funds have simplified state - value IS the cash balance
  if (config.fund_type === 'cash') {
    // For cash funds, compute interest earned on the cash balance
    const cashInterest = computeCashInterest(config, trades, cashflows, asOfDate)
    // start_input = principal (deposits minus withdrawals) = actualValue - interest
    // This ensures gain calculations only count interest, not the full cash balance
    const startInput = actualValue - cashInterest
    return {
      cash_available_usd: actualValue,
      expected_target_usd: 0,
      actual_value_usd: actualValue,
      start_input_usd: startInput,
      gain_usd: cashInterest,
      gain_pct: startInput > 0 && isFinite(cashInterest / startInput) ? cashInterest / startInput : 0,
      target_diff_usd: 0,
      cash_interest_usd: cashInterest,
      realized_gains_usd: cashInterest
    }
  }

  // Closed fund - return zeroed state
  if (config.status === 'closed') {
    return {
      cash_available_usd: 0,
      expected_target_usd: 0,
      actual_value_usd: actualValue,
      start_input_usd: 0,
      gain_usd: 0,
      gain_pct: 0,
      target_diff_usd: 0,
      cash_interest_usd: 0,
      realized_gains_usd: 0
    }
  }

  const startInput = computeStartInput(trades, asOfDate, config)
  const expectedTarget = computeExpectedTarget(config, trades, asOfDate)
  const cashAvailable = computeCashAvailable(config, trades, cashflows, dividends, expenses, asOfDate)
  const cashInterest = computeCashInterest(config, trades, cashflows, asOfDate)
  const realizedGains = computeRealizedGains(config, trades, cashflows, dividends, expenses, asOfDate)

  const gainUsd = startInput > 0 ? actualValue - startInput : 0
  const rawGainPct = startInput > 0 ? (actualValue / startInput) - 1 : 0
  const gainPct = isFinite(rawGainPct) ? rawGainPct : 0
  const targetDiff = actualValue - expectedTarget

  return {
    cash_available_usd: cashAvailable,
    expected_target_usd: expectedTarget,
    actual_value_usd: actualValue,
    start_input_usd: startInput,
    gain_usd: gainUsd,
    gain_pct: gainPct,
    target_diff_usd: targetDiff,
    cash_interest_usd: cashInterest,
    realized_gains_usd: realizedGains
  }
}

/**
 * Computes historical performance metrics for a closed fund.
 * Used to show overall return, APY, etc. for funds that have been liquidated.
 */
export function computeClosedFundMetrics(
  trades: Trade[],
  dividends: Dividend[],
  expenses: Expense[],
  cashInterest: number,
  startDate: string,
  endDate: string
): ClosedFundMetrics {
  let totalInvested = 0
  let totalReturned = 0

  for (const trade of trades) {
    if (trade.type === 'buy') {
      totalInvested += trade.amount_usd
    } else {
      totalReturned += trade.amount_usd
    }
  }

  let totalDividends = 0
  for (const div of dividends) {
    totalDividends += div.amount_usd
  }

  let totalExpenses = 0
  for (const exp of expenses) {
    totalExpenses += exp.amount_usd
  }

  const netGain = totalReturned + totalDividends + cashInterest - totalExpenses - totalInvested

  // Return percentage = profit / total invested
  // This shows the return on the capital that was put in
  const returnPct = totalInvested > 0 ? netGain / totalInvested : 0

  const durationDays = daysBetween(startDate, endDate)

  // APY = (1 + returnPct)^(365/days) - 1
  // For very short periods, avoid division issues
  const clampedReturnPct = Math.max(-0.99, returnPct)
  const apy = durationDays > 3
    ? Math.pow(1 + clampedReturnPct, DAYS_PER_YEAR / durationDays) - 1
    : clampedReturnPct

  return {
    total_invested_usd: totalInvested,
    total_returned_usd: totalReturned,
    total_dividends_usd: totalDividends,
    total_cash_interest_usd: cashInterest,
    total_expenses_usd: totalExpenses,
    net_gain_usd: netGain,
    return_pct: returnPct,
    apy,
    start_date: startDate,
    end_date: endDate,
    duration_days: durationDays
  }
}

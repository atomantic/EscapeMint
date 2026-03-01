import type { FundData } from '@escapemint/storage'
import {
  computeDerivativesEntriesState,
  isCashFund as checkIsCashFund,
  isDerivativesFund as checkIsDerivativesFund
} from '@escapemint/engine'

/**
 * Computed metrics for the latest state of a fund.
 * These are calculated once and used by both fund detail and platform aggregation.
 */
export interface FundComputedMetrics {
  // Core values
  fundSize: number
  currentValue: number
  cash: number
  totalInvested: number

  // Cumulative totals
  sumDividends: number
  sumExpenses: number
  sumCashInterest: number
  sumExtracted: number

  // Gains
  unrealized: number
  realized: number
  liquidPnl: number

  // APY calculations
  realizedApy: number
  liquidApy: number

  // Tracking
  daysActive: number
  costBasis: number

  // Derivatives-specific fields (only present for derivatives funds)
  position?: number           // Net contracts held
  avgEntry?: number          // Average entry price
  marginBalance?: number     // Total margin balance
  sumFunding?: number        // Cumulative funding payments
  sumRebates?: number        // Cumulative rebates
  sumFees?: number           // Cumulative trading fees
}

/**
 * Compute the final metrics for a fund by processing all entries.
 * This matches the calculation logic in FundDetail.tsx.
 */
export function computeFundFinalMetrics(fund: FundData): FundComputedMetrics {
  // Sort entries chronologically (API allows out-of-order entries)
  const entries = [...fund.entries].sort((a, b) => a.date.localeCompare(b.date))
  const config = fund.config
  const isCashFund = checkIsCashFund(config.fund_type)
  const isDerivativesFund = checkIsDerivativesFund(config.fund_type)
  const isAccumulate = config.accumulate ?? false
  const manageCash = config.manage_cash !== false

  // Handle derivatives funds separately
  if (isDerivativesFund && entries.length > 0) {
    const contractMultiplier = config.contract_multiplier ?? 0.01
    const maintenanceMarginRate = config.maintenance_margin_rate ?? 0.20
    const initialMarginRate = config.initial_margin_rate ?? 0.25
    const derivStates = computeDerivativesEntriesState(entries, contractMultiplier, maintenanceMarginRate, undefined, initialMarginRate)
    const lastState = derivStates[derivStates.length - 1]

    if (lastState) {
      // Compute cycle-aware active days (matches client-side FundDetail.tsx)
      // Track BUY/SELL cycles from entries: BUY starts a cycle, SELL ends it
      // For derivatives, entry.value is always 0, so every SELL is treated as full liquidation
      let cycleStartDate: string | null = null
      let cumulativeActiveDays = 0
      for (const entry of entries) {
        const entryTime = new Date(entry.date).getTime()
        if (entry.action === 'BUY' && entry.amount) {
          if (!cycleStartDate) cycleStartDate = entry.date
        } else if (entry.action === 'SELL' && entry.amount) {
          // In the derivatives branch, every SELL ends the cycle (positions close fully)
          if (cycleStartDate) {
            cumulativeActiveDays += Math.max(0,
              (entryTime - new Date(cycleStartDate).getTime()) / (1000 * 60 * 60 * 24)
            )
            cycleStartDate = null
          }
        }
      }
      // Add current open cycle if still active
      const currentCycleDays = cycleStartDate
        ? Math.max(0, (new Date(lastState.date).getTime() - new Date(cycleStartDate).getTime()) / (1000 * 60 * 60 * 24))
        : 0
      const hasAnyActiveHistory = cycleStartDate !== null || cumulativeActiveDays > 0
      const daysActive = hasAnyActiveHistory
        ? Math.max(1, cumulativeActiveDays + currentCycleDays)
        : Math.max(1, (new Date(lastState.date).getTime() - new Date(entries[0]!.date).getTime()) / (1000 * 60 * 60 * 24))

      // Derivatives Liquid P&L = Realized + Unrealized + Funding + Interest + Rebates
      const realized = lastState.realizedPnl
      const liquidPnl = realized + lastState.unrealizedPnl +
        lastState.sumFunding + lastState.sumInterest + lastState.sumRebates

      // Use marginBalance - liquidPnl as capital base (matches client-side FundDetail.tsx)
      // costBasis is 0 when position is closed, so it's unreliable as denominator
      const capitalBase = lastState.marginBalance - liquidPnl
      const denominator = capitalBase > 0 ? capitalBase : lastState.marginBalance

      // Calculate APY using same formula as client-side
      let realizedApy = 0
      let liquidApy = 0
      if (daysActive > 0 && denominator > 0) {
        const realizedPlusFunding = realized + lastState.sumFunding +
          lastState.sumInterest + lastState.sumRebates
        const realizedReturnPct = realizedPlusFunding / denominator
        const clampedRealizedPct = Math.max(-0.99, realizedReturnPct)
        realizedApy = Math.pow(1 + clampedRealizedPct, 365 / daysActive) - 1

        const liquidReturnPct = liquidPnl / denominator
        const clampedLiquidPct = Math.max(-0.99, liquidReturnPct)
        liquidApy = Math.pow(1 + clampedLiquidPct, 365 / daysActive) - 1
      }

      return {
        fundSize: lastState.marginBalance,
        currentValue: lastState.equity,
        cash: lastState.availableFunds,  // Available funds = marginBalance - marginLocked
        totalInvested: lastState.costBasis,
        sumDividends: 0,
        sumExpenses: lastState.sumFees,
        sumCashInterest: lastState.sumInterest,
        sumExtracted: lastState.realizedPnl,
        unrealized: lastState.unrealizedPnl,
        realized,
        liquidPnl,
        realizedApy,
        liquidApy,
        daysActive,
        costBasis: lastState.costBasis,
        // Derivatives-specific fields
        position: lastState.position,
        avgEntry: lastState.avgEntry,
        marginBalance: lastState.marginBalance,
        sumFunding: lastState.sumFunding,
        sumRebates: lastState.sumRebates,
        sumFees: lastState.sumFees
      }
    }
  }

  // Initialize tracking variables
  let totalBuys = 0
  let totalSells = 0
  let sumShares = 0
  let costBasis = 0
  let sumDividends = 0
  let sumExpenses = 0
  let sumCashInterest = 0
  let sumExtracted = 0
  // For TWAP calculation (trading funds - time-weighted average position)
  let twapNumerator = 0
  let twapLastDate: string | null = null

  // For TWAB calculation (cash funds)
  let twabNumerator = 0
  let lastCashBalance = 0
  let lastDate: string | null = null

  // Active days tracking: only count time when capital is deployed
  let cycleStartDate: string | null = null
  let cumulativeActiveDays = 0
  let hadFirstBuy = false

  // Process all entries
  for (const entry of entries) {
    // Track days between entries for TWAB (fractional to match client precision)
    if (lastDate && isCashFund) {
      const daysBetween = Math.max(0,
        (new Date(entry.date).getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24)
      )
      twabNumerator += lastCashBalance * daysBetween
    }

    // Track shares
    if (entry.shares !== undefined) {
      if (entry.action === 'BUY') sumShares += entry.shares
      else if (entry.action === 'SELL') sumShares -= entry.shares
    }

    // Track cumulative income/expenses
    if (entry.dividend) sumDividends += entry.dividend
    if (entry.expense) sumExpenses += entry.expense
    if (entry.cash_interest) sumCashInterest += entry.cash_interest

    // Accumulate TWAP before processing this entry's action (use costBasis from before this entry)
    if (!isCashFund && twapLastDate && cycleStartDate) {
      const daysBetween = Math.max(0,
        (new Date(entry.date).getTime() - new Date(twapLastDate).getTime()) / (1000 * 60 * 60 * 24)
      )
      twapNumerator += costBasis * daysBetween
    }
    if (cycleStartDate) twapLastDate = entry.date

    // Process buys and sells
    if (entry.action === 'BUY' && entry.amount) {
      totalBuys += entry.amount
      costBasis += entry.amount
      // Start active cycle on first BUY (or restart after liquidation)
      if (!cycleStartDate) {
        cycleStartDate = entry.date
        twapLastDate = entry.date
        hadFirstBuy = true
      }
    } else if (entry.action === 'SELL' && entry.amount) {
      // Check for full liquidation
      const hasShareTracking = entry.shares !== undefined && entry.shares !== 0
      const sharesLiquidated = hasShareTracking && Math.abs(sumShares) < 0.0001
      const valueLiquidated = (entry.value ?? 0) > 0 && (entry.value ?? 0) <= entry.amount + 0.01
      const isFullLiquidation = sharesLiquidated || valueLiquidated

      // Calculate extracted profit
      let extracted = 0
      if (isFullLiquidation) {
        extracted = entry.amount - costBasis
        costBasis = 0
        totalBuys = 0
        totalSells = 0
        // Freeze active days on full liquidation
        if (cycleStartDate) {
          const cycleDays = Math.max(0,
            (new Date(entry.date).getTime() - new Date(cycleStartDate).getTime()) / (1000 * 60 * 60 * 24)
          )
          cumulativeActiveDays += cycleDays
          cycleStartDate = null
        }
      } else if (isAccumulate) {
        // Accumulate mode: entire sell is profit extraction
        extracted = entry.amount
      } else {
        // Harvest mode: proportional cost basis
        const sellProportion = entry.amount / ((entry.value ?? 0) + entry.amount)
        const costBasisReturned = costBasis * sellProportion
        extracted = entry.amount - costBasisReturned
        costBasis -= costBasisReturned
        totalSells += entry.amount
      }
      sumExtracted += extracted

      // In accumulate mode, partial sells don't reduce totalSells
      if (!isAccumulate || isFullLiquidation) {
        if (!isFullLiquidation) totalSells += entry.amount
      }
    }

    // Update TWAB tracking
    if (isCashFund) {
      lastCashBalance = entry.cash ?? entry.value ?? 0
    }
    lastDate = entry.date
  }

  // Get latest entry for final values
  const latestEntry = entries[entries.length - 1]
  const today = new Date().toISOString().slice(0, 10)
  const endDate = latestEntry?.date ?? today

  // Add final TWAP period (from last entry to endDate)
  if (!isCashFund && twapLastDate && cycleStartDate) {
    const finalDays = Math.max(0,
      (new Date(endDate).getTime() - new Date(twapLastDate).getTime()) / (1000 * 60 * 60 * 24)
    )
    twapNumerator += costBasis * finalDays
  }

  // Compute active days: cumulative completed cycles + current cycle (if active)
  // For cash/derivatives funds or funds that never had a BUY, fall back to calendar days
  let daysActive: number
  if (hadFirstBuy) {
    const currentCycleDays = cycleStartDate
      ? Math.max(0, (new Date(endDate).getTime() - new Date(cycleStartDate).getTime()) / (1000 * 60 * 60 * 24))
      : 0
    daysActive = Math.max(1, cumulativeActiveDays + currentCycleDays)
  } else {
    // Cash funds, derivatives, or funds with no BUYs: use first entry to last entry
    const startDate = entries.length > 0 ? entries[0]!.date : today
    daysActive = Math.max(1,
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
    )
  }

  // Calculate final values
  const netInvested = Math.max(0, totalBuys - totalSells)

  let fundSize: number
  let currentValue: number
  let cash: number

  if (config.status === 'closed') {
    fundSize = 0
    currentValue = 0
    cash = 0
  } else if (isCashFund) {
    // For cash funds: fund_size = cash = currentValue
    cash = latestEntry?.cash ?? latestEntry?.fund_size ?? latestEntry?.value ?? 0
    fundSize = latestEntry?.fund_size ?? cash
    currentValue = cash
  } else {
    // For trading funds with manage_cash=false:
    //   Harvest mode: fundSize = netInvested (buys - sells = capital still deployed)
    //   Accumulate mode: use entry's fund_size (netInvested grows forever since sells
    //     don't reduce totalSells in accumulate mode, making it meaningless as fund size)
    // For trading funds with manage_cash=true, use entry's fund_size or config
    if (!manageCash) {
      fundSize = isAccumulate
        ? (latestEntry?.fund_size ?? netInvested)
        : netInvested
    } else {
      fundSize = latestEntry?.fund_size ?? config.fund_size_usd
    }
    // Calculate post-action value (entry.value is pre-action)
    // After a BUY, the equity value increases by the buy amount
    // After a SELL, the equity value decreases by the sell amount
    let postActionValue = latestEntry?.value ?? 0
    if (latestEntry?.action === 'BUY' && latestEntry?.amount) {
      postActionValue += latestEntry.amount
    } else if (latestEntry?.action === 'SELL' && latestEntry?.amount) {
      postActionValue = Math.max(0, postActionValue - latestEntry.amount)
    }
    currentValue = postActionValue
    if (!manageCash) {
      cash = 0
    } else {
      cash = latestEntry?.cash ?? Math.max(0, fundSize - netInvested)
    }
  }

  // Calculate unrealized and realized gains
  // For cash funds: no unrealized (cash doesn't appreciate), all gains are realized (interest)
  // For trading funds: unrealized = asset value - cost basis
  const unrealized = isCashFund ? 0 : (currentValue - costBasis)

  const realized = isCashFund
    ? sumCashInterest - sumExpenses
    : sumCashInterest + sumDividends + sumExtracted - sumExpenses

  const liquidPnl = unrealized + realized

  // Calculate APY
  let realizedApy = 0
  let liquidApy = 0

  // daysActive is always >= 1 (clamped above), so APY is always calculable
  if (isCashFund) {
    // Cash fund APY: based on TWAB
    const twab = twabNumerator / daysActive
    const denominator = twab > 0 ? twab : (fundSize > 0 ? fundSize : 1)
    if (Math.abs(realized) >= 0.01) {
      const returnPct = realized / denominator
      const clampedPct = Math.max(-0.99, returnPct)
      realizedApy = Math.pow(1 + clampedPct, 365 / daysActive) - 1
      liquidApy = realizedApy
    }
  } else {
    // Trading fund APY: use TWAP (time-weighted average position) as denominator
    const twap = twapNumerator / daysActive
    const denominator = twap > 0 ? twap : (costBasis > 0 ? costBasis : 1)
    if (denominator > 0) {
      const realizedReturnPct = realized / denominator
      const clampedRealizedPct = Math.max(-0.99, realizedReturnPct)
      realizedApy = Math.pow(1 + clampedRealizedPct, 365 / daysActive) - 1

      const liquidReturnPct = liquidPnl / denominator
      const clampedLiquidPct = Math.max(-0.99, liquidReturnPct)
      liquidApy = Math.pow(1 + clampedLiquidPct, 365 / daysActive) - 1
    }
  }

  return {
    fundSize,
    currentValue,
    cash,
    totalInvested: isCashFund ? cash : netInvested,
    sumDividends,
    sumExpenses,
    sumCashInterest,
    sumExtracted,
    unrealized,
    realized,
    liquidPnl,
    realizedApy,
    liquidApy,
    daysActive,
    costBasis
  }
}

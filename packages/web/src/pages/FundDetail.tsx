import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom'
import * as d3 from 'd3'
import { toast } from 'sonner'
import { fetchFund, fetchFundState, updateFundConfig, type FundDetail as FundDetailType, type FundStateResponse, type FundEntry, type ChartBounds } from '../api/funds'
import { fetchBtcPrice } from '../api/utils'
import { AddEntryModal } from '../components/AddEntryModal'
import { EditEntryModal } from '../components/EditEntryModal'
import { EditFundPanel } from '../components/EditFundPanel'
import { FundCharts } from '../components/FundCharts'
import { ChartSettings } from '../components/ChartSettings'
import { SIDEBAR_TOGGLED_EVENT } from '../components/Layout'
import { EntriesTable, type ComputedEntry, type ColumnId } from '../components/entriesTable'
import { CoinbaseScrapeButton } from '../components/CoinbaseScrapeButton'
import { formatCurrency, formatPercent, formatLocalDate } from '../utils/format'
import {
  isCashFund as checkIsCashFund,
  isDerivativesFund as checkIsDerivativesFund,
  getFundTypeFeatures
} from '@escapemint/engine'

// Chart data point for P&L and APY charts
interface ChartDataPoint {
  date: Date
  liquidPnl: number
  realizedPnl: number
  liquidApy: number
  realizedApy: number
}

export function FundDetail() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const isEditing = location.pathname.endsWith('/edit')
  const isAdding = location.pathname.endsWith('/add')

  const [fund, setFund] = useState<FundDetailType | null>(null)
  const [state, setState] = useState<FundStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddEntry, setShowAddEntry] = useState(isAdding)
  const [editingEntry, setEditingEntry] = useState<{ index: number; entry: FundEntry; calculatedFundSize?: number } | null>(null)
  const apyChartRef = useRef<SVGSVGElement>(null)
  const pnlChartRef = useRef<SVGSVGElement>(null)
  const [chartResize, setChartResize] = useState(0)
  const [apyBounds, setApyBounds] = useState<ChartBounds>({})
  const [pnlBounds, setPnlBounds] = useState<ChartBounds>({})
  const [chartsCollapsed, setChartsCollapsed] = useState(false)

  // Derived state using centralized fund type helpers
  const isDerivativesFund = checkIsDerivativesFund(fund?.config.fund_type)
  const isCashFund = checkIsCashFund(fund?.config.fund_type)
  const features = fund ? getFundTypeFeatures(fund.config.fund_type ?? 'stock') : getFundTypeFeatures('stock')

  // Resize handler for charts - listens for window resize and sidebar toggle
  useEffect(() => {
    const handleResize = () => setChartResize(n => n + 1)
    window.addEventListener('resize', handleResize)
    window.addEventListener(SIDEBAR_TOGGLED_EVENT, handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener(SIDEBAR_TOGGLED_EVENT, handleResize)
    }
  }, [])

  // Sync chart bounds and collapsed state from fund config when fund loads
  useEffect(() => {
    if (!fund) return
    setApyBounds(fund.config.chart_bounds?.apy ?? {})
    setPnlBounds(fund.config.chart_bounds?.pnl ?? {})
    setChartsCollapsed(fund.config.charts_collapsed ?? false)
  }, [fund])

  // Update APY chart bounds
  const updateApyBounds = useCallback(async (bounds: ChartBounds) => {
    setApyBounds(bounds)
    if (!id || !fund) return
    const newChartBounds: Record<string, ChartBounds> = { ...fund.config.chart_bounds, apy: bounds }
    if (bounds.yMin === undefined && bounds.yMax === undefined) {
      delete newChartBounds.apy
    }
    if (Object.keys(newChartBounds).length > 0) {
      await updateFundConfig(id, { chart_bounds: newChartBounds })
    } else {
      await updateFundConfig(id, { chart_bounds: {} })
    }
  }, [id, fund])

  // Update P&L chart bounds
  const updatePnlBounds = useCallback(async (bounds: ChartBounds) => {
    setPnlBounds(bounds)
    if (!id || !fund) return
    const newChartBounds: Record<string, ChartBounds> = { ...fund.config.chart_bounds, pnl: bounds }
    if (bounds.yMin === undefined && bounds.yMax === undefined) {
      delete newChartBounds.pnl
    }
    if (Object.keys(newChartBounds).length > 0) {
      await updateFundConfig(id, { chart_bounds: newChartBounds })
    } else {
      await updateFundConfig(id, { chart_bounds: {} })
    }
  }, [id, fund])

  // Toggle charts collapsed state
  const toggleChartsCollapsed = useCallback(async () => {
    const newValue = !chartsCollapsed
    setChartsCollapsed(newValue)
    // Trigger chart redraw after expanding (DOM needs time to render)
    if (!newValue) {
      setTimeout(() => setChartResize(n => n + 1), 50)
    }
    if (!id) return
    await updateFundConfig(id, { charts_collapsed: newValue })
  }, [id, chartsCollapsed])

  // Toggle audited status
  const toggleAudited = useCallback(async () => {
    if (!id || !fund) return
    const newAuditedValue: string = fund.config.audited ? '' : formatLocalDate(new Date())
    const result = await updateFundConfig(id, { audited: newAuditedValue })
    if (result.error) {
      toast.error(result.error)
    } else {
      setFund(prev => {
        if (!prev) return null
        return { ...prev, config: { ...prev.config, audited: newAuditedValue } }
      })
      toast.success(newAuditedValue ? 'Fund marked as audited' : 'Audit status cleared')
    }
  }, [id, fund])

  const loadData = useCallback(async (showLoading = true) => {
    if (!id) return

    if (showLoading) setLoading(true)

    const fundResult = await fetchFund(id)

    if (fundResult.error) {
      toast.error(fundResult.error)
      if (showLoading) setLoading(false)
      return
    }

    setFund(fundResult.data ?? null)

    // For derivatives funds, fetch BTC price for accurate mark price calculations
    const isDerivatives = checkIsDerivativesFund(fundResult.data?.config.fund_type)
    let markPrice: number | undefined
    if (isDerivatives) {
      const btcPrice = await fetchBtcPrice()
      if (btcPrice) {
        markPrice = btcPrice
      } else {
        toast.warning('Unable to fetch BTC price. Derivatives metrics may be inaccurate.')
      }
    }
    const stateResult = await fetchFundState(id, markPrice)

    if (stateResult.error) {
      toast.error(stateResult.error)
    } else if (stateResult.data) {
      setState(stateResult.data)
    }

    if (showLoading) setLoading(false)
  }, [id])

  // Handle inline fund updates from edit/delete operations
  // If fund data is provided, update state directly; otherwise fall back to full reload
  const handleFundUpdate = useCallback(async (updatedFund?: FundDetailType) => {
    if (updatedFund) {
      setFund(updatedFund)
      // Also refresh state for recommendation updates
      if (id) {
        // For derivatives funds, fetch and pass current mark price
        const isDerivatives = checkIsDerivativesFund(updatedFund.config.fund_type)
        const btcPrice = isDerivatives ? await fetchBtcPrice() : null
        const markPrice = isDerivatives && btcPrice ? btcPrice : undefined
        const stateResult = await fetchFundState(id, markPrice)
        if (stateResult.error) {
          toast.error(stateResult.error)
        } else if (stateResult.data) {
          setState(stateResult.data)
        }
      }
    } else {
      await loadData()
    }
  }, [id, loadData])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Compute running totals and metrics for each entry
  const computedEntries = useMemo(() => {
    if (!fund) return []

    // Track original index before sorting
    const entriesWithOriginalIndex = fund.entries.map((entry, originalIndex) => ({
      ...entry,
      _originalIndex: originalIndex
    }))
    const sorted = entriesWithOriginalIndex.sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
    )

    // Start date derived from first entry (no config dependency)
    const firstEntryDate = sorted.length > 0 ? new Date(sorted[0].date) : new Date()

    // For derivatives funds, use server-computed state if available
    const isDerivativesFund = checkIsDerivativesFund(fund.config.fund_type)
    const derivativesState = state?.derivativesEntriesState

    let totalBuys = 0
    let totalSells = 0 // For invested calculation (accumulate mode: only liquidations)
    let sumSellProceeds = 0 // For APY calculation (all sell amounts)
    let sumDividends = 0
    let sumExpenses = 0
    let sumCashInterest = 0
    let sumDeposits = 0
    let sumWithdrawals = 0
    let sumShares = 0
    let lastNonZeroValue = 0
    let lastApy = 0
    let costBasis = 0
    let sumExtracted = 0
    let previousCyclesGain = 0 // Realized gains from previous liquidation cycles

    // Active days tracking: only count time with capital deployed
    let cycleStartDate: Date | null = null
    let cumulativeActiveDays = 0

    // For cash fund TWAB (Time-Weighted Average Balance) calculation
    let twabNumerator = 0 // sum of (balance * days)
    let lastCashBalance = 0
    let lastEntryDate = firstEntryDate

    // For trading fund TWAP (Time-Weighted Average Position) calculation
    let twapNumerator = 0
    let twapLastDate: Date | null = null

    return sorted.map((entry, index) => {
      const entryDate = new Date(entry.date)

      // For cash fund TWAB: add previous balance * days since last entry
      if (checkIsCashFund(fund.config.fund_type) && index > 0) {
        const daysSinceLast = Math.max(0, (entryDate.getTime() - lastEntryDate.getTime()) / (1000 * 60 * 60 * 24))
        twabNumerator += lastCashBalance * daysSinceLast
      }
      lastEntryDate = entryDate
      // Update lastCashBalance with this entry's ending balance (will be used for next iteration)
      lastCashBalance = entry.cash ?? entry.value ?? 0

      // Track DEPOSIT/WITHDRAW for fund_size calculation
      if (entry.action === 'DEPOSIT' && entry.amount) {
        sumDeposits += entry.amount
      } else if (entry.action === 'WITHDRAW' && entry.amount) {
        sumWithdrawals += entry.amount
      }

      // Track dividends, expenses, cash interest, shares FIRST (they affect this row's APY and fund_size)
      // All values are positive in data; apply sign based on context
      if (entry.dividend) sumDividends += Math.abs(entry.dividend)
      if (entry.expense) sumExpenses += Math.abs(entry.expense)
      if (entry.cash_interest) sumCashInterest += Math.abs(entry.cash_interest)
      // Shares: BUY adds, SELL subtracts
      if (entry.shares) {
        const sharesAbs = Math.abs(entry.shares)
        sumShares += entry.action === 'SELL' ? -sharesAbs : sharesAbs
      }

      // Calculate fund_size: use manual override if set, otherwise calculate dynamically
      // For cash funds, fund_size IS the cash balance (no separate investment pool)
      // For non-cash managing trading funds, fund_size = invested amount (calculated after buy/sell processing below)
      // For cash managing trading funds, fund_size = base + deposits - withdrawals + dividends + interest - expenses
      const isCashFundType = checkIsCashFund(fund.config.fund_type)
      const expenseFromFund = fund.config.expense_from_fund !== false
      let calculatedFundSize: number
      if (isCashFundType) {
        // For cash funds, fund_size equals the cash balance
        calculatedFundSize = entry.cash ?? entry.value
      } else {
        // For trading funds with cash management, use the standard formula
        // Non-cash managing funds will be recalculated below after buy/sell processing
        calculatedFundSize = fund.config.fund_size_usd
          + sumDeposits - sumWithdrawals
          + sumDividends + sumCashInterest - (expenseFromFund ? sumExpenses : 0)
      }
      // For cash funds, always use calculated fund_size
      let fundSize = isCashFundType ? calculatedFundSize : (entry.fund_size ?? calculatedFundSize)

      // Calculate APY BEFORE processing this row's buy/sell action
      // Total return = currentValue + priorSellProceeds + dividends + interest - expenses - totalBuys + previousCyclesGain
      const totalMoneyOut = entry.value + sumSellProceeds + sumDividends + sumCashInterest - sumExpenses + previousCyclesGain
      const totalReturn = totalMoneyOut - totalBuys

      // Active days: cumulative completed cycles + current cycle (if active)
      // For cash funds or entries before first BUY, fall back to calendar days from first entry
      const calendarDays = (entryDate.getTime() - firstEntryDate.getTime()) / (1000 * 60 * 60 * 24)
      const currentCycleDays = cycleStartDate
        ? (entryDate.getTime() - cycleStartDate.getTime()) / (1000 * 60 * 60 * 24)
        : 0
      const hasActiveCycle = cycleStartDate !== null
      const hasAnyActiveHistory = hasActiveCycle || cumulativeActiveDays > 0
      const activeDays = Math.max(1, hasAnyActiveHistory
        ? cumulativeActiveDays + currentCycleDays
        : calendarDays)
      const isFirstEntry = index === 0

      // For APY calculation, use current value if > 0, otherwise use last non-zero value
      const denominatorValue = entry.value > 0 ? entry.value : lastNonZeroValue
      const returnPct = denominatorValue > 0 ? totalReturn / denominatorValue : 0
      // Annualize: APY = (1 + returnPct)^(365/days) - 1
      // Clamp returnPct to avoid NaN from Math.pow with negative base
      const clampedReturnPct = Math.max(-0.99, returnPct)
      let apy = isFirstEntry ? 0 : (activeDays > 0 ? Math.pow(1 + clampedReturnPct, 365 / activeDays) - 1 : 0)

      // If value is 0 (closed fund), preserve the last valid APY
      if (entry.value === 0 && lastApy !== 0) {
        apy = lastApy
      }

      // Track last non-zero value and APY for closed fund handling
      if (entry.value > 0) {
        lastNonZeroValue = entry.value
        lastApy = apy
      }

      // Calculate cash BEFORE the action (what was available before BUY/SELL)
      // If manage_cash is false, cash is always 0
      const manageCash = fund.config.manage_cash ?? true
      const netInvestedBefore = totalBuys - totalSells
      const cash = !manageCash ? 0 : (fundSize === 0 ? 0 : Math.max(0, fundSize - netInvestedBefore))

      // Accumulate TWAP before processing this entry's action (use costBasis from before this entry)
      if (!isCashFundType && twapLastDate && cycleStartDate) {
        const daysBetween = Math.max(0, (entryDate.getTime() - twapLastDate.getTime()) / (1000 * 60 * 60 * 24))
        twapNumerator += costBasis * daysBetween
      }
      if (cycleStartDate) twapLastDate = entryDate

      // NOW process this row's buy/sell action (for next iteration and display)
      let extracted = 0
      const isAccumulate = fund.config.accumulate

      if (entry.action === 'BUY' && entry.amount) {
        totalBuys += entry.amount
        costBasis += entry.amount
        // Start active cycle on first BUY (or restart after liquidation)
        if (!cycleStartDate) {
          cycleStartDate = entryDate
          twapLastDate = entryDate
        }
      } else if (entry.action === 'SELL' && entry.amount) {
        // Check if this is a full liquidation
        // Use sumShares check if fund has share tracking, AND value-based check as fallback
        // Either condition triggers liquidation (share tracking can accumulate errors over time)
        const hasShareTracking = entry.shares !== undefined && entry.shares !== 0
        const sharesLiquidated = hasShareTracking && Math.abs(sumShares) < 0.0001
        // Only use value-based liquidation when value > 0 (value=0 means
        // "unknown" for imported entries, not "position is worthless")
        const valueLiquidated = entry.value > 0 && entry.value <= entry.amount + 0.01
        // For derivatives funds, value is always 0 by design, so every SELL
        // is treated as a full liquidation for cycle tracking purposes
        const isFullLiquidation = isDerivativesFund || sharesLiquidated || valueLiquidated

        // Always track sell proceeds for APY calculation
        sumSellProceeds += entry.amount

        // In accumulate mode, sells are profit extraction and don't reduce totalSells
        // unless it's a full position exit. In harvest mode, all sells reduce invested.
        if (!isAccumulate || isFullLiquidation) {
          totalSells += entry.amount
        }

        // Calculate extracted profit from this sell
        if (isFullLiquidation) {
          // Full liquidation - extract remaining profit
          extracted = entry.amount - costBasis
          // Capture the realized gain from this cycle before resetting
          previousCyclesGain += extracted
          costBasis = 0
          // Reset running totals for next investment cycle
          totalBuys = 0
          totalSells = 0
          sumSellProceeds = 0
          // Freeze active days on full liquidation
          if (cycleStartDate) {
            cumulativeActiveDays += Math.max(0, (entryDate.getTime() - cycleStartDate.getTime()) / (1000 * 60 * 60 * 24))
            cycleStartDate = null
          }
        } else {
          // Partial sell
          if (isAccumulate) {
            // Accumulate mode: entire sell amount is profit extraction (cost basis unchanged)
            extracted = entry.amount
          } else {
            // Harvest mode: proportional cost basis
            const sellProportion = entry.amount / (entry.value + entry.amount)
            const costBasisReturned = costBasis * sellProportion
            extracted = entry.amount - costBasisReturned
            costBasis -= costBasisReturned
          }
        }
        sumExtracted += extracted
      }

      // Net invested = buys - sells (what's still "in" the fund from cash perspective)
      // In accumulate mode, partial sells don't reduce invested (they're profit extraction)
      // Cap at 0 - can't have negative invested
      const netInvested = Math.max(0, totalBuys - totalSells)

      // For non-cash managing funds, fund_size = invested amount (override the earlier calculation)
      if (!manageCash && !isCashFundType) {
        fundSize = netInvested
      }

      // Data integrity check: invested exceeds fund size (purchased without available cash)
      // Use small tolerance (1 cent) for floating point precision
      // Skip check for non-cash managing funds (they don't maintain a cash pool)
      // Skip for derivatives funds: notional trade value legitimately exceeds margin balance due to leverage
      const hasIntegrityIssue = !isDerivativesFund && manageCash && fundSize > 0 && netInvested > fundSize + 0.01

      // Data integrity check: margin borrowed exceeds margin available (margin call situation)
      const marginBorrowed = entry.margin_borrowed ?? 0
      const marginAvailable = entry.margin_available ?? 0
      const hasMarginIntegrityIssue = marginBorrowed > 0 && marginAvailable > 0 && marginBorrowed > marginAvailable + 0.01

      // Post-action cash (what's available AFTER this entry's action)
      const postActionCash = !manageCash ? 0 : (fundSize === 0 ? 0 : Math.max(0, fundSize - netInvested))

      // Post-action equity value (entry.value is pre-action)
      let postActionValue = entry.value
      if (entry.action === 'BUY' && entry.amount) {
        postActionValue = entry.value + entry.amount
      } else if (entry.action === 'SELL' && entry.amount) {
        postActionValue = Math.max(0, entry.value - entry.amount)
      }

      // Unrealized gain = post-action asset value - cost basis
      const unrealized = postActionValue - costBasis

      // APY calculation depends on fund type
      const localIsCashFund = checkIsCashFund(fund.config.fund_type)

      // Realized gain calculation differs by fund type
      // For cash funds: only interest - expenses (no dividends or extractions apply)
      // For trading funds: interest + dividends + extracted profits - expenses
      const realized = localIsCashFund
        ? sumCashInterest - sumExpenses
        : sumCashInterest + sumDividends + sumExtracted - sumExpenses

      // Liquid P&L = unrealized + realized (total paper + real gains)
      const liquidPnl = unrealized + realized
      let realizedApy = 0
      let liquidApy = 0

      if (localIsCashFund) {
        // Cash fund APY: based on interest earned minus expenses
        // Use Time-Weighted Average Balance (TWAB) as denominator for accurate APY
        if (Math.abs(realized) < 0.01 || isFirstEntry) {
          realizedApy = 0
          liquidApy = 0
        } else {
          // Calculate TWAB: sum(balance * days) / total_days
          // twabNumerator already accumulated up to this entry
          const twab = activeDays > 0 ? twabNumerator / activeDays : lastCashBalance

          // Use TWAB as denominator, fall back to current balance if TWAB is 0
          const cashDenominator = twab > 0 ? twab : (fundSize > 0 ? fundSize : 1)

          const cashReturnPct = realized / cashDenominator
          // APY = (1 + return)^(365/days) - 1
          const clampedCashPct = Math.max(-0.99, cashReturnPct)
          realizedApy = activeDays > 0 ? Math.pow(1 + clampedCashPct, 365 / activeDays) - 1 : 0
          liquidApy = realizedApy
        }
      } else {
        // Trading fund APY: based on current cycle invested capital
        // This matches the platform page calculation and reflects actual strategy performance
        // For harvest mode funds that recycle capital, using netInvested (current cycle) gives
        // meaningful APY that represents the strategy's return rate on deployed capital
        // After full liquidation, use totalEverInvested so realized gains from previous cycles
        // are measured against cumulative capital deployed, not just the new cycle's investment
        const twap = activeDays > 0 ? twapNumerator / activeDays : costBasis
        const investedDenominator = twap > 0 ? twap : (costBasis > 0 ? costBasis : 1)

        // Calculate Realized APY (based only on realized gains relative to invested)
        const realizedReturnPct = investedDenominator > 0 ? realized / investedDenominator : 0
        const clampedRealizedPct = Math.max(-0.99, realizedReturnPct)
        realizedApy = isFirstEntry ? 0 : (activeDays > 0 ? Math.pow(1 + clampedRealizedPct, 365 / activeDays) - 1 : 0)

        // Liquid APY = based on liquid P&L relative to invested capital
        const liquidReturnPct = investedDenominator > 0 ? liquidPnl / investedDenominator : 0
        const clampedLiquidPct = Math.max(-0.99, liquidReturnPct)
        liquidApy = isFirstEntry ? 0 : (activeDays > 0 ? Math.pow(1 + clampedLiquidPct, 365 / activeDays) - 1 : 0)
      }

      // If value is 0 (closed fund), preserve the last valid APYs
      // But NOT for cash funds - a $0 pre-action value before DEPOSIT is normal
      // Preserve last APY for closed funds (value=0), but NOT for new cycle BUYs after liquidation
      if (!localIsCashFund && entry.value === 0 && lastApy !== 0 && entry.action !== 'BUY') {
        realizedApy = lastApy
        liquidApy = lastApy
      }

      // Base computed entry
      const baseEntry = {
        ...entry,
        originalIndex: entry._originalIndex,
        fundSize,
        totalInvested: netInvested,
        calculatedCash: cash,
        postActionCash,
        sumDividends,
        sumExpenses,
        sumCashInterest,
        extracted,
        sumExtracted,
        sumShares,
        unrealized,
        realized,
        liquidPnl,
        realizedApy,
        liquidApy,
        hasIntegrityIssue,
        hasMarginIntegrityIssue,
        // Derivatives fields (populated when isDerivativesFund)
        derivPosition: undefined as number | undefined,
        derivAvgEntry: undefined as number | undefined,
        derivMarginBalance: undefined as number | undefined,
        derivCostBasis: undefined as number | undefined,
        derivUnrealized: undefined as number | undefined,
        derivRealized: undefined as number | undefined,
        derivEquity: undefined as number | undefined,
        derivSumFunding: undefined as number | undefined,
        derivSumInterest: undefined as number | undefined,
        derivSumRebates: undefined as number | undefined,
        derivSumFees: undefined as number | undefined,
        derivNotionalValue: undefined as number | undefined,
        derivMarginLocked: undefined as number | undefined,
        derivMaintenanceMargin: undefined as number | undefined,
        derivAvailableFunds: undefined as number | undefined,
        derivMarginRatio: undefined as number | undefined,
        derivLeverage: undefined as number | undefined,
        derivLiquidationPrice: undefined as number | undefined,
        derivMarginHealth: undefined as number | undefined,
        derivDistanceToLiq: undefined as number | undefined
      }

      // For derivatives funds, merge server-computed state
      if (isDerivativesFund && derivativesState && derivativesState[index]) {
        const derivState = derivativesState[index]

        // Derivatives Liquid P&L = Realized + Unrealized + Funding + Interest + Rebates
        const derivLiquidPnl = derivState.realizedPnl + derivState.unrealizedPnl +
          derivState.sumFunding + derivState.sumInterest + derivState.sumRebates

        // For derivatives APY, we need to use margin deposits as the denominator
        // marginBalance includes: deposits + all income/expenses + realized P&L - withdrawals
        // So the "invested" amount is roughly marginBalance - all gains
        // A simpler approach: use the first entry's margin balance as the starting capital
        // Or use marginBalance - liquidPnl as the "cost basis" (capital deployed)
        const derivCapitalBase = derivState.marginBalance - derivLiquidPnl
        const derivDenominator = derivCapitalBase > 0 ? derivCapitalBase : derivState.marginBalance

        // Calculate derivatives-specific APY
        let derivRealizedApy = 0
        let derivLiquidApy = 0
        if (!isFirstEntry && activeDays > 0 && derivDenominator > 0) {
          // Realized APY: based on realized gains relative to capital
          const realizedPlusFunding = derivState.realizedPnl + derivState.sumFunding +
            derivState.sumInterest + derivState.sumRebates
          const realizedReturnPct = realizedPlusFunding / derivDenominator
          const clampedRealizedPct = Math.max(-0.99, realizedReturnPct)
          derivRealizedApy = Math.pow(1 + clampedRealizedPct, 365 / activeDays) - 1

          // Liquid APY: based on total P&L (including unrealized) relative to capital
          const liquidReturnPct = derivLiquidPnl / derivDenominator
          const clampedLiquidPct = Math.max(-0.99, liquidReturnPct)
          derivLiquidApy = Math.pow(1 + clampedLiquidPct, 365 / activeDays) - 1
        }

        // Use tracked cash (entry.cash) when available, otherwise use calculated marginBalance
        const effectiveCash = entry.cash ?? derivState.marginBalance
        const effectiveEquity = effectiveCash + derivState.unrealizedPnl
        const effectiveAvailableFunds = effectiveCash - derivState.marginLocked

        // Use liquidation price from server (which prefers scraped exchange value over calculated)
        // Only recalculate if server didn't provide a meaningful value (liqPrice <= 0 means fully collateralized or error)
        const contractMultiplier = fund.config.contract_multiplier ?? 0.01
        const notionalSize = derivState.position * contractMultiplier
        let effectiveLiqPrice = derivState.liquidationPrice
        let effectiveDistanceToLiq = derivState.distanceToLiquidation

        // Only recalculate if we don't have a valid liquidation price from the server
        // and we have the data needed to calculate one
        if (effectiveLiqPrice <= 0 && entry.cash !== undefined && derivState.position !== 0 && notionalSize !== 0) {
          const buffer = effectiveCash - derivState.maintenanceMargin
          // For longs (positive position): subtract buffer/notional from entry
          // For shorts (negative position): add buffer/|notional| to entry
          effectiveLiqPrice = derivState.avgEntry - (buffer / notionalSize)
          effectiveDistanceToLiq = derivState.avgEntry > 0
            ? (derivState.avgEntry - effectiveLiqPrice) / derivState.avgEntry
            : 0
        }

        return {
          ...baseEntry,
          // Override with derivatives-specific computed values
          derivPosition: derivState.position,
          derivAvgEntry: derivState.avgEntry,
          derivMarginBalance: derivState.marginBalance,
          derivCostBasis: derivState.costBasis,
          derivUnrealized: derivState.unrealizedPnl,
          derivRealized: derivState.realizedPnl,
          derivEquity: effectiveEquity,  // Use tracked cash for equity calculation
          derivSumFunding: derivState.sumFunding,
          derivSumInterest: derivState.sumInterest,
          derivSumRebates: derivState.sumRebates,
          derivSumFees: derivState.sumFees,
          // Margin tracking
          derivNotionalValue: derivState.notionalValue,
          derivMarginLocked: derivState.marginLocked,
          derivMaintenanceMargin: derivState.maintenanceMargin,
          derivAvailableFunds: effectiveAvailableFunds,  // Use tracked cash for available funds
          derivMarginRatio: derivState.marginRatio,
          derivLeverage: derivState.leverage,
          // Liquidation tracking - use recalculated values when we have tracked cash
          derivLiquidationPrice: effectiveLiqPrice,
          derivMarginHealth: derivState.marginHealth,
          derivDistanceToLiq: effectiveDistanceToLiq,
          // Also use derivatives values for fundSize and P&L
          fundSize: effectiveEquity,  // Account value = cash + unrealized
          realized: derivState.realizedPnl,
          unrealized: derivState.unrealizedPnl,
          liquidPnl: derivLiquidPnl,
          realizedApy: derivRealizedApy,
          liquidApy: derivLiquidApy
        }
      }

      return baseEntry
    })
  }, [fund, state])

  // Get the latest entry for displaying current metrics
  const latestEntry = useMemo(() => {
    if (computedEntries.length === 0) return null
    return computedEntries[computedEntries.length - 1]
  }, [computedEntries])

  // Count entries with data integrity issues
  const integrityIssueCount = useMemo(() => {
    return computedEntries.filter(e => e.hasIntegrityIssue).length
  }, [computedEntries])

  // Count entries with margin integrity issues (borrowed > available)
  const marginIntegrityIssueCount = useMemo(() => {
    return computedEntries.filter(e => e.hasMarginIntegrityIssue).length
  }, [computedEntries])

  // Draw Fund APY chart (shows both Liquid and Realized APY)
  useEffect(() => {
    if (!apyChartRef.current || computedEntries.length === 0) return

    const svg = d3.select(apyChartRef.current)
    svg.selectAll('*').remove()

    const margin = { top: 10, right: 10, bottom: 25, left: 50 }
    const width = apyChartRef.current.clientWidth - margin.left - margin.right
    const height = apyChartRef.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Derive chart data from computedEntries
    const chartData: ChartDataPoint[] = computedEntries.map(e => ({
      date: new Date(e.date),
      liquidPnl: e.liquidPnl,
      realizedPnl: e.realized,
      liquidApy: e.liquidApy,
      realizedApy: e.realizedApy
    }))

    const data = chartData.filter(d => isFinite(d.liquidApy) && isFinite(d.realizedApy))

    if (data.length === 0) return

    // Use state bounds if available, otherwise auto-scale with reasonable limits
    const allApyValues = data.flatMap(d => [d.liquidApy, d.realizedApy])
    const yExtent = d3.extent(allApyValues) as [number, number]
    let yMin = apyBounds.yMin ?? Math.max(-2, yExtent[0])
    let yMax = apyBounds.yMax ?? Math.min(2, yExtent[1])

    // Ensure a minimum range to avoid collapsed scale when all values are the same
    if (yMin === yMax) {
      const padding = Math.abs(yMin) * 0.1 || 0.1
      yMin = yMin - padding
      yMax = yMax + padding
    }

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Clip path for chart area
    const clipId = `apy-clip-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // Liquid APY line (orange - prominent)
    const liquidLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(Math.max(yMin, Math.min(yMax, d.liquidApy))))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 2)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', liquidLine)

    // Realized APY line (green - secondary)
    const realizedLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(Math.max(yMin, Math.min(yMax, d.realizedApy))))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#10b981')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', realizedLine)

    // Zero line
    if (yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#64748b')
        .attr('stroke-dasharray', '3,3')
    }

    // Axes
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '9px')

    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => `${((d as number) * 100).toFixed(0)}%`))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '9px')

    svg.selectAll('.domain').attr('stroke', '#334155')
    svg.selectAll('.tick line').attr('stroke', '#334155')

    // Hover tooltip elements
    const focus = g.append('g').style('display', 'none')

    focus.append('line')
      .attr('class', 'hover-line')
      .attr('y1', 0)
      .attr('y2', height)
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')

    // Two circles for the two lines
    focus.append('circle')
      .attr('class', 'hover-circle-liquid')
      .attr('r', 4)
      .attr('fill', '#f59e0b')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)

    focus.append('circle')
      .attr('class', 'hover-circle-realized')
      .attr('r', 3)
      .attr('fill', '#10b981')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)

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

    tooltip.append('text')
      .attr('class', 'tooltip-liquid')
      .attr('fill', '#f59e0b')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-realized')
      .attr('fill', '#10b981')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

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
        const yPosLiquid = y(Math.max(yMin, Math.min(yMax, d.liquidApy)))
        const yPosRealized = y(Math.max(yMin, Math.min(yMax, d.realizedApy)))

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)
        focus.select('.hover-circle-liquid').attr('cx', xPos).attr('cy', yPosLiquid)
        focus.select('.hover-circle-realized').attr('cx', xPos).attr('cy', yPosRealized)

        const dateStr = d3.timeFormat('%b %d, %Y')(d.date)
        const liquidPct = d.liquidApy * 100
        const realizedPct = d.realizedApy * 100
        const liquidStr = `Liquid: ${liquidPct >= 0 ? '+' : ''}${liquidPct.toFixed(1)}%`
        const realizedStr = `Realized: ${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(1)}%`

        const tooltipGroup = focus.select('.tooltip-group')
        tooltipGroup.select('.tooltip-date').text(dateStr)
        tooltipGroup.select('.tooltip-liquid').text(liquidStr)
        tooltipGroup.select('.tooltip-realized').text(realizedStr)

        const tooltipWidth = 100
        const tooltipHeight = 46

        let tooltipX = xPos
        const tooltipY = Math.min(yPosLiquid, yPosRealized) - tooltipHeight - 10

        if (xPos + tooltipWidth / 2 > width) {
          tooltipX = width - tooltipWidth / 2
        } else if (xPos - tooltipWidth / 2 < 0) {
          tooltipX = tooltipWidth / 2
        }

        tooltipGroup.attr('transform', `translate(${tooltipX}, ${Math.max(0, tooltipY)})`)

        tooltipGroup.select('.tooltip-bg')
          .attr('x', -tooltipWidth / 2)
          .attr('y', 0)
          .attr('width', tooltipWidth)
          .attr('height', tooltipHeight)

        tooltipGroup.select('.tooltip-date')
          .attr('x', 0)
          .attr('y', 11)

        tooltipGroup.select('.tooltip-liquid')
          .attr('x', 0)
          .attr('y', 25)

        tooltipGroup.select('.tooltip-realized')
          .attr('x', 0)
          .attr('y', 39)
      })

  }, [computedEntries, apyBounds, chartResize])

  // Draw P&L chart (shows both Liquid and Realized P&L)
  useEffect(() => {
    if (!pnlChartRef.current || computedEntries.length === 0) return

    const svg = d3.select(pnlChartRef.current)
    svg.selectAll('*').remove()

    const margin = { top: 10, right: 10, bottom: 25, left: 50 }
    const width = pnlChartRef.current.clientWidth - margin.left - margin.right
    const height = pnlChartRef.current.clientHeight - margin.top - margin.bottom

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`)

    // Derive chart data from computedEntries
    const data: ChartDataPoint[] = computedEntries.map(e => ({
      date: new Date(e.date),
      liquidPnl: e.liquidPnl,
      realizedPnl: e.realized,
      liquidApy: e.liquidApy,
      realizedApy: e.realizedApy
    }))

    if (data.length === 0) return

    // Use state bounds if available, otherwise auto-scale
    const allPnlValues = data.flatMap(d => [d.liquidPnl, d.realizedPnl])
    const yExtent = d3.extent(allPnlValues) as [number, number]
    let yMin = pnlBounds.yMin ?? yExtent[0]
    let yMax = pnlBounds.yMax ?? yExtent[1]

    // Ensure a minimum range
    if (yMin === yMax) {
      const padding = Math.abs(yMin) * 0.1 || 100
      yMin = yMin - padding
      yMax = yMax + padding
    }

    const x = d3.scaleTime()
      .domain(d3.extent(data, d => d.date) as [Date, Date])
      .range([0, width])

    const y = d3.scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([height, 0])

    // Clip path for chart area
    const clipId = `pnl-clip-${Date.now()}`
    g.append('defs')
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // Liquid P&L line (orange - prominent)
    const liquidLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(Math.max(yMin, Math.min(yMax, d.liquidPnl))))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#f59e0b')
      .attr('stroke-width', 2)
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', liquidLine)

    // Realized P&L line (green - secondary)
    const realizedLine = d3.line<ChartDataPoint>()
      .x(d => x(d.date))
      .y(d => y(Math.max(yMin, Math.min(yMax, d.realizedPnl))))
      .curve(d3.curveMonotoneX)

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', '#10b981')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')
      .attr('clip-path', `url(#${clipId})`)
      .attr('d', realizedLine)

    // Zero line
    if (yMin < 0 && yMax > 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#64748b')
        .attr('stroke-dasharray', '3,3')
    }

    // Axes
    g.append('g')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(d => d3.timeFormat('%b %y')(d as Date)))
      .selectAll('text')
      .attr('fill', '#64748b')
      .attr('font-size', '9px')

    g.append('g')
      .call(d3.axisLeft(y).ticks(4).tickFormat(d => {
        const val = d as number
        if (Math.abs(val) >= 1000) return `$${(val / 1000).toFixed(0)}K`
        return `$${val.toFixed(0)}`
      }))
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

    // Two circles for the two lines
    focus.append('circle')
      .attr('class', 'hover-circle-liquid')
      .attr('r', 4)
      .attr('fill', '#f59e0b')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2)

    focus.append('circle')
      .attr('class', 'hover-circle-realized')
      .attr('r', 3)
      .attr('fill', '#10b981')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)

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

    tooltip.append('text')
      .attr('class', 'tooltip-liquid')
      .attr('fill', '#f59e0b')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

    tooltip.append('text')
      .attr('class', 'tooltip-realized')
      .attr('fill', '#10b981')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')

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
        const yPosLiquid = y(Math.max(yMin, Math.min(yMax, d.liquidPnl)))
        const yPosRealized = y(Math.max(yMin, Math.min(yMax, d.realizedPnl)))

        focus.select('.hover-line').attr('x1', xPos).attr('x2', xPos)
        focus.select('.hover-circle-liquid').attr('cx', xPos).attr('cy', yPosLiquid)
        focus.select('.hover-circle-realized').attr('cx', xPos).attr('cy', yPosRealized)

        const dateStr = d3.timeFormat('%b %d, %Y')(d.date)
        const formatCurr = (v: number) => (v >= 0 ? '+' : '') + new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        }).format(v)
        const liquidStr = `Liquid: ${formatCurr(d.liquidPnl)}`
        const realizedStr = `Realized: ${formatCurr(d.realizedPnl)}`

        const tooltipGroup = focus.select('.tooltip-group')
        tooltipGroup.select('.tooltip-date').text(dateStr)
        tooltipGroup.select('.tooltip-liquid').text(liquidStr)
        tooltipGroup.select('.tooltip-realized').text(realizedStr)

        const tooltipWidth = 110
        const tooltipHeight = 46

        let tooltipX = xPos
        const tooltipY = Math.min(yPosLiquid, yPosRealized) - tooltipHeight - 10

        if (xPos + tooltipWidth / 2 > width) {
          tooltipX = width - tooltipWidth / 2
        } else if (xPos - tooltipWidth / 2 < 0) {
          tooltipX = tooltipWidth / 2
        }

        tooltipGroup.attr('transform', `translate(${tooltipX}, ${Math.max(0, tooltipY)})`)

        tooltipGroup.select('.tooltip-bg')
          .attr('x', -tooltipWidth / 2)
          .attr('y', 0)
          .attr('width', tooltipWidth)
          .attr('height', tooltipHeight)

        tooltipGroup.select('.tooltip-date')
          .attr('x', 0)
          .attr('y', 11)

        tooltipGroup.select('.tooltip-liquid')
          .attr('x', 0)
          .attr('y', 25)

        tooltipGroup.select('.tooltip-realized')
          .attr('x', 0)
          .attr('y', 39)
      })

  }, [computedEntries, pnlBounds, chartResize])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-mint-400"></div>
      </div>
    )
  }

  if (!fund) {
    return (
      <div className="text-center py-8">
        <p className="text-slate-400 mb-3 text-sm">Fund not found</p>
        <Link to="/" className="text-mint-400 hover:underline text-sm">Back to Dashboard</Link>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {/* Header with Config Tags */}
        <div className="bg-slate-800 rounded-lg p-2 sm:p-3 border border-slate-700">
          <div className="flex items-start justify-between gap-2 sm:gap-3">
            <div className="flex-1 min-w-0">
              {/* Breadcrumb with indicators */}
              <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm flex-wrap gap-y-1">
                <Link to="/" className="text-slate-400 hover:text-white">Dashboard</Link>
                <span className="text-slate-600">/</span>
                <Link to={`/platform/${fund.platform}`} className="text-slate-400 hover:text-white capitalize truncate max-w-[100px] sm:max-w-none">{fund.platform}</Link>
                <span className="text-slate-600">/</span>
                <span className="text-white font-semibold uppercase">{fund.ticker}</span>
                {/* Closed Tag */}
                {fund.config.status === 'closed' && (
                  <span className="px-1.5 py-0.5 text-[9px] leading-tight font-medium bg-slate-700 text-slate-400 rounded">Closed</span>
                )}
                {/* Audited Badge - clickable to toggle */}
                <button
                  onClick={toggleAudited}
                  className={`px-1.5 sm:px-2 py-1 sm:py-0.5 text-[9px] sm:text-[10px] leading-tight font-medium rounded inline-flex items-center gap-1 transition-colors ${
                    fund.config.audited
                      ? 'bg-green-900/50 text-green-300 border border-green-700 hover:bg-green-900/70'
                      : 'bg-slate-700/50 text-slate-500 border border-slate-600 hover:bg-slate-700 hover:text-slate-400'
                  }`}
                  title={fund.config.audited ? `Audited on ${fund.config.audited} - click to clear` : 'Click to mark as audited'}
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  <span className="hidden xs:inline">{fund.config.audited ? 'Audited' : 'Audit'}</span>
                </button>
                {/* Recommendation Badge - not shown for cash funds */}
                {state?.recommendation && features.allowsRecommendations && (
                  <span
                    className={`px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px] leading-tight font-bold rounded ${
                      state.recommendation.action === 'BUY'
                        ? 'bg-green-900/50 text-green-300 border border-green-700'
                        : state.recommendation.action === 'HOLD'
                        ? 'bg-slate-700/50 text-slate-300 border border-slate-600'
                        : 'bg-orange-900/50 text-orange-300 border border-orange-700'
                    }`}
                    title={`Cash: ${formatCurrency(state.cash_available ?? 0)}${state.cash_source ? ` (from ${state.cash_source})` : ''}${fund.config.margin_enabled && state.margin_available ? ` | Margin: ${formatCurrency(state.margin_available)}` : ''}`}
                  >
                    {state.recommendation.action === 'HOLD' ? 'HOLD' : `${state.recommendation.action} ${formatCurrency(state.recommendation.amount)}`}
                  </span>
                )}
                {/* Cash/Margin Available */}
                {state && ((state.cash_available ?? 0) > 0 || (fund.config.margin_enabled && (state.margin_available ?? 0) > 0)) && (
                  <span className="px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px] leading-tight font-medium rounded bg-slate-700/50 text-slate-300 border border-slate-600">
                    {(state.cash_available ?? 0) > 0 && (
                      state.cash_source ? (
                        <Link to={`/fund/${state.cash_source}`} className="hover:text-mint-400">
                          Cash: {formatCurrency(state.cash_available ?? 0)} ↗
                        </Link>
                      ) : (
                        <span>Cash: {formatCurrency(state.cash_available ?? 0)}</span>
                      )
                    )}
                    {(state.cash_available ?? 0) > 0 && fund.config.margin_enabled && (state.margin_available ?? 0) > 0 && <span className="mx-1">|</span>}
                    {fund.config.margin_enabled && (state.margin_available ?? 0) > 0 && <span>Margin: {formatCurrency(state.margin_available ?? 0)}</span>}
                  </span>
                )}
              </div>
              {/* Config Details Row - different for cash vs trading funds */}
              <div className="flex items-center gap-1.5 sm:gap-3 mt-1.5 sm:mt-2 text-[10px] sm:text-xs text-slate-400 flex-wrap">
                {isCashFund ? (
                  // Cash fund: simplified config
                  <>
                    <span title="Fund Type" className="whitespace-nowrap">
                      <span className="text-slate-500 hidden sm:inline">Type: </span><span className={features.textColorClass}>{features.label}</span>
                    </span>
                    <span className="text-slate-600 hidden sm:inline">|</span>
                    <span title="Cash Balance" className="whitespace-nowrap">
                      <span className="text-slate-500 hidden sm:inline">Balance: </span><span className="text-white font-medium">{formatCurrency(latestEntry?.fundSize ?? 0)}</span>
                    </span>
                    <span className="text-slate-600 hidden sm:inline">|</span>
                    <span title="Total Interest Earned" className="whitespace-nowrap">
                      <span className="text-slate-500 hidden sm:inline">Interest: </span><span className="text-green-400">{formatCurrency(latestEntry?.sumCashInterest ?? 0)}</span>
                    </span>
                  </>
                ) : (
                  // Trading fund (stock/crypto): responsive config - show less on mobile
                  <>
                    <span title="Fund Type" className="whitespace-nowrap">
                      <span className="text-slate-500 hidden sm:inline">Type: </span><span className={features.textColorClass}>{features.label}</span>
                    </span>
                    <span className="text-slate-600 hidden sm:inline">|</span>
                    <span title="Mode" className="whitespace-nowrap">
                      <span className="text-slate-500 hidden sm:inline">Mode: </span><span className={fund.config.accumulate ? 'text-blue-300' : 'text-orange-300'}>{fund.config.accumulate ? 'Accumulate' : 'Harvest'}</span>
                    </span>
                    <span className="text-slate-600 hidden sm:inline">|</span>
                    <span title="Fund Size" className="whitespace-nowrap">
                      <span className="text-slate-500 hidden sm:inline">Size: </span><span className="text-white font-medium">{formatCurrency(latestEntry?.fundSize ?? fund.config.fund_size_usd)}</span>
                    </span>
                    <span className="text-slate-600 hidden md:inline">|</span>
                    <span title="Target APY" className="whitespace-nowrap hidden md:inline">
                      <span className="text-slate-500">Target APY: </span><span className="text-mint-400">{(fund.config.target_apy * 100).toFixed(0)}%</span>
                    </span>
                    <span className="text-slate-600 hidden lg:inline">|</span>
                    <span title="Check Interval" className="whitespace-nowrap hidden lg:inline">
                      <span className="text-slate-500">Every: </span><span className="text-white">{fund.config.interval_days}d</span>
                    </span>
                    <span className="text-slate-600 hidden lg:inline">|</span>
                    <span title="DCA Amounts (Min/Mid/Max)" className="whitespace-nowrap hidden lg:inline">
                      <span className="text-slate-500">DCA: </span><span className="text-white">${fund.config.input_min_usd}/${fund.config.input_mid_usd}/${fund.config.input_max_usd}</span>
                    </span>
                    <span className="text-slate-600 hidden lg:inline">|</span>
                    <span title="Max At / Min Profit" className="whitespace-nowrap hidden lg:inline">
                      <span className="text-slate-500">Max@: </span><span className="text-white">{(fund.config.max_at_pct * 100).toFixed(0)}%</span>
                      <span className="text-slate-500 ml-1">Profit: </span><span className="text-white">${fund.config.min_profit_usd}</span>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              {/* Scrape Button for Derivatives Funds */}
              {isDerivativesFund && (
                <CoinbaseScrapeButton
                  fundId={fund.id}
                  variant="secondary"
                  onComplete={() => loadData()}
                />
              )}
              {/* Edit Button */}
              <Link
                to={`/fund/${fund.id}/edit`}
                className="flex-shrink-0 p-1 sm:p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
                title="Edit Fund"
              >
                <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </Link>
            </div>
          </div>
        </div>

        {/* Stats Section (collapsible) */}
        <div className="bg-slate-800 rounded-lg border border-slate-700">
          <button
            onClick={toggleChartsCollapsed}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-700/50 transition-colors"
          >
            <h2 className="text-base font-semibold text-white">Stats</h2>
            <svg
              className={`w-5 h-5 text-slate-400 transition-transform ${chartsCollapsed ? '' : 'rotate-180'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {!chartsCollapsed && (
            <div className="p-3 space-y-3">
              {/* Current State + P&L + APY Charts Row (3 columns) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Current State */}
                <div className="bg-slate-700/50 rounded-lg p-3">
                  <h3 className="text-sm font-semibold text-white mb-2">Current State</h3>
                  {fund.config.status === 'closed' && state?.closedMetrics ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-[10px] text-slate-400">Total Invested</p>
                        <p className="font-medium text-white">{formatCurrency(state.closedMetrics.total_invested_usd)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Total Returned</p>
                        <p className="font-medium text-white">{formatCurrency(state.closedMetrics.total_returned_usd)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Net Gain/Loss</p>
                        <p className={`font-medium ${state.closedMetrics.net_gain_usd >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(state.closedMetrics.net_gain_usd)} ({formatPercent(state.closedMetrics.return_pct)})
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Annualized Return</p>
                        <p className={`font-medium ${state.closedMetrics.apy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercent(state.closedMetrics.apy)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Dividends</p>
                        <p className="font-medium text-mint-400">{formatCurrency(state.closedMetrics.total_dividends_usd)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Cash Interest</p>
                        <p className="font-medium text-mint-400">{formatCurrency(state.closedMetrics.total_cash_interest_usd)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Duration</p>
                        <p className="font-medium text-white">{state.closedMetrics.duration_days} days</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Expenses</p>
                        <p className="font-medium text-red-400">{formatCurrency(-state.closedMetrics.total_expenses_usd)}</p>
                      </div>
                    </div>
                  ) : fund.config.status === 'closed' ? (
                    <p className="text-slate-400 text-sm">This fund is closed. Historical data preserved below.</p>
                  ) : latestEntry && isDerivativesFund ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-[10px] text-slate-400">Position</p>
                        <p className="font-medium text-white">{latestEntry.derivPosition ?? 0} contracts</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Avg Entry</p>
                        <p className="font-medium text-white">{formatCurrency(latestEntry.derivAvgEntry ?? 0)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Margin Balance</p>
                        <p className="font-medium text-blue-400">{formatCurrency(latestEntry.cash ?? latestEntry.derivMarginBalance ?? 0)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Cost Basis</p>
                        <p className="font-medium text-white">{formatCurrency(latestEntry.derivCostBasis ?? 0)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Equity</p>
                        <p className="font-medium text-mint-400">{formatCurrency(latestEntry.derivEquity ?? 0)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Unrealized</p>
                        <p className={`font-medium ${(latestEntry.derivUnrealized ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.derivUnrealized ?? 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Realized</p>
                        <p className={`font-medium ${(latestEntry.derivRealized ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.derivRealized ?? 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Liquid P&L</p>
                        <p className={`font-medium ${latestEntry.liquidPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.liquidPnl)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Margin Locked</p>
                        <p className="font-medium text-amber-400">{formatCurrency(latestEntry.derivMarginLocked ?? 0)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Leverage</p>
                        <p className={`font-medium ${
                          (latestEntry.derivLeverage ?? 0) < 3 ? 'text-green-400'
                          : (latestEntry.derivLeverage ?? 0) < 5 ? 'text-amber-400'
                          : 'text-red-400'
                        }`}>
                          {latestEntry.derivLeverage !== undefined && latestEntry.derivLeverage > 0
                            ? `${latestEntry.derivLeverage.toFixed(2)}x`
                            : '-'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Liq Price</p>
                        <p className={`font-medium ${
                          latestEntry.derivLiquidationPrice !== undefined && latestEntry.derivLiquidationPrice < 0
                            ? 'text-green-400'  // Negative = over-collateralized
                            : 'text-orange-400'
                        }`}>
                          {latestEntry.derivLiquidationPrice !== undefined
                            ? `$${latestEntry.derivLiquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                            : '-'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Dist to Liq</p>
                        <p className={`font-medium ${
                          (latestEntry.derivDistanceToLiq ?? 0) > 0.5 ? 'text-green-400'
                          : (latestEntry.derivDistanceToLiq ?? 0) > 0.25 ? 'text-amber-400'
                          : 'text-red-400'
                        }`}>
                          {latestEntry.derivDistanceToLiq !== undefined && latestEntry.derivDistanceToLiq > 0
                            ? `${(latestEntry.derivDistanceToLiq * 100).toFixed(1)}%`
                            : '-'}
                        </p>
                      </div>
                    </div>
                  ) : latestEntry && isCashFund ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-[10px] text-slate-400">Cash Balance</p>
                        <p className="font-medium text-mint-400">{formatCurrency(latestEntry.postActionCash)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Interest Earned</p>
                        <p className="font-medium text-green-400">{formatCurrency(latestEntry.sumCashInterest)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Expenses</p>
                        <p className="font-medium text-red-400">{formatCurrency(-latestEntry.sumExpenses)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Net Gain</p>
                        <p className={`font-medium ${latestEntry.realized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.realized)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Realized APY</p>
                        <p className={`font-medium ${latestEntry.realizedApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercent(latestEntry.realizedApy)}
                        </p>
                      </div>
                      {(latestEntry.margin_available ?? 0) > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400">Margin Available</p>
                          <p className="font-medium text-blue-400">{formatCurrency(latestEntry.margin_available ?? 0)}</p>
                        </div>
                      )}
                      {(latestEntry.margin_borrowed ?? 0) > 0 && (
                        <div>
                          <p className="text-[10px] text-slate-400">Margin Borrowed</p>
                          <p className="font-medium text-orange-400">{formatCurrency(latestEntry.margin_borrowed ?? 0)}</p>
                        </div>
                      )}
                    </div>
                  ) : latestEntry ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-[10px] text-slate-400">Invested</p>
                        <p className="font-medium text-white">{formatCurrency(latestEntry.totalInvested)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Asset Value</p>
                        <p className="font-medium text-mint-400">{formatCurrency(latestEntry.value)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Unrealized</p>
                        <p className={`font-medium ${latestEntry.unrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.unrealized)}
                        </p>
                      </div>
                      {fund.config.manage_cash && (
                        <div>
                          <p className="text-[10px] text-slate-400">Cash</p>
                          <p className="font-medium text-white">{formatCurrency(latestEntry.postActionCash)}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-[10px] text-slate-400">Realized</p>
                        <p className={`font-medium ${latestEntry.realized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.realized)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Realized APY</p>
                        <p className={`font-medium ${latestEntry.realizedApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercent(latestEntry.realizedApy)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Liquid P&L</p>
                        <p className={`font-medium ${latestEntry.liquidPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(latestEntry.liquidPnl)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-400">Liquid APY</p>
                        <p className={`font-medium ${latestEntry.liquidApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercent(latestEntry.liquidApy)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-slate-400 text-sm">No state data available</p>
                  )}
                </div>

                {/* P&L Chart */}
                <div className="bg-slate-700/50 rounded-lg p-3 flex flex-col h-full">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-white">P&L</h3>
                      <div className="chart-legend flex gap-2">
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#f59e0b' }} />
                          Liquid
                        </span>
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <span className="w-2 h-0.5" style={{ backgroundColor: '#10b981' }} />
                          Realized
                        </span>
                      </div>
                    </div>
                    <ChartSettings bounds={pnlBounds} onChange={updatePnlBounds} />
                  </div>
                  <svg
                    ref={pnlChartRef}
                    className="w-full flex-1 min-h-[100px]"
                    style={{ overflow: 'visible' }}
                  />
                </div>

                {/* Fund APY Chart */}
                <div className="bg-slate-700/50 rounded-lg p-3 flex flex-col h-full">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-white">APY</h3>
                      <div className="chart-legend flex gap-2">
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#f59e0b' }} />
                          Liquid
                        </span>
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <span className="w-2 h-0.5" style={{ backgroundColor: '#10b981' }} />
                          Realized
                        </span>
                      </div>
                    </div>
                    <ChartSettings bounds={apyBounds} onChange={updateApyBounds} isPercent />
                  </div>
                  <svg
                    ref={apyChartRef}
                    className="w-full flex-1 min-h-[100px]"
                    style={{ overflow: 'visible' }}
                  />
                </div>
              </div>

              {/* Fund Analysis Charts */}
              <FundCharts
                entries={fund.entries}
                config={fund.config}
                fundId={fund.id}
                computedEntries={isDerivativesFund ? computedEntries as ComputedEntry[] : undefined}
                resize={chartResize}
              />
            </div>
          )}
        </div>

        {/* Data Integrity Alert */}
        {integrityIssueCount > 0 && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 flex items-center gap-3">
            <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <p className="text-red-300 text-sm font-medium">
                Data Integrity Issue{integrityIssueCount > 1 ? 's' : ''} Detected
              </p>
              <p className="text-red-400/80 text-xs">
                {integrityIssueCount} entr{integrityIssueCount === 1 ? 'y' : 'ies'} where invested amount exceeds fund size (highlighted in red below)
              </p>
            </div>
          </div>
        )}

        {/* Margin Integrity Alert */}
        {marginIntegrityIssueCount > 0 && (
          <div className="bg-orange-900/30 border border-orange-700 rounded-lg p-3 flex items-center gap-3">
            <svg className="w-5 h-5 text-orange-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <p className="text-orange-300 text-sm font-medium">
                Margin Call Warning{marginIntegrityIssueCount > 1 ? 's' : ''}
              </p>
              <p className="text-orange-400/80 text-xs">
                {marginIntegrityIssueCount} entr{marginIntegrityIssueCount === 1 ? 'y' : 'ies'} where margin borrowed exceeds margin available (highlighted in orange below)
              </p>
            </div>
          </div>
        )}

        {/* Entries Table */}
        <EntriesTable
          fundId={fund.id}
          entries={fund.entries}
          computedEntries={computedEntries as ComputedEntry[]}
          savedColumnOrder={fund.config.entries_column_order as ColumnId[]}
          savedVisibleColumns={fund.config.entries_visible_columns as ColumnId[]}
          fundType={fund.config.fund_type}
          onEdit={(index, entry, calculatedFundSize) => setEditingEntry({ index, entry, calculatedFundSize })}
          onAddEntry={() => setShowAddEntry(true)}
          onReload={loadData}
          showCoinbaseUpdate={isDerivativesFund}
          lastEntryDate={fund.entries.length > 0 ? fund.entries.reduce((max, e) => e.date > max ? e.date : max, fund.entries[0]!.date) : undefined}
          fundStartDate={fund.entries.length > 0 ? fund.entries.reduce((min, e) => e.date < min ? e.date : min, fund.entries[0]!.date) : undefined}
        />

        {/* Take Action Modal */}
        {showAddEntry && (
          <AddEntryModal
            fundId={fund.id}
            fundTicker={fund.ticker}
            currentRecommendation={features.allowsRecommendations ? state?.recommendation : undefined}
            existingEntries={fund.entries}
            targetApy={fund.config.target_apy}
            minProfitUsd={fund.config.min_profit_usd}
            manageCash={fund.config.manage_cash}
            fundType={fund.config.fund_type}
            marginEnabled={fund.config.margin_enabled}
            platform={fund.platform}
            cashFund={fund.config.cash_fund}
            fundStatus={fund.config.status}
            onClose={() => {
              setShowAddEntry(false)
              if (isAdding) navigate(`/fund/${fund.id}`, { replace: true })
            }}
            onAdded={() => loadData(false)}
          />
        )}

        {/* Edit Entry Modal */}
        {editingEntry && (
          <EditEntryModal
            fundId={fund.id}
            fundTicker={fund.ticker}
            entryIndex={editingEntry.index}
            entry={editingEntry.entry}
            existingEntries={fund.entries.slice(0, editingEntry.index)}
            calculatedFundSize={editingEntry.calculatedFundSize}
            fundType={fund.config.fund_type}
            manageCash={fund.config.manage_cash}
            marginEnabled={fund.config.margin_enabled}
            platform={fund.platform}
            onClose={() => setEditingEntry(null)}
            onUpdated={handleFundUpdate}
          />
        )}
      </div>

      {/* Edit Panel */}
      {isEditing && (
        <EditFundPanel
          fundId={fund.id}
          fundPlatform={fund.platform}
          fundTicker={fund.ticker}
          config={fund.config}
          onUpdated={loadData}
        />
      )}
    </>
  )
}

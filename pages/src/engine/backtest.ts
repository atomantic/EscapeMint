import { blendPricesWithDividends, type Allocation } from './price-blender'
import type { HistoricalData, DateRange, DividendPayment } from '../data/types'
import { computeFundState, computeRecommendation, type SubFundConfig, type Trade } from '@escapemint/engine'

export interface ScenarioConfig {
  id: string
  name: string

  // Pie allocation (must sum to 100)
  spxlPct: number
  vtiPct: number
  brgnxPct: number
  tqqqPct: number
  btcPct: number
  gldPct: number
  slvPct: number
  /** Optional. Existing scenarios leave these at 0. */
  qqqPct?: number
  soxxPct?: number
  soxlPct?: number

  // DCA strategy
  initialCash: number
  weeklyDCA: number
  targetAPY: number
  minProfitUSD: number
  accumulate: boolean

  // DCA tiers
  inputMin: number
  inputMid: number
  inputMax: number
  maxAtPct: number // Loss threshold for max DCA

  // Margin (optional)
  marginAccessUSD: number
  marginAPR: number
  cashAPY: number
}

export interface TimeSeriesPoint {
  date: string
  equity: number
  cash: number
  fundSize: number
  invested: number
  totalInvested: number
  totalExtracted: number
  expectedTarget: number
  action: 'BUY' | 'SELL' | 'HOLD'
  amount: number
  cashInterest: number
  sumCashInterest: number
  dividend: number
  sumDividends: number
}

export interface TradeRecord {
  date: string
  action: 'BUY' | 'SELL'
  amount: number
  equity: number
  price: number
  reason: string
}

export interface BacktestResult {
  timeSeries: TimeSeriesPoint[]
  trades: TradeRecord[]
  finalValue: number
  totalInvested: number
  totalExtracted: number
  realizedAPY: number
  liquidAPY: number
  unrealizedGain: number
  realizedGain: number
  liquidGain: number
  totalBuys: number
  totalSells: number
  maxDrawdown: number
  daysElapsed: number
  sumDividends: number
  sumCashInterest: number
}

function daysBetween(start: string, end: string): number {
  return Math.floor(
    (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24)
  )
}

function calculateAPY(gain: number, principal: number, days: number): number {
  if (principal <= 0 || days <= 0) return 0
  return (gain / principal) * (365 / days)
}

// Helper to find dividends that occurred between two dates
function getDividendsInRange(
  dividends: DividendPayment[],
  startDate: string,
  endDate: string
): DividendPayment[] {
  return dividends.filter(d => d.exDate > startDate && d.exDate <= endDate)
}

export function runBacktest(
  scenario: ScenarioConfig,
  historicalData: Record<string, HistoricalData>,
  dateRange: DateRange
): BacktestResult {
  // 1. Blend price histories based on allocation
  const allocation: Allocation = {
    SPXL: scenario.spxlPct / 100,
    VTI: scenario.vtiPct / 100,
    BRGNX: scenario.brgnxPct / 100,
    TQQQ: scenario.tqqqPct / 100,
    BTC: scenario.btcPct / 100,
    GLD: scenario.gldPct / 100,
    SLV: scenario.slvPct / 100,
    QQQ: (scenario.qqqPct ?? 0) / 100,
    SOXX: (scenario.soxxPct ?? 0) / 100,
    SOXL: (scenario.soxlPct ?? 0) / 100
  }

  const blendResult = blendPricesWithDividends(historicalData, allocation, dateRange)
  const blendedPrices = blendResult.prices

  // Debug: Log dividend data
  console.log('=== BACKTEST DIVIDENDS ===')
  console.log('SPXL divs in range:', blendResult.dividends.SPXL.length, blendResult.dividends.SPXL)
  console.log('VTI divs in range:', blendResult.dividends.VTI.length, blendResult.dividends.VTI)
  console.log('BRGNX divs in range:', blendResult.dividends.BRGNX.length, blendResult.dividends.BRGNX)
  console.log('TQQQ divs in range:', blendResult.dividends.TQQQ.length, blendResult.dividends.TQQQ)
  console.log('GLD divs in range:', blendResult.dividends.GLD.length, blendResult.dividends.GLD)
  console.log('SLV divs in range:', blendResult.dividends.SLV.length, blendResult.dividends.SLV)
  console.log('Date range:', dateRange)

  if (blendedPrices.length === 0) {
    return {
      timeSeries: [],
      trades: [],
      finalValue: 0,
      totalInvested: 0,
      totalExtracted: 0,
      realizedAPY: 0,
      liquidAPY: 0,
      unrealizedGain: 0,
      realizedGain: 0,
      liquidGain: 0,
      totalBuys: 0,
      totalSells: 0,
      maxDrawdown: 0,
      daysElapsed: 0,
      sumDividends: 0,
      sumCashInterest: 0
    }
  }

  // 2. Initialize state
  const trades: TradeRecord[] = []
  const timeSeries: TimeSeriesPoint[] = []

  let cash = scenario.initialCash
  let shares = 0
  let totalInvested = 0
  let totalExtracted = 0
  let costBasis = 0
  let sumCashInterest = 0
  let sumDividends = 0

  // Track equivalent shares of underlying assets (for dividend calculation)
  // When we buy $X of the blended fund, we're buying:
  //   $X * SPXL_pct / SPXL_starting_price worth of SPXL shares
  //   $X * VTI_pct / VTI_starting_price worth of VTI shares
  //   $X * BRGNX_pct / BRGNX_starting_price worth of BRGNX shares
  //   $X * TQQQ_pct / TQQQ_starting_price worth of TQQQ shares
  //   $X * GLD_pct / GLD_starting_price worth of GLD shares
  //   $X * SLV_pct / SLV_starting_price worth of SLV shares
  let spxlEquivShares = 0
  let vtiEquivShares = 0
  let brgnxEquivShares = 0
  let tqqqEquivShares = 0
  let gldEquivShares = 0
  let slvEquivShares = 0
  const { startingPrices, dividends: allDividends } = blendResult

  // Weekly interest rate from annual APY
  const weeklyInterestRate = scenario.cashAPY / 52

  // Convert scenario to engine config format
  const config: SubFundConfig = {
    fund_type: 'stock',
    fund_size_usd: scenario.initialCash,
    target_apy: scenario.targetAPY,
    interval_days: 7,
    input_min_usd: scenario.inputMin,
    input_mid_usd: scenario.inputMid,
    input_max_usd: scenario.inputMax,
    max_at_pct: scenario.maxAtPct,
    min_profit_usd: scenario.minProfitUSD,
    accumulate: scenario.accumulate,
    manage_cash: true,
    dividend_reinvest: false,
    interest_reinvest: false,
    expense_from_fund: false,
    cash_apy: scenario.cashAPY,
    margin_apr: scenario.marginAPR,
    margin_access_usd: scenario.marginAccessUSD,
    margin_enabled: scenario.marginAccessUSD > 0,
    status: 'active'
  }

  // 3. Process each week
  for (let i = 0; i < blendedPrices.length; i++) {
    const point = blendedPrices[i]
    const previousDate = i > 0 ? blendedPrices[i - 1].date : ''
    const equity = shares > 0 ? shares * point.value : 0

    // Calculate weekly cash interest (skip first week - no interest on day 1)
    const weeklyInterest = i > 0 ? cash * weeklyInterestRate : 0
    sumCashInterest += weeklyInterest
    cash += weeklyInterest

    // Calculate dividends for this period (based on equivalent shares held)
    let weeklyDividend = 0
    if (i > 0 && (spxlEquivShares > 0 || vtiEquivShares > 0 || brgnxEquivShares > 0 || tqqqEquivShares > 0 || gldEquivShares > 0 || slvEquivShares > 0)) {
      // Get dividends that occurred between last entry and this entry
      const spxlDivs = getDividendsInRange(allDividends.SPXL, previousDate, point.date)
      const vtiDivs = getDividendsInRange(allDividends.VTI, previousDate, point.date)
      const brgnxDivs = getDividendsInRange(allDividends.BRGNX, previousDate, point.date)
      const tqqqDivs = getDividendsInRange(allDividends.TQQQ, previousDate, point.date)
      const gldDivs = getDividendsInRange(allDividends.GLD, previousDate, point.date)
      const slvDivs = getDividendsInRange(allDividends.SLV, previousDate, point.date)

      // Debug: Log when dividends are found
      if (spxlDivs.length > 0 || vtiDivs.length > 0 || brgnxDivs.length > 0 || tqqqDivs.length > 0 || gldDivs.length > 0 || slvDivs.length > 0) {
        const spxlDivAmt = spxlDivs.reduce((sum, d) => sum + spxlEquivShares * d.amount, 0)
        const vtiDivAmt = vtiDivs.reduce((sum, d) => sum + vtiEquivShares * d.amount, 0)
        const brgnxDivAmt = brgnxDivs.reduce((sum, d) => sum + brgnxEquivShares * d.amount, 0)
        const tqqqDivAmt = tqqqDivs.reduce((sum, d) => sum + tqqqEquivShares * d.amount, 0)
        const gldDivAmt = gldDivs.reduce((sum, d) => sum + gldEquivShares * d.amount, 0)
        const slvDivAmt = slvDivs.reduce((sum, d) => sum + slvEquivShares * d.amount, 0)
        console.log(`Dividend on ${point.date}: SPXL $${spxlDivAmt.toFixed(2)}, VTI $${vtiDivAmt.toFixed(2)}, BRGNX $${brgnxDivAmt.toFixed(2)}, TQQQ $${tqqqDivAmt.toFixed(2)}, GLD $${gldDivAmt.toFixed(2)}, SLV $${slvDivAmt.toFixed(2)}`)
      }

      // Calculate dividend income from SPXL
      for (const div of spxlDivs) {
        weeklyDividend += spxlEquivShares * div.amount
      }

      // Calculate dividend income from VTI
      for (const div of vtiDivs) {
        weeklyDividend += vtiEquivShares * div.amount
      }

      // Calculate dividend income from BRGNX
      for (const div of brgnxDivs) {
        weeklyDividend += brgnxEquivShares * div.amount
      }

      // Calculate dividend income from TQQQ
      for (const div of tqqqDivs) {
        weeklyDividend += tqqqEquivShares * div.amount
      }

      // Calculate dividend income from GLD (typically none)
      for (const div of gldDivs) {
        weeklyDividend += gldEquivShares * div.amount
      }

      // Calculate dividend income from SLV (typically none)
      for (const div of slvDivs) {
        weeklyDividend += slvEquivShares * div.amount
      }

      // Add dividends to cash (simulates receiving dividend payment)
      cash += weeklyDividend
      sumDividends += weeklyDividend
    }

    // Build trade history for engine (tracks cost basis)
    const engineTrades: Trade[] = trades.map(t => ({
      date: t.date,
      type: t.action.toLowerCase() as 'buy' | 'sell',
      amount_usd: t.amount,
      shares: undefined,
      value: undefined
    }))

    // Compute fund state for recommendation
    const state = computeFundState(
      config,
      engineTrades,
      [],  // cashflows
      [],  // dividends
      [],  // expenses
      equity,  // actualValue
      point.date  // asOfDate
    )

    // Get recommendation
    const rec = computeRecommendation(config, state)

    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD'
    let amount = 0

    // Execute trade if recommended
    if (rec && rec.action !== 'HOLD' && rec.amount > 0) {
      if (rec.action === 'BUY' && cash >= rec.amount) {
        // BUY
        action = 'BUY'
        amount = rec.amount
        const sharesToBuy = amount / point.value
        shares += sharesToBuy
        cash -= amount
        totalInvested += amount
        costBasis += amount

        // Update equivalent shares of underlying assets
        // amount * allocation_pct / starting_price = equivalent shares
        spxlEquivShares += (amount * allocation.SPXL) / startingPrices.SPXL
        vtiEquivShares += (amount * allocation.VTI) / startingPrices.VTI
        brgnxEquivShares += (amount * allocation.BRGNX) / startingPrices.BRGNX
        tqqqEquivShares += (amount * allocation.TQQQ) / startingPrices.TQQQ
        gldEquivShares += (amount * allocation.GLD) / startingPrices.GLD
        slvEquivShares += (amount * allocation.SLV) / startingPrices.SLV

        // Debug: Log first BUY
        if (trades.length === 0) {
          console.log('=== FIRST BUY ===')
          console.log('Date:', point.date, 'Amount:', amount)
          console.log('SPXL equiv shares:', spxlEquivShares.toFixed(4))
          console.log('VTI equiv shares:', vtiEquivShares.toFixed(4))
          console.log('BRGNX equiv shares:', brgnxEquivShares.toFixed(4))
          console.log('TQQQ equiv shares:', tqqqEquivShares.toFixed(4))
          console.log('GLD equiv shares:', gldEquivShares.toFixed(4))
          console.log('SLV equiv shares:', slvEquivShares.toFixed(4))
        }

        trades.push({
          date: point.date,
          action: 'BUY',
          amount,
          equity,
          price: point.value,
          reason: rec.explanation.reasoning
        })
      } else if (rec.action === 'SELL' && shares > 0) {
        // SELL
        action = 'SELL'

        // Determine sell amount based on accumulate mode
        const sellAmount = scenario.accumulate
          ? Math.min(rec.amount, equity)
          : equity

        amount = sellAmount

        const sharesToSell = sellAmount / point.value
        const sellProportion = sharesToSell / shares
        shares = Math.max(0, shares - sharesToSell)
        cash += sellAmount
        totalExtracted += sellAmount

        // Reduce equivalent shares proportionally
        spxlEquivShares *= (1 - sellProportion)
        vtiEquivShares *= (1 - sellProportion)
        brgnxEquivShares *= (1 - sellProportion)
        tqqqEquivShares *= (1 - sellProportion)
        gldEquivShares *= (1 - sellProportion)
        slvEquivShares *= (1 - sellProportion)

        // Check for full liquidation using multiple detection methods (matches engine)
        // After selling, remaining equity = (shares - sharesToSell) * price = equity - sellAmount
        const remainingEquity = equity - sellAmount
        const sharesLiquidated = shares < 0.0001
        const valueLiquidated = remainingEquity <= sellAmount + 0.01
        // Dollar-based: total extracted (sells) >= total invested (buys)
        const dollarsLiquidated = totalExtracted >= totalInvested
        const isFullLiquidation = sharesLiquidated || valueLiquidated || dollarsLiquidated

        if (isFullLiquidation) {
          costBasis = 0
          shares = 0
          spxlEquivShares = 0
          vtiEquivShares = 0
          brgnxEquivShares = 0
          tqqqEquivShares = 0
          gldEquivShares = 0
          slvEquivShares = 0
        } else {
          // Partial sell - reduce cost basis proportionally
          if (scenario.accumulate) {
            // Accumulate mode: entire sell is profit extraction (cost basis unchanged)
          } else {
            // Harvest mode: proportional cost basis reduction
            costBasis = costBasis * (1 - sellProportion)
          }
        }

        trades.push({
          date: point.date,
          action: 'SELL',
          amount,
          equity,
          price: point.value,
          reason: rec.explanation.reasoning
        })
      }
    }

    // Calculate equity AFTER the trade for accurate recording
    const currentEquity = shares * point.value

    // Fund Size = Cash + Cost Basis (what we actually have invested in positions)
    // In accumulate mode, sells extract profit but don't reduce cost basis
    // In harvest mode, full liquidation resets cost basis to 0
    const fundSize = cash + costBasis

    // Record time series point
    timeSeries.push({
      date: point.date,
      equity: currentEquity,
      cash,
      fundSize,
      invested: costBasis,  // Use cost basis, not totalInvested - totalExtracted
      totalInvested,
      totalExtracted,
      expectedTarget: state.expected_target_usd,
      action,
      amount,
      cashInterest: weeklyInterest,
      sumCashInterest,
      dividend: weeklyDividend,
      sumDividends
    })
  }

  // 4. Calculate final metrics
  const finalEquity = shares * blendedPrices[blendedPrices.length - 1].value
  const finalValue = cash + finalEquity

  const daysElapsed = daysBetween(dateRange.start, dateRange.end)

  // Unrealized gain: current equity minus cost basis
  const unrealizedGain = finalEquity - costBasis

  // Cost basis of shares that were sold = totalInvested - remaining costBasis
  const soldCostBasis = totalInvested - costBasis

  // Realized gain: profit from sales + interest + dividends
  // = (what we got from selling) - (what those shares cost) + passive income
  const realizedGain = (totalExtracted - soldCostBasis) + sumCashInterest + sumDividends

  // Liquid gain: total portfolio value minus initial cash
  const liquidGain = finalValue - scenario.initialCash

  // Realized APY: Based on extracted profits
  const realizedAPY = calculateAPY(realizedGain, scenario.initialCash, daysElapsed)

  // Liquid APY: Based on current portfolio value
  const liquidAPY = calculateAPY(liquidGain, scenario.initialCash, daysElapsed)

  // Count buys and sells
  const totalBuys = trades.filter(t => t.action === 'BUY').length
  const totalSells = trades.filter(t => t.action === 'SELL').length

  // Calculate max drawdown from peak
  let peak = 0
  let maxDrawdown = 0
  for (const point of timeSeries) {
    if (point.fundSize > peak) {
      peak = point.fundSize
    }
    const drawdown = peak > 0 ? (peak - point.fundSize) / peak : 0
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
    }
  }

  // Debug: Summary
  console.log('=== BACKTEST SUMMARY ===')
  console.log('Dividends earned:', sumDividends.toFixed(2))
  console.log('Interest earned:', sumCashInterest.toFixed(2))
  console.log('Buys/Sells:', totalBuys, '/', totalSells)
  console.log('Final value:', finalValue.toFixed(2))

  return {
    timeSeries,
    trades,
    finalValue,
    totalInvested,
    totalExtracted,
    realizedAPY,
    liquidAPY,
    unrealizedGain,
    realizedGain,
    liquidGain,
    totalBuys,
    totalSells,
    maxDrawdown,
    daysElapsed,
    sumDividends,
    sumCashInterest
  }
}

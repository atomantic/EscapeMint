import { blendPricesWithDividends, type Allocation } from './price-blender'
import type { HistoricalData, DateRange, DividendPayment } from './types'
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
  maxAtPct: number

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
  const allocation: Allocation = {
    SPXL: scenario.spxlPct / 100,
    VTI: scenario.vtiPct / 100,
    BRGNX: scenario.brgnxPct / 100,
    TQQQ: scenario.tqqqPct / 100,
    BTC: scenario.btcPct / 100,
    GLD: scenario.gldPct / 100,
    SLV: scenario.slvPct / 100
  }

  const blendResult = blendPricesWithDividends(historicalData, allocation, dateRange)
  const blendedPrices = blendResult.prices

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

  const trades: TradeRecord[] = []
  const timeSeries: TimeSeriesPoint[] = []

  let cash = scenario.initialCash
  let shares = 0
  let totalInvested = 0
  let totalExtracted = 0
  let costBasis = 0
  let sumCashInterest = 0
  let sumDividends = 0

  let spxlEquivShares = 0
  let vtiEquivShares = 0
  let brgnxEquivShares = 0
  let tqqqEquivShares = 0
  let gldEquivShares = 0
  let slvEquivShares = 0
  const { startingPrices, dividends: allDividends } = blendResult

  const weeklyInterestRate = scenario.cashAPY / 52

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

  for (let i = 0; i < blendedPrices.length; i++) {
    const point = blendedPrices[i]!
    const previousDate = i > 0 ? blendedPrices[i - 1]!.date : ''
    const equity = shares > 0 ? shares * point.value : 0

    const weeklyInterest = i > 0 ? cash * weeklyInterestRate : 0
    sumCashInterest += weeklyInterest
    cash += weeklyInterest

    let weeklyDividend = 0
    if (i > 0 && (spxlEquivShares > 0 || vtiEquivShares > 0 || brgnxEquivShares > 0 || tqqqEquivShares > 0 || gldEquivShares > 0 || slvEquivShares > 0)) {
      const spxlDivs = getDividendsInRange(allDividends.SPXL, previousDate, point.date)
      const vtiDivs = getDividendsInRange(allDividends.VTI, previousDate, point.date)
      const brgnxDivs = getDividendsInRange(allDividends.BRGNX, previousDate, point.date)
      const tqqqDivs = getDividendsInRange(allDividends.TQQQ, previousDate, point.date)
      const gldDivs = getDividendsInRange(allDividends.GLD, previousDate, point.date)
      const slvDivs = getDividendsInRange(allDividends.SLV, previousDate, point.date)

      for (const div of spxlDivs) weeklyDividend += spxlEquivShares * div.amount
      for (const div of vtiDivs) weeklyDividend += vtiEquivShares * div.amount
      for (const div of brgnxDivs) weeklyDividend += brgnxEquivShares * div.amount
      for (const div of tqqqDivs) weeklyDividend += tqqqEquivShares * div.amount
      for (const div of gldDivs) weeklyDividend += gldEquivShares * div.amount
      for (const div of slvDivs) weeklyDividend += slvEquivShares * div.amount

      cash += weeklyDividend
      sumDividends += weeklyDividend
    }

    const engineTrades: Trade[] = trades.map(t => ({
      date: t.date,
      type: t.action.toLowerCase() as 'buy' | 'sell',
      amount_usd: t.amount
    }))

    const state = computeFundState(
      config,
      engineTrades,
      [],
      [],
      [],
      equity,
      point.date
    )

    const rec = computeRecommendation(config, state)

    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD'
    let amount = 0

    if (rec && rec.action !== 'HOLD' && rec.amount > 0) {
      if (rec.action === 'BUY' && cash >= rec.amount) {
        action = 'BUY'
        amount = rec.amount
        const sharesToBuy = amount / point.value
        shares += sharesToBuy
        cash -= amount
        totalInvested += amount
        costBasis += amount

        spxlEquivShares += (amount * allocation.SPXL) / startingPrices.SPXL
        vtiEquivShares += (amount * allocation.VTI) / startingPrices.VTI
        brgnxEquivShares += (amount * allocation.BRGNX) / startingPrices.BRGNX
        tqqqEquivShares += (amount * allocation.TQQQ) / startingPrices.TQQQ
        gldEquivShares += (amount * allocation.GLD) / startingPrices.GLD
        slvEquivShares += (amount * allocation.SLV) / startingPrices.SLV

        trades.push({
          date: point.date,
          action: 'BUY',
          amount,
          equity,
          price: point.value,
          reason: rec.explanation.reasoning
        })
      } else if (rec.action === 'SELL' && shares > 0) {
        action = 'SELL'

        const sellAmount = scenario.accumulate
          ? Math.min(rec.amount, equity)
          : equity

        amount = sellAmount

        const sharesToSell = sellAmount / point.value
        const sellProportion = sharesToSell / shares
        shares = Math.max(0, shares - sharesToSell)
        cash += sellAmount
        totalExtracted += sellAmount

        spxlEquivShares *= (1 - sellProportion)
        vtiEquivShares *= (1 - sellProportion)
        brgnxEquivShares *= (1 - sellProportion)
        tqqqEquivShares *= (1 - sellProportion)
        gldEquivShares *= (1 - sellProportion)
        slvEquivShares *= (1 - sellProportion)

        const sharesLiquidated = shares < 0.0001
        const valueLiquidated = equity <= sellAmount + 0.01
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
          if (!scenario.accumulate) {
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

    const currentEquity = shares * point.value
    const fundSize = cash + costBasis

    timeSeries.push({
      date: point.date,
      equity: currentEquity,
      cash,
      fundSize,
      invested: costBasis,
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

  const finalEquity = shares * blendedPrices[blendedPrices.length - 1]!.value
  const finalValue = cash + finalEquity

  const daysElapsed = daysBetween(dateRange.start, dateRange.end)
  const unrealizedGain = finalEquity - costBasis
  const soldCostBasis = totalInvested - costBasis
  const realizedGain = (totalExtracted - soldCostBasis) + sumCashInterest + sumDividends
  const liquidGain = finalValue - scenario.initialCash
  const realizedAPY = calculateAPY(realizedGain, scenario.initialCash, daysElapsed)
  const liquidAPY = calculateAPY(liquidGain, scenario.initialCash, daysElapsed)
  const totalBuys = trades.filter(t => t.action === 'BUY').length
  const totalSells = trades.filter(t => t.action === 'SELL').length

  let peak = 0
  let maxDrawdown = 0
  for (const point of timeSeries) {
    if (point.fundSize > peak) peak = point.fundSize
    const drawdown = peak > 0 ? (peak - point.fundSize) / peak : 0
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
  }

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

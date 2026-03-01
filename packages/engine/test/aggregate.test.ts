import { describe, it, expect } from 'vitest'
import {
  computeTimeWeightedFundSize,
  computeCashFundTimeWeightedSize,
  computeRealizedAPY,
  computeLiquidAPY,
  computeProjectedAnnualReturn,
  computeFundMetrics,
  computeAggregateMetrics
} from '../src/aggregate.js'
import type { Trade, CashFlow, SubFundConfig, FundState } from '../src/types.js'

describe('computeTimeWeightedFundSize', () => {
  it('returns 0 for empty trades', () => {
    const result = computeTimeWeightedFundSize([], '2024-01-01', '2024-12-31')
    expect(result).toBe(0)
  })

  it('returns 0 when start equals end date', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2024-01-01')
    expect(result).toBe(0)
  })

  it('calculates TWFS for single trade held entire period', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    // Trade at start, held for 365 days
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2025-01-01')
    // TWFS = (1000 * 366) / 366 = 1000 (2024 is a leap year)
    expect(result).toBe(1000)
  })

  it('calculates TWFS for trade mid-period', () => {
    const trades: Trade[] = [
      { date: '2024-07-01', amount_usd: 1000, type: 'buy' }
    ]
    // Trade 182 days into the year (leap year), held for remaining 184 days
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2025-01-01')
    // TWFS = (0 * 182 + 1000 * 184) / 366 ≈ 502.7
    expect(result).toBeCloseTo(502.7, 0)
  })

  it('calculates TWFS with multiple buys', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 1000, type: 'buy' }
    ]
    // First $1000 for full 366 days, second $1000 for 184 days
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2025-01-01')
    // TWFS = (1000 * 182 + 2000 * 184) / 366 ≈ 1502.7
    expect(result).toBeCloseTo(1502.7, 0)
  })

  it('calculates TWFS with buy then sell', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 500, type: 'sell' }
    ]
    // $1000 for first 182 days, $500 for remaining 184 days
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2025-01-01')
    // TWFS = (1000 * 182 + 500 * 184) / 366 ≈ 749
    expect(result).toBeCloseTo(749, 0)
  })

  it('clamps negative investment to zero', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-03-01', amount_usd: 2000, type: 'sell' } // Sell more than bought
    ]
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2024-06-01')
    // After sell, investment is clamped to 0
    expect(result).toBeGreaterThanOrEqual(0)
  })

  it('ignores trades before start date', () => {
    const trades: Trade[] = [
      { date: '2023-12-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2024-06-01')
    expect(result).toBe(0)
  })

  it('ignores trades after end date', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-12-01', amount_usd: 5000, type: 'buy' }
    ]
    const result = computeTimeWeightedFundSize(trades, '2024-01-01', '2024-06-01')
    // Only first buy counts, second is after end date
    // 152 days (Jan 1 to Jun 1)
    expect(result).toBeCloseTo(1000, 0)
  })
})

describe('computeCashFundTimeWeightedSize', () => {
  it('returns 0 for empty cash flows', () => {
    const result = computeCashFundTimeWeightedSize([], '2024-01-01', '2024-12-31')
    expect(result).toBe(0)
  })

  it('calculates TWFS for single deposit held entire period', () => {
    const cashFlows: CashFlow[] = [
      { date: '2024-01-01', amount_usd: 5000, type: 'deposit' }
    ]
    const result = computeCashFundTimeWeightedSize(cashFlows, '2024-01-01', '2025-01-01')
    expect(result).toBe(5000)
  })

  it('calculates TWFS with deposit then withdrawal', () => {
    const cashFlows: CashFlow[] = [
      { date: '2024-01-01', amount_usd: 5000, type: 'deposit' },
      { date: '2024-07-01', amount_usd: 2000, type: 'withdrawal' }
    ]
    // $5000 for 182 days, $3000 for 184 days
    const result = computeCashFundTimeWeightedSize(cashFlows, '2024-01-01', '2025-01-01')
    // TWFS = (5000 * 182 + 3000 * 184) / 366 ≈ 3995
    expect(result).toBeCloseTo(3995, 0)
  })

  it('handles multiple deposits', () => {
    const cashFlows: CashFlow[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'deposit' },
      { date: '2024-04-01', amount_usd: 1000, type: 'deposit' },
      { date: '2024-07-01', amount_usd: 1000, type: 'deposit' }
    ]
    const result = computeCashFundTimeWeightedSize(cashFlows, '2024-01-01', '2025-01-01')
    // Increasing balance over time
    expect(result).toBeGreaterThan(1000)
    expect(result).toBeLessThan(3000)
  })
})

describe('computeRealizedAPY', () => {
  it('returns 0 when TWFS is zero', () => {
    expect(computeRealizedAPY(100, 0, 365)).toBe(0)
  })

  it('returns 0 when days active is zero', () => {
    expect(computeRealizedAPY(100, 1000, 0)).toBe(0)
  })

  it('calculates annualized return for full year', () => {
    // $100 gain on $1000 TWFS over 365 days = 10% APY
    const result = computeRealizedAPY(100, 1000, 365)
    expect(result).toBeCloseTo(0.10, 2)
  })

  it('calculates annualized return for partial year', () => {
    // $50 gain on $1000 TWFS over 182.5 days = 10% APY (annualized)
    const result = computeRealizedAPY(50, 1000, 182.5)
    expect(result).toBeCloseTo(0.10, 2)
  })

  it('handles negative gains (losses)', () => {
    const result = computeRealizedAPY(-100, 1000, 365)
    expect(result).toBeCloseTo(-0.10, 2)
  })
})

describe('computeLiquidAPY', () => {
  it('returns 0 when TWFS is zero', () => {
    expect(computeLiquidAPY(500, 0, 365)).toBe(0)
  })

  it('returns 0 when days active is zero', () => {
    expect(computeLiquidAPY(500, 1000, 0)).toBe(0)
  })

  it('calculates liquid APY correctly', () => {
    // $500 gain on $1000 TWFS over 365 days = 50% APY
    const result = computeLiquidAPY(500, 1000, 365)
    expect(result).toBeCloseTo(0.50, 2)
  })
})

describe('computeProjectedAnnualReturn', () => {
  it('calculates projected return from APY', () => {
    // $10,000 current value at 10% APY = $1,000 projected return
    const result = computeProjectedAnnualReturn(10000, 0.10)
    expect(result).toBe(1000)
  })

  it('handles zero APY', () => {
    expect(computeProjectedAnnualReturn(10000, 0)).toBe(0)
  })

  it('handles negative APY', () => {
    const result = computeProjectedAnnualReturn(10000, -0.05)
    expect(result).toBe(-500)
  })
})

describe('computeFundMetrics', () => {
  const baseConfig: SubFundConfig = {
    fund_size_usd: 10000,
    target_apy: 0.30,
    interval_days: 7,
    input_min_usd: 100,
    input_mid_usd: 200,
    input_max_usd: 300,
    max_at_pct: -0.25,
    min_profit_usd: 100,
    cash_apy: 0.044,
    margin_apr: 0.0725,
    margin_access_usd: 0,
    accumulate: false,
    status: 'active',
    fund_type: 'stock'
  }

  const baseFundState: FundState = {
    start_input_usd: 1000,
    expected_target_usd: 1100,
    actual_value_usd: 1050,
    gain_usd: 50,
    gain_pct: 0.05,
    cash_available_usd: 500,
    realized_gains_usd: 25
  }

  it('computes metrics for stock fund', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]

    const result = computeFundMetrics(
      'test-fund',
      'platform',
      'TICKER',
      baseConfig,
      trades,
      baseFundState,
      '2024-07-01'
    )

    expect(result.id).toBe('test-fund')
    expect(result.platform).toBe('platform')
    expect(result.ticker).toBe('TICKER')
    expect(result.status).toBe('active')
    expect(result.fundType).toBe('stock')
    expect(result.fundSize).toBe(10000)
    expect(result.currentValue).toBe(1050)
    expect(result.startInput).toBe(1000)
    expect(result.daysActive).toBeGreaterThan(0)
    expect(result.timeWeightedFundSize).toBeGreaterThan(0)
    expect(result.realizedGains).toBe(25)
    expect(result.unrealizedGains).toBe(50) // gain_usd for stock funds
  })

  it('computes metrics for cash fund', () => {
    const cashConfig: SubFundConfig = {
      ...baseConfig,
      fund_type: 'cash'
    }

    const cashFlows: CashFlow[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'deposit' }
    ]

    const result = computeFundMetrics(
      'cash-fund',
      'platform',
      'SAVINGS',
      cashConfig,
      [],
      baseFundState,
      '2024-07-01',
      cashFlows
    )

    expect(result.fundType).toBe('cash')
    // For cash funds, unrealized gains is 0 (all gains are realized as interest)
    expect(result.unrealizedGains).toBe(0)
    expect(result.gainUsd).toBe(25) // realizedGains for cash funds
  })

  it('handles null fund state', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]

    const result = computeFundMetrics(
      'test-fund',
      'platform',
      'TICKER',
      baseConfig,
      trades,
      null,
      '2024-07-01'
    )

    expect(result.currentValue).toBe(0)
    expect(result.startInput).toBe(0)
    expect(result.realizedGains).toBe(0)
    expect(result.gainPct).toBe(0)
  })

  it('computes APY metrics', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]

    const result = computeFundMetrics(
      'test-fund',
      'platform',
      'TICKER',
      baseConfig,
      trades,
      baseFundState,
      '2024-07-01'
    )

    // Should have computed APY values
    expect(result.realizedAPY).toBeDefined()
    expect(result.liquidAPY).toBeDefined()
    expect(result.projectedAnnualReturn).toBeDefined()
  })
})

describe('computeAggregateMetrics', () => {
  it('returns zeros for empty funds array', () => {
    const result = computeAggregateMetrics([])

    expect(result.totalFundSize).toBe(0)
    expect(result.totalValue).toBe(0)
    expect(result.activeFunds).toBe(0)
    expect(result.closedFunds).toBe(0)
    expect(result.funds).toHaveLength(0)
  })

  it('aggregates totals across funds', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 180,
        timeWeightedFundSize: 4500,
        realizedGains: 200,
        unrealizedGains: 1000,
        realizedAPY: 0.10,
        liquidAPY: 0.50,
        projectedAnnualReturn: 500,
        gainUsd: 1000,
        gainPct: 0.25,
        fundShares: 0,
        fundSharesPct: 0
      },
      {
        id: 'fund2',
        platform: 'p2',
        ticker: 'T2',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 20000,
        currentValue: 8000,
        startInput: 7000,
        daysActive: 90,
        timeWeightedFundSize: 7000,
        realizedGains: 300,
        unrealizedGains: 1000,
        realizedAPY: 0.20,
        liquidAPY: 0.60,
        projectedAnnualReturn: 1600,
        gainUsd: 1000,
        gainPct: 0.14,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    expect(result.totalFundSize).toBe(30000)
    expect(result.totalValue).toBe(13000)
    expect(result.totalStartInput).toBe(11000)
    expect(result.totalTimeWeightedFundSize).toBe(11500)
    expect(result.totalDaysActive).toBe(270)
    expect(result.totalRealizedGains).toBe(500)
    expect(result.totalUnrealizedGains).toBe(2000)
    expect(result.activeFunds).toBe(2)
    expect(result.closedFunds).toBe(0)
  })

  it('counts closed funds separately', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 180,
        timeWeightedFundSize: 4500,
        realizedGains: 200,
        unrealizedGains: 1000,
        realizedAPY: 0.10,
        liquidAPY: 0.50,
        projectedAnnualReturn: 500,
        gainUsd: 1000,
        gainPct: 0.25,
        fundShares: 0,
        fundSharesPct: 0
      },
      {
        id: 'fund2',
        platform: 'p2',
        ticker: 'T2',
        status: 'closed' as const,
        fundType: 'stock' as const,
        fundSize: 5000,
        currentValue: 0,
        startInput: 0,
        daysActive: 365,
        timeWeightedFundSize: 2500,
        realizedGains: 800,
        unrealizedGains: 0,
        realizedAPY: 0.15,
        liquidAPY: 0.15,
        projectedAnnualReturn: 0,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    expect(result.activeFunds).toBe(1)
    expect(result.closedFunds).toBe(1)
  })

  it('calculates fund shares and percentages', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 365,
        timeWeightedFundSize: 5000,
        realizedGains: 200,
        unrealizedGains: 1000,
        realizedAPY: 0.10,
        liquidAPY: 0.50,
        projectedAnnualReturn: 500,
        gainUsd: 1000,
        gainPct: 0.25,
        fundShares: 0,
        fundSharesPct: 0
      },
      {
        id: 'fund2',
        platform: 'p2',
        ticker: 'T2',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 365,
        timeWeightedFundSize: 5000,
        realizedGains: 200,
        unrealizedGains: 1000,
        realizedAPY: 0.10,
        liquidAPY: 0.50,
        projectedAnnualReturn: 500,
        gainUsd: 1000,
        gainPct: 0.25,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    // Equal TWFS and days should give equal shares
    expect(result.funds[0]?.fundShares).toBeCloseTo(result.funds[1]?.fundShares ?? 0, 2)
    expect(result.funds[0]?.fundSharesPct).toBeCloseTo(0.5, 2)
    expect(result.funds[1]?.fundSharesPct).toBeCloseTo(0.5, 2)
  })

  it('calculates dollar-weighted compound realized APY', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 365,
        timeWeightedFundSize: 10000,
        realizedGains: 1000,
        unrealizedGains: 0,
        realizedAPY: 0.10, // 10%
        liquidAPY: 0.10,
        projectedAnnualReturn: 500,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      },
      {
        id: 'fund2',
        platform: 'p2',
        ticker: 'T2',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 365,
        timeWeightedFundSize: 10000,
        realizedGains: 2000,
        unrealizedGains: 0,
        realizedAPY: 0.20, // 20%
        liquidAPY: 0.20,
        projectedAnnualReturn: 1000,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    // Equal TWFS and equal days at 365 → compound and linear converge
    // totalDollarDays = 10000*365 + 10000*365 = 7,300,000
    // effectivePortfolioDays = 365 (max)
    // avgCapital = 7,300,000 / 365 = 20,000
    // totalReturn = 3000 / 20000 = 0.15
    // APY = (1 + 0.15)^(365/365) - 1 = 0.15
    expect(result.realizedAPY).toBeCloseTo(0.15, 2)
  })

  it('returns portfolioDays in result', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 180,
        timeWeightedFundSize: 4500,
        realizedGains: 200,
        unrealizedGains: 0,
        realizedAPY: 0.10,
        liquidAPY: 0.10,
        projectedAnnualReturn: 500,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)
    // Without explicit portfolioDays, defaults to max(daysActive) = 180
    expect(result.portfolioDays).toBe(180)
  })

  it('uses explicit portfolioDays parameter over max(daysActive)', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 180,
        timeWeightedFundSize: 4500,
        realizedGains: 200,
        unrealizedGains: 0,
        realizedAPY: 0.10,
        liquidAPY: 0.10,
        projectedAnnualReturn: 500,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds, 400)
    expect(result.portfolioDays).toBe(400)
  })

  it('does not let short-duration high-return funds dominate aggregate APY', () => {
    // Regression test: Fund B has 50% return in 30 days → ~12,875% if annualized alone
    // But with dollar-weighted compound, Fund A's larger capital dominates
    const funds = [
      {
        id: 'fundA',
        platform: 'p1',
        ticker: 'A',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 11000,
        startInput: 10000,
        daysActive: 365,
        timeWeightedFundSize: 10000,
        realizedGains: 1000,
        unrealizedGains: 0,
        realizedAPY: 0.10,
        liquidAPY: 0.10,
        projectedAnnualReturn: 1100,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      },
      {
        id: 'fundB',
        platform: 'p2',
        ticker: 'B',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 1000,
        currentValue: 1500,
        startInput: 1000,
        daysActive: 30,
        timeWeightedFundSize: 1000,
        realizedGains: 500,
        unrealizedGains: 0,
        realizedAPY: 128.75, // ~12,875% if annualized alone
        liquidAPY: 128.75,
        projectedAnnualReturn: 193125,
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    // totalDollarDays = 10000*365 + 1000*30 = 3,680,000
    // effectivePortfolioDays = 365 (max)
    // avgCapital = 3,680,000 / 365 ≈ 10,082.19
    // totalReturn = 1500 / 10,082.19 ≈ 0.1488
    // APY = (1 + 0.1488)^(365/365) - 1 ≈ 0.1488 = ~14.88%
    expect(result.realizedAPY).toBeCloseTo(0.1488, 2)
    // Should NOT be anywhere near Fund B's 12,875%
    expect(result.realizedAPY).toBeLessThan(0.50)
  })

  it('calculates total gain USD and percentage', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 11000,
        startInput: 10000,
        daysActive: 365,
        timeWeightedFundSize: 10000,
        realizedGains: 500,
        unrealizedGains: 500,
        realizedAPY: 0.10,
        liquidAPY: 0.10,
        projectedAnnualReturn: 1100,
        gainUsd: 1000,
        gainPct: 0.10,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    // Total gain = realized + unrealized
    expect(result.totalGainUsd).toBe(1000)
    // Gain % = (value / start_input) - 1 = (11000 / 10000) - 1 = 0.10
    expect(result.totalGainPct).toBeCloseTo(0.10, 2)
  })

  it('excludes closed funds from projected annual return', () => {
    const funds = [
      {
        id: 'fund1',
        platform: 'p1',
        ticker: 'T1',
        status: 'active' as const,
        fundType: 'stock' as const,
        fundSize: 10000,
        currentValue: 5000,
        startInput: 4000,
        daysActive: 365,
        timeWeightedFundSize: 5000,
        realizedGains: 500,
        unrealizedGains: 500,
        realizedAPY: 0.10,
        liquidAPY: 0.20,
        projectedAnnualReturn: 500,
        gainUsd: 1000,
        gainPct: 0.25,
        fundShares: 0,
        fundSharesPct: 0
      },
      {
        id: 'fund2',
        platform: 'p2',
        ticker: 'T2',
        status: 'closed' as const,
        fundType: 'stock' as const,
        fundSize: 5000,
        currentValue: 0,
        startInput: 0,
        daysActive: 365,
        timeWeightedFundSize: 2500,
        realizedGains: 800,
        unrealizedGains: 0,
        realizedAPY: 0.15,
        liquidAPY: 0.15,
        projectedAnnualReturn: 1000, // This should be ignored
        gainUsd: 0,
        gainPct: 0,
        fundShares: 0,
        fundSharesPct: 0
      }
    ]

    const result = computeAggregateMetrics(funds)

    // Projected return = totalActiveValue * portfolioRealizedAPY
    // portfolioRealizedAPY includes all funds (active + closed) for accurate track record
    // avgCapital = (5000*365 + 2500*365) / 365 = 7500
    // totalReturn = 1300 / 7500 = 0.17333
    // weightedRealizedAPY = (1.17333)^(365/365) - 1 = 0.17333
    // totalActiveValue = 5000 (closed fund has currentValue=0)
    // projected = 5000 * 0.17333 = 866.67
    expect(result.projectedAnnualReturn).toBeCloseTo(866.67, 0)
  })
})

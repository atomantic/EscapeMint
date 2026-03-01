import { describe, it, expect } from 'vitest'
import {
  computeExpectedTarget,
  computeCashAvailable,
  computeStartInput,
  computeCashInterest,
  computeRealizedGains,
  computeFundState,
  computeClosedFundMetrics
} from '../src/expected-equity.js'
import type { SubFundConfig, Trade, CashFlow, Dividend, Expense } from '../src/types.js'

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
  start_date: '2024-01-01',
}

describe('computeStartInput', () => {
  it('returns 0 when no trades', () => {
    const result = computeStartInput([], '2024-01-01')
    expect(result).toBe(0)
  })

  it('adds BUY trades to total', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 100, type: 'buy' },
      { date: '2024-01-08', amount_usd: 100, type: 'buy' }
    ]
    const result = computeStartInput(trades, '2024-01-15')
    expect(result).toBe(200)
  })

  it('subtracts SELL trades from total', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 500, type: 'buy' },
      { date: '2024-01-08', amount_usd: 300, type: 'sell' }
    ]
    const result = computeStartInput(trades, '2024-01-15')
    expect(result).toBe(200)
  })

  it('skips future trades', () => {
    const trades: Trade[] = [
      { date: '2024-02-01', amount_usd: 100, type: 'buy' }
    ]
    const result = computeStartInput(trades, '2024-01-15')
    expect(result).toBe(0)
  })

  it('returns 0 if sells exceed buys', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 100, type: 'buy' },
      { date: '2024-01-08', amount_usd: 500, type: 'sell' }
    ]
    const result = computeStartInput(trades, '2024-01-15')
    expect(result).toBe(0)
  })

  it('does not treat SELL with value=0 as liquidation when totalSells < totalBuys', () => {
    // Regression: imported entries may have value=0 (unknown), which previously
    // triggered value-based liquidation (value <= amount_usd) even though the
    // position was not actually closed. The trade.value > 0 guard prevents this.
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-03-01', amount_usd: 200, type: 'sell', value: 0 }
    ]
    const result = computeStartInput(trades, '2024-06-01')
    // Should be a partial sell (1000 - 200 = 800), NOT a liquidation (0)
    expect(result).toBe(800)
  })
})

describe('computeExpectedTarget', () => {
  it('returns 0 when no trades', () => {
    const result = computeExpectedTarget(baseConfig, [], '2024-01-01')
    expect(result).toBe(0)
  })

  it('compounds a single BUY trade from trade date', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')
    // $1000 * (1.30)^(366/365) ≈ $1301 (leap year)
    expect(result).toBeCloseTo(1301, 0)
  })

  it('compounds multiple BUY trades correctly', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')
    // First buy: $1000 * (1.30)^1 = $1300
    // Second buy: $1000 * (1.30)^0.5 ≈ $1140
    // Total: $2440
    expect(result).toBeCloseTo(2440, -1)
  })

  it('subtracts SELL trades proportionally from expected gain', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 200, type: 'sell' }
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')
    // Buy: $1000 on 2024-01-01 with 30% APY
    // Full year gain = 1000 * ((1.30)^(366/365) - 1) ≈ $301
    // Sell $200 = 20% of position, so 80% of gain remains
    // Expected gain = 301 * 0.8 = 240.8
    // start_input = 1000 - 200 = 800
    // Expected = 800 + 240.8 ≈ 1041
    expect(result).toBeCloseTo(1041, 0)
  })
})

describe('computeExpectedTarget - SELL handling', () => {
  it('selling 50% of position reduces expected gain by 50%', () => {
    // Buy $1000, let it compound for 6 months, then sell $500 (50%)
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    // Calculate expected gain after 6 months (182 days in leap year first half)
    const resultBefore = computeExpectedTarget(baseConfig, trades, '2024-07-01')
    // $1000 * (1.30)^(182/365) = approximately $1136
    // expectedGain before sell = resultBefore - 1000
    const expectedGainBefore = resultBefore - 1000

    // Now sell 50% of the position
    const tradesWithSell: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 500, type: 'sell' }  // 50% of $1000
    ]
    const resultAfter = computeExpectedTarget(baseConfig, tradesWithSell, '2024-07-01')
    // startInput = 1000 - 500 = 500
    // expectedGain should be reduced by 50%
    const expectedGainAfter = resultAfter - 500  // 500 is the remaining startInput

    // Verify the gain was reduced by 50%
    expect(expectedGainAfter).toBeCloseTo(expectedGainBefore * 0.5, 1)
  })

  it('selling 100% of position (full liquidation) zeros out expected gain', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 1000, type: 'sell' }  // Full liquidation
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2024-07-01')
    // startInput = 0 (fully liquidated)
    // expectedGain = 0 (100% reduction)
    expect(result).toBe(0)
  })

  it('selling more than position (edge case) handles correctly', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 1500, type: 'sell' }  // Sell more than bought
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2024-07-01')
    // sellFraction = min(1, 1500/1000) = 1 (capped at 100%)
    // startInput = max(0, 1000 - 1500) = 0
    // expectedGain *= (1 - 1) = 0
    expect(result).toBe(0)
  })

  it('multiple partial sells in sequence compound correctly', () => {
    // Buy $1000, then sell 25% twice = 50% total sold
    const buyOnly: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const expectedGainBeforeAnySell = computeExpectedTarget(baseConfig, buyOnly, '2024-07-01') - 1000

    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-04-01', amount_usd: 250, type: 'sell' },  // 25% of $1000
      { date: '2024-07-01', amount_usd: 250, type: 'sell' }   // 33.3% of remaining $750
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2024-07-01')

    // startInput = 1000 - 250 - 250 = 500
    expect(computeStartInput(trades, '2024-07-01')).toBe(500)

    // First sell removes 25% of gain -> 75% remains
    // Second sell removes 250/750 = 33.3% of remaining gain -> 66.7% of 75% = 50% remains
    // Final gain should be approximately 50% of original expected gain
    const expectedGainAfterSells = result - 500
    const expectedFraction = 0.75 * (1 - 250/750)  // 0.75 * 0.6667 = 0.50
    expect(expectedGainAfterSells).toBeCloseTo(expectedGainBeforeAnySell * expectedFraction, 0)
  })

  it('buy-sell-buy pattern works correctly', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-04-01', amount_usd: 500, type: 'sell' },   // Sell 50%
      { date: '2024-07-01', amount_usd: 500, type: 'buy' }     // Buy back
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')

    // After first buy: gain compounds from Jan 1
    // After sell on Apr 1: 50% of gain removed, startInput = 500
    // After second buy on Jul 1: new position adds new compounding

    // Verify startInput is back to $1000
    expect(computeStartInput(trades, '2025-01-01')).toBe(1000)

    // The second buy should compound from July 1
    // Expected target should be > startInput due to compounding
    expect(result).toBeGreaterThan(1000)

    // But less than if we had held $1000 the whole year
    const fullHold: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const fullHoldResult = computeExpectedTarget(baseConfig, fullHold, '2025-01-01')
    expect(result).toBeLessThan(fullHoldResult)
  })

  it('selling immediately after buy (no compounding yet) works correctly', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-01-01', amount_usd: 500, type: 'sell' }  // Same day sell
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2024-01-01')

    // On same day, 0 days of compounding = no expected gain
    // startInput = 500
    // expectedGain on day 0 = 0
    expect(result).toBe(500)
  })

  it('selling immediately after buy still compounds remaining position', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-01-01', amount_usd: 500, type: 'sell' }  // Same day sell
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')

    // startInput = 500
    // The buy was for $1000 with gain, sell removes 50% of that gain
    // Since we sold on same day (0 gain), remaining position still compounds
    // $1000 * ((1.30)^(366/365) - 1) = ~$301 gain
    // Sell 50% -> 50% of $301 = ~$150.5 gain remains
    // Expected = 500 + 150.5 ≈ 650.5

    // Compare with holding $500 from day 1
    const holdHalf: Trade[] = [
      { date: '2024-01-01', amount_usd: 500, type: 'buy' }
    ]
    const holdHalfResult = computeExpectedTarget(baseConfig, holdHalf, '2025-01-01')
    // $500 * (1.30)^(366/365) ≈ $650.5

    expect(result).toBeCloseTo(holdHalfResult, 0)
  })

  it('sell reduces gain proportionally regardless of timing', () => {
    // Test that a 30% sell always removes 30% of accumulated gain
    const buyOnly: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]

    // Sell 30% at 3 months
    const sellAt3Mo: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-04-01', amount_usd: 300, type: 'sell' }
    ]
    const gainBefore3Mo = computeExpectedTarget(baseConfig, buyOnly, '2024-04-01') - 1000
    const resultAt3Mo = computeExpectedTarget(baseConfig, sellAt3Mo, '2024-04-01')
    const gainAfter3Mo = resultAt3Mo - 700  // 700 = 1000 - 300
    expect(gainAfter3Mo).toBeCloseTo(gainBefore3Mo * 0.7, 1)

    // Sell 30% at 6 months
    const sellAt6Mo: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 300, type: 'sell' }
    ]
    const gainBefore6Mo = computeExpectedTarget(baseConfig, buyOnly, '2024-07-01') - 1000
    const resultAt6Mo = computeExpectedTarget(baseConfig, sellAt6Mo, '2024-07-01')
    const gainAfter6Mo = resultAt6Mo - 700
    expect(gainAfter6Mo).toBeCloseTo(gainBefore6Mo * 0.7, 1)
  })

  it('selling from multiple buys reduces total gain proportionally', () => {
    // Two buys at different times, then one sell
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 500, type: 'buy' },
      { date: '2024-04-01', amount_usd: 500, type: 'buy' },
      { date: '2024-07-01', amount_usd: 500, type: 'sell' }  // 50% of total $1000
    ]

    // Calculate expected gain before sell
    const beforeSell: Trade[] = [
      { date: '2024-01-01', amount_usd: 500, type: 'buy' },
      { date: '2024-04-01', amount_usd: 500, type: 'buy' }
    ]
    const expectedBefore = computeExpectedTarget(baseConfig, beforeSell, '2024-07-01')
    const gainBefore = expectedBefore - 1000

    const result = computeExpectedTarget(baseConfig, trades, '2024-07-01')
    const gainAfter = result - 500  // startInput = 1000 - 500 = 500

    // Selling 50% should reduce total accumulated gain by 50%
    expect(gainAfter).toBeCloseTo(gainBefore * 0.5, 1)
  })
})

describe('computeExpectedTarget - value=0 regression', () => {
  it('SELL with value=0 does not trigger false liquidation', () => {
    // Regression: imported CSV entries often have value=0 (unknown).
    // Previously, value-based liquidation (value <= amount_usd) would fire
    // because 0 <= 200, zeroing out the expected target even though the
    // position was only partially sold. The trade.value > 0 guard fixes this.
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 200, type: 'sell', value: 0 }
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')

    // Should still have a positive expected target (partial sell, not liquidation)
    expect(result).toBeGreaterThan(0)

    // Compare with the same scenario without value field - should behave identically
    const tradesNoValue: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 200, type: 'sell' }
    ]
    const resultNoValue = computeExpectedTarget(baseConfig, tradesNoValue, '2025-01-01')
    expect(result).toBeCloseTo(resultNoValue, 2)
  })
})

describe('computeExpectedTarget - accumulate mode', () => {
  const accumulateConfig = { ...baseConfig, accumulate: true }

  it('partial sells do not reduce expected target in accumulate mode', () => {
    // In accumulate mode, partial sells are profit extraction only
    // The expected target (what invested capital should grow to) remains unchanged
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-07-01', amount_usd: 200, type: 'sell' }
    ]
    const resultWithSell = computeExpectedTarget(accumulateConfig, trades, '2025-01-01')

    // Compare with no sell - should be the same
    const tradesNoSell: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const resultNoSell = computeExpectedTarget(accumulateConfig, tradesNoSell, '2025-01-01')

    // In accumulate mode, partial sells don't affect expected target
    expect(resultWithSell).toBeCloseTo(resultNoSell, 0)
  })

  it('multiple partial sells do not incorrectly trigger liquidation detection', () => {
    // Multiple partial sells that together exceed the buy amount
    // should NOT be treated as a liquidation in accumulate mode
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-04-01', amount_usd: 400, type: 'sell' },
      { date: '2024-07-01', amount_usd: 400, type: 'sell' },
      { date: '2024-10-01', amount_usd: 400, type: 'sell' }  // Total sells = 1200 > 1000 buys
    ]
    const result = computeExpectedTarget(accumulateConfig, trades, '2025-01-01')

    // In accumulate mode, these are profit extractions, not liquidations
    // Expected target should still be based on original $1000 investment
    const tradesNoSell: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const resultNoSell = computeExpectedTarget(accumulateConfig, tradesNoSell, '2025-01-01')

    expect(result).toBeCloseTo(resultNoSell, 0)
  })

  it('expected target remains stable after multiple profit extractions', () => {
    // Simulate DCA buying with periodic profit taking in accumulate mode
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 500, type: 'buy' },
      { date: '2024-03-01', amount_usd: 100, type: 'sell' },  // Profit extraction
      { date: '2024-04-01', amount_usd: 500, type: 'buy' },
      { date: '2024-06-01', amount_usd: 150, type: 'sell' },  // Profit extraction
      { date: '2024-07-01', amount_usd: 500, type: 'buy' }
    ]
    const result = computeExpectedTarget(accumulateConfig, trades, '2025-01-01')

    // The sells should not affect expected target in accumulate mode
    // Expected target should be based on $1500 total invested (500 + 500 + 500)
    expect(computeStartInput(trades, '2025-01-01', accumulateConfig)).toBe(1500)
    expect(result).toBeGreaterThan(1500)  // Should have compounding gains
  })

  it('full liquidation still resets in accumulate mode', () => {
    // Even in accumulate mode, a full liquidation (selling 100%) should reset
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy', shares: 10 },
      { date: '2024-07-01', amount_usd: 1200, type: 'sell', shares: 10, value: 1200 }  // Full liquidation
    ]
    const result = computeExpectedTarget(accumulateConfig, trades, '2025-01-01')

    // Full liquidation should zero out expected target
    expect(result).toBe(0)
  })
})

describe('computeExpectedTarget - edge cases', () => {
  it('handles leap year (366 days)', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    // 2024 is a leap year, so 366 days
    const result = computeExpectedTarget(baseConfig, trades, '2024-12-31')
    // $1000 * (1.30)^(365/365) = $1300
    expect(result).toBeCloseTo(1300, 0)
  })

  it('handles 0% target APY', () => {
    const zeroApyConfig = { ...baseConfig, target_apy: 0 }
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeExpectedTarget(zeroApyConfig, trades, '2025-01-01')
    // With 0% APY, expected = start input (no growth)
    expect(result).toBe(1000)
  })

  it('handles 100%+ target APY', () => {
    const highApyConfig = { ...baseConfig, target_apy: 1.5 } // 150% APY
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeExpectedTarget(highApyConfig, trades, '2025-01-01')
    // $1000 * (2.5)^(366/365) ≈ $2506 (leap year)
    expect(result).toBeCloseTo(2506, 0)
  })

  it('handles trades on same day', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 500, type: 'buy' },
      { date: '2024-01-01', amount_usd: 500, type: 'buy' }
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2025-01-01')
    // Both trades compound for same duration
    // $1000 * (1.30)^(366/365) ≈ $1301 (leap year)
    expect(result).toBeCloseTo(1301, 0)
  })

  it('handles very old trades (10+ years)', () => {
    const trades: Trade[] = [
      { date: '2014-01-01', amount_usd: 1000, type: 'buy' }
    ]
    const result = computeExpectedTarget(baseConfig, trades, '2024-01-01')
    // $1000 * (1.30)^(3653/365) ≈ $13,806 (includes leap years)
    expect(result).toBeCloseTo(13806, 0)
  })
})

describe('computeCashAvailable', () => {
  // Use config with reinvest disabled to get simpler cash calculations
  const noReinvestConfig: SubFundConfig = {
    ...baseConfig,
    dividend_reinvest: false,
    interest_reinvest: false,
    expense_from_fund: false
  }

  it('returns full fund size when no trades', () => {
    const result = computeCashAvailable(noReinvestConfig, [], [], [], [], '2024-01-01')
    expect(result).toBe(10000)
  })

  it('reduces cash after BUY trades', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 100, type: 'buy' },
      { date: '2024-01-08', amount_usd: 100, type: 'buy' }
    ]
    const result = computeCashAvailable(noReinvestConfig, trades, [], [], [], '2024-01-15')
    expect(result).toBe(9800)
  })

  it('increases cash after SELL trades', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-01-08', amount_usd: 500, type: 'sell' }
    ]
    const result = computeCashAvailable(noReinvestConfig, trades, [], [], [], '2024-01-15')
    expect(result).toBe(9500)
  })

  it('handles external deposits', () => {
    const cashflows: CashFlow[] = [
      { date: '2024-01-15', amount_usd: 1000, type: 'deposit' }
    ]
    const result = computeCashAvailable(noReinvestConfig, [], cashflows, [], [], '2024-02-01')
    expect(result).toBe(11000)
  })

  it('handles external withdrawals', () => {
    const cashflows: CashFlow[] = [
      { date: '2024-01-15', amount_usd: 2000, type: 'withdrawal' }
    ]
    const result = computeCashAvailable(noReinvestConfig, [], cashflows, [], [], '2024-02-01')
    expect(result).toBe(8000)
  })

  it('skips future events', () => {
    const trades: Trade[] = [
      { date: '2024-02-01', amount_usd: 100, type: 'buy' }
    ]
    const result = computeCashAvailable(noReinvestConfig, trades, [], [], [], '2024-01-15')
    expect(result).toBe(10000)
  })
})

describe('computeCashInterest', () => {
  it('calculates interest on full fund when no trades', () => {
    const result = computeCashInterest(baseConfig, [], [], '2025-01-01')
    // $10,000 * ((1.044)^(366/365) - 1) for full year (leap year 2024)
    // Approximately $441
    expect(result).toBeCloseTo(441, 0)
  })

  it('handles 0% APY', () => {
    const zeroApyConfig = { ...baseConfig, cash_apy: 0 }
    const result = computeCashInterest(zeroApyConfig, [], [], '2025-01-01')
    expect(result).toBe(0)
  })

  it('handles month boundary crossing', () => {
    const trades: Trade[] = [
      { date: '2024-01-15', amount_usd: 5000, type: 'buy' }
    ]
    const result = computeCashInterest(baseConfig, trades, [], '2024-02-15')
    // Period 1: $10,000 for 14 days (Jan 1-15)
    // Period 2: $5,000 for 31 days (Jan 15 - Feb 15)
    // Interest = $10,000 * ((1.044)^(14/365) - 1) + $5,000 * ((1.044)^(31/365) - 1)
    // Approximately $16.52 + $18.16 = $34.68
    expect(result).toBeCloseTo(35, 0)
  })

  it('calculates interest between multiple trades', () => {
    const trades: Trade[] = [
      { date: '2024-01-15', amount_usd: 2000, type: 'buy' },
      { date: '2024-02-15', amount_usd: 3000, type: 'buy' }
    ]
    const result = computeCashInterest(baseConfig, trades, [], '2024-03-15')
    // Period 1: $10,000 for 14 days
    // Period 2: $8,000 for 31 days
    // Period 3: $5,000 for 29 days
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(100)
  })
})

describe('computeRealizedGains', () => {
  // Use config with reinvest disabled so dividends/interest count as realized gains
  const noReinvestConfig: SubFundConfig = {
    ...baseConfig,
    dividend_reinvest: false,
    interest_reinvest: false,
    expense_from_fund: true
  }

  it('includes dividends in realized gains when not reinvesting', () => {
    const dividends: Dividend[] = [
      { date: '2024-06-15', amount_usd: 50 },
      { date: '2024-12-15', amount_usd: 50 }
    ]
    const result = computeRealizedGains(noReinvestConfig, [], [], dividends, [], '2025-01-01')
    // Should include cash interest + $100 dividends
    const interestOnly = computeCashInterest(noReinvestConfig, [], [], '2025-01-01')
    expect(result).toBeCloseTo(interestOnly + 100, 0)
  })

  it('subtracts expenses from realized gains when paid from fund', () => {
    const expenses: Expense[] = [
      { date: '2024-03-15', amount_usd: 25 },
      { date: '2024-09-15', amount_usd: 25 }
    ]
    const result = computeRealizedGains(noReinvestConfig, [], [], [], expenses, '2025-01-01')
    // Should be cash interest - $50 expenses
    const interestOnly = computeCashInterest(noReinvestConfig, [], [], '2025-01-01')
    expect(result).toBeCloseTo(interestOnly - 50, 0)
  })

  it('combines dividends, expenses, and interest when not reinvesting', () => {
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 30 }]
    const result = computeRealizedGains(noReinvestConfig, [], [], dividends, expenses, '2025-01-01')
    const interestOnly = computeCashInterest(noReinvestConfig, [], [], '2025-01-01')
    expect(result).toBeCloseTo(interestOnly + 100 - 30, 0)
  })

  it('skips future dividends and expenses', () => {
    const dividends: Dividend[] = [{ date: '2025-06-15', amount_usd: 100 }]
    const expenses: Expense[] = [{ date: '2025-06-15', amount_usd: 30 }]
    const result = computeRealizedGains(noReinvestConfig, [], [], dividends, expenses, '2025-01-01')
    const interestOnly = computeCashInterest(noReinvestConfig, [], [], '2025-01-01')
    expect(result).toBeCloseTo(interestOnly, 0)
  })

  it('includes ALL dividends and interest in realized gains (regardless of reinvest settings)', () => {
    const dividends: Dividend[] = [
      { date: '2024-06-15', amount_usd: 50 },
      { date: '2024-12-15', amount_usd: 50 }
    ]
    // Reinvest settings don't affect realized gains - ALL dividends and interest are counted
    const result = computeRealizedGains(baseConfig, [], [], dividends, [], '2025-01-01')
    const expectedInterest = computeCashInterest(baseConfig, [], [], '2025-01-01')
    // Realized = ALL interest + ALL dividends
    expect(result).toBeCloseTo(expectedInterest + 100, 0)
  })
})

describe('computeFundState', () => {
  it('returns zeroed state for closed fund (status: closed)', () => {
    const closedConfig = { ...baseConfig, status: 'closed' as const }
    const result = computeFundState(closedConfig, [], [], [], [], 100, '2024-06-01')
    expect(result.cash_available_usd).toBe(0)
    expect(result.expected_target_usd).toBe(0)
    expect(result.start_input_usd).toBe(0)
    expect(result.actual_value_usd).toBe(100)
    expect(result.gain_usd).toBe(0)
    expect(result.gain_pct).toBe(0)
    expect(result.target_diff_usd).toBe(0)
  })

  it('computes complete lifecycle state', () => {
    // Use config with reinvest disabled for clearer test values
    const noReinvestConfig: SubFundConfig = {
      ...baseConfig,
      dividend_reinvest: false,
      interest_reinvest: false,
      expense_from_fund: false
    }
    const trades: Trade[] = [
      { date: '2024-01-15', amount_usd: 1000, type: 'buy' },
      { date: '2024-03-15', amount_usd: 500, type: 'buy' },
      { date: '2024-06-15', amount_usd: 200, type: 'sell' }
    ]
    const dividends: Dividend[] = [{ date: '2024-06-01', amount_usd: 25 }]
    const expenses: Expense[] = [{ date: '2024-04-01', amount_usd: 10 }]

    const result = computeFundState(noReinvestConfig, trades, [], dividends, expenses, 1500, '2024-07-01')

    // start_input = 1000 + 500 - 200 = 1300
    expect(result.start_input_usd).toBe(1300)

    // cash_available = 10000 - 1300 = 8700 (with no reinvest)
    expect(result.cash_available_usd).toBe(8700)

    // expected_target > start_input (due to APY compounding)
    expect(result.expected_target_usd).toBeGreaterThan(1300)

    // actual_value from snapshot
    expect(result.actual_value_usd).toBe(1500)

    // gain_usd = 1500 - 1300 = 200
    expect(result.gain_usd).toBe(200)

    // gain_pct = (1500 / 1300) - 1 ≈ 0.1538
    expect(result.gain_pct).toBeCloseTo(0.1538, 3)

    // target_diff = actual - expected
    expect(result.target_diff_usd).toBe(1500 - result.expected_target_usd)

    // realized_gains includes interest + dividends (since not reinvesting)
    // expense_from_fund=false means expenses don't reduce realized gains
    const expectedInterest = computeCashInterest(noReinvestConfig, trades, [], '2024-07-01')
    expect(result.realized_gains_usd).toBeCloseTo(expectedInterest + 25, 0)
  })

  it('handles zero actual value with positive start_input', () => {
    const trades: Trade[] = [{ date: '2024-01-15', amount_usd: 1000, type: 'buy' }]
    const result = computeFundState(baseConfig, trades, [], [], [], 0, '2024-06-01')
    expect(result.actual_value_usd).toBe(0)
    expect(result.gain_usd).toBe(-1000)
    expect(result.gain_pct).toBe(-1)
  })
})

describe('computeClosedFundMetrics', () => {
  it('computes APY for short period (< 30 days)', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-01-15', amount_usd: 1050, type: 'sell' }
    ]
    const result = computeClosedFundMetrics(trades, [], [], 0, '2024-01-01', '2024-01-15')
    expect(result.total_invested_usd).toBe(1000)
    expect(result.total_returned_usd).toBe(1050)
    expect(result.net_gain_usd).toBe(50)
    expect(result.duration_days).toBe(14)
    // return_pct = 50/1000 = 5%
    expect(result.return_pct).toBeCloseTo(0.05, 5)
    expect(result.apy).toBeGreaterThan(0)
  })

  it('computes APY for long period (> 1 year)', () => {
    const trades: Trade[] = [
      { date: '2022-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-01-01', amount_usd: 1500, type: 'sell' }
    ]
    const result = computeClosedFundMetrics(trades, [], [], 0, '2022-01-01', '2024-01-01')
    expect(result.total_invested_usd).toBe(1000)
    expect(result.total_returned_usd).toBe(1500)
    expect(result.net_gain_usd).toBe(500)
    expect(result.duration_days).toBe(730) // 2022 (365) + 2023 (365) = 730
    // return_pct = 500/1000 = 50%
    // APY = (1 + 0.5)^(365/730) - 1 ≈ 22.5%
    expect(result.return_pct).toBeCloseTo(0.5, 5)
    expect(result.apy).toBeCloseTo(0.2247, 2)
  })

  it('includes dividends and expenses in metrics', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-12-01', amount_usd: 900, type: 'sell' }
    ]
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 50 }]
    const expenses: Expense[] = [{ date: '2024-03-15', amount_usd: 20 }]
    const cashInterest = 30

    const result = computeClosedFundMetrics(trades, dividends, expenses, cashInterest, '2024-01-01', '2024-12-01')
    expect(result.total_dividends_usd).toBe(50)
    expect(result.total_expenses_usd).toBe(20)
    expect(result.total_cash_interest_usd).toBe(30)
    // net_gain = 900 + 50 + 30 - 20 - 1000 = -40
    expect(result.net_gain_usd).toBe(-40)
    // return_pct = -40/1000 = -4%
    expect(result.return_pct).toBeCloseTo(-0.04, 5)
  })

  it('handles very short period (< 3 days) without division issues', () => {
    const trades: Trade[] = [
      { date: '2024-01-01', amount_usd: 1000, type: 'buy' },
      { date: '2024-01-02', amount_usd: 1010, type: 'sell' }
    ]
    const result = computeClosedFundMetrics(trades, [], [], 0, '2024-01-01', '2024-01-02')
    expect(result.duration_days).toBe(1)
    // return_pct = 10/1000 = 1%
    expect(result.return_pct).toBeCloseTo(0.01, 5)
    // For <= 3 days, APY = returnPct (no annualization)
    expect(result.apy).toBeCloseTo(result.return_pct, 5)
  })
})

describe('dividend_reinvest config option', () => {
  it('defaults to true - dividends add to cash and increase fund_size', () => {
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]

    // Default config (dividend_reinvest defaults to true)
    const resultDefault = computeCashAvailable(baseConfig, [], [], dividends, [], '2024-12-01')
    // Cash should include dividend (and interest which is also true by default)
    const interestAmount = computeCashInterest(baseConfig, [], [], '2024-12-01')
    expect(resultDefault).toBeCloseTo(10000 + 100 + interestAmount, 0)
  })

  it('when true - dividends add to cash balance', () => {
    const reinvestConfig = { ...baseConfig, dividend_reinvest: true, interest_reinvest: false }
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]

    const result = computeCashAvailable(reinvestConfig, [], [], dividends, [], '2024-12-01')
    // Cash should include dividend
    expect(result).toBe(10100)
  })

  it('when false - dividends do not add to cash', () => {
    const noReinvestConfig = { ...baseConfig, dividend_reinvest: false, interest_reinvest: false }
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]

    const result = computeCashAvailable(noReinvestConfig, [], [], dividends, [], '2024-12-01')
    // Cash should NOT include dividend
    expect(result).toBe(10000)
  })

  it('dividends always count as realized gains (reinvest setting does not affect realized gains)', () => {
    // Regardless of reinvest setting, dividends always count as realized
    const noReinvestConfig = { ...baseConfig, dividend_reinvest: false }
    const reinvestConfig = { ...baseConfig, dividend_reinvest: true }
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]

    const noReinvestResult = computeRealizedGains(noReinvestConfig, [], [], dividends, [], '2024-12-01')
    const reinvestResult = computeRealizedGains(reinvestConfig, [], [], dividends, [], '2024-12-01')
    const expectedInterest = computeCashInterest(noReinvestConfig, [], [], '2024-12-01')

    // Both should include dividends + interest
    expect(noReinvestResult).toBeCloseTo(expectedInterest + 100, 0)
    expect(reinvestResult).toBeCloseTo(expectedInterest + 100, 0)
  })
})

describe('interest_reinvest config option', () => {
  it('defaults to true - interest adds to cash', () => {
    // With dividend_reinvest false to isolate interest behavior
    const defaultConfig = { ...baseConfig, dividend_reinvest: false }
    const result = computeCashAvailable(defaultConfig, [], [], [], [], '2025-01-01')
    const expectedInterest = computeCashInterest(baseConfig, [], [], '2025-01-01')
    // Cash = fund_size + interest (since interest_reinvest defaults to true)
    expect(result).toBeCloseTo(10000 + expectedInterest, 0)
  })

  it('when true - interest adds to cash balance', () => {
    const reinvestConfig = { ...baseConfig, interest_reinvest: true, dividend_reinvest: false }
    const result = computeCashAvailable(reinvestConfig, [], [], [], [], '2025-01-01')
    const expectedInterest = computeCashInterest(reinvestConfig, [], [], '2025-01-01')
    expect(result).toBeCloseTo(10000 + expectedInterest, 0)
  })

  it('when false - interest does not add to cash', () => {
    const noReinvestConfig = { ...baseConfig, interest_reinvest: false, dividend_reinvest: false }
    const result = computeCashAvailable(noReinvestConfig, [], [], [], [], '2025-01-01')
    // Cash should NOT include interest
    expect(result).toBe(10000)
  })

  it('when false - interest counts as realized gains', () => {
    const noReinvestConfig = { ...baseConfig, interest_reinvest: false, dividend_reinvest: false }
    const result = computeRealizedGains(noReinvestConfig, [], [], [], [], '2025-01-01')
    const expectedInterest = computeCashInterest(noReinvestConfig, [], [], '2025-01-01')
    expect(result).toBeCloseTo(expectedInterest, 0)
  })

  it('interest always counts as realized gains (reinvest setting does not affect realized gains)', () => {
    // Regardless of reinvest setting, interest always counts as realized
    const noReinvestConfig = { ...baseConfig, interest_reinvest: false }
    const reinvestConfig = { ...baseConfig, interest_reinvest: true }

    const noReinvestResult = computeRealizedGains(noReinvestConfig, [], [], [], [], '2025-01-01')
    const reinvestResult = computeRealizedGains(reinvestConfig, [], [], [], [], '2025-01-01')
    const expectedInterest = computeCashInterest(noReinvestConfig, [], [], '2025-01-01')

    // Both should include interest
    expect(noReinvestResult).toBeCloseTo(expectedInterest, 0)
    expect(reinvestResult).toBeCloseTo(expectedInterest, 0)
  })
})

describe('expense_from_fund config option', () => {
  it('defaults to true - expenses reduce cash', () => {
    // Disable other reinvest options to isolate expense behavior
    const defaultConfig = { ...baseConfig, dividend_reinvest: false, interest_reinvest: false }
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const result = computeCashAvailable(defaultConfig, [], [], [], expenses, '2024-12-01')
    // Cash should be reduced by expenses
    expect(result).toBe(9900)
  })

  it('when true - expenses reduce cash balance', () => {
    const fromFundConfig = { ...baseConfig, expense_from_fund: true, dividend_reinvest: false, interest_reinvest: false }
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const result = computeCashAvailable(fromFundConfig, [], [], [], expenses, '2024-12-01')
    expect(result).toBe(9900)
  })

  it('when false - expenses do not reduce cash', () => {
    const externalConfig = { ...baseConfig, expense_from_fund: false, dividend_reinvest: false, interest_reinvest: false }
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const result = computeCashAvailable(externalConfig, [], [], [], expenses, '2024-12-01')
    // Cash should NOT be reduced by expenses (externally covered)
    expect(result).toBe(10000)
  })

  it('when true - expenses reduce realized gains', () => {
    const fromFundConfig = { ...baseConfig, expense_from_fund: true, interest_reinvest: false }
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const result = computeRealizedGains(fromFundConfig, [], [], [], expenses, '2024-12-01')
    const expectedInterest = computeCashInterest(fromFundConfig, [], [], '2024-12-01')
    expect(result).toBeCloseTo(expectedInterest - 100, 0)
  })

  it('when false - expenses do NOT reduce realized gains', () => {
    const externalConfig = { ...baseConfig, expense_from_fund: false, interest_reinvest: false }
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const result = computeRealizedGains(externalConfig, [], [], [], expenses, '2024-12-01')
    const expectedInterest = computeCashInterest(externalConfig, [], [], '2024-12-01')
    // Expenses externally covered = no impact on P&L
    expect(result).toBeCloseTo(expectedInterest, 0)
  })
})

describe('config options combined scenarios', () => {
  it('all options true (default) - maximum fund growth', () => {
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 50 }]

    const result = computeCashAvailable(baseConfig, [], [], dividends, expenses, '2024-12-01')
    const expectedInterest = computeCashInterest(baseConfig, [], [], '2024-12-01')
    // Cash = fund_size + dividends + interest - expenses
    expect(result).toBeCloseTo(10000 + 100 + expectedInterest - 50, 0)

    // Realized gains = ALL interest + ALL dividends - expenses
    const realizedGains = computeRealizedGains(baseConfig, [], [], dividends, expenses, '2024-12-01')
    expect(realizedGains).toBeCloseTo(expectedInterest + 100 - 50, 0)
  })

  it('all options false - maximum extraction', () => {
    const noReinvestConfig = {
      ...baseConfig,
      dividend_reinvest: false,
      interest_reinvest: false,
      expense_from_fund: false
    }
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 50 }]

    const result = computeCashAvailable(noReinvestConfig, [], [], dividends, expenses, '2024-12-01')
    // Cash = fund_size only (nothing added, nothing subtracted)
    expect(result).toBe(10000)

    // Realized gains = interest + dividends (no expense deduction since external)
    const realizedGains = computeRealizedGains(noReinvestConfig, [], [], dividends, expenses, '2024-12-01')
    const expectedInterest = computeCashInterest(noReinvestConfig, [], [], '2024-12-01')
    expect(realizedGains).toBeCloseTo(expectedInterest + 100, 0)
  })

  it('mixed config: reinvest dividends, extract interest, expenses external', () => {
    const mixedConfig = {
      ...baseConfig,
      dividend_reinvest: true,
      interest_reinvest: false,
      expense_from_fund: false
    }
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 50 }]

    // Cash = fund_size + dividends (reinvested) - no interest - no expenses
    const result = computeCashAvailable(mixedConfig, [], [], dividends, expenses, '2024-12-01')
    expect(result).toBe(10100)

    // Realized = ALL interest + ALL dividends (reinvest setting doesn't affect realized) + no expense impact (external)
    const realizedGains = computeRealizedGains(mixedConfig, [], [], dividends, expenses, '2024-12-01')
    const expectedInterest = computeCashInterest(mixedConfig, [], [], '2024-12-01')
    expect(realizedGains).toBeCloseTo(expectedInterest + 100, 0)
  })

  it('fund state integrates all config options correctly', () => {
    const mixedConfig = {
      ...baseConfig,
      dividend_reinvest: true,
      interest_reinvest: false,
      expense_from_fund: true
    }
    const trades: Trade[] = [{ date: '2024-01-15', amount_usd: 1000, type: 'buy' }]
    const dividends: Dividend[] = [{ date: '2024-06-15', amount_usd: 100 }]
    const expenses: Expense[] = [{ date: '2024-06-15', amount_usd: 50 }]

    const state = computeFundState(mixedConfig, trades, [], dividends, expenses, 1200, '2024-12-01')

    // start_input = 1000
    expect(state.start_input_usd).toBe(1000)

    // cash = fund_size - invested + dividends (reinvest) - expenses (from fund)
    // = 10000 - 1000 + 100 - 50 = 9050
    expect(state.cash_available_usd).toBe(9050)

    // realized gains = ALL interest + ALL dividends - expenses (from fund)
    const expectedInterest = computeCashInterest(mixedConfig, trades, [], '2024-12-01')
    expect(state.realized_gains_usd).toBeCloseTo(expectedInterest + 100 - 50, 0)
  })
})

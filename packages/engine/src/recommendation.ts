import { evaluateFallback } from './leverage-fallback.js'
import type { SubFundConfig, Recommendation, FundState } from './types.js'

/**
 * Optional market context for the 1x fallback rule.
 * Omit it, or leave the rule disabled, and recommendations are unchanged.
 * Drawdown versus cost basis is read from fund state. Peak drawdown and the
 * moving average are used only when this context supplies them.
 */
export interface FallbackContext {
  /** Positive fraction the leveraged price is below its running peak. */
  drawdownFromPeak?: number
  /** Underlying closes, oldest first, including the latest close. */
  underlyingCloses?: readonly number[]
}

/**
 * Determines the action amount (limit) based on fund performance.
 *
 * Logic from spreadsheet:
 * - If gain_usd < 0 (lost money):
 *   - If gain_pct < max_at_pct (significant loss): use input_max_usd
 *   - Else: use input_mid_usd
 * - Else (made money or break-even): use input_min_usd
 */
export function computeLimit(config: SubFundConfig, state: FundState): number {
  const { input_min_usd, input_mid_usd, input_max_usd, max_at_pct } = config

  // If no investment yet, use min amount for initial buy
  if (state.start_input_usd === 0) {
    return input_min_usd
  }

  // If lost money this period
  if (state.gain_usd < 0) {
    // If loss exceeds threshold (e.g., -25%), use max amount
    if (state.gain_pct < max_at_pct) {
      return input_max_usd
    }
    // Otherwise use mid amount
    return input_mid_usd
  }

  // Made money or break-even: use min amount
  return input_min_usd
}

/**
 * Computes a buy/sell recommendation based on fund state.
 *
 * Logic from spreadsheet:
 * - If target_diff > min_profit (above target by profit threshold):
 *   - If accumulate mode: SELL the limit amount
 *   - Else: SELL everything
 * - Else if cash < limit:
 *   - BUY what we can afford
 * - Else:
 *   - BUY the limit amount (normal DCA)
 */
export function computeRecommendation(
  config: SubFundConfig,
  state: FundState,
  fallbackContext?: FallbackContext
): Recommendation | null {
  // Cash funds don't need trading recommendations - only DEPOSIT/WITHDRAW
  if (config.fund_type === 'cash') {
    return null
  }

  // Derivatives funds use their own order management system
  // Standard BUY/SELL recommendations don't apply to perpetual futures
  if (config.fund_type === 'derivatives') {
    return null
  }

  // Closed fund - no recommendation
  if (config.status === 'closed') {
    return null
  }

  const { min_profit_usd, accumulate, manage_cash } = config
  const hasCashPool = manage_cash ?? true // Default to true for backwards compatibility

  const limit = computeLimit(config, state)
  const { start_input_usd, expected_target_usd, actual_value_usd, gain_usd, gain_pct, target_diff_usd, cash_available_usd } = state

  // Special case: no investment yet, recommend initial BUY
  if (start_input_usd === 0 && actual_value_usd === 0) {
    // For non-cash managed funds, always use full limit (no cash pool to check)
    const buyAmount = hasCashPool ? Math.min(limit, cash_available_usd) : limit
    return routeBuyIfFallback(config, state, fallbackContext, {
      action: 'BUY',
      amount: buyAmount,
      explanation: {
        start_input_usd,
        expected_target_usd,
        actual_value_usd,
        gain_usd,
        gain_pct,
        target_diff_usd,
        cash_available_usd,
        limit_usd: limit,
        reasoning: `Initial DCA purchase of $${buyAmount.toFixed(2)}.`
      },
      insufficient_cash: hasCashPool && cash_available_usd < limit
    })
  }

  // Above target by more than min_profit AND actually in profit: SELL
  // Never sell at a loss just because we're "ahead" of a declining target curve
  if (target_diff_usd > min_profit_usd && gain_usd > 0) {
    // Determine sell amount based on accumulate mode
    const sellAmount = accumulate ? limit : actual_value_usd

    return {
      action: 'SELL',
      amount: sellAmount,
      explanation: {
        start_input_usd,
        expected_target_usd,
        actual_value_usd,
        gain_usd,
        gain_pct,
        target_diff_usd,
        cash_available_usd,
        limit_usd: limit,
        reasoning: accumulate
          ? `Above target by $${target_diff_usd.toFixed(2)} (> $${min_profit_usd.toFixed(2)} threshold). Accumulate mode: SELL $${sellAmount.toFixed(2)}.`
          : `Above target by $${target_diff_usd.toFixed(2)} (> $${min_profit_usd.toFixed(2)} threshold). Liquidating entire position of $${sellAmount.toFixed(2)}.`
      },
      insufficient_cash: false
    }
  }

  // Below or at target: BUY
  // For non-cash managed funds, always use full limit (no cash pool to check)
  const buyAmount = hasCashPool ? Math.min(limit, cash_available_usd) : limit
  const insufficient = hasCashPool && cash_available_usd < limit

  // Determine reasoning based on performance
  let reasoning: string
  if (gain_usd < 0 && gain_pct < config.max_at_pct) {
    reasoning = `Significant loss (${(gain_pct * 100).toFixed(1)}% < ${(config.max_at_pct * 100).toFixed(0)}% threshold). DCA max amount: $${limit.toFixed(2)}.`
  } else if (gain_usd < 0) {
    reasoning = `Below cost basis (${(gain_pct * 100).toFixed(1)}% loss). DCA mid amount: $${limit.toFixed(2)}.`
  } else {
    reasoning = `On track or above cost. DCA min amount: $${limit.toFixed(2)}.`
  }

  // If no cash available for buying, recommend HOLD instead of BUY $0
  // Check both: cash-managed funds with no cash, OR non-cash-managed funds with zero cash
  if ((hasCashPool && buyAmount < 0.01) || (!hasCashPool && cash_available_usd < 0.01)) {
    reasoning = `No cash available for DCA. Holding position.`
    return {
      action: 'HOLD',
      amount: 0,
      explanation: {
        start_input_usd,
        expected_target_usd,
        actual_value_usd,
        gain_usd,
        gain_pct,
        target_diff_usd,
        cash_available_usd,
        limit_usd: limit,
        reasoning
      },
      insufficient_cash: true
    }
  }

  if (insufficient) {
    reasoning += ` Insufficient cash: only $${cash_available_usd.toFixed(2)} available.`
  }

  return routeBuyIfFallback(config, state, fallbackContext, {
    action: 'BUY',
    amount: buyAmount,
    explanation: {
      start_input_usd,
      expected_target_usd,
      actual_value_usd,
      gain_usd,
      gain_pct,
      target_diff_usd,
      cash_available_usd,
      limit_usd: limit,
      reasoning
    },
    insufficient_cash: insufficient
  })
}

/**
 * When the fallback rule is enabled and a trigger is live, point the buy at
 * the 1x ticker. Dollar amount, action, and every disabled-rule result stay
 * as they were. This never adds margin.
 */
function routeBuyIfFallback(
  config: SubFundConfig,
  state: FundState,
  context: FallbackContext | undefined,
  recommendation: Recommendation
): Recommendation {
  if (!config.fallback_enabled || recommendation.action !== 'BUY') return recommendation
  const ticker = config.fallback_ticker?.trim().toUpperCase()
  if (!ticker) return recommendation

  const fromCost = state.gain_pct < 0 ? -state.gain_pct : 0
  const decision = evaluateFallback(
    {
      enabled: true,
      fallbackTicker: ticker,
      ...(config.fallback_drawdown_pct !== undefined
        ? { drawdownThreshold: config.fallback_drawdown_pct }
        : {}),
      ...(config.fallback_ma_days !== undefined ? { maDays: config.fallback_ma_days } : {})
    },
    {
      drawdownFromCost: fromCost,
      ...(context?.drawdownFromPeak !== undefined
        ? { drawdownFromPeak: context.drawdownFromPeak }
        : {}),
      ...(context?.underlyingCloses !== undefined
        ? { underlyingCloses: context.underlyingCloses }
        : {})
    }
  )
  if (!decision.active || !decision.routeTicker) return recommendation

  const parts: string[] = []
  if (decision.reason === 'drawdown' || decision.reason === 'drawdown_and_below_ma') {
    const threshold = (config.fallback_drawdown_pct ?? 0.6) * 100
    parts.push(`down ${(decision.drawdown * 100).toFixed(1)}% (threshold ${threshold.toFixed(0)}%)`)
  }
  if (decision.reason === 'below_ma' || decision.reason === 'drawdown_and_below_ma') {
    const days = config.fallback_ma_days ?? 200
    parts.push(`underlying is below its ${days}-day average`)
  }
  const why = parts.join(' and ')
  return {
    ...recommendation,
    route_ticker: decision.routeTicker,
    explanation: {
      ...recommendation.explanation,
      reasoning: `${recommendation.explanation.reasoning} 1x fallback is active (${why}). Buy ${decision.routeTicker} instead of the leveraged fund. Do not use margin.`
    }
  }
}

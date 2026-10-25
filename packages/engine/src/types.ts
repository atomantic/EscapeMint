export type ActionType = 'BUY' | 'SELL' | 'HOLD'

export type FundStatus = 'active' | 'closed'

/**
 * Fund category represents investment philosophy pillars:
 * - 'liquidity': 24/7 cash access for spending/investing
 * - 'yield': Stable high-yield instruments (STRC or similar stable dividend stocks)
 * - 'sov': Store of Value, hedge against fiat (BTC)
 * - 'volatility': Capture market fluctuations (TQQQ, whole market exposure)
 *
 * Note: Margin is tracked separately as borrowing capacity, not an allocation category.
 */
export type FundCategory = 'liquidity' | 'yield' | 'sov' | 'volatility'

/**
 * Category allocation for multi-category "pie" funds.
 * Allows a single fund to be split across multiple investment philosophy categories.
 */
export interface CategoryAllocation {
  /** The category this allocation belongs to */
  category: FundCategory
  /** Percentage of the fund allocated to this category (0-100, should sum to 100) */
  percentage: number
}

/**
 * Fund type determines asset class and available features:
 * - 'cash': Platform cash pools (DEPOSIT/WITHDRAW only, no dividends)
 * - 'stock': Stock/ETF trading (full features including dividends)
 * - 'crypto': Cryptocurrency trading (no dividends, has staking rewards via interest)
 * - 'derivatives': Futures/perpetuals trading (FIFO cost basis, margin, liquidation tracking)
 */
export type FundType = 'cash' | 'stock' | 'crypto' | 'derivatives'

export interface SubFundConfig {
  /**
   * Fund type determines asset class and available features.
   * Defaults to 'stock' if not specified.
   */
  fund_type?: FundType

  /**
   * Fund status: 'active' for running funds, 'closed' for completed funds.
   * Defaults to 'active' if not specified.
   */
  status?: FundStatus

  /**
   * Fund category for portfolio balance tracking.
   * Represents the investment philosophy pillar this fund belongs to.
   * If not specified, defaults based on fund_type (cash→liquidity, crypto→sov, derivatives→volatility).
   * For single-category funds only. Use category_allocations for multi-category "pie" funds.
   */
  category?: FundCategory

  /**
   * Multi-category allocations for "pie" funds (e.g., M1 Finance pies).
   * When set, the fund's value is split across categories based on these percentages.
   * Percentages should sum to 100. Takes precedence over single category field.
   */
  category_allocations?: CategoryAllocation[]

  /**
   * Total capital allocated to this sub-fund (e.g., $10,000).
   * This is the total fund size including both cash and invested amounts.
   */
  fund_size_usd: number

  /**
   * Target annual percentage yield (e.g., 0.25 for 25% APY).
   * Used to calculate expected growth of invested amounts.
   */
  target_apy: number

  /**
   * Trading interval in days (1=daily, 7=weekly, 30=monthly).
   */
  interval_days: number

  /**
   * DCA amount when asset is performing at or above target.
   */
  input_min_usd: number

  /**
   * DCA amount when asset is below target but not significantly.
   */
  input_mid_usd: number

  /**
   * DCA amount when asset is significantly below target (loss exceeds max_at_pct).
   */
  input_max_usd: number

  /**
   * Threshold for using max DCA amount (e.g., -0.25 for -25% loss).
   * When gain_pct < max_at_pct, use input_max_usd.
   */
  max_at_pct: number

  /**
   * Minimum profit (in USD) above expected target to trigger SELL.
   * If target_diff_usd > min_profit_usd, recommend selling.
   */
  min_profit_usd: number

  /**
   * Interest rate earned on idle cash (e.g., 0.044 for 4.4% APY).
   */
  cash_apy: number

  /**
   * Margin interest rate if borrowing (e.g., 0.0725 for 7.25% APR).
   */
  margin_apr: number

  /**
   * Maximum margin available for this fund (0 if no margin access).
   */
  margin_access_usd: number

  /**
   * Accumulate vs Harvest mode:
   * - true (Accumulate): Buy/sell only the DCA amount (reinvest profits, keep position)
   * - false (Harvest): When above target, harvest entire position back to cash
   */
  accumulate: boolean

  /**
   * Cash management mode (defaults to true):
   * - true: Fund maintains a cash pile, sells add to cash balance
   * - false: No cash pile, sells auto-withdraw (fund_size = invested, cash = 0)
   */
  manage_cash?: boolean

  /**
   * Enable margin features (defaults to false).
   * When enabled, margin APR and margin access/borrowed tracking are available.
   */
  margin_enabled?: boolean

  /**
   * Dividend handling (defaults to true = reinvest):
   * - true: Dividends add to cash and increase fund_size
   * - false: Dividends extracted as profit (fund_size unchanged)
   */
  dividend_reinvest?: boolean

  /**
   * Cash interest handling (defaults to true = reinvest):
   * - true: Interest adds to cash and increases fund_size
   * - false: Interest extracted as profit (fund_size unchanged)
   */
  interest_reinvest?: boolean

  /**
   * Expense handling (defaults to true = from fund):
   * - true: Expenses reduce fund_size (paid from fund)
   * - false: Expenses covered externally (fund_size unchanged)
   */
  expense_from_fund?: boolean

  /**
   * ID of the cash fund to use for available cash when manage_cash=false.
   * If not specified, defaults to '{platform}-cash' convention.
   * When set, recommendations will check this fund's balance for available cash.
   */
  cash_fund?: string

  /**
   * @deprecated No longer used - start date is derived from first entry date.
   * Kept optional for backward compatibility with existing JSON configs.
   */
  start_date?: string

  /**
   * Optional chart display settings for Y-axis bounds.
   * Keys are chart names, values are {yMin?, yMax?} bounds.
   */
  chart_bounds?: Record<string, { yMin?: number; yMax?: number }>

  /**
   * Optional column order for entries table display.
   * Array of column IDs in user-preferred order.
   */
  entries_column_order?: string[]

  /**
   * Optional set of visible columns for entries table.
   * Array of column IDs that should be shown.
   */
  entries_visible_columns?: string[]

  /**
   * ISO date string indicating when this fund was last audited.
   * Null/undefined means not audited.
   */
  audited?: string

  /**
   * Route new buys from a daily-reset leveraged fund to its 1x equivalent
   * while the fund is in a deep drawdown or its underlying is below a moving average.
   * Off unless set. Existing funds are unchanged.
   */
  fallback_enabled?: boolean

  /**
   * Drawdown that triggers the 1x fallback, as a positive fraction.
   * 0.60 means "down 60%" from the fund's peak or from cost basis.
   * Defaults to 0.60 when the rule is enabled.
   */
  fallback_drawdown_pct?: number

  /**
   * Underlying moving-average length, in trading days. Defaults to 200.
   * New buys return to the leveraged fund only once this trend has recovered
   * and the drawdown is back inside the threshold.
   */
  fallback_ma_days?: number

  /**
   * Ticker that receives new buys while the fallback is active.
   * Typical pairs: TQQQ→QQQ, SOXL→SOXX, SPXL→SPY (VOO is the same exposure).
   */
  fallback_ticker?: string

  // ============================================
  // Derivatives-specific configuration fields
  // ============================================

  /**
   * Coinbase product ID for the futures contract.
   * Examples: 'BIP-20DEC30-CDE' (micro BTC), 'BTC-PERP-INTX' (standard)
   */
  product_id?: string

  /**
   * Initial margin rate for opening positions (e.g., 0.20 for 20%).
   * Defaults to 0.20 for Coinbase BTC futures.
   */
  initial_margin_rate?: number

  /**
   * Maintenance margin rate for liquidation calculation (e.g., 0.20 for 20%).
   * Defaults to 0.20 for Coinbase BTC perpetuals.
   */
  maintenance_margin_rate?: number

  /**
   * Contract multiplier - BTC amount per contract.
   * 0.01 for BIP micro-futures, 1.0 for standard BTC-PERP.
   */
  contract_multiplier?: number

  /**
   * Reference name for stored API credentials in macOS Keychain.
   * Used to fetch Coinbase API key/secret for this fund.
   */
  api_key_name?: string

  /**
   * Liquidation mode threshold - target gain percentage before recommending liquidation.
   * Similar to min_profit_usd but percentage-based for derivatives.
   * E.g., 0.30 means recommend closing when 30% above cost basis.
   */
  liquidation_threshold_pct?: number
}

/**
 * A purchase (BUY) or sale (SELL) of the asset.
 * BUY: moves cash from pool into the investment
 * SELL: moves value from investment back to cash
 */
export interface Trade {
  date: string
  amount_usd: number
  type: 'buy' | 'sell'
  /** Optional: number of shares/units traded (for share-based liquidation detection) */
  shares?: number
  /** Optional: equity value before action (for value-based liquidation detection) */
  value?: number
}

/**
 * External cash added to or removed from the cash pool.
 * deposit: adding more cash to invest (e.g., monthly contribution)
 * withdrawal: removing cash from pool (e.g., taking profits)
 */
export interface CashFlow {
  date: string
  amount_usd: number
  type: 'deposit' | 'withdrawal'
}

export interface Dividend {
  date: string
  amount_usd: number
}

export interface Expense {
  date: string
  amount_usd: number
}

export interface RecommendationInput {
  config: SubFundConfig
  trades: Trade[]
  cashflows: CashFlow[]
  dividends: Dividend[]
  expenses: Expense[]
  snapshot_date: string
  equity_value_usd: number
}

export interface Explanation {
  start_input_usd: number
  expected_target_usd: number
  actual_value_usd: number
  gain_usd: number
  gain_pct: number
  target_diff_usd: number
  cash_available_usd: number
  limit_usd: number
  reasoning: string
}

export interface Recommendation {
  action: ActionType
  amount: number
  explanation: Explanation
  insufficient_cash?: boolean
  /**
   * Set only when the 1x fallback rule is enabled and active.
   * A BUY of this amount should be placed in this ticker instead of the leveraged fund.
   */
  route_ticker?: string
}

/**
 * Computed state of a subfund at a point in time.
 */
export interface FundState {
  /** Total cash remaining in pool (fund_size - total_invested + deposits - withdrawals) */
  cash_available_usd: number
  /** Expected target value based on compounded growth of purchases */
  expected_target_usd: number
  /** Actual equity value from latest snapshot */
  actual_value_usd: number
  /** Total amount invested (sum of buys - sells) */
  start_input_usd: number
  /** Gain in USD (actual - start_input) */
  gain_usd: number
  /** Gain as percentage ((actual / start_input) - 1) */
  gain_pct: number
  /** Difference from expected (actual - expected_target) */
  target_diff_usd: number
  /** Cumulative cash interest earned */
  cash_interest_usd: number
  /** Cumulative realized gains (interest + dividends + sell profits - expenses) */
  realized_gains_usd: number
}

/**
 * Historical performance metrics for a closed fund.
 */
export interface ClosedFundMetrics {
  /** Total amount invested (sum of all BUY transactions) */
  total_invested_usd: number
  /** Total amount returned (sum of all SELL transactions) */
  total_returned_usd: number
  /** Total dividends received */
  total_dividends_usd: number
  /** Total cash interest earned */
  total_cash_interest_usd: number
  /** Total expenses paid */
  total_expenses_usd: number
  /** Net gain/loss (returned + dividends + cash_interest - expenses - invested) */
  net_gain_usd: number
  /** Return percentage (net_gain / total_invested) */
  return_pct: number
  /** Annualized return (APY) */
  apy: number
  /** First entry date */
  start_date: string
  /** Last entry date */
  end_date: string
  /** Duration in days */
  duration_days: number
}

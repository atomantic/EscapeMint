export {
  computeStartInput,
  computeExpectedTarget,
  computeCashAvailable,
  computeCashInterest,
  computeRealizedGains,
  computeFundState,
  computeClosedFundMetrics
} from './expected-equity.js'
export {
  processTrade,
  calculateLiquidationPrice,
  calculateEquityAtPrice,
  calculateSafeLimitOrders,
  mergeFundingData,
  calculateDailyPnL,
  processTradeHistory,
  computeDerivativesState,
  computeDerivativesEntriesState,
  formatPositionSummary
} from './derivatives-calculations.js'
export type { DerivativesEntryState } from './derivatives-calculations.js'
export { computeLimit, computeRecommendation } from './recommendation.js'
export { formatCurrency, formatPercent, summarizeFundState } from './explainer.js'
export {
  getFundStartDate,
  computeTimeWeightedFundSize,
  computeCashFundTimeWeightedSize,
  computeRealizedAPY,
  computeProjectedAnnualReturn,
  computeFundMetrics,
  computeAggregateMetrics
} from './aggregate.js'
export type {
  ActionType,
  FundStatus,
  FundType,
  FundCategory,
  CategoryAllocation,
  SubFundConfig,
  Trade,
  CashFlow,
  Dividend,
  Expense,
  RecommendationInput,
  Explanation,
  Recommendation,
  FundState,
  ClosedFundMetrics
} from './types.js'
export type {
  CostBasisLot,
  DerivativesPosition,
  FundingPayment,
  RewardPayment,
  ProcessedTrade,
  DailyPnL,
  SuggestedOrder,
  OrderLadder,
  CoinbasePosition,
  CoinbaseFill,
  CoinbaseFundingPayment,
  ApiKeyReference,
  SyncResult
} from './derivatives-types.js'
export type {
  FundMetrics,
  AggregateMetrics
} from './aggregate.js'
export {
  FUND_TYPE_DEFAULTS,
  FUND_TYPE_FEATURES,
  ALLOWED_ACTIONS,
  FUND_CATEGORY_CONFIG,
  FUND_CATEGORIES,
  DEFAULT_CATEGORY_BY_TYPE,
  isCashFund,
  isDerivativesFund,
  isTradingFund,
  getFundTypeFeatures,
  getFundTypeDefaults,
  getAllowedActions,
  isValidAction,
  applyFundTypeDefaults,
  getFundCategoryConfig,
  getEffectiveCategory
} from './fund-type-config.js'
export type {
  FundTypeFeatures,
  FundCategoryConfig,
  CashFundAction,
  TradingFundAction,
  DerivativesFundAction
} from './fund-type-config.js'

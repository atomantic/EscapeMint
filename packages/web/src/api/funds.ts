import { fetchJson, postJson, putJson, deleteResource, API_BASE } from './utils'
import type { ApiResult } from './utils'
import type { DerivativesEntryState } from '@escapemint/engine'

export type { ApiResult }

// Event to notify components when funds list changes
export const FUNDS_CHANGED_EVENT = 'escapemint:funds-changed'

export function notifyFundsChanged() {
  window.dispatchEvent(new CustomEvent(FUNDS_CHANGED_EVENT))
}

export interface ChartBounds {
  yMin?: number
  yMax?: number
}

export type FundStatus = 'active' | 'closed'
export type FundType = 'cash' | 'stock' | 'crypto' | 'derivatives'
export type FundCategory = 'liquidity' | 'yield' | 'sov' | 'volatility'

export interface CategoryAllocation {
  category: FundCategory
  percentage: number
}

export interface FundConfig {
  fund_type?: FundType
  status?: FundStatus
  category?: FundCategory
  category_allocations?: CategoryAllocation[]
  fund_size_usd: number
  target_apy: number
  interval_days: number
  input_min_usd: number
  input_mid_usd: number
  input_max_usd: number
  max_at_pct: number
  min_profit_usd: number
  cash_apy: number
  margin_apr: number
  margin_access_usd: number
  accumulate: boolean
  manage_cash?: boolean
  margin_enabled?: boolean
  dividend_reinvest?: boolean
  interest_reinvest?: boolean
  expense_from_fund?: boolean
  cash_fund?: string  // ID of cash fund to use when manage_cash=false
  start_date?: string
  chart_bounds?: Record<string, ChartBounds>
  charts_collapsed?: boolean
  entries_column_order?: string[]
  entries_visible_columns?: string[]
  audited?: string
  // Derivatives-specific config
  product_id?: string  // Coinbase product ID (e.g., 'BIP-20DEC30-CDE')
  initial_margin_rate?: number  // Default 0.20 (20%)
  maintenance_margin_rate?: number  // Default 0.05 (5%)
  contract_multiplier?: number  // 0.01 for BIP micro-futures
  api_key_name?: string  // Reference to stored Keychain credential
  liquidation_threshold_pct?: number  // Alert threshold
  initial_deposit?: number  // Starting margin deposit (added on re-import)
}

export interface FundSummary {
  id: string
  platform: string
  ticker: string
  config: FundConfig
  entryCount: number
  latestEquity: {
    date: string
    value: number
  } | null
  latestFundSize?: number
  firstEntryDate?: string
}

// Action types for regular funds (trading, cash, crypto)
export type RegularFundAction = 'BUY' | 'SELL' | 'HOLD' | 'DEPOSIT' | 'WITHDRAW' | 'MARGIN'

// Action types specific to derivatives funds
export type DerivativesFundAction = 'FUNDING' | 'INTEREST' | 'REBATE' | 'FEE'

// Combined action type for all funds
export type FundAction = RegularFundAction | DerivativesFundAction

export interface FundEntry {
  date: string
  value: number
  cash?: number  // Actual cash available in account (tracked, not calculated)
  action?: FundAction
  amount?: number
  shares?: number
  price?: number
  dividend?: number
  expense?: number
  cash_interest?: number
  fund_size?: number
  margin_available?: number
  margin_borrowed?: number
  margin_expense?: number    // Margin interest expense for cash funds with margin
  notes?: string

  // Derivatives-specific fields
  contracts?: number           // Number of contracts (position size)
  entry_price?: number         // Average entry price at snapshot
  liquidation_price?: number   // Calculated liquidation price
  unrealized_pnl?: number      // Unrealized P&L at snapshot
  margin_locked?: number       // Total margin locked in positions
  fee?: number                 // Trading fee associated with BUY/SELL action
  margin?: number              // Actual margin locked for BUY/SELL trades
}

export interface FundState {
  cash_available_usd: number
  expected_target_usd: number
  actual_value_usd: number
  start_input_usd: number
  gain_usd: number
  gain_pct: number
  target_diff_usd: number
  cash_interest_usd: number
  realized_gains_usd: number
}

export interface Recommendation {
  action: 'BUY' | 'SELL' | 'HOLD'
  amount: number
  explanation: {
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
  insufficient_cash?: boolean
}

export interface FundDetail {
  id: string
  platform: string
  ticker: string
  config: FundConfig
  entries: FundEntry[]
}

export interface ClosedFundMetrics {
  total_invested_usd: number
  total_returned_usd: number
  total_dividends_usd: number
  total_cash_interest_usd: number
  total_expenses_usd: number
  net_gain_usd: number
  return_pct: number
  apy: number
  start_date: string
  end_date: string
  duration_days: number
}

// Derivatives entry state from engine calculations
// DerivativesEntryState is imported from @escapemint/engine

export interface FundStateResponse {
  fund: {
    id: string
    platform: string
    ticker: string
    config: FundConfig
  }
  state: FundState | null
  recommendation: Recommendation | null
  closedMetrics: ClosedFundMetrics | null
  margin_available?: number
  margin_borrowed?: number
  cash_available?: number
  cash_source?: string | null  // null if from own fund, fund ID if from shared cash fund
  fund_size?: number
  derivativesEntriesState?: DerivativesEntryState[]  // Computed state for each derivatives entry
}

export async function fetchFunds(includeTest = false): Promise<ApiResult<FundSummary[]>> {
  const url = includeTest ? `${API_BASE}/funds?include_test=true` : `${API_BASE}/funds`
  return fetchJson<FundSummary[]>(url, undefined, 'Failed to fetch funds')
}

export async function fetchFund(id: string): Promise<ApiResult<FundDetail>> {
  return fetchJson<FundDetail>(`${API_BASE}/funds/${id}`, undefined, 'Fund not found')
}

export async function fetchFundState(id: string, markPrice?: number): Promise<ApiResult<FundStateResponse>> {
  const url = markPrice
    ? `${API_BASE}/funds/${id}/state?markPrice=${markPrice}`
    : `${API_BASE}/funds/${id}/state`
  return fetchJson<FundStateResponse>(url, undefined, 'Failed to fetch fund state')
}

export async function updateFundConfig(id: string, config: Partial<FundConfig>): Promise<ApiResult<FundDetail>> {
  return putJson<FundDetail>(`${API_BASE}/funds/${id}`, { config }, 'Failed to update fund')
}

export async function updateFund(id: string, updates: { config?: Partial<FundConfig>; platform?: string; ticker?: string }): Promise<ApiResult<FundDetail>> {
  return putJson<FundDetail>(`${API_BASE}/funds/${id}`, updates, 'Failed to update fund')
}

export async function deleteFund(id: string): Promise<ApiResult<void>> {
  return deleteResource<void>(`${API_BASE}/funds/${id}`, 'Failed to delete fund')
}

export async function createFund(data: {
  platform: string
  ticker: string
  config: Partial<FundConfig>
  initialEntry?: Partial<FundEntry>
}): Promise<ApiResult<FundDetail>> {
  return postJson<FundDetail>(`${API_BASE}/funds`, data, 'Failed to create fund')
}

export async function addFundEntry(id: string, entry: Partial<FundEntry>): Promise<ApiResult<{ entry: FundEntry; state: FundState; recommendation: Recommendation; margin_available?: number; margin_borrowed?: number }>> {
  return postJson<{ entry: FundEntry; state: FundState; recommendation: Recommendation; margin_available?: number; margin_borrowed?: number }>(
    `${API_BASE}/funds/${id}/entries`,
    entry,
    'Failed to add entry'
  )
}

export async function previewRecommendation(id: string, equityValue: number, date?: string): Promise<ApiResult<{ state: FundState; recommendation: Recommendation | null; margin_available: number; fund_size: number }>> {
  return postJson<{ state: FundState; recommendation: Recommendation | null; margin_available: number; fund_size: number }>(
    `${API_BASE}/funds/${id}/preview`,
    { equity_value_usd: equityValue, date },
    'Failed to preview recommendation'
  )
}

export async function updateFundEntry(id: string, entryIndex: number, entry: FundEntry): Promise<ApiResult<{ entry: FundEntry; fund: FundDetail }>> {
  return putJson<{ entry: FundEntry; fund: FundDetail }>(
    `${API_BASE}/funds/${id}/entries/${entryIndex}`,
    entry,
    'Failed to update entry'
  )
}

export async function deleteFundEntry(id: string, entryIndex: number): Promise<ApiResult<{ fund: FundDetail }>> {
  return deleteResource<{ fund: FundDetail }>(
    `${API_BASE}/funds/${id}/entries/${entryIndex}`,
    'Failed to delete entry'
  )
}

export async function recalculateFund(id: string): Promise<ApiResult<{ message: string; fund: FundDetail }>> {
  return postJson<{ message: string; fund: FundDetail }>(
    `${API_BASE}/funds/${id}/recalculate`,
    {},
    'Failed to recalculate fund'
  )
}

export type InterpolatableColumn = 'margin_available' | 'margin_borrowed' | 'fund_size' | 'value'

export interface InterpolateResult {
  success: boolean
  message: string
  interpolated: number
  column: string
  totalEntries: number
  knownValues: number
}

export async function interpolateColumn(id: string, column: InterpolatableColumn): Promise<ApiResult<InterpolateResult>> {
  return postJson<InterpolateResult>(
    `${API_BASE}/funds/${id}/interpolate`,
    { column },
    `Failed to interpolate ${column} values`
  )
}

// Aggregate calculations for dashboard
export interface FundMetrics {
  id: string
  platform: string
  ticker: string
  status: 'active' | 'closed'
  fundType: 'cash' | 'stock' | 'crypto' | 'derivatives'
  category?: FundCategory
  fundSize: number
  currentValue: number
  startInput: number
  daysActive: number
  timeWeightedFundSize: number
  realizedGains: number
  unrealizedGains: number
  realizedAPY: number
  liquidAPY: number
  projectedAnnualReturn: number
  gainUsd: number
  gainPct: number
  fundShares: number
  fundSharesPct: number
}

export interface AggregateMetrics {
  totalFundSize: number
  totalValue: number
  totalStartInput: number
  totalTimeWeightedFundSize: number
  totalDaysActive: number
  totalRealizedGains: number
  totalUnrealizedGains: number
  unrealizedGainPct: number
  realizedAPY: number
  liquidAPY: number
  projectedAnnualReturn: number
  totalGainUsd: number
  totalGainPct: number
  activeFunds: number
  closedFunds: number
  portfolioDays?: number
  funds: FundMetrics[]
}

export async function fetchAggregateMetrics(includeTest = false): Promise<ApiResult<AggregateMetrics>> {
  const url = includeTest ? `${API_BASE}/funds/aggregate?include_test=true` : `${API_BASE}/funds/aggregate`
  return fetchJson<AggregateMetrics>(url, undefined, 'Failed to fetch aggregate metrics')
}

// Audit trail entry with fund info
export interface AuditEntry {
  fundId: string
  platform: string
  ticker: string
  date: string
  value: number
  action?: FundAction
  amount?: number
  dividend?: number
  expense?: number
  notes?: string
}

export async function fetchAllEntries(): Promise<ApiResult<AuditEntry[]>> {
  // Fetch all funds and flatten their entries
  const fundsResult = await fetchFunds()
  if (fundsResult.error) {
    return { error: fundsResult.error }
  }

  const allEntries: AuditEntry[] = []

  // Fetch details for each fund to get entries
  const promises = (fundsResult.data ?? []).map(async (fundSummary) => {
    const fundResult = await fetchFund(fundSummary.id)
    if (fundResult.data) {
      const fund = fundResult.data
      for (const entry of fund.entries) {
        allEntries.push({
          fundId: fund.id,
          platform: fund.platform,
          ticker: fund.ticker,
          ...entry
        })
      }
    }
  })

  await Promise.all(promises)

  // Sort by date descending
  allEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  return { data: allEntries }
}

// Historical time series data for charts
export interface TimeSeriesPoint {
  date: string
  totalFundSize: number
  totalValue: number
  totalCash: number
  totalMarginBorrowed: number
  totalMarginAccess: number
  totalStartInput: number
  totalDividends: number
  totalExpenses: number
  totalCashInterest: number
  totalRealizedGain: number
  totalUnrealizedGain: number
  totalExpectedTarget: number
  realizedAPY: number
  liquidAPY: number
  totalGainUsd: number
  totalGainPct: number
  fundBreakdown: Record<string, number>  // Per-fund breakdown of fund sizes
  realizedGainBreakdown?: Record<string, number>  // Per-fund breakdown of realized gains
  unrealizedGainBreakdown?: Record<string, number>  // Per-fund breakdown of unrealized gains
}

export interface AllocationData {
  id: string
  ticker: string
  platform: string
  fundType?: FundType
  category?: FundCategory
  value: number
  cash: number
  fundSize: number
  marginAccess: number
  marginBorrowed: number
}

export interface HistoryResponse {
  timeSeries: TimeSeriesPoint[]
  currentAllocations: AllocationData[]
  totals: {
    totalCurrentValue: number
    totalCurrentCash: number
    totalCurrentMarginAccess: number
    totalCurrentMarginBorrowed: number
  }
  aggregateTotals: {
    totalGainUsd: number
    totalRealizedGains: number
    totalValue: number
    totalStartInput: number
  }
}

export async function fetchHistory(includeTest = false): Promise<ApiResult<HistoryResponse>> {
  const url = includeTest ? `${API_BASE}/funds/history?include_test=true` : `${API_BASE}/funds/history`
  return fetchJson<HistoryResponse>(url, undefined, 'Failed to fetch history')
}

export interface SyncFromSubfundsResult {
  success: boolean
  message: string
  added: number
  skipped: number
  subFundsSynced: string[]
  finalBalance: number
}

export async function syncFromSubfunds(id: string): Promise<ApiResult<SyncFromSubfundsResult>> {
  return postJson<SyncFromSubfundsResult>(
    `${API_BASE}/funds/${id}/sync-from-subfunds`,
    {},
    'Failed to sync from sub-funds'
  )
}

// Actionable funds - due for action based on interval_days
export interface ActionableFund {
  id: string
  platform: string
  ticker: string
  fundType: FundType
  intervalDays: number
  daysSinceLastEntry: number
  daysOverdue: number
  lastEntryDate: string | null
}

export interface ActionableFundsResponse {
  actionableFunds: ActionableFund[]
  count: number
  asOf: string
}

export async function fetchActionableFunds(includeTest = false): Promise<ApiResult<ActionableFundsResponse>> {
  const url = includeTest ? `${API_BASE}/funds/actionable?include_test=true` : `${API_BASE}/funds/actionable`
  return fetchJson<ActionableFundsResponse>(url, undefined, 'Failed to fetch actionable funds')
}

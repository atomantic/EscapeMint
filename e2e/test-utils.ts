import { type Page, expect } from '@playwright/test'
import { createRequire } from 'module'

// Import ports from ecosystem config (single source of truth)
const require = createRequire(import.meta.url)
const { PORTS } = require('../ecosystem.config.cjs')

// API base URL
export const API_BASE = `http://localhost:${PORTS.API}/api/v1`

// Types matching the application
export interface FundConfig {
  status?: 'active' | 'closed'
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
  start_date?: string
}

export interface FundEntry {
  date: string
  value: number
  cash?: number
  action?: 'BUY' | 'SELL' | 'HOLD' | 'DEPOSIT' | 'WITHDRAW'
  amount?: number
  shares?: number
  price?: number
  dividend?: number
  expense?: number
  cash_interest?: number
  fund_size?: number
  margin_available?: number
  margin_borrowed?: number
  notes?: string
  contracts?: number
  liquidation_price?: number
}

export interface FundData {
  id: string
  platform: string
  ticker: string
  config: FundConfig
  entries: FundEntry[]
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
  action: 'BUY' | 'SELL'
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
  route_ticker?: string
}

// API helper functions

/**
 * Create a platform via API (needed for test platforms that don't exist)
 */
export async function createPlatformViaAPI(
  page: Page,
  id: string,
  name?: string
): Promise<{ id: string; name: string }> {
  const response = await page.request.post(`${API_BASE}/platforms`, {
    data: { id, name: name ?? id }
  })
  // Platform might already exist, which is fine
  if (response.ok()) {
    return response.json()
  }
  return { id, name: name ?? id }
}

/**
 * Delete a platform via API
 */
export async function deletePlatformViaAPI(page: Page, id: string): Promise<void> {
  await page.request.delete(`${API_BASE}/platforms/${id}`)
  // Don't assert - platform might have funds or might not exist
}

export async function createFundViaAPI(
  page: Page,
  platform: string,
  ticker: string,
  config: Partial<FundConfig>
): Promise<FundData> {
  const response = await page.request.post(`${API_BASE}/funds`, {
    data: { platform, ticker, config }
  })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function deleteFundViaAPI(page: Page, fundId: string): Promise<void> {
  const response = await page.request.delete(`${API_BASE}/funds/${fundId}`)
  expect(response.ok()).toBeTruthy()
}

export async function addEntryViaAPI(
  page: Page,
  fundId: string,
  entry: FundEntry
): Promise<{ entry: FundEntry; state: FundState; recommendation: Recommendation | null }> {
  const response = await page.request.post(`${API_BASE}/funds/${fundId}/entries`, {
    data: entry
  })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function updateEntryViaAPI(
  page: Page,
  fundId: string,
  entryIndex: number,
  entry: FundEntry
): Promise<{ entry: FundEntry; fund: FundData }> {
  const response = await page.request.put(`${API_BASE}/funds/${fundId}/entries/${entryIndex}`, {
    data: entry
  })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function deleteEntryViaAPI(
  page: Page,
  fundId: string,
  entryIndex: number
): Promise<{ fund: FundData }> {
  const response = await page.request.delete(`${API_BASE}/funds/${fundId}/entries/${entryIndex}`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function getFundStateViaAPI(
  page: Page,
  fundId: string
): Promise<{ fund: FundData; state: FundState | null; recommendation: Recommendation | null }> {
  const response = await page.request.get(`${API_BASE}/funds/${fundId}/state`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function getFundViaAPI(page: Page, fundId: string): Promise<FundData> {
  const response = await page.request.get(`${API_BASE}/funds/${fundId}`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function listFundsViaAPI(page: Page, includeTest = true): Promise<FundData[]> {
  const url = includeTest ? `${API_BASE}/funds?include_test=true` : `${API_BASE}/funds`
  const response = await page.request.get(url)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

export async function previewRecommendationViaAPI(
  page: Page,
  fundId: string,
  equityValue: number,
  date?: string
): Promise<{ state: FundState; recommendation: Recommendation | null }> {
  const response = await page.request.post(`${API_BASE}/funds/${fundId}/preview`, {
    data: { equity_value_usd: equityValue, date }
  })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

// Date helper functions
export function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0] as string
}

export function subtractDays(date: string, days: number): string {
  return addDays(date, -days)
}

export function getDatesBetween(startDate: string, endDate: string, intervalDays: number): string[] {
  const dates: string[] = []
  let currentDate = startDate
  while (currentDate <= endDate) {
    dates.push(currentDate)
    currentDate = addDays(currentDate, intervalDays)
  }
  return dates
}

// Calculation helpers for verification
export function computeExpectedTarget(
  startInput: number,
  targetApy: number,
  trades: Array<{ date: string; amount: number; type: 'buy' | 'sell' }>,
  asOfDate: string
): number {
  let totalExpectedGain = 0

  for (const trade of trades) {
    if (trade.date > asOfDate) continue
    const daysHeld = daysBetween(trade.date, asOfDate)
    const multiplier = Math.pow(1 + targetApy, daysHeld / 365) - 1

    if (trade.type === 'buy') {
      totalExpectedGain += trade.amount * multiplier
    }
  }

  return startInput + totalExpectedGain
}

export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1)
  const d2 = new Date(date2)
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24))
}

export function computeStartInput(
  trades: Array<{ date: string; amount: number; type: 'buy' | 'sell'; value?: number }>,
  asOfDate: string,
  accumulate = false
): number {
  // Sort trades by date to process in chronological order
  const sortedTrades = [...trades]
    .filter(t => t.date <= asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date))

  let totalBuys = 0
  let totalSells = 0

  for (const trade of sortedTrades) {
    if (trade.type === 'buy') {
      totalBuys += trade.amount
    } else {
      totalSells += trade.amount
      // Value-based liquidation: remaining value is dust compared to sale
      const valueBasedLiquidation = trade.value !== undefined && trade.value <= trade.amount + 0.01
      // Dollar-based fallback: total sells >= total buys
      const dollarBasedLiquidation = totalSells >= totalBuys
      const isFullLiquidation = valueBasedLiquidation || dollarBasedLiquidation
      if (isFullLiquidation) {
        totalBuys = 0
        totalSells = 0
      } else if (accumulate) {
        // Accumulate mode: partial sells are profit extraction, don't reduce cost basis
        totalSells = 0
      }
    }
  }

  return Math.max(0, totalBuys - totalSells)
}

// Test data generators
export function generateTestConfig(overrides: Partial<FundConfig> = {}): FundConfig {
  return {
    status: 'active',
    fund_size_usd: 10000,
    target_apy: 0.25,
    interval_days: 7,
    input_min_usd: 100,
    input_mid_usd: 200,
    input_max_usd: 500,
    max_at_pct: -0.25,
    min_profit_usd: 100,
    cash_apy: 0.044,
    margin_apr: 0.0725,
    margin_access_usd: 0,
    accumulate: true,
    manage_cash: true,
    margin_enabled: false,
    dividend_reinvest: true,
    interest_reinvest: true,
    expense_from_fund: true,
    ...overrides
  }
}

export function generateRandomTicker(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let ticker = ''
  for (let i = 0; i < 4; i++) {
    ticker += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  // Add timestamp to ensure uniqueness
  return `${ticker}${Date.now().toString(36).toUpperCase().slice(-4)}`
}

// Tolerance for floating point comparisons
export function assertApproxEqual(actual: number, expected: number, tolerance = 0.01): void {
  const diff = Math.abs(actual - expected)
  if (diff > tolerance) {
    throw new Error(`Expected ${expected} but got ${actual} (diff: ${diff}, tolerance: ${tolerance})`)
  }
}

// Page object helpers
export class FundPage {
  constructor(private page: Page) {}

  async goto(fundId: string) {
    await this.page.goto(`/fund/${fundId}`)
    await this.page.waitForLoadState('networkidle')
  }

  async openAddEntryModal() {
    await this.page.click('button:has-text("Add Entry")')
    await this.page.waitForSelector('[role="dialog"]')
  }

  async fillEntry(entry: Partial<FundEntry>) {
    if (entry.date) {
      await this.page.fill('input[type="date"]', entry.date)
    }
    if (entry.value !== undefined) {
      await this.page.fill('input[placeholder*="equity" i], input[name="value"], #value', String(entry.value))
    }
    if (entry.action) {
      await this.page.selectOption('select[name="action"], #action', entry.action)
    }
    if (entry.amount !== undefined) {
      await this.page.fill('input[name="amount"], #amount', String(entry.amount))
    }
    if (entry.dividend !== undefined) {
      await this.page.fill('input[name="dividend"], #dividend', String(entry.dividend))
    }
    if (entry.expense !== undefined) {
      await this.page.fill('input[name="expense"], #expense', String(entry.expense))
    }
    if (entry.notes) {
      await this.page.fill('textarea[name="notes"], #notes', entry.notes)
    }
  }

  async submitEntry() {
    await this.page.click('button[type="submit"]:has-text("Add"), button[type="submit"]:has-text("Save")')
    await this.page.waitForTimeout(500) // Wait for submission
  }

  async closeModal() {
    await this.page.click('button:has-text("Cancel"), button:has-text("Close")')
  }

  async getDisplayedState(): Promise<Partial<FundState>> {
    // Extract state values from the UI
    const state: Partial<FundState> = {}

    const startInputEl = this.page.locator('text=/start input|invested/i').first()
    if (await startInputEl.count() > 0) {
      const text = await startInputEl.textContent()
      const match = text?.match(/\$?([\d,.-]+)/)
      if (match) {
        state.start_input_usd = parseFloat(match[1].replace(/,/g, ''))
      }
    }

    return state
  }

  async getRecommendation(): Promise<{ action: string; amount: number } | null> {
    const recEl = this.page.locator('[data-testid="recommendation"], .recommendation')
    if (await recEl.count() === 0) return null

    const text = await recEl.textContent()
    const match = text?.match(/(BUY|SELL)\s*\$?([\d,.-]+)/)
    if (!match) return null

    return {
      action: match[1],
      amount: parseFloat(match[2].replace(/,/g, ''))
    }
  }

  async clickEntry(index: number) {
    await this.page.click(`table tbody tr:nth-child(${index + 1})`)
  }
}

export class DashboardPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/')
    await this.page.waitForLoadState('networkidle')
  }

  async openCreateFundModal() {
    await this.page.click('button:has-text("Create Fund"), button:has-text("New Fund")')
    await this.page.waitForSelector('[role="dialog"]')
  }

  async createFund(platform: string, ticker: string, config: Partial<FundConfig>) {
    await this.openCreateFundModal()

    // Fill form
    await this.page.selectOption('select:near(:text("Platform"))', platform)
    await this.page.fill('input:near(:text("Ticker"))', ticker)
    await this.page.fill('input:near(:text("Fund Size"))', String(config.fund_size_usd ?? 10000))

    if (config.target_apy !== undefined) {
      await this.page.fill('input:near(:text("Target APY"))', String(config.target_apy * 100))
    }
    if (config.interval_days !== undefined) {
      await this.page.fill('input:near(:text("Interval"))', String(config.interval_days))
    }
    // Submit
    await this.page.click('button[type="submit"]:has-text("Create")')
    await this.page.waitForURL(/\/fund\//)
  }

  async getFundCards(): Promise<string[]> {
    await this.page.waitForSelector('.fund-card, [data-testid="fund-card"]')
    const cards = await this.page.locator('.fund-card, [data-testid="fund-card"]').all()
    return Promise.all(cards.map(c => c.textContent().then(t => t ?? '')))
  }
}

// Cleanup helper
export async function cleanupTestFunds(page: Page, platform: string, tickerPrefix: string) {
  const funds = await listFundsViaAPI(page)
  for (const fund of funds) {
    if (fund.platform === platform && fund.ticker.startsWith(tickerPrefix.toLowerCase())) {
      await deleteFundViaAPI(page, fund.id)
    }
  }
}

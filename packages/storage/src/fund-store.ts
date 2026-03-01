import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import lockfile from 'proper-lockfile'
import type { SubFundConfig, Trade, CashFlow, Dividend, Expense } from '@escapemint/engine'

// Action types for regular funds (trading, cash, crypto)
export type RegularFundAction = 'BUY' | 'SELL' | 'HOLD' | 'DEPOSIT' | 'WITHDRAW' | 'MARGIN'

// Action types specific to derivatives funds
export type DerivativesFundAction = 'FUNDING' | 'INTEREST' | 'REBATE' | 'FEE'

// Combined action type for all funds
export type FundAction = RegularFundAction | DerivativesFundAction

/**
 * A single row in the fund time-series.
 */
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

/**
 * Complete fund data from a single file.
 */
export interface FundData {
  /** Derived from filename: platform-ticker */
  id: string
  platform: string
  ticker: string
  config: SubFundConfig
  entries: FundEntry[]
}

const ENTRY_HEADERS = ['date', 'value', 'cash', 'action', 'amount', 'shares', 'price', 'dividend', 'expense', 'cash_interest', 'fund_size', 'margin_available', 'margin_borrowed', 'margin_expense', 'notes', 'contracts', 'entry_price', 'liquidation_price', 'unrealized_pnl', 'margin_locked', 'fee', 'margin']

const LOCK_OPTIONS = { retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 } }

/**
 * Execute a function while holding an exclusive file lock.
 * Ensures read-modify-write operations are atomic.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(filePath, LOCK_OPTIONS)
  } catch (error) {
    console.warn(`⚠️ failed to acquire lock for "${filePath}"`, error)
    throw error
  }
  try {
    return await fn()
  } finally {
    await release()
  }
}

/**
 * Get the JSON config file path for a TSV file.
 */
function getConfigPath(tsvPath: string): string {
  return tsvPath.replace(/\.tsv$/, '.json')
}

/**
 * Read config from JSON file.
 */
async function readConfig(configPath: string): Promise<SubFundConfig | null> {
  if (!existsSync(configPath)) {
    return null
  }
  const content = await readFile(configPath, 'utf-8')
  return JSON.parse(content) as SubFundConfig
}

/**
 * Write config to JSON file.
 */
async function writeConfig(configPath: string, config: SubFundConfig): Promise<void> {
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  const tempPath = join(dir, `.${uuidv4()}.tmp`)
  await writeFile(tempPath, JSON.stringify(config, null, 2), 'utf-8')
  await rename(tempPath, configPath)
}


/**
 * Parse a data row into FundEntry.
 */
function parseEntry(line: string, headers: string[]): FundEntry {
  const values = line.split('\t')
  const entry: FundEntry = {
    date: '',
    value: 0
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    const val = values[i] ?? ''

    switch (header) {
      case 'date':
        entry.date = val
        break
      case 'value':
        entry.value = parseFloat(val) || 0
        break
      case 'cash':
        if (val) entry.cash = parseFloat(val)
        break
      case 'action':
        // Regular actions and derivatives-specific actions
        if (val === 'BUY' || val === 'SELL' || val === 'HOLD' || val === 'DEPOSIT' || val === 'WITHDRAW' || val === 'MARGIN' ||
            val === 'FUNDING' || val === 'INTEREST' || val === 'REBATE' || val === 'FEE') {
          entry.action = val as FundAction
        }
        break
      case 'amount':
        if (val) entry.amount = parseFloat(val)
        break
      case 'shares':
        if (val) entry.shares = parseFloat(val)
        break
      case 'price':
        if (val) entry.price = parseFloat(val)
        break
      case 'dividend':
        if (val) entry.dividend = parseFloat(val)
        break
      case 'expense':
        if (val) entry.expense = parseFloat(val)
        break
      case 'cash_interest':
        if (val) entry.cash_interest = parseFloat(val)
        break
      case 'fund_size':
        if (val) entry.fund_size = parseFloat(val)
        break
      case 'margin_available':
        if (val) entry.margin_available = parseFloat(val)
        break
      case 'margin_borrowed':
        if (val) entry.margin_borrowed = parseFloat(val)
        break
      case 'margin_expense':
        if (val) entry.margin_expense = parseFloat(val)
        break
      case 'notes':
        if (val) entry.notes = val.replace(/\\t/g, '\t').replace(/\\n/g, '\n')
        break
      // Derivatives-specific fields
      case 'contracts':
        if (val) entry.contracts = parseFloat(val)
        break
      case 'entry_price':
        if (val) entry.entry_price = parseFloat(val)
        break
      case 'liquidation_price':
        if (val) entry.liquidation_price = parseFloat(val)
        break
      case 'unrealized_pnl':
        if (val) entry.unrealized_pnl = parseFloat(val)
        break
      case 'margin_locked':
        if (val) entry.margin_locked = parseFloat(val)
        break
      case 'fee':
        if (val) entry.fee = parseFloat(val)
        break
      case 'margin':
        if (val) entry.margin = parseFloat(val)
        break
    }
  }

  return entry
}

/**
 * Serialize entry to TSV line.
 */
function serializeEntry(entry: FundEntry): string {
  const values = [
    entry.date,
    entry.value.toString(),
    entry.cash?.toString() ?? '',
    entry.action ?? '',
    entry.amount?.toString() ?? '',
    entry.shares?.toString() ?? '',
    entry.price?.toString() ?? '',
    entry.dividend?.toString() ?? '',
    entry.expense?.toString() ?? '',
    entry.cash_interest?.toString() ?? '',
    entry.fund_size?.toString() ?? '',
    entry.margin_available?.toString() ?? '',
    entry.margin_borrowed?.toString() ?? '',
    entry.margin_expense?.toString() ?? '',  // FIX: Was missing, causing column misalignment
    (entry.notes ?? '').replace(/\t/g, '\\t').replace(/\n/g, '\\n'),
    // Derivatives-specific fields
    entry.contracts?.toString() ?? '',
    entry.entry_price?.toString() ?? '',
    entry.liquidation_price?.toString() ?? '',
    entry.unrealized_pnl?.toString() ?? '',
    entry.margin_locked?.toString() ?? '',
    entry.fee?.toString() ?? '',
    entry.margin?.toString() ?? ''
  ]
  return values.join('\t')
}

/**
 * Read a fund file and return parsed data.
 * Config is read from JSON file, entries from TSV file.
 */
export async function readFund(filePath: string): Promise<FundData | null> {
  if (!existsSync(filePath)) {
    return null
  }

  const configPath = getConfigPath(filePath)

  // Read config from JSON file (now includes platform and ticker metadata)
  const configData = await readConfig(configPath)
  if (!configData) {
    return null
  }

  // Extract platform/ticker from config metadata
  type ConfigWithMetadata = SubFundConfig & { __platform?: string; __ticker?: string }
  const configWithMeta = configData as ConfigWithMetadata

  if (!configWithMeta.__platform || !configWithMeta.__ticker) {
    throw new Error(`Config file missing __platform or __ticker metadata: ${configPath}`)
  }

  const platform = configWithMeta.__platform
  const ticker = configWithMeta.__ticker
  // Remove metadata from config by filtering out all keys starting with "__"
  const cleanConfigEntries = Object.entries(configWithMeta).filter(
    ([key]) => !key.startsWith('__')
  )
  const cleanConfig = Object.fromEntries(cleanConfigEntries) as SubFundConfig

  // Read entries from TSV file (normalize CRLF line endings)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '')

  if (lines.length < 1) {
    return null
  }

  // First line is headers
  const headerLine = lines[0]
  if (!headerLine) {
    return null
  }
  const headers = headerLine.split('\t')

  // Remaining lines are entries
  const entries: FundEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line) {
      entries.push(parseEntry(line, headers))
    }
  }

  return {
    id: `${platform}-${ticker}`,
    platform,
    ticker,
    config: cleanConfig,
    entries
  }
}

/**
 * Write fund data to file atomically.
 * Config is written to a separate JSON file, TSV contains only data.
 */
export async function writeFund(filePath: string, data: FundData): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  // Write config to JSON file with platform/ticker metadata
  const configPath = getConfigPath(filePath)
  const configWithMetadata = {
    ...data.config,
    __platform: data.platform,
    __ticker: data.ticker
  }
  await writeConfig(configPath, configWithMetadata as SubFundConfig)

  // Write only headers + entries to TSV (no config line)
  const lines: string[] = [
    ENTRY_HEADERS.join('\t'),
    ...data.entries.map(serializeEntry)
  ]

  const content = lines.join('\n') + '\n'

  // Atomic write
  const tempPath = join(dir, `.${uuidv4()}.tmp`)
  await writeFile(tempPath, content, 'utf-8')
  await rename(tempPath, filePath)
}

/**
 * Update only the config for a fund (more efficient than writeFund for config-only changes).
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function updateFundConfig(filePath: string, config: Partial<SubFundConfig>): Promise<SubFundConfig> {
  return withFileLock(filePath, async () => {
    const configPath = getConfigPath(filePath)
    const existingConfig = await readConfig(configPath)

    if (!existingConfig) {
      throw new Error(`Config file not found: ${configPath}`)
    }

    const updatedConfig: SubFundConfig = { ...existingConfig, ...config }
    await writeConfig(configPath, updatedConfig)
    return updatedConfig
  })
}

/**
 * Delete a fund (removes both TSV data and JSON config files).
 */
export async function deleteFund(filePath: string): Promise<void> {
  const configPath = getConfigPath(filePath)

  // Delete TSV file
  if (existsSync(filePath)) {
    await unlink(filePath)
  }

  // Delete JSON config file
  if (existsSync(configPath)) {
    await unlink(configPath)
  }
}

/**
 * Append an entry to a fund file.
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function appendEntry(filePath: string, entry: FundEntry): Promise<void> {
  await withFileLock(filePath, async () => {
    const fund = await readFund(filePath)
    if (!fund) {
      throw new Error(`Fund file not found: ${filePath}`)
    }

    fund.entries.push(entry)
    await writeFund(filePath, fund)
  })
}

/**
 * Update an entry at a specific index.
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function updateEntry(filePath: string, entryIndex: number, entry: FundEntry): Promise<void> {
  await withFileLock(filePath, async () => {
    const fund = await readFund(filePath)
    if (!fund) {
      throw new Error(`Fund file not found: ${filePath}`)
    }

    if (entryIndex < 0 || entryIndex >= fund.entries.length) {
      throw new Error(`Entry index out of bounds: ${entryIndex}`)
    }

    fund.entries[entryIndex] = entry
    await writeFund(filePath, fund)
  })
}

/**
 * Delete an entry at a specific index.
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function deleteEntry(filePath: string, entryIndex: number): Promise<void> {
  await withFileLock(filePath, async () => {
    const fund = await readFund(filePath)
    if (!fund) {
      throw new Error(`Fund file not found: ${filePath}`)
    }

    if (entryIndex < 0 || entryIndex >= fund.entries.length) {
      throw new Error(`Entry index out of bounds: ${entryIndex}`)
    }

    fund.entries.splice(entryIndex, 1)
    await writeFund(filePath, fund)
  })
}

/**
 * List all fund files in a directory.
 */
export async function listFunds(fundsDir: string): Promise<string[]> {
  if (!existsSync(fundsDir)) {
    return []
  }

  const files = await readdir(fundsDir)
  return files
    .filter(f => f.endsWith('.tsv'))
    .map(f => join(fundsDir, f))
}

/**
 * Read all funds from a directory.
 * Resilient to individual fund failures — skips malformed files with a warning.
 */
export async function readAllFunds(fundsDir: string): Promise<FundData[]> {
  const files = await listFunds(fundsDir)
  const results = await Promise.allSettled(files.map(file => readFund(file)))

  const funds: FundData[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    if (result.status === 'fulfilled' && result.value) {
      funds.push(result.value)
    } else if (result.status === 'rejected') {
      console.warn(`⚠️ skipped malformed fund file: ${files[i]}`, result.reason)
    }
  }

  return funds
}

/**
 * Convert fund entries to trades for engine calculation.
 * Only includes BUY and SELL actions (not DEPOSIT, WITHDRAW, or HOLD).
 */
export function entriesToTrades(entries: FundEntry[]): Trade[] {
  return entries
    .filter(e => e.amount && (e.action === 'BUY' || e.action === 'SELL'))
    .map(e => {
      const trade: Trade = {
        date: e.date,
        amount_usd: e.amount!,
        type: e.action!.toLowerCase() as 'buy' | 'sell'
      }
      if (e.shares !== undefined) trade.shares = e.shares
      // Pass value for buys (value=0 is valid for initial buy) but only
      // for sells when value > 0 (value=0 on sells triggers false liquidation
      // detection in the engine for imported entries without real portfolio values)
      if (e.value !== undefined && (e.action === 'BUY' || e.value > 0)) trade.value = e.value
      return trade
    })
}

/**
 * Convert fund entries to dividends for engine calculation.
 */
export function entriesToDividends(entries: FundEntry[]): Dividend[] {
  return entries
    .filter(e => e.dividend && e.dividend > 0)
    .map(e => ({
      date: e.date,
      amount_usd: e.dividend!
    }))
}

/**
 * Convert fund entries to expenses for engine calculation.
 */
export function entriesToExpenses(entries: FundEntry[]): Expense[] {
  return entries
    .filter(e => e.expense && e.expense > 0)
    .map(e => ({
      date: e.date,
      amount_usd: e.expense!
    }))
}

/**
 * Sum all cash interest from entries.
 */
export function entriesToCashInterest(entries: FundEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.cash_interest ?? 0), 0)
}

/**
 * Convert fund entries to cash flows for cash fund TWFS calculation.
 * Supports legacy DEPOSIT/WITHDRAW and normalized HOLD entries with signed amounts.
 */
export function entriesToCashFlows(entries: FundEntry[]): CashFlow[] {
  return entries
    .filter(e => e.amount && (e.action === 'DEPOSIT' || e.action === 'WITHDRAW' || e.action === 'HOLD'))
    .map(e => {
      if (e.action === 'HOLD') {
        if (e.amount === 0) return null
        return {
          date: e.date,
          amount_usd: Math.abs(e.amount!),
          type: e.amount! > 0 ? 'deposit' as const : 'withdrawal' as const
        }
      }
      return {
        date: e.date,
        amount_usd: e.amount!,
        type: e.action === 'DEPOSIT' ? 'deposit' as const : 'withdrawal' as const
      }
    })
    .filter((cf): cf is CashFlow => cf !== null)
}

/**
 * Get latest equity value from entries.
 */
export function getLatestEquity(entries: FundEntry[]): { date: string; value: number } | null {
  if (entries.length === 0) return null
  const latest = entries[entries.length - 1]
  if (!latest) return null
  return { date: latest.date, value: latest.value }
}

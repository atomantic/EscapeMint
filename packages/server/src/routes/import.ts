import { Router } from 'express'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { platform } from 'node:os'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { chromium, type Browser, type Page, type ElementHandle } from 'playwright'
import { readAllFunds, appendEntry, readFund, writeFund, type FundEntry, type FundData } from '@escapemint/storage'
import { badRequest, validationError } from '../middleware/error-handler.js'
import { PDFParse } from 'pdf-parse'
import { createLogger } from '../utils/logger.js'

const log = createLogger('import')

export const importRouter: ReturnType<typeof Router> = Router()

const DATA_DIR = process.env['DATA_DIR'] ?? './data'
const FUNDS_DIR = join(DATA_DIR, 'funds')
const SCRAPE_ARCHIVE_DIR = join(DATA_DIR, 'scrape-archives')
const STATEMENTS_DIR = join(DATA_DIR, 'statements')
const CRYPTO_STATEMENTS_DIR = join(STATEMENTS_DIR, 'robinhood')
const M1_STATEMENTS_DIR = join(STATEMENTS_DIR, 'm1')

// Minimum change threshold for cash balance updates (in USD)
const CASH_BALANCE_UPDATE_THRESHOLD = 0.01

// CDP connection for browser scraping
let connectedBrowser: Browser | null = null
let launchedChromeProcess: ChildProcess | null = null

// ============================================================================
// Types
// ============================================================================

interface RobinhoodTransaction {
  activityDate: string
  settleDate: string
  transCode: string
  description: string
  symbol: string
  quantity: number
  price: number
  amount: number
}

interface ParsedTransaction {
  date: string
  action: 'BUY' | 'SELL' | 'DEPOSIT' | 'WITHDRAW' | 'DIVIDEND' | 'INTEREST' | 'STOCK_LENDING' | 'FEE' | 'TRANSFER' | 'SPLIT' | 'MERGER' | 'OPTION' | 'CRYPTO' | 'REINVEST' | 'ADJUSTMENT' | 'OTHER'
  symbol: string
  quantity: number
  price: number
  amount: number
  description: string
  fundId: string | null
  fundExists: boolean
  rawDetails?: Record<string, string>  // Preserve all raw details for later processing
}

interface ImportPreview {
  transactions: ParsedTransaction[]
  summary: {
    total: number
    matched: number
    unmatched: number
    bySymbol: Record<string, { count: number; fundId: string | null; fundExists: boolean }>
  }
}

interface ImportResult {
  applied: number
  skipped: number
  errors: string[]
}

// Scraped transaction from Robinhood UI - captures ALL transaction types
interface ScrapedTransaction {
  id: string  // unique ID based on date + type + amount + title hash
  date: string  // ISO date YYYY-MM-DD
  type: 'buy' | 'sell' | 'dividend' | 'interest' | 'deposit' | 'withdrawal' | 'stock_lending' | 'fee' | 'transfer' | 'split' | 'merger' | 'option' | 'crypto' | 'reinvest' | 'adjustment' | 'other'
  title: string  // Full title from the header (raw, unmodified)
  amount: number  // Total amount in USD (0 if not applicable)
  symbol?: string  // Ticker symbol (if trade or dividend)
  shares?: number  // Number of shares (if trade)
  pricePerShare?: number  // Price per share (if trade)
  details: Record<string, string>  // All detail fields from expanded view (captures everything)
  rawHtml?: string  // For debugging unknown types
  rawText?: string  // Full text content for searching/analysis
}

interface ScrapeArchive {
  platform: string
  createdAt: string
  updatedAt: string
  transactions: ScrapedTransaction[]
}

// Crypto statement types
interface CryptoTransaction {
  date: string  // YYYY-MM-DD
  type: 'buy' | 'sell' | 'transfer' | 'interest' | 'staking' | 'other'
  symbol: string  // BTC, ETH, etc.
  quantity: number
  price: number  // Price per unit in USD
  value: number  // Total USD value
  rawText?: string  // Original text for debugging
}

interface CryptoHolding {
  name: string
  symbol: string
  quantity: number
  marketValue: number
  portfolioPercent: number
}

interface CryptoStatementData {
  filename: string
  periodStart: string
  periodEnd: string
  openingBalance: number
  closingBalance: number
  holdings: CryptoHolding[]
  transactions: CryptoTransaction[]
}

interface CryptoStatementInfo {
  filename: string
  monthYear: string  // "November 2025"
  downloadUrl: string
  downloaded: boolean
}

// ============================================================================
// Crypto Statement Filename Helpers
// ============================================================================

const MONTH_TO_NUM: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12'
}

/**
 * Convert "November 2025" or "November-2025" to "Crypto-Statement-2025-11.pdf"
 */
const monthYearToStatementFilename = (monthYear: string): string => {
  const cleaned = monthYear.replace(/[-–—]/g, ' ').trim()
  const match = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/)
  if (!match || !match[1] || !match[2]) return `Crypto-Statement-unknown.pdf`
  const month = match[1]
  const year = match[2]
  const mm = MONTH_TO_NUM[month.toLowerCase()] ?? '00'
  return `Crypto-Statement-${year}-${mm}.pdf`
}

/**
 * Parse both old format "November-2025-Robinhood-..." and new format "Crypto-Statement-2025-11.pdf"
 * Returns display month/year like "November 2025"
 */
const parseStatementFilename = (filename: string): string => {
  // New format: Crypto-Statement-YYYY-MM.pdf
  const newMatch = filename.match(/^Crypto-Statement-(\d{4})-(\d{2})\.pdf$/)
  if (newMatch) {
    const [, year, mm] = newMatch
    const monthName = Object.entries(MONTH_TO_NUM).find(([, num]) => num === mm)?.[0]
    if (monthName) {
      return `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${year}`
    }
  }
  // Old format: Month-Year-Robinhood-...
  const oldMatch = filename.match(/^([A-Za-z]+)-(\d{4})/)
  if (oldMatch) {
    return `${oldMatch[1]} ${oldMatch[2]}`
  }
  return filename
}

// ============================================================================
// CSV Parsing (functional, no external deps)
// ============================================================================

/**
 * Parse CSV content into array of objects using first row as headers.
 * Handles multi-line quoted fields properly.
 */
const parseCSV = (content: string): Record<string, string>[] => {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false

  // Process character by character to handle multi-line quoted fields
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    const nextChar = content[i + 1]

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote - add literal quote
        currentField += '"'
        i++
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      currentRow.push(currentField.trim())
      currentField = ''
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      // End of row (skip \n if preceded by \r)
      if (char === '\r' && nextChar === '\n') {
        i++
      }
      if (currentField || currentRow.length > 0) {
        currentRow.push(currentField.trim())
        if (currentRow.some(f => f)) { // Only add non-empty rows
          rows.push(currentRow)
        }
        currentRow = []
        currentField = ''
      }
    } else {
      // Regular character (including newlines inside quotes)
      currentField += char
    }
  }

  // Handle last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim())
    if (currentRow.some(f => f)) {
      rows.push(currentRow)
    }
  }

  if (rows.length < 2) return []

  const headerRow = rows[0]
  if (!headerRow) return []

  const headers = headerRow.map(h => h.toLowerCase().replace(/\s+/g, '_'))

  return rows.slice(1).map(row => {
    const record: Record<string, string> = {}
    headers.forEach((header, i) => {
      record[header] = row[i] ?? ''
    })
    return record
  })
}

// ============================================================================
// Robinhood Transaction Mapping
// ============================================================================

/**
 * Map Robinhood transaction code to FundEntry action.
 * Comprehensive mapping of all Robinhood transaction codes.
 *
 * Common Robinhood codes:
 * - ACH: ACH transfer (deposit/withdrawal)
 * - CDIV: Cash Dividend
 * - SLIP: Stock Lending Income Payment
 * - INT: Interest payment
 * - BTO: Buy To Open (options)
 * - STC: Sell To Close (options)
 * - STO: Sell To Open (options)
 * - BTC: Buy To Close (options)
 * - GOLD: Robinhood Gold subscription fee
 * - GDBP: Gold Deposit Boost Payout
 * - GMPC: Gold Margin Payment Credit
 * - NOA: Nasdaq Opening Auction
 * - IADJ: Interest Adjustment
 * - T/A: Transfer/Adjustment
 * - DTAX: Dividend Tax Withheld
 * - OEXP: Option Expiration
 * - OEXCS: Option Exercise
 * - FUTSWP: Futures Sweep
 * - CONV: Conversion
 * - ROC: Return of Capital
 * - MINT: Margin Interest
 * - MDIV: Mutual Fund Dividend
 * - LIQ: Liquidation
 * - DFEE: Various fees
 * - ABIP: ACATS Buy-In Protection
 * - CIL: Cash In Lieu
 * - MISC: Miscellaneous
 */
const mapTransCode = (code: string, description: string, amount: number = 0): ParsedTransaction['action'] => {
  const upper = code.toUpperCase().trim()
  const descUpper = description.toUpperCase()

  // === Trading - Stocks ===
  if (upper === 'BUY' || upper.includes('BUY')) return 'BUY'
  if (upper === 'SELL' || upper.includes('SELL')) return 'SELL'
  // Market orders at specific auctions
  if (upper === 'NOA' || upper === 'NOC') { // Nasdaq Opening/Closing Auction
    return descUpper.includes('SELL') || amount < 0 ? 'SELL' : 'BUY'
  }

  // === Trading - Options ===
  if (upper === 'BTO' || upper === 'BTC') return 'OPTION'  // Buy To Open/Close
  if (upper === 'STO' || upper === 'STC') return 'OPTION'  // Sell To Open/Close
  if (upper === 'OEXP') return 'OPTION'  // Option Expiration
  if (upper === 'OEXCS') return 'OPTION'  // Option Exercise
  if (upper === 'CIL') return 'OPTION'  // Cash In Lieu (from options)

  // === Transfers (deposits/withdrawals) ===
  if (upper === 'ACH' || upper === 'WIRE') {
    // ACH can be deposit or withdrawal - check amount or description
    if (descUpper.includes('WITHDRAW') || amount < 0) return 'WITHDRAW'
    return 'DEPOSIT'
  }
  if (upper.includes('DEPOSIT')) return 'DEPOSIT'
  if (upper.includes('WITHDRAW')) return 'WITHDRAW'
  if (upper === 'FUTSWP') return 'TRANSFER'  // Futures Sweep
  if (upper === 'T/A' || upper === 'TA') return 'TRANSFER'  // Transfer/Adjustment
  if (upper === 'ABIP') return 'TRANSFER'  // ACATS Buy-In Protection
  if (upper === 'ACATI' || upper === 'ACATO') return 'TRANSFER'  // ACATS In/Out (broker transfer)
  if (upper === 'CONV') return 'TRANSFER'  // Conversion (stock conversion)
  if (upper === 'LIQ') return 'SELL'  // Liquidation

  // === Income - Dividends ===
  if (upper === 'CDIV' || upper === 'DIV') return 'DIVIDEND'
  if (upper === 'MDIV') return 'DIVIDEND'  // Mutual Fund Dividend
  if (upper === 'ROC') return 'DIVIDEND'  // Return of Capital
  if (upper === 'GDBP') return 'DIVIDEND'  // Gold Deposit Boost Payout (bonus)
  if (upper === 'GMPC') return 'INTEREST'  // Gold Margin Payment Credit
  if (descUpper.includes('DIVIDEND') && !descUpper.includes('TAX')) return 'DIVIDEND'

  // === Income - Interest ===
  if (upper === 'INT') return 'INTEREST'
  if (upper === 'IADJ') return 'INTEREST'  // Interest Adjustment
  if (upper === 'MINT') return 'INTEREST'  // Margin Interest (negative = fee)
  if (descUpper.includes('INTEREST') && !descUpper.includes('TAX')) return 'INTEREST'

  // === Income - Stock Lending ===
  if (upper === 'SLIP') return 'STOCK_LENDING'
  if (descUpper.includes('LENDING') || descUpper.includes('SECURITIES LENDING')) return 'STOCK_LENDING'

  // === Fees ===
  if (upper === 'GOLD') return 'FEE'  // Robinhood Gold subscription
  if (upper === 'DFEE') return 'FEE'  // Dividend fee
  if (upper === 'FEE') return 'FEE'
  if (descUpper.includes('FEE') || descUpper.includes('SUBSCRIPTION')) return 'FEE'

  // === Tax Withholdings (treated as fees) ===
  if (upper === 'DTAX') return 'FEE'  // Dividend Tax Withheld

  // === Corporate Actions ===
  if (upper === 'SPLIT' || upper === 'SPR' || upper === 'SPL' || descUpper.includes('SPLIT')) return 'SPLIT'
  if (upper === 'SXCH') return 'MERGER'  // Symbol Exchange (ticker change)
  if (descUpper.includes('MERGER') || descUpper.includes('ACQUISITION')) return 'MERGER'

  // === Referral/Promotional Stock ===
  if (upper === 'SCXL' || upper === 'BCXL') return 'DIVIDEND'  // Stock credits (referral bonuses)

  // === Stock Split/Internal Transfers ===
  if (upper === 'ITRF') return 'SPLIT'  // Internal Transfer (stock split fractional adjustments)
  if (upper === 'REC') return 'REINVEST'  // Receive (dividend reinvestment or stock grant)

  // === Reinvestment ===
  if (upper === 'DRIP' || descUpper.includes('REINVEST')) return 'REINVEST'

  // === Adjustments ===
  if (upper === 'ADJ' || descUpper.includes('ADJUSTMENT') || descUpper.includes('CORRECTION')) return 'ADJUSTMENT'

  // === Miscellaneous ===
  if (upper === 'MISC') {
    // Try to infer from description
    if (descUpper.includes('DIVIDEND')) return 'DIVIDEND'
    if (descUpper.includes('INTEREST')) return 'INTEREST'
    if (descUpper.includes('DEPOSIT')) return 'DEPOSIT'
    if (descUpper.includes('WITHDRAW')) return 'WITHDRAW'
    if (descUpper.includes('FEE')) return 'FEE'
    if (descUpper.includes('REWARD') || descUpper.includes('CASH REWARD') || descUpper.includes('BONUS')) return 'DIVIDEND'
    if (descUpper.includes('CORRECTION') || descUpper.includes('CREDIT')) return 'ADJUSTMENT'
  }

  // === Fallback: Check description for common patterns ===
  if (descUpper.includes('BOUGHT') || descUpper.includes('MARKET BUY') || descUpper.includes('LIMIT BUY')) return 'BUY'
  if (descUpper.includes('SOLD') || descUpper.includes('MARKET SELL') || descUpper.includes('LIMIT SELL')) return 'SELL'
  if (descUpper.includes('OPTION')) return 'OPTION'
  if (descUpper.includes('CRYPTO')) return 'CRYPTO'

  return 'OTHER'
}

/**
 * Parse a date string into ISO format (YYYY-MM-DD).
 * Handles formats like "12/31/2024", "2024-12-31", etc.
 */
const parseDate = (dateStr: string): string => {
  if (!dateStr) return ''

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.slice(0, 10)
  }

  // US format: MM/DD/YYYY
  const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (usMatch) {
    const [, month, day, year] = usMatch
    return `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`
  }

  // Try Date parsing as fallback
  const parsed = new Date(dateStr)
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10)
  }

  return dateStr
}


/**
 * Parse Robinhood date formats like "Jan 2", "Dec 31, 2025", etc.
 */
const parseRobinhoodDate = (dateText: string): string => {
  const currentYear = new Date().getFullYear()

  // Clean the date text
  const cleaned = dateText.trim()

  // Format: "Dec 31, 2025" or "Jan 2, 2025"
  const withYearMatch = cleaned.match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(\d{4})/)
  if (withYearMatch) {
    const [, month, day, year] = withYearMatch
    const monthNum = monthToNumber(month ?? '')
    return `${year}-${monthNum.toString().padStart(2, '0')}-${(day ?? '').padStart(2, '0')}`
  }

  // Format: "Jan 2" (no year, assume current year)
  const noYearMatch = cleaned.match(/([A-Z][a-z]{2})\s+(\d{1,2})/)
  if (noYearMatch) {
    const [, month, day] = noYearMatch
    const monthNum = monthToNumber(month ?? '')
    return `${currentYear}-${monthNum.toString().padStart(2, '0')}-${(day ?? '').padStart(2, '0')}`
  }

  return cleaned
}

const monthToNumber = (month: string): number => {
  const months: Record<string, number> = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
  }
  return months[month] ?? 1
}

/**
 * Parse amount from Robinhood format like "+$1,000.00" or "$100.00"
 */
const parseAmount = (amountText: string): number => {
  const cleaned = amountText.replace(/[+$,]/g, '')
  return parseFloat(cleaned) || 0
}

/**
 * Parse shares from text like "1.009998 shares at $99.01" or "0.01132829 Bitcoin at $88,274.51"
 */
const parseSharesAndPrice = (text: string): { shares: number; price: number } => {
  // Pattern: "X shares at $Y" or "X Bitcoin at $Y"
  const match = text.match(/([\d.]+)\s+(?:shares?|Bitcoin)\s+at\s+\$([\d,]+\.?\d*)/)
  if (match) {
    return {
      shares: parseFloat(match[1] ?? '0') || 0,
      price: parseFloat((match[2] ?? '0').replace(/,/g, '')) || 0
    }
  }
  return { shares: 0, price: 0 }
}

/**
 * Determine transaction type from title - captures ALL transaction types
 * We NEVER skip transactions, even if we can't categorize them - they go into 'other'
 * Order matters! More specific patterns first, then general patterns.
 */
const determineTransactionType = (title: string): ScrapedTransaction['type'] => {
  const lower = title.toLowerCase()

  // Income - check FIRST since "Dividend from X Option ETF" is still a dividend
  if (lower.includes('dividend from') || (lower.includes('dividend') && !lower.includes('split'))) return 'dividend'
  if (lower.includes('interest') && !lower.includes('interest rate')) return 'interest'
  if (lower.includes('staking earnings') || lower.includes('staking reward')) return 'interest'  // Staking yields = interest
  if (lower.includes('stock lending') || lower.includes('lending income') || lower.includes('securities lending') || lower.includes('lending payment')) return 'stock_lending'
  if (lower.includes('reward') || lower.includes('bonus') || lower.includes('payout') || lower.includes('trivia')) return 'dividend'  // Promotional rewards = income

  // Trading actions - specific phrases
  if (lower.includes('market buy') || lower.includes('limit buy') || lower.startsWith('buy ') || lower.includes(' buy ') || lower.includes('bought')) return 'buy'
  if (lower.includes('market sell') || lower.includes('limit sell') || lower.startsWith('sell ') || lower.includes(' sell ') || lower.includes('sold')) return 'sell'

  // Reinvestments (DRIP)
  if (lower.includes('reinvest') || lower.includes('drip') || lower.includes('automatic reinvestment')) return 'reinvest'

  // Corporate actions - before options since "Reverse Split" shouldn't match "option"
  if (lower.includes('forward split') || lower.includes('reverse split') || (lower.includes(' split') && !lower.includes('option'))) return 'split'
  if (lower.includes('merger') || lower.includes('acquisition') || lower.includes('spinoff') || lower.includes('spin-off') || lower.includes('reorganization')) return 'merger'

  // Options trading - only actual option transactions, not ETFs with "option" in name
  if (lower.includes(' call ') || lower.includes(' put ') || lower.includes('exercise') || lower.includes('assignment') || lower.includes(' expir')) return 'option'

  // Crypto - check for crypto-specific patterns
  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') || lower.includes(' btc ') || lower.includes(' eth ') || lower.includes(' sol ') || lower.includes(' doge ')) return 'crypto'

  // Transfers
  if (lower.includes('deposit')) return 'deposit'
  if (lower.includes('withdraw') || lower.includes('unstake')) return 'withdrawal'
  if (lower.includes('transfer') || lower.includes('sweep') || lower.includes('ach') || lower.includes(' sent') || lower.includes(' received') || lower.includes('stake ')) return 'transfer'

  // Adjustments (corrections, cost basis, etc.)
  if (lower.includes('adjust') || lower.includes('correction') || lower.includes('cost basis') || lower.includes('amendment')) return 'adjustment'

  // Fees and charges
  if (lower.includes('fee') || lower.includes('robinhood gold') || lower.includes('subscription') || lower.includes('charge')) return 'fee'

  // If we can't categorize it, return 'other' - but we STILL capture all the data
  return 'other'
}

/**
 * Extract symbol from title or expanded content
 */
const extractSymbol = (title: string, details: Record<string, string>): string | undefined => {
  // Check if Symbol is in details
  if (details['Symbol']) {
    return details['Symbol']
  }

  // For crypto, check title like "BTC Market Buy"
  const cryptoMatch = title.match(/^(BTC|ETH|SOL|DOGE|SHIB|XRP|ADA|AVAX|MATIC|DOT|LINK|UNI|ATOM)\s/)
  if (cryptoMatch) {
    return cryptoMatch[1]
  }

  return undefined
}


/**
 * Load or create scrape archive for a platform
 */
const loadArchive = async (platform: string): Promise<ScrapeArchive> => {
  await mkdir(SCRAPE_ARCHIVE_DIR, { recursive: true })
  const archivePath = join(SCRAPE_ARCHIVE_DIR, `${platform}.json`)

  const content = await readFile(archivePath, 'utf-8').catch(() => null)
  if (content) {
    return JSON.parse(content) as ScrapeArchive
  }

  return {
    platform,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    transactions: []
  }
}

/**
 * Save archive to disk
 */
const saveArchive = async (archive: ScrapeArchive): Promise<void> => {
  await mkdir(SCRAPE_ARCHIVE_DIR, { recursive: true })
  const archivePath = join(SCRAPE_ARCHIVE_DIR, `${archive.platform}.json`)
  archive.updatedAt = new Date().toISOString()
  await writeFile(archivePath, JSON.stringify(archive, null, 2), 'utf-8')
}

/**
 * Add transaction to archive if not already present
 */
const addToArchive = (archive: ScrapeArchive, tx: ScrapedTransaction): boolean => {
  const exists = archive.transactions.some(t => t.id === tx.id)
  if (!exists) {
    archive.transactions.push(tx)
    // Sort by date descending (newest first)
    archive.transactions.sort((a, b) => b.date.localeCompare(a.date))
    return true
  }
  return false
}

/**
 * Parse Robinhood CSV row into RobinhoodTransaction.
 * Handles various column name formats.
 */
const parseRobinhoodRow = (row: Record<string, string>): RobinhoodTransaction => {
  // Activity date - try various column names
  const activityDate = row['activity_date'] || row['date'] || row['trans_date'] || row['transaction_date'] || ''
  const settleDate = row['settle_date'] || row['settlement_date'] || ''

  // Transaction code/type
  const transCode = row['trans_code'] || row['type'] || row['transaction_type'] || row['action'] || ''

  // Symbol - Robinhood calls it "Instrument"
  const symbol = (row['instrument'] || row['symbol'] || row['ticker'] || '').toUpperCase()

  // Quantity - handle negative for sells
  const quantityStr = row['quantity'] || row['qty'] || row['shares'] || '0'
  const quantity = Math.abs(parseFloat(quantityStr.replace(/[,$]/g, '')) || 0)

  // Price
  const priceStr = row['price'] || row['avg_price'] || row['average_price'] || '0'
  const price = parseFloat(priceStr.replace(/[,$]/g, '')) || 0

  // Amount - total transaction value
  const amountStr = row['amount'] || row['total'] || row['value'] || '0'
  const amount = Math.abs(parseFloat(amountStr.replace(/[,$()]/g, '')) || 0)

  // Description
  const description = row['description'] || row['name'] || row['desc'] || ''

  return {
    activityDate: parseDate(activityDate),
    settleDate: parseDate(settleDate),
    transCode,
    description,
    symbol,
    quantity,
    price,
    amount
  }
}

// ============================================================================
// CashApp CSV Parsing
// ============================================================================

/**
 * Detect if CSV content is from CashApp based on header columns.
 */
const isCashAppCSV = (rows: Record<string, string>[]): boolean => {
  if (rows.length === 0) return false
  const keys = Object.keys(rows[0] ?? {})
  return keys.includes('transaction_type') && keys.includes('asset_type') && keys.includes('net_amount')
}

/**
 * Parse CashApp CSV row into a ParsedTransaction.
 * CashApp columns: date, transaction_id, transaction_type, currency, amount, fee, net_amount,
 *   asset_type, asset_price, asset_amount, status, notes, name_of_sender/receiver, account
 */
const parseCashAppRow = (row: Record<string, string>, platform: string): ParsedTransaction | null => {
  const status = (row['status'] ?? '').toUpperCase()
  // Skip failed transactions
  if (status === 'FAILED') return null

  const transType = (row['transaction_type'] ?? '').trim()
  const assetType = (row['asset_type'] ?? '').toUpperCase().trim()

  // Map transaction type to action
  let action: ParsedTransaction['action']
  let symbol = assetType

  const notes = (row['notes'] ?? '').trim()

  if (transType === 'Bitcoin Buy' || transType.endsWith(' Buy')) {
    action = 'BUY'
  } else if (transType === 'Bitcoin Sell' || transType.endsWith(' Sell')) {
    action = 'SELL'
  } else if (transType === 'Stock Dividends' || transType.endsWith(' Dividends') || transType.endsWith(' Dividend')) {
    action = 'DIVIDEND'
  } else if (transType === 'P2P') {
    // P2P transfers are cash deposits/withdrawals - route to cash fund
    const amountStr = row['amount'] ?? '0'
    const amountVal = parseFloat(amountStr.replace(/[$,\s]/g, '')) || 0
    action = amountVal >= 0 ? 'DEPOSIT' : 'WITHDRAW'
    symbol = 'CASH'
  } else if (!transType && notes.toLowerCase().includes('sale of')) {
    // CashApp sometimes exports sales with empty transaction_type
    action = 'SELL'
  } else {
    // Skip unrecognized transaction types
    return null
  }

  // Parse date - format: "2026-02-22 17:59:47 PST"
  const dateStr = (row['date'] ?? '').trim()
  const date = dateStr ? dateStr.slice(0, 10) : '' // Take YYYY-MM-DD portion
  if (!date) return null

  // Parse amounts - strip $, commas, and handle negative with -$
  const parseAmount = (str: string): number => {
    if (!str) return 0
    return Math.abs(parseFloat(str.replace(/[$,\s]/g, '')) || 0)
  }

  // Use net_amount as the canonical amount:
  // - For BUYs: net_amount = cost + fee (total out of pocket, correct cost basis)
  // - For SELLs: net_amount = proceeds - fee (actual cash received)
  const netAmount = parseAmount(row['net_amount'] ?? '0')
  const fee = parseAmount(row['fee'] ?? '0')
  const assetPrice = parseAmount(row['asset_price'] ?? '0')
  const assetAmount = parseFloat((row['asset_amount'] ?? '0').replace(/[$,\s]/g, '')) || 0

  const description = notes

  // Build fund ID
  const fundId = symbol === 'CASH'
    ? `${platform.toLowerCase()}-cash`
    : symbol
      ? buildFundId(platform, symbol)
      : null

  return {
    date,
    action,
    symbol,
    quantity: Math.abs(assetAmount),
    price: assetPrice,
    amount: netAmount,
    description: description || `${transType} ${symbol ? symbol + ' ' : ''}${assetAmount ? assetAmount + ' @ $' + assetPrice.toLocaleString() : ''}`.trim(),
    fundId,
    fundExists: false, // Will be set later
    rawDetails: { fee: fee.toString() }
  }
}

/**
 * Build fund ID from platform and symbol.
 */
const buildFundId = (platform: string, symbol: string): string => {
  return `${platform.toLowerCase()}-${symbol.toLowerCase()}`
}

/**
 * Check if a fund exists by ID.
 */
const fundExists = (fundId: string, funds: FundData[]): boolean => {
  return funds.some(f => f.id === fundId)
}

// ============================================================================
// Preview Endpoint
// ============================================================================

/**
 * POST /import/robinhood/preview
 * Parse CSV and return preview with fund mappings.
 *
 * Options:
 * - includeCashImpact: When true, generates CASH entries for all cash-affecting
 *   transactions (BUY→WITHDRAW, SELL→DEPOSIT, DIVIDEND→DEPOSIT, etc.)
 */
importRouter.post('/robinhood/preview', async (req, res, next) => {
  const { csvContent, platform = 'robinhood', includeCashImpact = false } = req.body as {
    csvContent?: string
    platform?: string
    includeCashImpact?: boolean
  }

  if (!csvContent) {
    return next(badRequest('csvContent is required'))
  }

  // Parse CSV
  const rows = parseCSV(csvContent)
  if (rows.length === 0) {
    return next(validationError('No valid data rows found in CSV'))
  }

  // Auto-detect CashApp CSV format and override platform if needed
  const detectedCashApp = isCashAppCSV(rows)
  const effectivePlatform = detectedCashApp ? 'cashapp' : platform

  // Load existing funds
  const funds = await readAllFunds(FUNDS_DIR).catch(() => [])
  const cashFundId = `${effectivePlatform.toLowerCase().replace(/-cash$/, '')}-cash`
  const cashFundExists = fundExists(cashFundId, funds)

  // Parse and map transactions
  const transactions: ParsedTransaction[] = []
  const bySymbol: Record<string, { count: number; fundId: string | null; fundExists: boolean }> = {}

  // CashApp CSV - use dedicated parser
  if (detectedCashApp) {
    for (const row of rows) {
      const tx = parseCashAppRow(row, effectivePlatform)
      if (!tx) continue

      // Set fundExists
      tx.fundExists = tx.fundId ? fundExists(tx.fundId, funds) : false

      // Track by symbol
      if (tx.symbol) {
        if (!bySymbol[tx.symbol]) {
          bySymbol[tx.symbol] = { count: 0, fundId: tx.fundId, fundExists: tx.fundExists }
        }
        bySymbol[tx.symbol]!.count++
      }

      transactions.push(tx)

      // If includeCashImpact, also create a CASH entry for cash-affecting transactions
      if (includeCashImpact && ['BUY', 'SELL', 'DIVIDEND'].includes(tx.action) && tx.amount > 0) {
        let cashAction: ParsedTransaction['action']
        let cashDescription: string

        if (tx.action === 'BUY') {
          cashAction = 'WITHDRAW'
          cashDescription = `Trade: Buy ${tx.symbol} (${tx.quantity} @ $${tx.price.toFixed(2)})`
        } else if (tx.action === 'SELL') {
          cashAction = 'DEPOSIT'
          cashDescription = `Trade: Sell ${tx.symbol} (${tx.quantity} @ $${tx.price.toFixed(2)})`
        } else {
          // DIVIDEND
          cashAction = 'DEPOSIT'
          cashDescription = `Dividend: ${tx.symbol}`
        }

        // Track as CASH
        if (!bySymbol['CASH']) {
          bySymbol['CASH'] = { count: 0, fundId: cashFundId, fundExists: cashFundExists }
        }
        bySymbol['CASH']!.count++

        transactions.push({
          date: tx.date,
          action: cashAction,
          symbol: 'CASH',
          quantity: 0,
          price: 0,
          amount: tx.amount,
          description: cashDescription,
          fundId: cashFundId,
          fundExists: cashFundExists
        })
      }
    }

    // Sort by date
    transactions.sort((a, b) => a.date.localeCompare(b.date))

    const matched = transactions.filter(t => t.fundExists).length
    const unmatched = transactions.filter(t => t.fundId && !t.fundExists).length

    const preview: ImportPreview = {
      transactions,
      summary: {
        total: transactions.length,
        matched,
        unmatched,
        bySymbol
      }
    }

    return res.json(preview)
  }

  // Robinhood CSV - use existing parser
  for (const row of rows) {
    const parsed = parseRobinhoodRow(row)
    const action = mapTransCode(parsed.transCode, parsed.description, parsed.amount)

    // Determine fund ID for trades, dividends, options, etc.
    let fundId: string | null = null
    let exists = false
    let effectiveSymbol = parsed.symbol

    // Actions that should be associated with a symbol/fund
    const symbolActions: ParsedTransaction['action'][] = [
      'BUY', 'SELL', 'DIVIDEND', 'OPTION', 'STOCK_LENDING', 'SPLIT', 'MERGER', 'REINVEST', 'CRYPTO'
    ]

    // Cash transactions (no symbol) should be routed to the cash fund
    const cashActions: ParsedTransaction['action'][] = ['DEPOSIT', 'WITHDRAW', 'INTEREST']
    const isCashTransaction = !parsed.symbol && cashActions.includes(action)

    // Actions that affect cash balance (for includeCashImpact mode)
    const cashImpactActions: ParsedTransaction['action'][] = [
      'BUY', 'SELL', 'DIVIDEND', 'STOCK_LENDING', 'FEE'
    ]

    if (isCashTransaction) {
      // Route to platform's cash fund (e.g., robinhood-cash)
      fundId = cashFundId
      exists = cashFundExists
      effectiveSymbol = 'CASH'

      // Track by CASH symbol
      if (!bySymbol['CASH']) {
        bySymbol['CASH'] = { count: 0, fundId, fundExists: exists }
      }
      bySymbol['CASH']!.count++

      transactions.push({
        date: parsed.activityDate,
        action,
        symbol: effectiveSymbol,
        quantity: parsed.quantity,
        price: parsed.price,
        amount: parsed.amount || (parsed.quantity * parsed.price),
        description: parsed.description,
        fundId,
        fundExists: exists
      })
    } else if (parsed.symbol && symbolActions.includes(action)) {
      fundId = buildFundId(platform, parsed.symbol)
      exists = fundExists(fundId, funds)

      // Track by symbol
      if (!bySymbol[parsed.symbol]) {
        bySymbol[parsed.symbol] = { count: 0, fundId, fundExists: exists }
      }
      bySymbol[parsed.symbol]!.count++

      transactions.push({
        date: parsed.activityDate,
        action,
        symbol: effectiveSymbol,
        quantity: parsed.quantity,
        price: parsed.price,
        amount: parsed.amount || (parsed.quantity * parsed.price),
        description: parsed.description,
        fundId,
        fundExists: exists
      })

      // If includeCashImpact, also create a CASH entry for cash-affecting transactions
      if (includeCashImpact && cashImpactActions.includes(action) && parsed.amount > 0) {
        // Convert action to cash impact: BUY→WITHDRAW, SELL/DIVIDEND/STOCK_LENDING→DEPOSIT
        let cashAction: ParsedTransaction['action']
        let cashDescription: string

        if (action === 'BUY') {
          cashAction = 'WITHDRAW'
          cashDescription = `Trade: Buy ${parsed.symbol} (${parsed.quantity} @ $${parsed.price.toFixed(2)})`
        } else if (action === 'SELL') {
          cashAction = 'DEPOSIT'
          cashDescription = `Trade: Sell ${parsed.symbol} (${parsed.quantity} @ $${parsed.price.toFixed(2)})`
        } else if (action === 'DIVIDEND') {
          cashAction = 'DEPOSIT'
          cashDescription = `Dividend: ${parsed.symbol}`
        } else if (action === 'STOCK_LENDING') {
          cashAction = 'DEPOSIT'
          cashDescription = `Stock Lending: ${parsed.symbol}`
        } else if (action === 'FEE') {
          cashAction = 'WITHDRAW'
          cashDescription = `Fee: ${parsed.symbol} - ${parsed.description}`
        } else {
          continue // Skip other actions
        }

        // Track as CASH
        if (!bySymbol['CASH']) {
          bySymbol['CASH'] = { count: 0, fundId: cashFundId, fundExists: cashFundExists }
        }
        bySymbol['CASH']!.count++

        transactions.push({
          date: parsed.activityDate,
          action: cashAction,
          symbol: 'CASH',
          quantity: 0,
          price: 0,
          amount: parsed.amount,
          description: cashDescription,
          fundId: cashFundId,
          fundExists: cashFundExists
        })
      }
    }
  }

  // Sort by date
  transactions.sort((a, b) => a.date.localeCompare(b.date))

  const matched = transactions.filter(t => t.fundExists).length
  const unmatched = transactions.filter(t => t.fundId && !t.fundExists).length

  const preview: ImportPreview = {
    transactions,
    summary: {
      total: transactions.length,
      matched,
      unmatched,
      bySymbol
    }
  }

  res.json(preview)
})

// ============================================================================
// Apply Endpoint
// ============================================================================

/**
 * POST /import/robinhood/apply
 * Apply confirmed transactions to existing funds.
 */
importRouter.post('/robinhood/apply', async (req, res, next) => {
  const { transactions, skipUnmatched = true, clearBeforeImport = false } = req.body as {
    transactions?: ParsedTransaction[]
    skipUnmatched?: boolean
    clearBeforeImport?: boolean
  }

  if (!transactions || !Array.isArray(transactions)) {
    return next(badRequest('transactions array is required'))
  }

  // Load existing funds to verify
  const funds = await readAllFunds(FUNDS_DIR).catch(() => [])
  const fundMap = new Map(funds.map(f => [f.id, f]))

  // If clearBeforeImport, clear all entries from target funds first
  if (clearBeforeImport) {
    const targetFundIds = new Set(transactions.map(tx => tx.fundId).filter(Boolean))
    for (const fundId of targetFundIds) {
      const fund = fundMap.get(fundId!)
      if (fund) {
        // Write empty entries to clear the fund
        const filePath = join(FUNDS_DIR, `${fundId}.tsv`)
        // Re-read fund to get config, then write with empty entries
        const existingFund = funds.find(f => f.id === fundId)
        if (existingFund) {
          // Import writeFund from storage
          const { writeFund } = await import('@escapemint/storage')
          await writeFund(filePath, { ...existingFund, entries: [] })
          // Update the map with cleared entries
          fundMap.set(fundId!, { ...existingFund, entries: [] })
        }
      }
    }
  }

  const result: ImportResult = {
    applied: 0,
    skipped: 0,
    errors: []
  }

  // Track running shares and last known price per fund to compute pre-action equity value
  // Initialize from existing fund entries that are BEFORE the earliest imported tx date
  // for each fund. This prevents incorrect values when importing historical data into
  // a fund that already has newer entries.
  const fundRunningShares = new Map<string, number>()
  const fundLastPrice = new Map<string, number>()

  // Build a map of fundId -> earliest import date so we only initialize from
  // existing entries that predate the imported transactions
  const fundEarliestImportDate = new Map<string, string>()
  for (const tx of transactions) {
    if (!tx.fundId) continue
    const current = fundEarliestImportDate.get(tx.fundId)
    if (!current || tx.date < current) {
      fundEarliestImportDate.set(tx.fundId, tx.date)
    }
  }

  for (const [fundId, fund] of fundMap) {
    let shares = 0
    let lastPrice = 0
    let lastPriceDate = ''
    const earliestImportDate = fundEarliestImportDate.get(fundId)
    for (const e of fund.entries) {
      // Only count entries before the earliest imported tx date for this fund
      if (earliestImportDate && e.date >= earliestImportDate) continue
      if (e.shares) {
        shares += e.action === 'SELL' ? -Math.abs(e.shares) : Math.abs(e.shares)
      }
      if (e.price && e.price > 0 && e.date >= lastPriceDate) {
        lastPrice = e.price
        lastPriceDate = e.date
      }
    }
    fundRunningShares.set(fundId, shares)
    if (lastPrice > 0) fundLastPrice.set(fundId, lastPrice)
  }

  // Sort transactions by date to process in chronological order
  const sortedTxs = [...transactions].sort((a, b) => a.date.localeCompare(b.date))

  for (const tx of sortedTxs) {
    // Skip transactions without fund mapping
    if (!tx.fundId) {
      result.skipped++
      continue
    }

    // Check if fund exists
    const fund = fundMap.get(tx.fundId)
    if (!fund) {
      if (skipUnmatched) {
        result.skipped++
        continue
      }
      result.errors.push(`Fund not found: ${tx.fundId}`)
      continue
    }

    // Compute pre-action equity value from running shares and current/last known price
    const runningShares = fundRunningShares.get(tx.fundId) ?? 0
    const effectivePrice = tx.price > 0 ? tx.price : (fundLastPrice.get(tx.fundId) ?? 0)
    const preActionValue = effectivePrice > 0 && runningShares > 0
      ? runningShares * effectivePrice
      : 0

    // Convert to FundEntry
    const entry: FundEntry = {
      date: tx.date,
      value: Math.round(preActionValue * 100) / 100,
      notes: `Imported: ${tx.description}`
    }

    // Set action-specific fields
    if (tx.action === 'BUY' || tx.action === 'SELL') {
      entry.action = tx.action
      entry.amount = tx.amount
      entry.shares = tx.quantity
      entry.price = tx.price
      // Update running shares and last known price for this fund
      const delta = tx.action === 'SELL' ? -Math.abs(tx.quantity) : Math.abs(tx.quantity)
      fundRunningShares.set(tx.fundId, runningShares + delta)
      if (tx.price > 0) fundLastPrice.set(tx.fundId, tx.price)
    } else if (tx.action === 'DIVIDEND') {
      entry.dividend = tx.amount
    } else if (tx.action === 'INTEREST') {
      entry.cash_interest = tx.amount
    } else if (tx.action === 'DEPOSIT') {
      entry.action = 'DEPOSIT'
      entry.amount = tx.amount
    } else if (tx.action === 'WITHDRAW') {
      entry.action = 'WITHDRAW'
      entry.amount = Math.abs(tx.amount) // Ensure positive for withdraw
    }

    // Normalize cash-fund DEPOSIT/WITHDRAW to HOLD with signed amounts
    // The UI renders cash entries using action=HOLD with signed amount: positive=deposit, negative=withdraw
    if (tx.fundId.endsWith('-cash') && entry.amount) {
      if (entry.action === 'DEPOSIT') {
        entry.amount = Math.abs(entry.amount)
        entry.action = 'HOLD'
      } else if (entry.action === 'WITHDRAW') {
        entry.amount = -Math.abs(entry.amount)
        entry.action = 'HOLD'
      }
    }

    // Check for duplicate based on transaction type
    let isDuplicate = false
    if (tx.action === 'INTEREST') {
      // For interest, check date and cash_interest amount
      isDuplicate = fund.entries.some(e =>
        e.date === entry.date &&
        e.cash_interest === entry.cash_interest
      )
    } else if (tx.fundId.endsWith('-cash') && entry.action === 'HOLD') {
      // Cash fund entries may exist as legacy DEPOSIT/WITHDRAW or normalized HOLD.
      // Match against both conventions to prevent re-importing the same cash flow.
      const absAmount = Math.abs(entry.amount ?? 0)
      const legacyAction = (entry.amount ?? 0) >= 0 ? 'DEPOSIT' : 'WITHDRAW'
      isDuplicate = fund.entries.some(e =>
        e.date === entry.date && (
          // Match normalized HOLD entries (same signed amount)
          (e.action === 'HOLD' && e.amount === entry.amount) ||
          // Match legacy DEPOSIT/WITHDRAW entries (unsigned amount)
          (e.action === legacyAction && Math.abs(e.amount ?? 0) === absAmount)
        )
      )
    } else {
      // For other actions, check date, action, and amount
      isDuplicate = fund.entries.some(e =>
        e.date === entry.date &&
        e.action === entry.action &&
        e.amount === entry.amount
      )
    }

    if (isDuplicate) {
      result.skipped++
      continue
    }

    // Append entry
    const filePath = join(FUNDS_DIR, `${tx.fundId}.tsv`)
    const appendResult = await appendEntry(filePath, entry).catch((err: Error) => {
      result.errors.push(`Failed to add entry to ${tx.fundId}: ${err.message}`)
      return null
    })

    if (appendResult !== null) {
      result.applied++
    }
  }

  // Post-process: Update running balances for cash funds
  if (result.applied > 0) {
    const cashFundIds = new Set(
      transactions
        .filter(tx => tx.fundId?.endsWith('-cash'))
        .map(tx => tx.fundId!)
    )

    for (const cashFundId of cashFundIds) {
      const filePath = join(FUNDS_DIR, `${cashFundId}.tsv`)
      // Re-read the fund to get all entries including newly added ones
      const { readFund, writeFund } = await import('@escapemint/storage')
      const updatedFund = await readFund(filePath).catch(() => null)

      if (updatedFund && updatedFund.entries.length > 0) {
        // Sort entries by date
        updatedFund.entries.sort((a, b) => a.date.localeCompare(b.date))

        // Calculate running balance and update value/fund_size fields
        // Entries may be normalized (HOLD with signed amount) or legacy (DEPOSIT/WITHDRAW)
        let runningBalance = 0
        for (const entry of updatedFund.entries) {
          if (entry.action === 'DEPOSIT' && entry.amount) {
            runningBalance += entry.amount
          } else if (entry.action === 'WITHDRAW' && entry.amount) {
            runningBalance -= entry.amount
          } else if (entry.action === 'HOLD' && entry.amount) {
            // Normalized cash entry: amount is already signed
            runningBalance += entry.amount
          }
          if (entry.cash_interest) {
            runningBalance += entry.cash_interest
          }
          if (entry.expense) {
            runningBalance -= entry.expense
          }

          // Set value, cash, and fund_size to the running balance
          entry.value = Math.round(runningBalance * 100) / 100
          entry.cash = entry.value
          entry.fund_size = entry.value
        }

        // Write back the updated fund
        await writeFund(filePath, updatedFund)
      }
    }
  }

  res.json({
    success: result.errors.length === 0,
    result
  })
})

// ============================================================================
// M1 Cash Import Apply
// ============================================================================

/**
 * POST /import/m1-cash/apply
 * Apply M1 cash transactions (interest, deposit, withdrawal) to the m1-cash fund.
 * Transfers are stored separately for later reconciliation with trading funds.
 */
importRouter.post('/m1-cash/apply', async (req, res, next) => {
  const { transactions, skipDuplicates = true } = req.body as {
    transactions?: ParsedTransaction[]
    skipDuplicates?: boolean
  }

  if (!transactions || !Array.isArray(transactions)) {
    return next(badRequest('transactions array is required'))
  }

  // Load the m1-cash fund
  const funds = await readAllFunds(FUNDS_DIR).catch(() => [])
  const cashFund = funds.find(f => f.id === 'm1-cash')

  if (!cashFund) {
    return next(badRequest('m1-cash fund not found. Please create it first.'))
  }

  const result: ImportResult = {
    applied: 0,
    skipped: 0,
    errors: []
  }

  const filePath = join(FUNDS_DIR, 'm1-cash.tsv')

  for (const tx of transactions) {
    // Only process cash-related transactions
    const cashActions = ['INTEREST', 'DEPOSIT', 'WITHDRAW']
    if (!cashActions.includes(tx.action)) {
      // Skip non-cash transactions (like transfers) for now
      result.skipped++
      continue
    }

    // Create the fund entry based on transaction type
    const entry: FundEntry = {
      date: tx.date,
      value: 0,  // Will be recalculated by the UI from entries
      notes: `Imported from M1 Finance: ${tx.description}`
    }

    if (tx.action === 'INTEREST') {
      // Interest goes into cash_interest field
      entry.cash_interest = tx.amount
    } else if (tx.action === 'DEPOSIT') {
      entry.action = 'DEPOSIT'
      entry.amount = tx.amount
    } else if (tx.action === 'WITHDRAW') {
      entry.action = 'WITHDRAW'
      entry.amount = tx.amount
    }

    // Check for duplicates
    if (skipDuplicates) {
      const isDuplicate = cashFund.entries.some(e => {
        // Match by date and type
        if (e.date !== entry.date) return false
        if (tx.action === 'INTEREST') {
          return e.cash_interest === entry.cash_interest
        }
        return e.action === entry.action && e.amount === entry.amount
      })

      if (isDuplicate) {
        result.skipped++
        continue
      }
    }

    // Append entry
    const appendResult = await appendEntry(filePath, entry).catch((err: Error) => {
      result.errors.push(`Failed to add ${tx.action} entry: ${err.message}`)
      return null
    })

    if (appendResult !== null) {
      result.applied++
    }
  }

  res.json({
    success: result.errors.length === 0,
    result
  })
})

// ============================================================================
// Browser Scraping (CDP Connection)
// ============================================================================

// Use a dedicated port and profile to avoid conflicts with other browser automation
const CDP_PORT = process.env['CDP_PORT'] ?? '5549'
const DEFAULT_CDP_URL = `http://localhost:${CDP_PORT}`
const BROWSER_USER_DATA_DIR = join(process.cwd(), '.browser')

/**
 * Connect to an existing Chrome browser via CDP.
 */
const connectToBrowser = async (cdpUrl: string = DEFAULT_CDP_URL): Promise<Browser> => {
  if (connectedBrowser?.isConnected()) {
    return connectedBrowser
  }

  connectedBrowser = await chromium.connectOverCDP(cdpUrl)
  return connectedBrowser
}

/**
 * Find an existing Robinhood page in the browser.
 * Returns null if no Robinhood page found - user needs to open and log in manually.
 */
const findRobinhoodPage = async (browser: Browser): Promise<Page | null> => {
  const contexts = browser.contexts()
  log.debug(`[Import] Found ${contexts.length} browser contexts`)

  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!
    const pages = context.pages()
    log.debug(`[Import] Context ${i}: ${pages.length} pages`)
    for (const page of pages) {
      const pageUrl = page.url()
      // Must start with robinhood.com domain (not just contain it in a fragment/param)
      // Exclude Stripe iframes and other third-party pages
      const isRobinhoodPage = (
        pageUrl.startsWith('https://robinhood.com') ||
        pageUrl.startsWith('http://robinhood.com')
      ) && !pageUrl.includes('/login')

      if (isRobinhoodPage) {
        log.debug(`[Import] Found existing Robinhood page: ${pageUrl}`)
        return page
      }
    }
  }

  return null
}

/**
 * Navigate to Robinhood history page by clicking through the UI.
 * This is a fallback when direct URL navigation doesn't work.
 */
const navigateRobinhoodViaUI = async (page: Page): Promise<boolean> => {
  log.debug('[Robinhood] Attempting UI navigation to history page')

  // Try multiple strategies to find and click the Account link
  const accountSelectors = [
    'a[href="/account"]',
    'a[href*="/account"]',
    '[data-testid="AccountLink"]',
    'text=Account',
    'nav a:has-text("Account")',
    '[aria-label="Account"]',
    'a:has-text("Account")'
  ]

  let accountClicked = false
  for (const selector of accountSelectors) {
    const accountLink = await page.$(selector).catch(() => null)
    if (accountLink) {
      log.debug(`[Robinhood] Found account link with selector: ${selector}`)
      await accountLink.click().catch(() => null)
      accountClicked = true
      await page.waitForTimeout(2000)
      break
    }
  }

  if (!accountClicked) {
    log.debug('[Robinhood] Could not find Account link, trying direct profile icon click')
    // Try clicking on profile/account icon (usually in top right)
    const profileIcon = await page.$('[data-testid="ProfileIcon"], [aria-label="Profile"], svg[class*="profile"], .account-icon').catch(() => null)
    if (profileIcon) {
      await profileIcon.click().catch(() => null)
      await page.waitForTimeout(2000)
    }
  }

  // Check if we're on an account page now
  let currentUrl = page.url()
  log.debug(`[Robinhood] After account click, URL is: ${currentUrl}`)

  // If we're on an account page but not history, click History
  if (currentUrl.includes('/account') && !currentUrl.includes('history')) {
    const historySelectors = [
      'a[href="/account/history"]',
      'a[href*="history"]',
      'text=History',
      'a:has-text("History")',
      '[data-testid="HistoryLink"]'
    ]

    for (const selector of historySelectors) {
      const historyLink = await page.$(selector).catch(() => null)
      if (historyLink) {
        log.debug(`[Robinhood] Found history link with selector: ${selector}`)
        await historyLink.click().catch(() => null)
        await page.waitForTimeout(2000)
        break
      }
    }
  }

  // Final check
  currentUrl = page.url()
  log.debug(`[Robinhood] Final URL after UI navigation: ${currentUrl}`)

  if (currentUrl.includes('history') || currentUrl.includes('/account/')) {
    log.debug('[Robinhood] UI navigation successful')
    return true
  }

  // Last resort: try clicking any visible "History" text on the page
  const historyText = await page.$('text=History').catch(() => null)
  if (historyText) {
    log.debug('[Robinhood] Clicking History text as last resort')
    await historyText.click().catch(() => null)
    await page.waitForTimeout(2000)

    currentUrl = page.url()
    if (currentUrl.includes('history')) {
      return true
    }
  }

  log.debug('[Robinhood] UI navigation failed')
  return false
}

/**
 * Create a new page in the browser context.
 */
const createNewPage = async (browser: Browser): Promise<Page> => {
  const contexts = browser.contexts()

  // Use the same context as an existing non-extension page
  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!
    const pages = context.pages()
    for (const existingPage of pages) {
      const pageUrl = existingPage.url()
      if (!pageUrl.startsWith('chrome-extension://') && !pageUrl.startsWith('blob:') && pageUrl !== 'about:blank') {
        log.debug(`[Import] Creating new page in context ${i}`)
        // Add timeout to prevent hanging
        const newPagePromise = context.newPage()
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout creating new page')), 10000)
        )
        const newPage = await Promise.race([newPagePromise, timeoutPromise])
        log.debug(`[Import] New page created successfully, URL: ${newPage.url()}`)
        return newPage
      }
    }
  }

  // Fallback to first context
  log.debug('[Import] Using fallback context')
  const context = contexts[0]
  if (!context) {
    throw new Error('No browser context found')
  }
  const newPagePromise = context.newPage()
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Timeout creating new page in fallback context')), 10000)
  )
  const newPage = await Promise.race([newPagePromise, timeoutPromise])
  log.debug('[Import] New page created in fallback context')
  return newPage
}

/**
 * Scrape a single transaction from an activity item element.
 * Expands it if needed and extracts all data.
 * @param existingIds - Set of existing transaction IDs to skip expanding for performance
 */

/**
 * Extract all data from an activity item in a single browser evaluate call.
 * This avoids the O(n) cost of page.$$() which creates handles for all items.
 */
const scrapeActivityItem = async (
  page: Page,
  itemSelector: string,
  index: number,
  _existingIds?: Set<string>  // Reserved for future deduplication; kept for API stability
): Promise<ScrapedTransaction | null> => {
  // Log timing every 100 items (use index which is 0-based)
  const shouldLog = (index + 1) % 100 === 0
  const timings: Record<string, number> = {}
  const t0 = Date.now()

  // Extract header data in a single evaluate - no expansion, just header info
  const headerData = await page.evaluate(
    ([idx, sel]) => {
      const items = document.querySelectorAll(sel)
      const item = items[idx]
      if (!item) return null

      const header = item.querySelector('[data-testid="rh-ExpandableItem-buttonContent"]')
      if (!header) return null

      const titleEl = header.querySelector('h3')
      const title = titleEl?.textContent ?? ''
      if (!title) return null

      const headerText = header.textContent ?? ''
      return { title, headerText }
    },
    [index, itemSelector] as [number, string]
  )

  if (!headerData) return null
  const { title, headerText } = headerData
  if (shouldLog) timings['getHeader'] = Date.now() - t0

  // Extract date from header text
  let dateText = ''
  const dateMatch = headerText.match(/([A-Z][a-z]{2}\s+\d{1,2}(?:,?\s+\d{4})?)/)
  if (dateMatch && dateMatch[1]) {
    dateText = dateMatch[1]
  }

  // Extract amount from header text
  let amountText = ''
  const amountMatch = headerText.match(/\$[\d,]+\.?\d*/)
  if (amountMatch) {
    amountText = amountMatch[0]
  }

  // Also look for shares info in the header
  let headerSharesText = ''
  const sharesMatch = headerText.match(/([\d.]+)\s+shares?\s+at\s+\$([\d,.]+)/)
  if (sharesMatch) {
    headerSharesText = sharesMatch[0]
  }

  // No expansion - just use header data
  const details: Record<string, string> = {}
  if (shouldLog) timings['parseHeader'] = Date.now() - t0 - (timings['getHeader'] ?? 0)

  // Parse the data
  const type = determineTransactionType(title)
  const date = parseRobinhoodDate(dateText)
  const amount = parseAmount(amountText)
  const symbol = extractSymbol(title, details)
  if (shouldLog) timings['parseData'] = Date.now() - t0 - Object.values(timings).reduce((a, b) => a + b, 0)

  // Get shares and price
  let shares: number | undefined
  let pricePerShare: number | undefined

  // Try from details first
  if (details['Number of Shares']) {
    shares = parseFloat(details['Number of Shares'].replace(/,/g, '')) || undefined
  }
  if (details['Amount per Share']) {
    pricePerShare = parseFloat(details['Amount per Share'].replace(/[$,]/g, '')) || undefined
  }

  // Or from Filled Quantity
  if (details['Filled Quantity'] && !shares) {
    const parsed = parseSharesAndPrice(details['Filled Quantity'])
    shares = parsed.shares || undefined
    pricePerShare = parsed.price || undefined
  }

  // Or from header text
  if (headerSharesText && !shares) {
    const parsed = parseSharesAndPrice(headerSharesText)
    shares = parsed.shares || undefined
    pricePerShare = parsed.price || undefined
  }

  // Create a more unique ID using title hash to handle same-date, same-amount transactions
  const titleHash = title.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0).toString(36)
  const id = `${date}-${type}-${amount.toFixed(2)}-${symbol || titleHash}`

  // Slim result - only essential fields
  const result: ScrapedTransaction = {
    id,
    date,
    type,
    title,  // Keep for debugging/display (replaces rawText which was removed to slim payload)
    amount,
    details  // Empty object now, but keep for type compatibility
  }

  // Only add optional properties if they have values
  if (symbol) result.symbol = symbol
  if (shares) result.shares = shares
  if (pricePerShare) result.pricePerShare = pricePerShare

  // Log timing breakdown every 100 items
  if (shouldLog && Object.keys(timings).length > 0) {
    const total = Object.values(timings).reduce((a, b) => a + b, 0)
    const breakdown = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(', ')
    log.debug(`[Robinhood] Item #${index + 1} timing (total=${total}ms): ${breakdown}`)
  }

  return result
}

/**
 * Scrape transaction history from a Robinhood page with progress updates.
 * Expands each item to get full details.
 * @param fullSync - When true, disables early exit on consecutive existing transactions (for full resync)
 */
const scrapeRobinhoodHistoryWithProgress = async (
  page: Page,
  archive: ScrapeArchive,
  onProgress: (current: number, total: number, tx: ScrapedTransaction | null) => void,
  fullSync = false   // When true, don't early exit on consecutive existing transactions
): Promise<{ newCount: number; totalScraped: number }> => {
  // Wait for activity items to load
  await page.waitForSelector('[data-testid="activity-item"], [data-testid="UnifiedTransferActivityItem"]', {
    timeout: 15000
  }).catch(() => null)

  // Wait for page to stabilize - check that items have loaded and page is ready
  await page.waitForFunction(
    (sel) => {
      const items = document.querySelectorAll(sel as string)
      // Wait until we have at least a few items loaded
      return items.length >= 3
    },
    '[data-testid="activity-item"], [data-testid="UnifiedTransferActivityItem"]',
    { timeout: 10000 }
  ).catch(() => null)

  let totalScraped = 0
  let newCount = 0
  let consecutiveExisting = 0  // Track consecutive already-scraped transactions
  const MAX_CONSECUTIVE_EXISTING = 50  // Stop early if we've seen this many existing txns in a row

  const itemSelector = '[data-testid="activity-item"], [data-testid="UnifiedTransferActivityItem"]'

  // Build set of existing IDs for fast lookup
  const existingIds = new Set(archive.transactions.map(t => t.id))

  // Process items using index-based approach with periodic page refresh
  // Refresh every BATCH_SIZE items to reset browser state and prevent slowdown
  const BATCH_SIZE = 200
  let previousItemCount = 0
  let noNewItemsCount = 0
  const maxScrolls = 500

  // Timing diagnostics
  let lastLogTime = Date.now()
  let itemTimes: number[] = []
  let batchStartCount = 0

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    // Get current item count
    const currentItemCount = await page.evaluate(
      (sel) => document.querySelectorAll(sel).length,
      itemSelector
    )

    // Process new items (from previousItemCount to currentItemCount)
    let shouldBreak = false
    let needsRefresh = false

    for (let i = previousItemCount; i < currentItemCount; i++) {
      const itemStart = Date.now()
      const tx = await scrapeActivityItem(page, itemSelector, i, existingIds)

      if (tx) {
        totalScraped++
        const isNew = addToArchive(archive, tx)
        if (isNew) {
          newCount++
          existingIds.add(tx.id)
          consecutiveExisting = 0
        } else {
          consecutiveExisting++
          if (!fullSync && consecutiveExisting >= MAX_CONSECUTIVE_EXISTING) {
            log.debug(`[Robinhood] Early exit: ${consecutiveExisting} consecutive existing transactions, stopping scrape`)
            shouldBreak = true
            break
          }
        }
        onProgress(totalScraped, currentItemCount, tx)

        // Track timing
        itemTimes.push(Date.now() - itemStart)

        // Save and log every 100 items
        if (totalScraped % 100 === 0) {
          await saveArchive(archive)
          const avg = itemTimes.reduce((a, b) => a + b, 0) / itemTimes.length
          const max = Math.max(...itemTimes)
          const elapsed = Date.now() - lastLogTime
          log.debug(`[Robinhood] Items ${totalScraped - 99}-${totalScraped}: avg=${avg.toFixed(0)}ms, max=${max}ms, total=${elapsed}ms, new=${newCount}`)
          itemTimes = []
          lastLogTime = Date.now()
        }

        // Check if we need to refresh page to reset browser state
        if (totalScraped - batchStartCount >= BATCH_SIZE) {
          needsRefresh = true
          break
        }
      }
    }

    if (shouldBreak) break

    // Remove processed items from DOM in bulk to reset browser state
    // This is faster than page refresh and doesn't require scrolling to reload
    if (needsRefresh) {
      log.debug(`[Robinhood] Removing ${previousItemCount} processed items from DOM to reset browser state...`)
      await saveArchive(archive)

      // Remove first N items (the ones we just processed) in a single bulk operation
      const removed = await page.evaluate(
        ([count, sel]) => {
          const items = document.querySelectorAll(sel)
          let removedCount = 0
          // Remove items from the beginning (oldest processed items)
          for (let i = 0; i < count && i < items.length; i++) {
            const item = items[i]
            if (item) {
              item.remove()
              removedCount++
            }
          }
          return removedCount
        },
        [previousItemCount, itemSelector] as [number, string]
      )

      log.debug(`[Robinhood] Removed ${removed} items, DOM now has ${await page.evaluate((sel) => document.querySelectorAll(sel).length, itemSelector)} items`)

      // Wait a moment for React to stabilize after bulk removal
      await page.waitForTimeout(500)

      // Reset counters - we now start from index 0 since we removed processed items
      previousItemCount = 0
      batchStartCount = totalScraped
      noNewItemsCount = 0
      continue
    }

    previousItemCount = currentItemCount

    // Scroll to load more
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })

    // Wait for new items to load
    const gotNewItems = await page.waitForFunction(
      ([prevCount, sel]) => document.querySelectorAll(sel).length > prevCount,
      [currentItemCount, itemSelector] as [number, string],
      { timeout: 3000 }
    ).then(() => true).catch(() => false)

    if (!gotNewItems) {
      noNewItemsCount++
      if (noNewItemsCount >= 2) {
        log.debug(`[Robinhood] No more items after ${noNewItemsCount} scroll attempts`)
        break
      }
    } else {
      noNewItemsCount = 0
    }

    // Safety limit
    if (totalScraped > 10000) break
  }

  // Final save
  await saveArchive(archive)

  return { newCount, totalScraped }
}

/**
 * Get the Chrome executable path based on platform.
 */
const getChromePath = (): string => {
  const os = platform()
  if (os === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  } else if (os === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  } else {
    // Linux - try common paths
    return 'google-chrome'
  }
}

// Platform-specific login URLs
const PLATFORM_LOGIN_URLS: Record<string, string> = {
  robinhood: 'https://robinhood.com/login',
  m1: 'https://dashboard.m1.com',
  'm1-cash': 'https://dashboard.m1.com',
  coinbase: 'https://www.coinbase.com/signin',
  _default: 'about:blank'
}

const getPlatformLoginUrl = (platform?: string): string => {
  if (!platform) return PLATFORM_LOGIN_URLS._default!
  const normalized = platform.toLowerCase()
  return PLATFORM_LOGIN_URLS[normalized] ?? PLATFORM_LOGIN_URLS._default!
}

const getPlatformName = (platform?: string): string => {
  if (!platform) return 'the website'
  const normalized = platform.toLowerCase().replace(/-cash$/, '')
  const names: Record<string, string> = {
    robinhood: 'Robinhood',
    m1: 'M1 Finance',
    coinbase: 'Coinbase'
  }
  return names[normalized] ?? platform
}

/**
 * POST /import/browser/launch
 * Launch Chrome with remote debugging enabled.
 * Body: { platform?: string } - Platform to navigate to (robinhood, m1, etc.)
 */
importRouter.post('/browser/launch', async (req, res, next) => {
  const { platform } = req.body as { platform?: string }
  const loginUrl = getPlatformLoginUrl(platform)
  const platformName = getPlatformName(platform)

  // Check if browser is already launched or connected
  if (connectedBrowser?.isConnected()) {
    return res.json({
      success: true,
      message: 'Browser already connected',
      alreadyRunning: true
    })
  }

  if (launchedChromeProcess && !launchedChromeProcess.killed) {
    return res.json({
      success: true,
      message: 'Chrome already running',
      alreadyRunning: true
    })
  }

  const chromePath = getChromePath()

  // Launch Chrome with remote debugging on dedicated port with persistent profile
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${BROWSER_USER_DATA_DIR}`,
    loginUrl
  ]

  launchedChromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore'
  })

  launchedChromeProcess.unref()

  // Give Chrome a moment to start
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Check if process is still running
  if (launchedChromeProcess.killed) {
    launchedChromeProcess = null
    return next(badRequest('Failed to launch Chrome. Make sure Chrome is installed.'))
  }

  res.json({
    success: true,
    message: `Chrome launched. Please log into ${platformName}.`,
    alreadyRunning: false
  })
})

/**
 * POST /import/browser/kill
 * Kill the launched Chrome browser.
 */
importRouter.post('/browser/kill', async (_req, res) => {
  // Disconnect from browser first
  if (connectedBrowser?.isConnected()) {
    await connectedBrowser.close().catch(() => {})
    connectedBrowser = null
  }

  // Kill the Chrome process
  if (launchedChromeProcess && !launchedChromeProcess.killed) {
    launchedChromeProcess.kill('SIGTERM')
    launchedChromeProcess = null
  }

  res.json({
    success: true,
    message: 'Browser closed'
  })
})

/**
 * POST /import/browser/connect
 * Connect to browser via CDP.
 */
importRouter.post('/browser/connect', async (req, res, next) => {
  const { cdpUrl = DEFAULT_CDP_URL } = req.body as { cdpUrl?: string }

  const browser = await connectToBrowser(cdpUrl).catch((err: Error) => {
    return next(badRequest(`Failed to connect to browser: ${err.message}. Start Chrome with: chrome --remote-debugging-port=${CDP_PORT}`))
  })

  if (!browser) return

  res.json({
    success: true,
    message: 'Connected to browser',
    pages: (await browser.contexts()[0]?.pages())?.length ?? 0
  })
})

/**
 * GET /import/browser/status
 * Check if CDP browser is running and get login status for platforms.
 */
importRouter.get('/browser/status', async (req, res) => {
  const { platform } = req.query as { platform?: string }

  // Check if browser is running by trying to connect
  const browser = await connectToBrowser().catch(() => null)

  if (!browser) {
    res.json({
      connected: false,
      message: 'Browser not running. Start with: pm2 start escapemint-browser'
    })
    return
  }

  // Browser is connected, check for platform-specific login status
  const contexts = browser.contexts()
  const pages: Array<{ url: string; title: string }> = []

  for (const context of contexts) {
    for (const page of context.pages()) {
      pages.push({ url: page.url(), title: await page.title().catch(() => '') })
    }
  }

  // Check login status for specific platform
  let loggedIn = false
  let loginUrl = ''
  let pageFound = false

  if (platform === 'm1') {
    const m1Page = pages.find(p => p.url.includes('m1.com'))
    pageFound = !!m1Page
    loggedIn = !!m1Page && m1Page.url.includes('dashboard.m1.com') && !m1Page.url.includes('/login')
    loginUrl = 'https://dashboard.m1.com'
  } else if (platform === 'robinhood') {
    const rhPage = pages.find(p => p.url.includes('robinhood.com'))
    pageFound = !!rhPage
    loggedIn = !!rhPage && !rhPage.url.includes('/login')
    loginUrl = 'https://robinhood.com'
  }

  res.json({
    connected: true,
    pageCount: pages.length,
    pages,
    platform: platform ?? null,
    pageFound,
    loggedIn,
    loginUrl
  })
})

/**
 * POST /import/browser/navigate
 * Navigate to a URL in the browser and wait for login if needed.
 */
importRouter.post('/browser/navigate', async (req, res) => {
  const { url, platform } = req.body as { url: string; platform?: string }

  const browser = await connectToBrowser().catch(() => null)
  if (!browser) {
    res.status(400).json({ error: 'Browser not running' })
    return
  }

  // Find or create a page for this platform
  let page = null
  const contexts = browser.contexts()

  for (const context of contexts) {
    for (const p of context.pages()) {
      const pageUrl = p.url()
      if (platform === 'm1' && pageUrl.includes('m1.com')) {
        page = p
        break
      } else if (platform === 'robinhood' && pageUrl.includes('robinhood.com')) {
        page = p
        break
      }
    }
    if (page) break
  }

  // If no existing page, create one
  if (!page && contexts.length > 0) {
    page = await contexts[0]!.newPage()
  }

  if (!page) {
    res.status(400).json({ error: 'Could not create page' })
    return
  }

  // Navigate to URL
  await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => null)
  await page.waitForTimeout(2000)

  const currentUrl = page.url()
  const isLoggedIn = platform === 'm1'
    ? currentUrl.includes('dashboard.m1.com') && !currentUrl.includes('/login')
    : !currentUrl.includes('/login')

  res.json({
    success: true,
    currentUrl,
    isLoggedIn
  })
})

/**
 * GET /import/archive/:platform
 * Get the existing scrape archive for a platform with full summary.
 */
importRouter.get('/archive/:platform', async (req, res) => {
  const { platform } = req.params
  const { full } = req.query as { full?: string }
  const archive = await loadArchive(platform)

  // Build comprehensive summary
  const byType: Record<string, number> = {}
  const bySymbol: Record<string, { count: number; types: string[]; totalAmount: number }> = {}
  const byYear: Record<string, number> = {}
  let totalAmount = 0
  let unknownCount = 0
  let oldestDate = ''
  let newestDate = ''

  // Track cash transactions separately (deposit, withdrawal, interest without symbol)
  const cashTypes = ['deposit', 'withdrawal', 'interest']

  for (const tx of archive.transactions) {
    // By type
    byType[tx.type] = (byType[tx.type] ?? 0) + 1
    if (tx.type === 'other') unknownCount++

    // By symbol - or CASH for cash transactions without symbol
    const effectiveSymbol = tx.symbol || (cashTypes.includes(tx.type) ? 'CASH' : null)
    if (effectiveSymbol) {
      if (!bySymbol[effectiveSymbol]) {
        bySymbol[effectiveSymbol] = { count: 0, types: [], totalAmount: 0 }
      }
      bySymbol[effectiveSymbol]!.count++
      if (!bySymbol[effectiveSymbol]!.types.includes(tx.type)) {
        bySymbol[effectiveSymbol]!.types.push(tx.type)
      }
      bySymbol[effectiveSymbol]!.totalAmount += tx.amount
    }

    // By year
    const year = tx.date.slice(0, 4)
    byYear[year] = (byYear[year] ?? 0) + 1

    // Total amount
    totalAmount += tx.amount

    // Date range
    if (!oldestDate || tx.date < oldestDate) oldestDate = tx.date
    if (!newestDate || tx.date > newestDate) newestDate = tx.date
  }

  // Load existing funds to show which symbols are tracked
  const funds = await readAllFunds(FUNDS_DIR).catch(() => [])

  // Add fundId to bySymbol
  const bySymbolWithFunds: Record<string, {
    count: number
    types: string[]
    totalAmount: number
    fundId: string
    fundExists: boolean
    ticker?: string
  }> = {}

  for (const [symbol, data] of Object.entries(bySymbol)) {
    const fundId = buildFundId(platform, symbol)
    const fund = funds.find(f => f.id === fundId)
    bySymbolWithFunds[symbol] = {
      ...data,
      fundId,
      fundExists: !!fund
    }
    if (fund?.ticker) {
      bySymbolWithFunds[symbol]!.ticker = fund.ticker
    }
  }

  // For m1-cash platform, add special handling to show that cash transactions
  // can be imported to the m1-cash fund (they don't have symbols)
  let cashFundExists = false
  let cashTransactionCount = 0
  if (platform === 'm1-cash') {
    cashFundExists = funds.some(f => f.id === 'm1-cash')
    // Count cash-related transactions (interest, deposit, withdrawal)
    cashTransactionCount = archive.transactions.filter(tx =>
      ['interest', 'deposit', 'withdrawal'].includes(tx.type)
    ).length
  }

  res.json({
    platform: archive.platform,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    transactionCount: archive.transactions.length,
    summary: {
      totalAmount,
      unknownCount,
      dateRange: { oldest: oldestDate, newest: newestDate },
      byType,
      bySymbol: bySymbolWithFunds,
      byYear,
      // M1 cash-specific: indicate cash fund exists and count of importable transactions
      ...(platform === 'm1-cash' && {
        cashFundId: 'm1-cash',
        cashFundExists,
        cashTransactionCount
      })
    },
    // Return all transactions if full=true, otherwise first 50
    transactions: full === 'true' ? archive.transactions : archive.transactions.slice(0, 50)
  })
})

/**
 * POST /import/archive/:platform/reclassify
 * Re-classify existing transactions using the updated type detection.
 * This is useful when type detection is improved after initial scrape.
 */
importRouter.post('/archive/:platform/reclassify', async (req, res) => {
  const { platform } = req.params
  const archive = await loadArchive(platform)

  let reclassified = 0
  const changes: Array<{ id: string; oldType: string; newType: string; title: string }> = []

  for (const tx of archive.transactions) {
    const newType = determineTransactionType(tx.title)
    if (newType !== tx.type && newType !== 'other') {
      changes.push({
        id: tx.id,
        oldType: tx.type,
        newType,
        title: tx.title
      })
      tx.type = newType
      reclassified++
    }
  }

  if (reclassified > 0) {
    await saveArchive(archive)
  }

  res.json({
    platform,
    total: archive.transactions.length,
    reclassified,
    changes: changes.slice(0, 50)  // Show first 50 changes
  })
})

/**
 * GET /import/robinhood/scrape-stream
 * SSE endpoint for scraping with real-time progress updates.
 * Query params:
 *   - url: Robinhood history page URL (required)
 *   - platform: Platform name for archive (default: 'robinhood')
 *   - full: When 'true', performs full sync without early exit (for complete resync)
 */
importRouter.get('/robinhood/scrape-stream', async (req, res) => {
  const { url, platform = 'robinhood', full } = req.query as { url?: string; platform?: string; full?: string }
  const fullSync = full === 'true'

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  if (!url) {
    sendEvent('error', { message: 'url is required' })
    res.end()
    return
  }

  // Validate URL
  const isValidUrl = url.includes('robinhood.com') && (
    url.includes('history') || url.includes('/account/')
  )
  if (!isValidUrl) {
    sendEvent('error', { message: 'URL must be a Robinhood history page' })
    res.end()
    return
  }

  // Connect to browser
  const browser = await connectToBrowser().catch((err: Error) => {
    sendEvent('error', { message: `Failed to connect: ${err.message}` })
    return null
  })

  if (!browser) {
    res.end()
    return
  }

  sendEvent('status', { message: 'Looking for Robinhood page...', phase: 'navigating' })

  // First, try to find an existing Robinhood page
  let page = await findRobinhoodPage(browser)
  let pageCreated = false

  if (page) {
    log.debug(`[Import] Using existing Robinhood page: ${page.url()}`)
    sendEvent('status', { message: 'Found logged-in Robinhood page', phase: 'navigating' })
  } else {
    // No Robinhood page found - try to find ANY page we can use
    log.debug('[Import] No Robinhood page found, looking for any usable page...')
    sendEvent('status', { message: 'Looking for browser page...', phase: 'navigating' })

    // Find any existing page to reuse (avoid creating new pages which can hang)
    const contexts = browser.contexts()
    for (const context of contexts) {
      const pages = context.pages()
      for (const existingPage of pages) {
        const pageUrl = existingPage.url()
        // Use any non-extension page
        if (!pageUrl.startsWith('chrome-extension://') && !pageUrl.startsWith('blob:')) {
          log.debug(`[Import] Found usable page: ${pageUrl}`)
          page = existingPage
          break
        }
      }
      if (page) break
    }

    if (!page) {
      // Last resort: try to create a new page
      log.debug('[Import] No usable page found, attempting to create new one...')
      sendEvent('status', { message: 'Creating new browser tab...', phase: 'navigating' })

      page = await createNewPage(browser).catch((err: Error) => {
        log.debug(`[Import] Failed to create new page: ${err.message}`)
        sendEvent('error', { message: `Failed to create browser tab: ${err.message}. Please open a tab manually and try again.` })
        return null
      }) as Page | null

      if (!page) {
        res.end()
        return
      }
      pageCreated = true
    }

    log.debug(`[Robinhood] Using page: ${page.url()}`)
  }

  // Bring page to front
  log.debug('[Robinhood] Bringing page to front...')
  await page.bringToFront()
  log.debug('[Robinhood] Page brought to front')

  // Navigate to history page
  const currentUrl = page.url()
  log.debug(`[Robinhood] Current page URL: ${currentUrl}`)
  log.debug(`[Robinhood] Target URL: ${url}`)

  // Always navigate to the target URL if not already there
  if (!currentUrl.includes('history')) {
    sendEvent('status', { message: `Navigating to history page...`, phase: 'navigating' })

    log.debug(`[Robinhood] Navigating to: ${url}`)

    // Navigate directly to history URL - use domcontentloaded for speed
    const navResult = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch((err: Error) => err)

    if (navResult instanceof Error) {
      log.debug(`[Robinhood] Navigation error: ${navResult.message}`)
      sendEvent('error', { message: `Navigation failed: ${navResult.message}` })
      if (pageCreated) await page.close().catch(() => {})
      res.end()
      return
    }

    // Short wait for any redirects
    await page.waitForTimeout(2000)

    // Check URL immediately
    let newUrl = page.url()
    log.debug(`[Robinhood] After navigation, URL is: ${newUrl}`)

    // Check if redirected to login
    if (newUrl.includes('/login')) {
      log.debug('[Robinhood] Redirected to login - user needs to log in manually')
      sendEvent('error', {
        message: 'Please log in to Robinhood in your browser first, then navigate to the history page and try again.'
      })
      res.end()
      return
    }

    // If we got redirected away from history, try UI navigation
    if (!newUrl.includes('history') && !newUrl.includes('/account/')) {
      log.debug(`[Robinhood] Redirected to: ${newUrl}, trying UI navigation`)
      sendEvent('status', { message: `Navigating via UI...`, phase: 'navigating' })

      // Try clicking through the UI instead
      const navSuccess = await navigateRobinhoodViaUI(page)
      if (!navSuccess) {
        const finalUrl = page.url()
        sendEvent('error', {
          message: `Cannot navigate to history page. Ended up at: ${finalUrl}. Please log in to Robinhood and manually navigate to Account > History, then try again.`
        })
        res.end()
        return
      }
      newUrl = page.url()
      log.debug(`[Robinhood] After UI navigation, URL is: ${newUrl}`)
    }

    // Now wait for history items to load
    log.debug('[Robinhood] Waiting for history items to load...')
    sendEvent('status', { message: `Loading history...`, phase: 'loading' })
    await page.waitForSelector('[data-testid="activity-item"], [data-testid="UnifiedTransferActivityItem"]', {
      timeout: 15000
    }).catch(() => null)
  }

  // Verify we're on the history page and logged in
  const loginForm = await page.$('input[name="username"], input[type="email"], [data-testid="login"]')
  if (loginForm || page.url().includes('/login')) {
    log.debug(`[Import] Login form detected. Current URL: ${page.url()}`)
    sendEvent('error', {
      message: 'Please log in to Robinhood in the browser tab that just opened, then try again.'
    })
    // Don't close - let user log in
    res.end()
    return
  }

  sendEvent('status', { message: 'Loading archive...', phase: 'loading' })

  // Load existing archive
  const archive = await loadArchive(platform)
  const existingCount = archive.transactions.length

  sendEvent('status', {
    message: fullSync
      ? `Full sync mode: Found ${existingCount} existing transactions. Scraping ALL history...`
      : existingCount > 0
        ? `Found ${existingCount} existing transactions. Scraping for new data...`
        : 'Starting fresh scrape...',
    phase: 'scraping',
    existingCount,
    fullSync
  })

  // Scrape with progress updates
  const result = await scrapeRobinhoodHistoryWithProgress(
    page,
    archive,
    (current, total, tx) => {
      sendEvent('progress', {
        current,
        total,
        newCount: archive.transactions.length - existingCount,
        lastTransaction: tx ? {
          date: tx.date,
          type: tx.type,
          symbol: tx.symbol,
          amount: tx.amount,
          title: tx.title.substring(0, 50)
        } : null
      })
    },
    fullSync
  ).catch((err: Error) => {
    sendEvent('error', { message: `Scraping error: ${err.message}` })
    return null
  })

  // Only close the page if we created it
  if (pageCreated) await page.close().catch(() => {})

  if (result) {
    sendEvent('complete', {
      totalScraped: result.totalScraped,
      newCount: result.newCount,
      archiveTotal: archive.transactions.length,
      message: result.newCount > 0
        ? `Scraped ${result.totalScraped} transactions, ${result.newCount} new`
        : `Scraped ${result.totalScraped} transactions, all already in archive`
    })
  }

  res.end()
})

/**
 * POST /import/robinhood/scrape
 * Scrape transaction history from a Robinhood URL.
 * Returns immediately with scraped data (non-streaming version for backward compatibility).
 * Body params:
 *   - url: Robinhood history page URL (required)
 *   - platform: Platform name for archive (default: 'robinhood')
 *   - cdpUrl: Chrome DevTools Protocol URL
 *   - full: When true, performs full sync without early exit (for complete resync)
 */
importRouter.post('/robinhood/scrape', async (req, res, next) => {
  const { url, platform = 'robinhood', cdpUrl = DEFAULT_CDP_URL, full = false } = req.body as {
    url?: string
    platform?: string
    cdpUrl?: string
    full?: boolean
  }
  const fullSync = full === true

  if (!url) {
    return next(badRequest('url is required'))
  }

  // Validate URL is a Robinhood history or account page
  const isValidUrl = url.includes('robinhood.com') && (
    url.includes('history') || url.includes('/account/')
  )
  if (!isValidUrl) {
    return next(validationError('URL must be a Robinhood history page'))
  }

  // Connect to browser
  const connectResult = await connectToBrowser(cdpUrl).catch((err: Error) => err)
  if (connectResult instanceof Error) {
    return next(badRequest(`Failed to connect to browser: ${connectResult.message}`))
  }
  const browser: Browser = connectResult

  // First, try to find an existing Robinhood page
  let page: Page | null = await findRobinhoodPage(browser)
  let pageCreated = false

  if (!page) {
    // No existing page - create new one
    const newPageResult = await createNewPage(browser).catch((err: Error) => err)
    if (newPageResult instanceof Error) {
      return next(badRequest(newPageResult.message))
    }
    page = newPageResult
    pageCreated = true
  }

  // Navigate to the URL if needed
  if (!page.url().includes('history')) {
    const navResult = await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      if (pageCreated) await page.close().catch(() => {})
      return next(badRequest(`Navigation failed: ${navResult.message}`))
    }
    await page.waitForTimeout(2000)
  }

  // Check login
  const loginForm = await page.$('input[name="username"], input[type="email"], [data-testid="login"]')
  if (loginForm || page.url().includes('/login')) {
    return next(badRequest('Please log in to Robinhood in your browser first, then navigate to the history page and try again.'))
  }

  // Load existing archive
  const archive = await loadArchive(platform)
  const existingCount = archive.transactions.length

  // Scrape with progress (no-op callback for non-streaming)
  const result = await scrapeRobinhoodHistoryWithProgress(
    page,
    archive,
    () => {}, // No progress callback for non-streaming
    fullSync
  ).catch((err: Error) => {
    return { error: err.message }
  })

  // Only close the page if we created it
  if (pageCreated) await page.close().catch(() => {})

  if ('error' in result) {
    return next(badRequest(`Scraping failed: ${result.error}`))
  }

  // Convert scraped transactions to preview format
  const funds = await readAllFunds(FUNDS_DIR).catch(() => [])

  const transactions: ParsedTransaction[] = archive.transactions.map(tx => {
    // For cash transactions (interest, deposit, withdrawal) without a symbol,
    // route to the platform's cash fund (e.g., robinhood-cash, m1-cash)
    const isCashTransaction = !tx.symbol && ['interest', 'deposit', 'withdrawal'].includes(tx.type)
    const cashFundId = `${platform.toLowerCase().replace(/-cash$/, '')}-cash`

    const fundId = isCashTransaction
      ? cashFundId
      : (tx.symbol ? buildFundId(platform, tx.symbol) : null)
    const exists = fundId ? fundExists(fundId, funds) : false

    const actionMap: Record<ScrapedTransaction['type'], ParsedTransaction['action']> = {
      'buy': 'BUY',
      'sell': 'SELL',
      'dividend': 'DIVIDEND',
      'interest': 'INTEREST',
      'deposit': 'DEPOSIT',
      'withdrawal': 'WITHDRAW',
      'stock_lending': 'STOCK_LENDING',
      'fee': 'FEE',
      'transfer': 'TRANSFER',
      'split': 'SPLIT',
      'merger': 'MERGER',
      'option': 'OPTION',
      'crypto': 'CRYPTO',
      'reinvest': 'REINVEST',
      'adjustment': 'ADJUSTMENT',
      'other': 'OTHER'
    }

    return {
      date: tx.date,
      action: actionMap[tx.type] ?? 'OTHER',
      symbol: tx.symbol || (isCashTransaction ? 'CASH' : ''),
      quantity: tx.shares ?? 0,
      price: tx.pricePerShare ?? 0,
      amount: tx.amount,
      description: tx.title,
      fundId,
      fundExists: exists,
      rawDetails: tx.details  // Preserve all raw details for later processing
    }
  })

  // Build summary
  const bySymbol: Record<string, { count: number; fundId: string | null; fundExists: boolean }> = {}
  for (const tx of transactions) {
    if (tx.symbol) {
      if (!bySymbol[tx.symbol]) {
        bySymbol[tx.symbol] = { count: 0, fundId: tx.fundId, fundExists: tx.fundExists }
      }
      bySymbol[tx.symbol]!.count++
    }
  }

  const matched = transactions.filter(t => t.fundExists).length
  const unmatched = transactions.filter(t => t.fundId && !t.fundExists).length

  res.json({
    transactions,
    summary: {
      total: transactions.length,
      matched,
      unmatched,
      bySymbol,
      newCount: result.newCount,
      existingCount,
      archiveUpdated: new Date().toISOString()
    }
  })
})

/**
 * POST /import/browser/disconnect
 * Disconnect from browser.
 */
importRouter.post('/browser/disconnect', async (_req, res) => {
  if (connectedBrowser) {
    await connectedBrowser.close().catch(() => {})
    connectedBrowser = null
  }
  res.json({ success: true, message: 'Disconnected from browser' })
})

// ============================================================================
// Crypto Statement PDF Parsing
// ============================================================================

/**
 * Parse a Robinhood crypto statement PDF and extract transactions.
 */
const parseCryptoStatementPDF = async (pdfBuffer: Buffer, filename: string): Promise<CryptoStatementData> => {
  const parser = new PDFParse({ data: pdfBuffer })
  const result = await parser.getText()
  const text = result.text
  await parser.destroy()

  // Extract period dates
  const periodStartMatch = text.match(/PERIOD START\s+(\d{4}-\d{2}-\d{2})/)
  const periodEndMatch = text.match(/PERIOD END\s+(\d{4}-\d{2}-\d{2})/)
  const openingMatch = text.match(/OPENING BALANCE\s+\$?([\d,.]+)/)
  const closingMatch = text.match(/CLOSING BALANCE\s+\$?([\d,.]+)/)

  const periodStart = periodStartMatch?.[1] ?? ''
  const periodEnd = periodEndMatch?.[1] ?? ''
  const openingBalance = parseFloat(openingMatch?.[1]?.replace(/,/g, '') ?? '0')
  const closingBalance = parseFloat(closingMatch?.[1]?.replace(/,/g, '') ?? '0')

  // Extract holdings from the holdings table
  const holdings: CryptoHolding[] = []
  // Pattern for holdings: Name, Quantity, Symbol, Market Value, % of Portfolio
  // E.g., "Bitcoin 1.64494099 BTC $31910.36 45.98%"
  const holdingsPattern = /([A-Za-z][A-Za-z\s]*?)\s+([\d.]+)\s+([A-Z]{2,10})\s+\$([\d,.]+)\s+([\d.]+)%/g
  let holdingMatch
  while ((holdingMatch = holdingsPattern.exec(text)) !== null) {
    const [, name, qty, symbol, value, pct] = holdingMatch
    if (!name || !qty || !symbol || !value || !pct) continue
    // Skip if it looks like a transaction row or header text
    if (name.includes('Crypto') || name.includes('2022') || name.includes('2023') || name.includes('PORTFOLIO')) continue
    // Clean up name by removing any newline artifacts
    const cleanName = name.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    holdings.push({
      name: cleanName,
      symbol,
      quantity: parseFloat(qty),
      marketValue: parseFloat(value.replace(/,/g, '')),
      portfolioPercent: parseFloat(pct)
    })
  }

  // Extract transactions from ACCOUNT ACTIVITY section
  const transactions: CryptoTransaction[] = []

  // Pattern for transactions:
  // DATE, TRANSACTION TYPE, DEBIT (for sales), CREDIT (for purchases), PRICE, VALUE
  // Buy: "2022-09-01 Crypto purchase -- 0.00497181 BTC $20110.73992718 $99.99"
  // Sell: "2022-09-02 Crypto sale 2222.22 ADA -- $0.45603963 $1013.42"

  // Split text into lines and look for transaction patterns
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i]
    if (!currentLine) continue
    const line = currentLine.trim()

    // Look for date pattern at start of line
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) continue

    // Try to parse as a transaction line
    // Purchase: date + "Crypto purchase" + "--" + quantity + symbol + price + value
    // Sale: date + "Crypto sale" + quantity + symbol + "--" + price + value

    // Join with next line if it appears to continue (some PDFs split lines)
    let fullLine = line
    const nextLine = lines[i + 1]
    if (nextLine && !nextLine.match(/^\d{4}-\d{2}-\d{2}/)) {
      fullLine += ' ' + nextLine.trim()
    }

    // Purchase pattern: date Crypto Purchase -- QUANTITY SYMBOL $PRICE $VALUE [--]
    // Case-insensitive, handles tabs and optional fee column
    const purchaseMatch = fullLine.match(/(\d{4}-\d{2}-\d{2})[\s\t]+Crypto [Pp]urchase[\s\t]+--[\s\t]+([\d.]+)[\s\t]+([A-Z]{2,10})[\s\t]+\$([\d,.]+)[\s\t]+\$([\d,.]+)/i)
    if (purchaseMatch) {
      const [, pDate, pQty, pSymbol, pPrice, pValue] = purchaseMatch
      if (pDate && pQty && pSymbol && pPrice && pValue) {
        transactions.push({
          date: pDate,
          type: 'buy',
          quantity: parseFloat(pQty),
          symbol: pSymbol,
          price: parseFloat(pPrice.replace(/,/g, '')),
          value: parseFloat(pValue.replace(/,/g, '')),
          rawText: fullLine
        })
        continue
      }
    }

    // Sale pattern: date Crypto Sale QUANTITY SYMBOL -- $PRICE $VALUE [--]
    // Case-insensitive, handles tabs and optional fee column
    const saleMatch = fullLine.match(/(\d{4}-\d{2}-\d{2})[\s\t]+Crypto [Ss]ale[\s\t]+([\d.]+)[\s\t]+([A-Z]{2,10})[\s\t]+--[\s\t]+\$([\d,.]+)[\s\t]+\$([\d,.]+)/i)
    if (saleMatch) {
      const [, sDate, sQty, sSymbol, sPrice, sValue] = saleMatch
      if (sDate && sQty && sSymbol && sPrice && sValue) {
        transactions.push({
          date: sDate,
          type: 'sell',
          quantity: parseFloat(sQty),
          symbol: sSymbol,
          price: parseFloat(sPrice.replace(/,/g, '')),
          value: parseFloat(sValue.replace(/,/g, '')),
          rawText: fullLine
        })
        continue
      }
    }

    // Transfer/deposit/withdrawal patterns
    const transferMatch = fullLine.match(/(\d{4}-\d{2}-\d{2})\s+(Crypto transfer|Deposit|Withdrawal)\s+([\d.]+)\s+([A-Z]{2,10})\s+/)
    if (transferMatch) {
      const [, tDate, , tQty, tSymbol] = transferMatch
      if (tDate && tQty && tSymbol) {
        transactions.push({
          date: tDate,
          type: 'transfer',
          quantity: parseFloat(tQty),
          symbol: tSymbol,
          price: 0,
          value: 0,
          rawText: fullLine
        })
        continue
      }
    }

    // Staking/interest patterns
    const stakingMatch = fullLine.match(/(\d{4}-\d{2}-\d{2})\s+(Staking|Interest|Reward)\s+([\d.]+)\s+([A-Z]{2,10})\s+/)
    if (stakingMatch) {
      const [, stDate, stType, stQty, stSymbol] = stakingMatch
      if (stDate && stType && stQty && stSymbol) {
        transactions.push({
          date: stDate,
          type: stType.toLowerCase().includes('staking') ? 'staking' : 'interest',
          quantity: parseFloat(stQty),
          symbol: stSymbol,
          price: 0,
          value: 0,
          rawText: fullLine
        })
      }
    }
  }

  // Sort transactions by date
  transactions.sort((a, b) => a.date.localeCompare(b.date))

  return {
    filename,
    periodStart,
    periodEnd,
    openingBalance,
    closingBalance,
    holdings,
    transactions
  }
}

/**
 * GET /import/crypto/statements
 * Scrape the Robinhood crypto statements page to get list of available PDFs.
 */
importRouter.get('/crypto/statements', async (_req, res, next) => {
  const browser = await connectToBrowser().catch((err: Error) => {
    return next(badRequest(`Failed to connect to browser: ${err.message}`))
  })
  if (!browser) return

  // Find Robinhood page
  const page = await findRobinhoodPage(browser)
  if (!page) {
    return next(badRequest('No Robinhood page found. Please log in first.'))
  }

  // Navigate to crypto statements page
  const statementsUrl = 'https://robinhood.com/account/reports-statements/crypto'
  if (!page.url().includes('reports-statements/crypto')) {
    const navResult = await page.goto(statementsUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      return next(badRequest(`Navigation failed: ${navResult.message}`))
    }
    await page.waitForTimeout(2000)
  }

  // Check if we need to click "View More" to load all statements
  let hasMore = true
  while (hasMore) {
    const viewMoreBtn = await page.$('a:has-text("View More")')
    if (viewMoreBtn) {
      await viewMoreBtn.click({ force: true })
      await page.waitForTimeout(1000)
    } else {
      hasMore = false
    }
  }

  // Get list of existing downloaded files
  await mkdir(CRYPTO_STATEMENTS_DIR, { recursive: true })
  const existingFiles: string[] = await readdir(CRYPTO_STATEMENTS_DIR).catch(() => [] as string[])

  // Extract statement links
  const statementsRaw = await page.evaluate(() => {
    const links = document.querySelectorAll('a[download*="Robinhood Crypto Account Statement"]')
    return Array.from(links).map(link => {
      const downloadAttr = link.getAttribute('download') ?? ''
      // Extract month/year from download attribute like "November 2025 – Robinhood Crypto Account Statement"
      const monthYearMatch = downloadAttr.match(/^([A-Za-z]+\s+\d{4})/)
      return {
        monthYear: monthYearMatch?.[1] ?? downloadAttr,
        downloadUrl: link.getAttribute('href') ?? ''
      }
    })
  })

  // Convert to CryptoStatementInfo with new filename format
  const statements: CryptoStatementInfo[] = statementsRaw.map(s => ({
    filename: monthYearToStatementFilename(s.monthYear),
    monthYear: s.monthYear,
    downloadUrl: s.downloadUrl,
    downloaded: false
  }))

  // Mark which ones are already downloaded
  for (const stmt of statements) {
    stmt.downloaded = existingFiles.includes(stmt.filename)
  }

  res.json({
    count: statements.length,
    statements,
    downloadDir: CRYPTO_STATEMENTS_DIR
  })
})

/**
 * POST /import/crypto/download-statements
 * Download crypto statement PDFs from Robinhood.
 * Uses SSE to stream progress.
 */
importRouter.get('/crypto/download-stream', async (req, res) => {
  const { all } = req.query as { all?: string }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // Connect to browser
  const browser = await connectToBrowser().catch((err: Error) => {
    sendEvent('error', { message: `Failed to connect: ${err.message}` })
    return null
  })

  if (!browser) {
    res.end()
    return
  }

  // Find Robinhood page
  const page = await findRobinhoodPage(browser)
  if (!page) {
    sendEvent('error', { message: 'No Robinhood page found. Please log in first.' })
    res.end()
    return
  }

  sendEvent('status', { message: 'Navigating to statements page...', phase: 'navigating' })

  // Navigate to crypto statements page
  const statementsUrl = 'https://robinhood.com/account/reports-statements/crypto'
  if (!page.url().includes('reports-statements/crypto')) {
    const navResult = await page.goto(statementsUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      sendEvent('error', { message: `Navigation failed: ${navResult.message}` })
      res.end()
      return
    }
    await page.waitForTimeout(2000)
  }

  sendEvent('status', { message: 'Loading all statements...', phase: 'loading' })

  // Click "View More" to load all statements
  let hasMore = true
  let loadCount = 0
  while (hasMore && loadCount < 50) {
    const viewMoreBtn = await page.$('a:has-text("View More")')
    if (viewMoreBtn) {
      await viewMoreBtn.click({ force: true })
      await page.waitForTimeout(1000)
      loadCount++
      sendEvent('status', { message: `Loading statements... (${loadCount} clicks)`, phase: 'loading' })
    } else {
      hasMore = false
    }
  }

  // Get list of existing downloaded files
  await mkdir(CRYPTO_STATEMENTS_DIR, { recursive: true })
  const existingFiles: string[] = await readdir(CRYPTO_STATEMENTS_DIR).catch(() => [] as string[])

  // Get all statement download links
  const statementLinks = await page.$$('a[download*="Robinhood Crypto Account Statement"]')
  const total = statementLinks.length

  sendEvent('status', { message: `Found ${total} statements. Starting downloads...`, phase: 'downloading', total })

  let downloaded = 0
  let skipped = 0

  for (let i = 0; i < statementLinks.length; i++) {
    const link = statementLinks[i]
    if (!link) continue
    const downloadAttr = await link.getAttribute('download') ?? ''
    // Extract month/year like "November 2025" from "November 2025 – Robinhood Crypto Account Statement"
    const monthYearMatch = downloadAttr.match(/^([A-Za-z]+\s+\d{4})/)
    const monthYear = monthYearMatch?.[1] ?? downloadAttr
    const filename = monthYearToStatementFilename(monthYear)

    // Skip if already downloaded (unless all=true)
    if (all !== 'true' && existingFiles.includes(filename)) {
      skipped++
      sendEvent('progress', {
        current: i + 1,
        total,
        downloaded,
        skipped,
        filename,
        status: 'skipped'
      })
      continue
    }

    // Click to download - Robinhood uses dynamic URLs so we need to intercept
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
    await link.click({ force: true })
    const download = await downloadPromise

    if (download) {
      const filePath = join(CRYPTO_STATEMENTS_DIR, filename)
      await download.saveAs(filePath)
      downloaded++
      sendEvent('progress', {
        current: i + 1,
        total,
        downloaded,
        skipped,
        filename,
        status: 'downloaded'
      })
    } else {
      sendEvent('progress', {
        current: i + 1,
        total,
        downloaded,
        skipped,
        filename,
        status: 'failed'
      })
    }

    // Small delay between downloads
    await page.waitForTimeout(500)
  }

  sendEvent('complete', {
    total,
    downloaded,
    skipped,
    message: `Downloaded ${downloaded} statements (${skipped} skipped)`
  })

  res.end()
})

/**
 * GET /import/crypto/local-statements
 * List locally stored crypto statement PDFs.
 */
importRouter.get('/crypto/local-statements', async (_req, res) => {
  await mkdir(CRYPTO_STATEMENTS_DIR, { recursive: true })
  const files = await readdir(CRYPTO_STATEMENTS_DIR).catch(() => [])

  const statements = files
    .filter(f => f.endsWith('.pdf'))
    .map(filename => ({
      filename,
      monthYear: parseStatementFilename(filename),
      path: join(CRYPTO_STATEMENTS_DIR, filename)
    }))
    .sort((a, b) => {
      // Sort by filename for chronological order (Crypto-Statement-YYYY-MM.pdf sorts correctly)
      return b.filename.localeCompare(a.filename)
    })

  res.json({
    count: statements.length,
    statements,
    directory: CRYPTO_STATEMENTS_DIR
  })
})

/**
 * POST /import/crypto/parse
 * Parse a crypto statement PDF and return extracted transactions.
 */
importRouter.post('/crypto/parse', async (req, res, next) => {
  const { filename } = req.body as { filename?: string }

  if (!filename) {
    return next(badRequest('filename is required'))
  }

  const filePath = join(CRYPTO_STATEMENTS_DIR, filename)
  const pdfBuffer = await readFile(filePath).catch(() => null)

  if (!pdfBuffer) {
    return next(badRequest(`File not found: ${filename}`))
  }

  const result = await parseCryptoStatementPDF(pdfBuffer, filename).catch((err: Error) => {
    return next(badRequest(`Failed to parse PDF: ${err.message}`))
  })

  if (!result) return

  res.json(result)
})

/**
 * POST /import/crypto/parse-all
 * Parse all local crypto statement PDFs and return combined transactions.
 */
importRouter.post('/crypto/parse-all', async (_req, res) => {
  await mkdir(CRYPTO_STATEMENTS_DIR, { recursive: true })
  const files = await readdir(CRYPTO_STATEMENTS_DIR).catch(() => [])
  const pdfFiles = files.filter(f => f.endsWith('.pdf'))

  const allTransactions: CryptoTransaction[] = []
  const allHoldings: Map<string, CryptoHolding> = new Map()
  const parsedStatements: CryptoStatementData[] = []
  const errors: string[] = []

  for (const filename of pdfFiles) {
    const filePath = join(CRYPTO_STATEMENTS_DIR, filename)
    const pdfBuffer = await readFile(filePath).catch(() => null)

    if (!pdfBuffer) {
      errors.push(`Failed to read: ${filename}`)
      continue
    }

    const result = await parseCryptoStatementPDF(pdfBuffer, filename).catch((err: Error) => {
      errors.push(`Failed to parse ${filename}: ${err.message}`)
      return null
    })

    if (result) {
      parsedStatements.push(result)
      allTransactions.push(...result.transactions)
      // Keep latest holdings
      for (const holding of result.holdings) {
        allHoldings.set(holding.symbol, holding)
      }
    }
  }

  // Sort transactions by date
  allTransactions.sort((a, b) => a.date.localeCompare(b.date))

  // Load funds to check existence
  const allFunds = await readAllFunds(FUNDS_DIR).catch(() => [] as FundData[])

  // Build summary by symbol with fund existence check
  const bySymbol: Record<string, {
    buys: number
    sells: number
    totalBought: number
    totalSold: number
    totalSpent: number
    totalReceived: number
    fundId: string
    fundExists: boolean
  }> = {}

  for (const tx of allTransactions) {
    let stats = bySymbol[tx.symbol]
    if (!stats) {
      const fundId = buildFundId('robinhood', tx.symbol)
      stats = {
        buys: 0,
        sells: 0,
        totalBought: 0,
        totalSold: 0,
        totalSpent: 0,
        totalReceived: 0,
        fundId,
        fundExists: fundExists(fundId, allFunds)
      }
      bySymbol[tx.symbol] = stats
    }
    if (tx.type === 'buy') {
      stats.buys++
      stats.totalBought += tx.quantity
      stats.totalSpent += tx.value
    } else if (tx.type === 'sell') {
      stats.sells++
      stats.totalSold += tx.quantity
      stats.totalReceived += tx.value
    }
  }

  res.json({
    statementCount: parsedStatements.length,
    transactionCount: allTransactions.length,
    holdings: Array.from(allHoldings.values()),
    transactions: allTransactions,
    bySymbol,
    errors: errors.length > 0 ? errors : undefined
  })
})

/**
 * POST /import/crypto/import-to-fund
 * Import parsed crypto transactions into a specific fund.
 * Body: {
 *   fundId: string,
 *   symbol: string,
 *   mode: 'append' | 'replace',
 *   consolidate: boolean,  // Group same-day same-type transactions
 *   startDate?: string     // Filter transactions from this date onwards
 * }
 */
importRouter.post('/crypto/import-to-fund', async (req, res, next) => {
  const { fundId, symbol, mode = 'append', consolidate = false, startDate } = req.body as {
    fundId: string
    symbol: string
    mode?: 'append' | 'replace'
    consolidate?: boolean
    startDate?: string
  }

  if (!fundId) return next(badRequest('fundId is required'))
  if (!symbol) return next(badRequest('symbol is required'))

  // Read all PDF statements and parse
  const pdfFiles = await readdir(CRYPTO_STATEMENTS_DIR).catch(() => [] as string[])
    .then((files: string[]) => files.filter(f => f.endsWith('.pdf')))

  if (pdfFiles.length === 0) {
    return next(badRequest('No crypto statement PDFs found'))
  }

  // Parse all statements
  const allTransactions: CryptoTransaction[] = []
  const errors: string[] = []

  for (const filename of pdfFiles) {
    const filePath = join(CRYPTO_STATEMENTS_DIR, filename)
    const pdfBuffer = await readFile(filePath).catch(() => null)

    if (!pdfBuffer) {
      errors.push(`Failed to read: ${filename}`)
      continue
    }

    const result = await parseCryptoStatementPDF(pdfBuffer, filename).catch((err: Error) => {
      errors.push(`Failed to parse ${filename}: ${err.message}`)
      return null
    })

    if (result) {
      allTransactions.push(...result.transactions)
    }
  }

  // Filter by symbol and optionally by start date
  let symbolTransactions = allTransactions.filter(tx => tx.symbol === symbol.toUpperCase())
  if (startDate) {
    symbolTransactions = symbolTransactions.filter(tx => tx.date >= startDate)
  }

  if (symbolTransactions.length === 0) {
    return next(badRequest(`No transactions found for symbol: ${symbol}${startDate ? ` from ${startDate}` : ''}`))
  }

  // Sort by date
  symbolTransactions.sort((a, b) => a.date.localeCompare(b.date))

  // Consolidate if requested: group by date + type, process BUYs before SELLs
  interface ConsolidatedTx {
    date: string
    type: 'buy' | 'sell'
    totalShares: number
    totalAmount: number
    count: number
  }

  let processedTransactions: ConsolidatedTx[] = []

  if (consolidate) {
    // Group by date + type
    const groups = new Map<string, ConsolidatedTx>()

    for (const tx of symbolTransactions) {
      if (tx.type !== 'buy' && tx.type !== 'sell') continue

      const key = `${tx.date}|${tx.type}`
      const existing = groups.get(key)

      if (existing) {
        existing.totalShares += tx.quantity
        existing.totalAmount += tx.value
        existing.count++
      } else {
        groups.set(key, {
          date: tx.date,
          type: tx.type,
          totalShares: tx.quantity,
          totalAmount: tx.value,
          count: 1
        })
      }
    }

    // Convert to array and sort: by date, then BUYs before SELLs
    processedTransactions = Array.from(groups.values()).sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date)
      if (dateCompare !== 0) return dateCompare
      // BUYs before SELLs on same day
      if (a.type === 'buy' && b.type === 'sell') return -1
      if (a.type === 'sell' && b.type === 'buy') return 1
      return 0
    })
  } else {
    // No consolidation - convert to same format
    processedTransactions = symbolTransactions
      .filter(tx => tx.type === 'buy' || tx.type === 'sell')
      .map(tx => ({
        date: tx.date,
        type: tx.type as 'buy' | 'sell',
        totalShares: tx.quantity,
        totalAmount: tx.value,
        count: 1
      }))
  }

  // Read target fund
  const allFunds = await readAllFunds(FUNDS_DIR).catch(() => [] as FundData[])
  const fund = allFunds.find(f => f.id === fundId)

  if (!fund) {
    return next(badRequest(`Fund not found: ${fundId}`))
  }

  // Track cumulative shares
  let sumShares = mode === 'replace' ? 0 : (fund.entries.reduce((sum, e) => {
    if (e.action === 'BUY' && e.shares) return sum + e.shares
    if (e.action === 'SELL' && e.shares) return sum - e.shares
    return sum
  }, 0))

  // Convert to fund entries
  const entries: FundEntry[] = []
  let imported = 0
  let consolidated = 0
  let skippedSells = 0

  // Track sub-entries per date for labeling (a, b, c...)
  const dateCounters = new Map<string, number>()

  for (const tx of processedTransactions) {
    const action = tx.type === 'buy' ? 'BUY' : 'SELL'
    const avgPrice = tx.totalAmount / tx.totalShares

    // Update cumulative shares
    if (action === 'BUY') {
      sumShares += tx.totalShares
    } else {
      // Skip sells that would make sumShares negative (selling pre-existing holdings)
      if (sumShares < tx.totalShares) {
        skippedSells++
        continue  // Skip this sell - not enough shares accumulated
      }
      sumShares -= tx.totalShares
    }

    // Generate sub-identifier for multiple entries on same date
    const dateCount = dateCounters.get(tx.date) ?? 0
    dateCounters.set(tx.date, dateCount + 1)
    const subId = dateCount > 0 ? String.fromCharCode(97 + dateCount) : '' // '', 'b', 'c', 'd'...

    const notesText = tx.count > 1
      ? `${tx.count} ${tx.type}s consolidated${subId ? ` [${tx.date}-${subId}]` : ''}`
      : subId ? `[${tx.date}-${subId}]` : null

    const entry: FundEntry = {
      date: tx.date,
      value: Math.max(0, sumShares * avgPrice),  // Equity can't be negative
      action,
      amount: tx.totalAmount,
      shares: tx.totalShares,
      price: avgPrice,
      ...(notesText && { notes: notesText })
    }

    entries.push(entry)
    imported++
    if (tx.count > 1) consolidated += tx.count - 1
  }

  // Apply entries
  const fundPath = join(FUNDS_DIR, `${fundId}.tsv`)

  if (mode === 'replace') {
    const { writeFund } = await import('@escapemint/storage')
    fund.entries = entries
    await writeFund(fundPath, fund).catch((err: Error) => next(badRequest(err.message)))
  } else {
    for (const entry of entries) {
      await appendEntry(fundPath, entry).catch((err: Error) => {
        errors.push(`Failed to append entry: ${err.message}`)
      })
    }
  }

  res.json({
    success: true,
    fundId,
    symbol,
    mode,
    consolidate,
    startDate: startDate ?? null,
    imported,
    consolidated,
    skippedSells,
    originalCount: symbolTransactions.length,
    errors: errors.length > 0 ? errors : undefined
  })
})

// ============================================================================
// M1 Finance Cash Account Scraping
// ============================================================================

/**
 * M1 Cash transaction types based on their UI.
 * Primary focus is on interest payments from the savings/cash account.
 */
type M1CashTransactionType = 'interest' | 'deposit' | 'withdrawal' | 'transfer' | 'other'

/**
 * Determine M1 Cash transaction type from description and category.
 */
const determineM1TransactionType = (description: string, category: string): M1CashTransactionType => {
  const descLower = description.toLowerCase()
  const catLower = category.toLowerCase()

  // Interest payments - the primary goal of this importer
  if (descLower.includes('interest application') || catLower.includes('interest payment')) {
    return 'interest'
  }

  // Deposits from external banks
  if (descLower.includes('transfer from linked bank') || descLower.includes('ach credit')) {
    return 'deposit'
  }

  // Withdrawals
  if (descLower.includes('transfer to linked bank') || descLower.includes('ach debit') || descLower.includes('withdrawal')) {
    return 'withdrawal'
  }

  // Internal M1 transfers (between Invest and Save)
  if (descLower.includes('transfer to m1 invest') || descLower.includes('transfer from m1 invest') || catLower.includes('m1 transfer')) {
    return 'transfer'
  }

  return 'other'
}

/**
 * Parse M1 date format (e.g., "Dec 31, 2025" or "Pending") to YYYY-MM-DD
 */
const parseM1Date = (dateText: string): string => {
  if (!dateText || dateText.toLowerCase() === 'pending') {
    return new Date().toISOString().split('T')[0]!
  }

  // Remove any extra whitespace
  const cleaned = dateText.trim()

  // Parse "Dec 31, 2025" format
  const match = cleaned.match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(\d{4})/)
  if (match) {
    const months: Record<string, string> = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
    }
    const month = months[match[1]!] ?? '01'
    const day = match[2]!.padStart(2, '0')
    const year = match[3]!
    return `${year}-${month}-${day}`
  }

  // Fallback to current date
  return new Date().toISOString().split('T')[0]!
}

/**
 * Parse M1 amount format (e.g., "+$18.45" or "-$20,000.00")
 */
const parseM1Amount = (amountText: string): number => {
  const cleaned = amountText.replace(/[$,]/g, '').trim()
  const value = parseFloat(cleaned) || 0
  return value
}

/**
 * Find an existing M1 Finance savings page in the browser.
 */
const findM1SavingsPage = async (browser: Browser): Promise<Page | null> => {
  const contexts = browser.contexts()
  log.debug(`[M1 Import] Found ${contexts.length} browser contexts`)

  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!
    const pages = context.pages()
    log.debug(`[M1 Import] Context ${i}: ${pages.length} pages`)
    for (const page of pages) {
      const pageUrl = page.url()
      if (pageUrl.includes('m1.com') && !pageUrl.includes('/login')) {
        log.debug(`[M1 Import] Found existing M1 page: ${pageUrl}`)
        return page
      }
    }
  }

  return null
}

/**
 * Scrape M1 Cash transactions from the current page.
 * Handles the table structure with date headers and transaction rows.
 */
const scrapeM1CashTransactionsFromPage = async (
  page: Page
): Promise<ScrapedTransaction[]> => {
  const transactions: ScrapedTransaction[] = []

  // Wait for table to load
  await page.waitForSelector('table tbody', { timeout: 10000 }).catch(() => null)
  await page.waitForTimeout(1000)

  // Get all rows from the table
  const rows = await page.$$('table tbody tr')
  let currentDate = ''

  for (const row of rows) {
    // Check if this is a date header row (has a th with colspan)
    const dateHeader = await row.$('th[colspan]')
    if (dateHeader) {
      const headerText = await dateHeader.textContent() ?? ''
      // Skip "Pending" section
      if (headerText.toLowerCase() !== 'pending') {
        currentDate = parseM1Date(headerText)
      }
      continue
    }

    // This is a transaction row - get the cells
    const cells = await row.$$('td')
    if (cells.length < 3) continue

    // Extract description from first cell
    const descCell = cells[0]
    const description = await descCell?.$eval('p', el => el.textContent?.trim() ?? '').catch(() => '')
    if (!description) continue

    // Extract category from second cell
    const catCell = cells[1]
    const category = await catCell?.$eval('p', el => el.textContent?.trim() ?? '').catch(() => '')

    // Extract amount from third cell
    const amountCell = cells[2]
    const amountText = await amountCell?.$eval('p', el => el.textContent?.trim() ?? '').catch(() => '')
    const amount = parseM1Amount(amountText ?? '')

    // Determine transaction type
    const type = determineM1TransactionType(description, category ?? '')

    // Create unique ID
    const titleHash = description.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0).toString(36)
    const id = `${currentDate}-${type}-${amount.toFixed(2)}-${titleHash}`

    const tx: ScrapedTransaction = {
      id,
      date: currentDate,
      type: type as ScrapedTransaction['type'],
      title: description,
      amount: Math.abs(amount),
      details: {
        category: category ?? '',
        originalAmount: amountText ?? ''
      },
      rawText: `${description} | ${category} | ${amountText}`
    }

    transactions.push(tx)
  }

  return transactions
}

/**
 * Scrape M1 Cash history with pagination and progress updates.
 * Uses Next button to load more pages.
 */
const scrapeM1CashHistoryWithProgress = async (
  page: Page,
  archive: ScrapeArchive,
  onProgress: (current: number, total: number, tx: ScrapedTransaction | null) => void,
  maxPages = 50
): Promise<{ newCount: number; totalScraped: number }> => {
  let totalScraped = 0
  let newCount = 0
  let pageNum = 0
  let consecutiveExisting = 0  // Track consecutive already-scraped transactions
  const MAX_CONSECUTIVE_EXISTING = 30  // Stop early if we've seen this many existing txns in a row

  // Process pages
  while (pageNum < maxPages) {
    pageNum++

    // Scrape current page
    const pageTxns = await scrapeM1CashTransactionsFromPage(page)

    let shouldBreak = false
    for (const tx of pageTxns) {
      totalScraped++
      const isNew = addToArchive(archive, tx)
      if (isNew) {
        newCount++
        consecutiveExisting = 0  // Reset counter when we find a new transaction
        // Save incrementally every 10 new transactions
        if (newCount % 10 === 0) {
          await saveArchive(archive)
        }
      } else {
        consecutiveExisting++
        // Early exit: if we've seen many consecutive existing transactions, we're caught up
        if (consecutiveExisting >= MAX_CONSECUTIVE_EXISTING) {
          log.debug(`[M1 Import] Early exit: ${consecutiveExisting} consecutive existing transactions, stopping scrape`)
          shouldBreak = true
          break
        }
      }
      onProgress(totalScraped, totalScraped, tx)
    }

    if (shouldBreak) {
      break
    }

    // Check for Next button and click it
    const nextButton = await page.$('button:has-text("Next"):not([disabled])')
    if (!nextButton) {
      log.debug('[M1 Import] No more pages (Next button disabled or not found)')
      break
    }

    // Click Next and wait for page to update
    await nextButton.click()
    await page.waitForTimeout(2000)
  }

  // Final save
  await saveArchive(archive)

  return { newCount, totalScraped }
}

/**
 * GET /import/m1-cash/scrape-stream
 * SSE endpoint for scraping M1 Cash transactions with real-time progress.
 */
importRouter.get('/m1-cash/scrape-stream', async (req, res) => {
  const { url, platform = 'm1-cash' } = req.query as { url?: string; platform?: string }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const targetUrl = url ?? 'https://dashboard.m1.com/d/save/savings/transactions'

  // Validate URL
  if (!targetUrl.includes('m1.com')) {
    sendEvent('error', { message: 'URL must be an M1 Finance page' })
    res.end()
    return
  }

  // Connect to browser
  const browser = await connectToBrowser().catch((err: Error) => {
    sendEvent('error', { message: `Failed to connect: ${err.message}` })
    return null
  })

  if (!browser) {
    res.end()
    return
  }

  sendEvent('status', { message: 'Looking for M1 Finance page...', phase: 'navigating' })

  // Try to find an existing M1 page
  let page = await findM1SavingsPage(browser)
  let pageCreated = false

  if (page) {
    log.debug(`[M1 Import] Using existing M1 page: ${page.url()}`)
    sendEvent('status', { message: 'Found logged-in M1 page', phase: 'navigating' })
  } else {
    // No existing page - create new one
    log.debug('[M1 Import] No M1 page found, creating new one')
    sendEvent('status', { message: 'Opening M1 Finance...', phase: 'navigating' })

    page = await createNewPage(browser).catch((err: Error) => {
      sendEvent('error', { message: err.message })
      return null
    }) as Page | null

    if (!page) {
      res.end()
      return
    }

    pageCreated = true

    // Navigate to M1
    const navResult = await page.goto('https://dashboard.m1.com', { waitUntil: 'networkidle', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      sendEvent('error', { message: `Navigation failed: ${navResult.message}` })
      await page.close().catch(() => {})
      res.end()
      return
    }

    await page.waitForTimeout(2000)

    // Check if redirected to login
    if (page.url().includes('/login') || page.url().includes('/signin')) {
      log.debug('[M1 Import] Redirected to login - user needs to log in manually')
      sendEvent('error', {
        message: 'Please log in to M1 Finance in your browser first, then navigate to the savings transactions page and try again.'
      })
      res.end()
      return
    }
  }

  // Navigate to savings transactions if needed
  if (!page.url().includes('/save/') && !page.url().includes('savings')) {
    sendEvent('status', { message: 'Opening savings transactions page...', phase: 'navigating' })
    const navResult = await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      sendEvent('error', { message: `Navigation failed: ${navResult.message}` })
      if (pageCreated) await page.close().catch(() => {})
      res.end()
      return
    }
    await page.waitForTimeout(2000)
  }

  // Check for login
  const loginForm = await page.$('input[type="email"], input[type="password"], [data-testid="login"]')
  if (loginForm || page.url().includes('/login') || page.url().includes('/signin')) {
    log.debug(`[M1 Import] Login form detected. Current URL: ${page.url()}`)
    sendEvent('error', {
      message: 'Please log in to M1 Finance in the browser tab that just opened, then try again.'
    })
    res.end()
    return
  }

  sendEvent('status', { message: 'Loading archive...', phase: 'loading' })

  // Load existing archive
  const archive = await loadArchive(platform)
  const existingCount = archive.transactions.length

  sendEvent('status', {
    message: existingCount > 0
      ? `Found ${existingCount} existing transactions. Scraping for new data...`
      : 'Starting fresh scrape...',
    phase: 'scraping',
    existingCount
  })

  // Scrape with progress updates
  const result = await scrapeM1CashHistoryWithProgress(
    page,
    archive,
    (current, total, tx) => {
      sendEvent('progress', {
        current,
        total,
        newCount: archive.transactions.length - existingCount,
        lastTransaction: tx ? {
          date: tx.date,
          type: tx.type,
          symbol: undefined,
          amount: tx.amount,
          title: tx.title.substring(0, 50)
        } : null
      })
    }
  ).catch((err: Error) => {
    sendEvent('error', { message: `Scraping error: ${err.message}` })
    return null
  })

  // Only close the page if we created it
  if (pageCreated) await page.close().catch(() => {})

  if (result) {
    sendEvent('complete', {
      totalScraped: result.totalScraped,
      newCount: result.newCount,
      archiveTotal: archive.transactions.length,
      message: result.newCount > 0
        ? `Scraped ${result.totalScraped} transactions, ${result.newCount} new`
        : `Scraped ${result.totalScraped} transactions, all already in archive`
    })
  }

  res.end()
})

// ============================================================================
// M1 Finance PDF Statement Import
// ============================================================================

/**
 * M1 statement transaction from PDF parsing
 */
interface M1StatementTransaction {
  date: string  // YYYY-MM-DD
  description: string
  amount: number  // Positive for credits, negative for debits
  type: 'interest' | 'deposit' | 'withdrawal' | 'transfer' | 'fee' | 'other'
}

/**
 * Parsed M1 statement data
 */
interface M1StatementData {
  filename: string
  accountType: 'earn' | 'invest' | 'crypto' | 'unknown'
  periodStart: string
  periodEnd: string
  beginningBalance: number
  endingBalance: number
  totalDeposits: number
  totalWithdrawals: number
  totalInterest: number
  transactions: M1StatementTransaction[]
}

/**
 * M1 statement info for listing
 */
interface M1StatementInfo {
  filename: string
  accountType: string
  monthYear: string
  downloaded: boolean
  path?: string
}

/**
 * Determine M1 transaction type from PDF description
 */
const determineM1StatementTransactionType = (description: string): M1StatementTransaction['type'] => {
  const descLower = description.toLowerCase()

  if (descLower.includes('interest application') || descLower.includes('interest payment')) {
    return 'interest'
  }
  if (descLower.includes('transfer from linked bank') || descLower.includes('ach credit') || descLower.includes('deposit')) {
    return 'deposit'
  }
  if (descLower.includes('transfer to linked bank') || descLower.includes('ach debit')) {
    return 'withdrawal'
  }
  if (descLower.includes('transfer to m1') || descLower.includes('transfer from m1') || descLower.includes('instant transfer')) {
    return 'transfer'
  }
  if (descLower.includes('membership') || descLower.includes('fee')) {
    return 'fee'
  }
  return 'other'
}

/**
 * Parse M1 Earn/Save PDF statement
 */
const parseM1StatementPDF = async (pdfBuffer: Buffer, filename: string): Promise<M1StatementData> => {
  const parser = new PDFParse({ data: pdfBuffer })
  const result = await parser.getText()
  const text = result.text
  await parser.destroy()

  // Determine account type from filename or content
  let accountType: M1StatementData['accountType'] = 'unknown'
  const filenameLower = filename.toLowerCase()
  if (filenameLower.includes('earn') || filenameLower.includes('save')) {
    accountType = 'earn'
  } else if (filenameLower.includes('invest') || filenameLower.includes('brokerage')) {
    accountType = 'invest'
  } else if (filenameLower.includes('crypto')) {
    accountType = 'crypto'
  } else if (text.toLowerCase().includes('m1 save') || text.toLowerCase().includes('m1 earn')) {
    accountType = 'earn'
  } else if (text.toLowerCase().includes('brokerage')) {
    accountType = 'invest'
  }

  // Extract summary section values
  // M1 format: "Beginning Balance as of DATE \t$0.00" or "Ending Balance as of DATE $X"
  const beginningMatch = text.match(/beginning\s+balance(?:\s+as\s+of\s+\S+)?\s*[\t:]*\s*\$?([\d,.]+)/i)
  const endingMatch = text.match(/ending\s+balance(?:\s+as\s+of\s+\S+)?\s*[\t:]*\s*\$?([\d,.]+)/i)
  const depositsMatch = text.match(/deposits\s+(?:and\s+other\s+credits\s+)?\s*[\t:]*\s*\$?([\d,.]+)/i)
  const withdrawalsMatch = text.match(/withdrawals\s+(?:and\s+other\s+debits\s+)?\s*[\t:]*\s*\$?([\d,.]+)/i)
  const interestMatch = text.match(/(?:total\s+)?interest(?:\s+earned)?\s*[\t:]*\s*\$?([\d,.]+)/i)

  const beginningBalance = parseFloat(beginningMatch?.[1]?.replace(/,/g, '') ?? '0')
  const endingBalance = parseFloat(endingMatch?.[1]?.replace(/,/g, '') ?? '0')
  const totalDeposits = parseFloat(depositsMatch?.[1]?.replace(/,/g, '') ?? '0')
  const totalWithdrawals = parseFloat(withdrawalsMatch?.[1]?.replace(/,/g, '') ?? '0')
  const totalInterest = parseFloat(interestMatch?.[1]?.replace(/,/g, '') ?? '0')

  // Extract period dates from filename or content
  // Filename pattern: "M1 Save Account Statement-2025-09.pdf"
  const filenameMonthMatch = filename.match(/(\d{4})-(\d{2})\.pdf$/i)
  let periodStart = ''
  let periodEnd = ''

  if (filenameMonthMatch) {
    const year = filenameMonthMatch[1]!
    const month = filenameMonthMatch[2]!
    periodStart = `${year}-${month}-01`
    // Calculate last day of month
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    periodEnd = `${year}-${month}-${lastDay.toString().padStart(2, '0')}`
  } else {
    // Try to extract from content
    const periodMatch = text.match(/(\w+\s+\d{1,2},?\s+\d{4})\s*(?:to|through|-)\s*(\w+\s+\d{1,2},?\s+\d{4})/i)
    if (periodMatch) {
      periodStart = parseM1Date(periodMatch[1]!)
      periodEnd = parseM1Date(periodMatch[2]!)
    }
  }

  // Parse transactions from Activity section
  const transactions: M1StatementTransaction[] = []

  // Split text into lines and look for transaction patterns
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i]
    if (!currentLine) continue
    const line = currentLine.trim()

    // Look for date pattern at start of line (YYYY-MM-DD)
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/)
    if (!dateMatch) continue

    const date = dateMatch[1]!

    // Try to extract description and amount from same line or next line
    // Pattern: DATE DESCRIPTION AMOUNT
    // Amount may be negative (e.g., -$500.00) or positive ($500.00)

    let fullLine = line
    const nextLine = lines[i + 1]
    if (nextLine && !nextLine.match(/^\d{4}-\d{2}-\d{2}/)) {
      fullLine += ' ' + nextLine.trim()
    }

    // Extract amount (look for $X,XXX.XX pattern, optionally with minus)
    const amountMatch = fullLine.match(/(-?\$?[\d,]+\.\d{2})/)
    if (!amountMatch) continue

    const amountStr = amountMatch[1]!
    const amount = parseFloat(amountStr.replace(/[$,]/g, ''))

    // Extract description (everything between date and amount)
    const description = fullLine
      .replace(date, '')
      .replace(amountStr, '')
      .trim()
      .replace(/\s+/g, ' ')

    if (description) {
      transactions.push({
        date,
        description,
        amount,
        type: determineM1StatementTransactionType(description)
      })
    }
  }

  // Sort transactions by date
  transactions.sort((a, b) => a.date.localeCompare(b.date))

  return {
    filename,
    accountType,
    periodStart,
    periodEnd,
    beginningBalance,
    endingBalance,
    totalDeposits,
    totalWithdrawals,
    totalInterest,
    transactions
  }
}

/**
 * Find M1 Finance page in browser
 */
const findM1StatementsPage = async (browser: Browser): Promise<Page | null> => {
  const contexts = browser.contexts()

  for (const context of contexts) {
    const pages = context.pages()
    for (const page of pages) {
      const url = page.url()
      if (url.includes('dashboard.m1.com') || url.includes('m1.com')) {
        return page
      }
    }
  }

  return null
}

/**
 * GET /import/m1-statements/debug-text
 * Debug endpoint to see raw PDF text content.
 */
importRouter.get('/m1-statements/debug-text', async (req, res, next) => {
  const { filename } = req.query as { filename?: string }
  if (!filename) {
    return next(badRequest('filename is required'))
  }

  const filePath = join(M1_STATEMENTS_DIR, filename)
  const pdfBuffer = await readFile(filePath).catch(() => null)

  if (!pdfBuffer) {
    return next(badRequest(`File not found: ${filename}`))
  }

  const parser = new PDFParse({ data: pdfBuffer })
  const result = await parser.getText()
  await parser.destroy()

  // Check what we can match (M1 format: "Beginning Balance as of DATE \t$0.00")
  const text = result.text
  const beginningMatch = text.match(/beginning\s+balance(?:\s+as\s+of\s+\S+)?\s*[\t:]*\s*\$?([\d,.]+)/i)
  const endingMatch = text.match(/ending\s+balance(?:\s+as\s+of\s+\S+)?\s*[\t:]*\s*\$?([\d,.]+)/i)

  res.json({
    filename,
    textLength: text.length,
    firstChars: text.slice(0, 2000),
    beginningMatch: beginningMatch ? beginningMatch[0] : null,
    endingMatch: endingMatch ? endingMatch[0] : null
  })
})

/**
 * GET /import/m1-statements/list
 * Scrape the M1 statements page to get list of available PDFs.
 */
importRouter.get('/m1-statements/list', async (_req, res, next) => {
  const browser = await connectToBrowser().catch((err: Error) => {
    return next(badRequest(`Failed to connect to browser: ${err.message}`))
  })
  if (!browser) return

  const page = await findM1StatementsPage(browser)
  if (!page) {
    return next(badRequest('No M1 Finance page found. Please log in first.'))
  }

  // Navigate to statements page
  const statementsUrl = 'https://dashboard.m1.com/d/settings/documents/statements'
  if (!page.url().includes('documents/statements')) {
    const navResult = await page.goto(statementsUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      return next(badRequest(`Failed to navigate to statements: ${navResult.message}`))
    }
  }

  // Wait for statements to load
  await page.waitForTimeout(2000)

  // Get list of existing downloaded files
  await mkdir(M1_STATEMENTS_DIR, { recursive: true })
  const existingFiles: string[] = await readdir(M1_STATEMENTS_DIR).catch(() => [] as string[])

  // Extract statement info from the page
  // M1 has a year dropdown and then lists statements for that year
  const statements: M1StatementInfo[] = await page.evaluate(() => {
    const results: M1StatementInfo[] = []

    // Look for download links or statement rows
    const links = document.querySelectorAll('a[href*="statement"], a[download*="Statement"]')
    links.forEach(link => {
      const download = link.getAttribute('download') ?? ''
      const text = link.textContent?.trim() ?? ''

      // Try to extract account type and date from the link or text
      let accountType = 'unknown'
      if (download.toLowerCase().includes('save') || download.toLowerCase().includes('earn')) {
        accountType = 'earn'
      } else if (download.toLowerCase().includes('invest') || download.toLowerCase().includes('brokerage')) {
        accountType = 'invest'
      } else if (download.toLowerCase().includes('crypto')) {
        accountType = 'crypto'
      }

      // Extract month/year from download name or text
      const dateMatch = download.match(/(\d{4})-(\d{2})/) ?? text.match(/(\w+)\s+(\d{4})/)
      const monthYear = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}` : text

      results.push({
        filename: download || `${text.replace(/\s+/g, '-')}.pdf`,
        accountType,
        monthYear,
        downloaded: false
      })
    })

    return results
  })

  // Mark which are already downloaded
  statements.forEach(s => {
    s.downloaded = existingFiles.some(f => f.toLowerCase() === s.filename.toLowerCase())
    if (s.downloaded) {
      s.path = join(M1_STATEMENTS_DIR, s.filename)
    }
  })

  res.json({
    count: statements.length,
    statements,
    downloadDir: M1_STATEMENTS_DIR
  })
})

/**
 * GET /import/m1-statements/download-stream
 * Download M1 statement PDFs with SSE progress.
 */
importRouter.get('/m1-statements/download-stream', async (req, res) => {
  log.debug('[M1 Statements] Download stream started')
  const { all, year, accountType } = req.query as { all?: string; year?: string; accountType?: string }
  log.debug(`[M1 Statements] Params: all=${all}, year=${year}, accountType=${accountType}`)

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    log.debug(`[M1 Statements] Event: ${event}`, JSON.stringify(data))
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  log.debug('[M1 Statements] Connecting to browser...')
  const browser = await connectToBrowser().catch((err: Error) => {
    log.debug(`[M1 Statements] Browser connection failed: ${err.message}`)
    sendEvent('error', { message: `Failed to connect to browser: ${err.message}` })
    res.end()
    return null
  })
  if (!browser) return
  log.debug('[M1 Statements] Browser connected')

  log.debug('[M1 Statements] Finding M1 page...')
  const page = await findM1StatementsPage(browser)
  if (!page) {
    log.debug('[M1 Statements] No M1 page found')
    sendEvent('error', { message: 'No M1 Finance page found. Please log in first.' })
    res.end()
    return
  }
  log.debug(`[M1 Statements] Found M1 page: ${page.url()}`)

  sendEvent('status', { message: 'Navigating to statements page...', phase: 'navigating' })

  // Navigate to statements page
  const statementsUrl = 'https://dashboard.m1.com/d/settings/documents/statements'
  log.debug(`[M1 Statements] Current URL: ${page.url()}`)

  if (!page.url().includes('documents/statements')) {
    log.debug(`[M1 Statements] Navigating to ${statementsUrl}`)
    // Use 'load' instead of 'networkidle' to avoid timeout issues
    const navResult = await page.goto(statementsUrl, { waitUntil: 'load', timeout: 30000 }).catch((err: Error) => err)
    if (navResult instanceof Error) {
      log.debug(`[M1 Statements] Navigation failed: ${navResult.message}`)
      sendEvent('error', { message: `Failed to navigate: ${navResult.message}` })
      res.end()
      return
    }
    log.debug(`[M1 Statements] Navigation successful`)
  } else {
    log.debug(`[M1 Statements] Already on statements page`)
  }

  // Wait for page content to load
  await page.waitForTimeout(3000)
  log.debug(`[M1 Statements] Page loaded, current URL: ${page.url()}`)

  // Get list of existing downloaded files
  await mkdir(M1_STATEMENTS_DIR, { recursive: true })
  const existingFiles: string[] = await readdir(M1_STATEMENTS_DIR).catch(() => [] as string[])

  let totalDownloaded = 0
  let totalSkipped = 0
  let totalProcessed = 0

  // Helper to select a year using React Select dropdown
  const selectYear = async (targetYear: string): Promise<boolean> => {
    log.debug(`[M1 Statements] Attempting to select year ${targetYear}`)

    // React Select dropdown - click on the control area to open
    // The control div has classes like "css-*-control"
    const dropdownSelectors = [
      'div[class*="-control"]',  // React Select control
      'input#year',              // Hidden input
      'label[for="year"]',       // Label
    ]

    let dropdownOpened = false

    for (const selector of dropdownSelectors) {
      const element = await page.$(selector).catch(() => null)
      if (element) {
        await element.click()
        await page.waitForTimeout(800)
        dropdownOpened = true
        log.debug(`[M1 Statements] Clicked dropdown using selector: ${selector}`)
        break
      }
    }

    if (!dropdownOpened) {
      // Try clicking the span showing current year
      const currentYearSpan = await page.$('span:has-text("202")').catch(() => null)
      if (currentYearSpan) {
        await currentYearSpan.click()
        await page.waitForTimeout(800)
        dropdownOpened = true
        log.debug(`[M1 Statements] Clicked year span`)
      }
    }

    // Wait for dropdown menu to appear
    await page.waitForTimeout(500)

    // Find and click the target year option
    // React Select options have classes like "css-*-option"
    const optionSelectors = [
      `div[class*="-option"]:has-text("${targetYear}")`,
      `div[class*="option"]:has-text("${targetYear}")`,
      `[role="option"]:has-text("${targetYear}")`,
    ]

    for (const selector of optionSelectors) {
      const option = await page.$(selector).catch(() => null)
      if (option) {
        await option.click()
        await page.waitForTimeout(1500) // Wait for table to update
        log.debug(`[M1 Statements] Selected year ${targetYear} using selector: ${selector}`)
        return true
      }
    }

    // Fallback: Use keyboard navigation
    // Clear any existing input first, then type the year to filter options
    log.debug(`[M1 Statements] Trying keyboard input for year ${targetYear}`)
    // Select all and clear any existing text (Meta for macOS, Control for others)
    await page.keyboard.press('Meta+a')
    await page.waitForTimeout(100)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)
    await page.keyboard.type(targetYear)
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)

    // Check if year changed by looking at the displayed value
    const displayedYear = await page.evaluate(() => {
      const yearSpan = document.querySelector('div[class*="-control"] span')
      return yearSpan?.textContent?.trim() ?? ''
    })

    log.debug(`[M1 Statements] Displayed year after selection: ${displayedYear}`)
    return displayedYear === targetYear
  }

  // Get available years from dropdown
  const getAvailableYears = async (): Promise<string[]> => {
    log.debug(`[M1 Statements] Getting available years from dropdown`)

    // Click to open dropdown
    const dropdownSelectors = [
      'div[class*="-control"]',
      'input#year',
      'label[for="year"]',
    ]

    for (const selector of dropdownSelectors) {
      const element = await page.$(selector).catch(() => null)
      if (element) {
        await element.click()
        await page.waitForTimeout(800)
        log.debug(`[M1 Statements] Opened dropdown using: ${selector}`)
        break
      }
    }

    // Wait for menu to appear
    await page.waitForTimeout(500)

    // Get all year options from the dropdown menu
    const years = await page.evaluate(() => {
      const yearList: string[] = []
      // React Select options
      const options = document.querySelectorAll('div[class*="-option"], div[class*="option"], [role="option"]')
      options.forEach(opt => {
        const text = opt.textContent?.trim()
        if (text && /^\d{4}$/.test(text)) {
          yearList.push(text)
        }
      })
      return yearList
    })

    log.debug(`[M1 Statements] Found years in dropdown: ${years.join(', ')}`)

    // Close dropdown by pressing Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    return years
  }

  // Get years to process
  sendEvent('status', { message: 'Finding available years...', phase: 'scanning' })
  let yearsToProcess = await getAvailableYears()

  // If no years found from dropdown, try generating a range
  if (yearsToProcess.length === 0) {
    const currentYear = new Date().getFullYear()
    yearsToProcess = Array.from({ length: 10 }, (_, i) => String(currentYear - i))
    sendEvent('status', { message: `Using default year range: ${currentYear} to ${currentYear - 9}`, phase: 'scanning' })
  } else {
    sendEvent('status', { message: `Found ${yearsToProcess.length} years to scan`, phase: 'scanning' })
  }

  // Sort years descending (newest first)
  yearsToProcess.sort((a, b) => parseInt(b) - parseInt(a))

  // If specific year requested, only process that year
  if (year) {
    yearsToProcess = yearsToProcess.filter(y => y === year)
    if (yearsToProcess.length === 0) {
      yearsToProcess = [year]
    }
  }

  // Process each year
  for (const currentYear of yearsToProcess) {
    sendEvent('status', { message: `Processing year ${currentYear}...`, phase: 'downloading', year: currentYear })

    // Select the year
    const selected = await selectYear(currentYear)
    if (!selected) {
      sendEvent('status', { message: `Could not select year ${currentYear}, skipping...`, phase: 'downloading' })
      continue
    }

    await page.waitForTimeout(1000)

    // Click "Load more" button repeatedly until all statements are loaded
    let loadMoreClicks = 0
    const maxLoadMoreClicks = 20 // Safety limit
    while (loadMoreClicks < maxLoadMoreClicks) {
      const loadMoreBtn = await page.$('button:has(span:text("Load more")), button:has-text("Load more")').catch(() => null)
      if (!loadMoreBtn) {
        break
      }
      log.debug(`[M1 Statements] Clicking "Load more" button (click ${loadMoreClicks + 1})`)
      await loadMoreBtn.click()
      await page.waitForTimeout(1500) // Wait for more statements to load
      loadMoreClicks++
    }
    if (loadMoreClicks > 0) {
      log.debug(`[M1 Statements] Clicked "Load more" ${loadMoreClicks} times for year ${currentYear}`)
      sendEvent('status', { message: `Loaded all statements for ${currentYear} (${loadMoreClicks} pages)`, phase: 'downloading', year: currentYear })
    }

    // Check if there are any statements (look for "No documents" message)
    const noDocsMessage = await page.$('td:has-text("No documents")').catch(() => null)
    if (noDocsMessage) {
      sendEvent('status', { message: `No statements for ${currentYear}`, phase: 'downloading', year: currentYear })
      continue
    }

    // Find all table rows with statements
    const tableRows = await page.$$('tbody tr').catch(() => [])
    log.debug(`[M1 Statements] Found ${tableRows.length} table rows for ${currentYear}`)

    // Collect all PDF URLs first by intercepting requests
    const pdfUrls: Array<{ url: string; filename: string; rowText: string }> = []

    for (let i = 0; i < tableRows.length; i++) {
      const row = tableRows[i]!
      const rowText = await row.textContent().catch(() => '') ?? ''
      log.debug(`[M1 Statements] Row ${i + 1} text: "${rowText.substring(0, 100)}"`)

      // Skip rows that say "No documents"
      if (rowText.includes('No documents')) {
        log.debug(`[M1 Statements] Skipping row ${i + 1} - No documents`)
        continue
      }

      // Filter by account type if specified
      if (accountType) {
        const rowLower = rowText.toLowerCase()
        const typeMatches =
          (accountType === 'earn' && (rowLower.includes('earn') || rowLower.includes('save') || rowLower.includes('hysa'))) ||
          (accountType === 'invest' && (rowLower.includes('invest') || rowLower.includes('individual') || rowLower.includes('brokerage'))) ||
          (accountType === 'crypto' && rowLower.includes('crypto'))
        if (!typeMatches) {
          log.debug(`[M1 Statements] Skipping row ${i + 1} - doesn't match accountType ${accountType}`)
          totalSkipped++
          continue
        }
      }

      // Generate filename from row content
      const monthMatch = rowText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)
      const accountMatch = rowText.match(/(Save|Earn|Invest|Crypto|Individual|Brokerage)/i)
      // Convert month name to number (01-12)
      const monthNames: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
      }
      const month = monthMatch?.[1] ? (monthNames[monthMatch[1].toLowerCase()] ?? `row${i + 1}`) : `row${i + 1}`
      const account = accountMatch ? accountMatch[1] : 'Statement'
      const filename = `M1-${account}-${currentYear}-${month}.pdf`

      // Check if already downloaded
      if (all !== 'true' && existingFiles.some(f => f.toLowerCase().includes(filename.toLowerCase().replace('.pdf', '')))) {
        log.debug(`[M1 Statements] Skipping row ${i + 1} - already downloaded: ${filename}`)
        totalSkipped++
        totalProcessed++
        sendEvent('progress', {
          current: totalProcessed,
          total: totalProcessed + tableRows.length - i,
          downloaded: totalDownloaded,
          skipped: totalSkipped,
          filename,
          status: 'skipped',
          year: currentYear
        })
        continue
      }

      // Try to find button or link in this row
      const clickable = await row.$('button, a').catch(() => null)
      if (!clickable) {
        log.debug(`[M1 Statements] No clickable element in row ${i + 1}`)
        continue
      }

      // Get href if it's a link
      const href = await clickable.getAttribute('href').catch(() => null)
      log.debug(`[M1 Statements] Row ${i + 1} href: ${href}`)

      // Accept any valid URL - M1 uses external document providers like apexclearing.com
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        // Direct link - we can fetch it
        pdfUrls.push({ url: href, filename, rowText })
        log.debug(`[M1 Statements] Found direct URL: ${href.substring(0, 80)}...`)
      } else if (href && href.startsWith('/')) {
        // Relative URL
        const fullUrl = `https://dashboard.m1.com${href}`
        pdfUrls.push({ url: fullUrl, filename, rowText })
        log.debug(`[M1 Statements] Found relative URL: ${fullUrl}`)
      } else {
        // Need to click and intercept the new tab/request
        log.debug(`[M1 Statements] Clicking row ${i + 1} to get PDF URL...`)

        // Set up request interception to capture PDF URL
        let capturedPdfUrl: string | null = null
        const requestHandler = (request: { url: () => string }) => {
          const url = request.url()
          if (url.includes('.pdf') || url.includes('/documents/') || url.includes('/statement')) {
            capturedPdfUrl = url
            log.debug(`[M1 Statements] Captured PDF request: ${url}`)
          }
        }
        page.on('request', requestHandler)

        // Listen for new page (popup)
        const context = page.context()
        const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null)

        await clickable.click()
        await page.waitForTimeout(2000)

        // Check if we got a popup
        const popup = await popupPromise
        if (popup) {
          const popupUrl = popup.url()
          log.debug(`[M1 Statements] Popup opened: ${popupUrl}`)

          // Wait for it to load
          await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
          const finalUrl = popup.url()
          log.debug(`[M1 Statements] Popup final URL: ${finalUrl}`)

          if (finalUrl && finalUrl !== 'about:blank') {
            pdfUrls.push({ url: finalUrl, filename, rowText })
          }

          // Close the popup
          await popup.close().catch(() => {})
        } else if (capturedPdfUrl) {
          pdfUrls.push({ url: capturedPdfUrl, filename, rowText })
        }

        page.off('request', requestHandler)
      }
    }

    log.debug(`[M1 Statements] Collected ${pdfUrls.length} PDF URLs for ${currentYear}`)
    sendEvent('status', { message: `Found ${pdfUrls.length} statements for ${currentYear}`, phase: 'downloading' })

    // Now download all the PDFs
    for (const { url, filename } of pdfUrls) {
      log.debug(`[M1 Statements] Downloading: ${url} -> ${filename}`)

      const filePath = join(M1_STATEMENTS_DIR, filename)

      // Use fetch with the page's cookies
      const cookies = await page.context().cookies()
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

      const response = await fetch(url, {
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }).catch(err => {
        log.debug(`[M1 Statements] Fetch error: ${err}`)
        return null
      })

      if (response && response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer())
        await writeFile(filePath, buffer)
        log.debug(`[M1 Statements] Saved: ${filePath} (${buffer.length} bytes)`)
        totalDownloaded++
        existingFiles.push(filename)
        sendEvent('progress', {
          current: totalProcessed + 1,
          total: totalProcessed + pdfUrls.length,
          downloaded: totalDownloaded,
          skipped: totalSkipped,
          filename,
          status: 'downloaded',
          year: currentYear
        })
      } else {
        log.debug(`[M1 Statements] Failed to download: ${url} - ${response?.status}`)
        totalSkipped++
      }

      totalProcessed++
      await page.waitForTimeout(500)
    }
  }

  sendEvent('complete', {
    total: totalProcessed,
    downloaded: totalDownloaded,
    skipped: totalSkipped,
    message: `Downloaded ${totalDownloaded} statements across ${yearsToProcess.length} years, skipped ${totalSkipped}`
  })

  res.end()
})

/**
 * GET /import/m1-statements/local
 * List locally stored M1 statement PDFs.
 */
importRouter.get('/m1-statements/local', async (_req, res) => {
  await mkdir(M1_STATEMENTS_DIR, { recursive: true })
  const files = await readdir(M1_STATEMENTS_DIR).catch(() => [])

  const statements = files
    .filter(f => f.endsWith('.pdf'))
    .map(filename => {
      // Parse account type from filename
      const fnLower = filename.toLowerCase()
      let accountType = 'unknown'
      if (fnLower.includes('earn') || fnLower.includes('save')) {
        accountType = 'earn'
      } else if (fnLower.includes('invest')) {
        accountType = 'invest'
      } else if (fnLower.includes('crypto')) {
        accountType = 'crypto'
      }

      // Parse month/year from filename
      const dateMatch = filename.match(/(\d{4})-(\d{2})/)
      const monthYear = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}` : filename

      return {
        filename,
        accountType,
        monthYear,
        downloaded: true,
        path: join(M1_STATEMENTS_DIR, filename)
      }
    })
    .sort((a, b) => b.monthYear.localeCompare(a.monthYear))

  res.json({
    count: statements.length,
    statements,
    directory: M1_STATEMENTS_DIR
  })
})

/**
 * POST /import/m1-statements/parse
 * Parse a single M1 statement PDF.
 */
importRouter.post('/m1-statements/parse', async (req, res, next) => {
  const { filename } = req.body as { filename?: string }

  if (!filename) {
    return next(badRequest('filename is required'))
  }

  const filePath = join(M1_STATEMENTS_DIR, filename)
  const pdfBuffer = await readFile(filePath).catch(() => null)

  if (!pdfBuffer) {
    return next(badRequest(`File not found: ${filename}`))
  }

  const result = await parseM1StatementPDF(pdfBuffer, filename).catch((err: Error) => {
    return next(badRequest(`Failed to parse PDF: ${err.message}`))
  })

  if (!result) return

  res.json(result)
})

/**
 * POST /import/m1-statements/parse-all
 * Parse all local M1 statement PDFs and return combined transactions.
 */
importRouter.post('/m1-statements/parse-all', async (req, res) => {
  const { accountType } = req.body as { accountType?: string }

  await mkdir(M1_STATEMENTS_DIR, { recursive: true })
  const files = await readdir(M1_STATEMENTS_DIR).catch(() => [])
  let pdfFiles = files.filter(f => f.endsWith('.pdf'))

  // Filter by account type if specified
  if (accountType) {
    pdfFiles = pdfFiles.filter(f => {
      const fnLower = f.toLowerCase()
      return (accountType === 'earn' && (fnLower.includes('earn') || fnLower.includes('save'))) ||
             (accountType === 'invest' && fnLower.includes('invest')) ||
             (accountType === 'crypto' && fnLower.includes('crypto'))
    })
  }

  const allTransactions: M1StatementTransaction[] = []
  const statements: M1StatementData[] = []
  const errors: string[] = []

  for (const filename of pdfFiles) {
    const filePath = join(M1_STATEMENTS_DIR, filename)
    const pdfBuffer = await readFile(filePath).catch(() => null)

    if (!pdfBuffer) {
      errors.push(`Failed to read ${filename}`)
      continue
    }

    const result = await parseM1StatementPDF(pdfBuffer, filename).catch((err: Error) => {
      errors.push(`Failed to parse ${filename}: ${err.message}`)
      return null
    })

    if (result) {
      statements.push(result)
      allTransactions.push(...result.transactions)
    }
  }

  // Sort all transactions by date
  allTransactions.sort((a, b) => a.date.localeCompare(b.date))

  // Aggregate by type
  const byType: Record<string, { count: number; total: number }> = {}
  for (const tx of allTransactions) {
    if (!byType[tx.type]) {
      byType[tx.type] = { count: 0, total: 0 }
    }
    byType[tx.type]!.count++
    byType[tx.type]!.total += tx.amount
  }

  // Sort statements by period start for continuity checking
  statements.sort((a, b) => a.periodStart.localeCompare(b.periodStart))

  res.json({
    statementCount: statements.length,
    transactionCount: allTransactions.length,
    transactions: allTransactions,
    statements: statements.map(s => ({
      filename: s.filename,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      beginningBalance: s.beginningBalance,
      endingBalance: s.endingBalance,
      totalDeposits: s.totalDeposits,
      totalWithdrawals: s.totalWithdrawals,
      totalInterest: s.totalInterest,
      transactionCount: s.transactions.length
    })),
    byType,
    dateRange: allTransactions.length > 0 ? {
      oldest: allTransactions[0]!.date,
      newest: allTransactions[allTransactions.length - 1]!.date
    } : null,
    errors: errors.length > 0 ? errors : undefined
  })
})

/**
 * POST /import/m1-statements/apply
 * Apply parsed M1 statement transactions to the m1-cash fund.
 */
importRouter.post('/m1-statements/apply', async (req, res, next) => {
  const { transactions } = req.body as {
    transactions: M1StatementTransaction[]
  }

  if (!transactions || !Array.isArray(transactions)) {
    return next(badRequest('transactions array is required'))
  }

  // Read m1-cash fund
  const allFunds = await readAllFunds(FUNDS_DIR).catch(() => [] as FundData[])
  const fund = allFunds.find(f => f.id === 'm1-cash')

  if (!fund) {
    return next(badRequest('m1-cash fund not found. Please create it first.'))
  }

  // Group transactions by date and consolidate
  const byDate = new Map<string, {
    deposits: number
    withdrawals: number
    interest: number
    fees: number
    notes: string[]
  }>()

  for (const tx of transactions) {
    let day = byDate.get(tx.date)
    if (!day) {
      day = { deposits: 0, withdrawals: 0, interest: 0, fees: 0, notes: [] }
      byDate.set(tx.date, day)
    }

    if (tx.type === 'interest') {
      day.interest += tx.amount
    } else if (tx.type === 'deposit') {
      day.deposits += tx.amount
    } else if (tx.type === 'withdrawal') {
      day.withdrawals += Math.abs(tx.amount)
    } else if (tx.type === 'fee') {
      day.fees += Math.abs(tx.amount)
    } else if (tx.type === 'transfer') {
      if (tx.amount > 0) {
        day.deposits += tx.amount
      } else {
        day.withdrawals += Math.abs(tx.amount)
      }
    }
    day.notes.push(tx.description)
  }

  // Sort dates chronologically
  const sortedDates = Array.from(byDate.keys()).sort()

  let applied = 0
  const errors: string[] = []
  let runningBalance = 0

  for (const date of sortedDates) {
    const day = byDate.get(date)!
    const netFlow = day.deposits - day.withdrawals + day.interest - day.fees

    // value = equity at START of day (before transaction)
    // cash = equity at END of day (after transaction)
    const startBalance = runningBalance
    runningBalance += netFlow
    const endBalance = runningBalance

    // Create single consolidated entry for this day
    const entry: FundEntry = {
      date,
      value: startBalance,   // Equity Start (before action)
      cash: endBalance,      // Equity End (after action)
      notes: day.notes.join('; ')
    }

    // Set action based on primary activity
    if (day.deposits > 0 && day.withdrawals === 0) {
      entry.action = 'DEPOSIT'
      entry.amount = day.deposits
    } else if (day.withdrawals > 0 && day.deposits === 0) {
      entry.action = 'WITHDRAW'
      entry.amount = day.withdrawals
    } else if (day.deposits > day.withdrawals) {
      // Net deposit
      entry.action = 'DEPOSIT'
      entry.amount = day.deposits - day.withdrawals
    } else if (day.withdrawals > day.deposits) {
      // Net withdrawal
      entry.action = 'WITHDRAW'
      entry.amount = day.withdrawals - day.deposits
    } else {
      // Only interest/fees or balanced deposits/withdrawals
      entry.action = 'HOLD'
    }

    // Always include interest and fees if present
    if (day.interest > 0) {
      entry.cash_interest = day.interest
    }
    if (day.fees > 0) {
      entry.expense = day.fees
    }

    // Append entry
    const fundPath = join(FUNDS_DIR, 'm1-cash.tsv')
    const appendResult = await appendEntry(fundPath, entry).catch((err: Error) => {
      errors.push(`Failed to add entry for ${date}: ${err.message}`)
      return false
    })

    if (appendResult !== false) {
      applied++
    }
  }

  res.json({
    result: {
      applied,
      skipped: 0,
      originalTransactions: transactions.length,
      consolidatedEntries: applied,
      errors
    }
  })
})

// ============================================================================
// Coinbase Derivatives Scraping (for funding/rewards not in API)
// ============================================================================

// Types for Coinbase scraped data
interface CoinbaseFundingEntry {
  id: string  // unique ID based on date + amount
  date: string  // ISO date YYYY-MM-DD
  amount: number  // Funding amount (positive = received, negative = paid)
  rate?: string  // Funding rate if available
  productId?: string  // Product ID like 'BIP-20DEC30-CDE'
}

interface CoinbaseRewardEntry {
  id: string
  date: string  // ISO date YYYY-MM-DD
  amount: number  // Reward amount (always positive)
  type: 'usdc_interest' | 'staking' | 'other'
  description?: string
}

interface CoinbaseDerivativesArchive {
  platform: 'coinbase-btcd'
  createdAt: string
  updatedAt: string
  fundingPayments: CoinbaseFundingEntry[]
  rewards: CoinbaseRewardEntry[]
}

// ============================================================================
// Coinbase Transactions Page Scraping Types
// ============================================================================

type CoinbaseTransactionType =
  | 'FUNDING_LOSS' | 'FUNDING_PROFIT'
  | 'BUY' | 'SELL'
  | 'USDC_INTEREST' | 'REBATE'
  | 'STAKING' | 'CARD' | 'DEPOSIT' | 'WITHDRAWAL' | 'OTHER'

interface CoinbaseScrapedTransaction {
  id: string                    // From row id attribute (decoded)
  date: string                  // ISO YYYY-MM-DD
  type: CoinbaseTransactionType // Enum
  title: string                 // Raw: "Funding deducted"
  amount: number                // USD value (signed)
  secondaryAmount?: string      // Raw: "-232.52 USD" or "+1 contract"
  contracts?: number            // For perp trades
  price?: number                // For perp trades (USD per contract)
  symbol?: string               // BTC, USDC, etc.
  fee?: number                  // Trading fee (from detail dialog)
  isPerpRelated: boolean        // Filter flag
}

interface CoinbaseTransactionArchive {
  platform: 'coinbase-transactions'
  createdAt: string
  updatedAt: string
  transactions: CoinbaseScrapedTransaction[]
}

/**
 * Determine transaction type from Coinbase title
 */
const determineCoinbaseTransactionType = (title: string): CoinbaseTransactionType => {
  const upper = title.toUpperCase()

  // Perp-related
  if (upper.includes('FUNDING DEDUCTED')) return 'FUNDING_LOSS'
  if (upper.includes('FUNDING RECEIVED')) return 'FUNDING_PROFIT'
  if (upper.includes('BOUGHT') && upper.includes('PERP')) return 'BUY'
  if (upper.includes('SOLD') && upper.includes('PERP')) return 'SELL'
  if (upper.includes('TRADING REBATE')) return 'REBATE'

  // Rewards/Interest
  if (upper.includes('USDC REWARD')) return 'USDC_INTEREST'
  if (upper.includes('REWARD')) return 'STAKING'

  // Transfers
  if (upper.includes('RECEIVED')) return 'DEPOSIT'
  if (upper.includes('SENT')) return 'WITHDRAWAL'
  if (upper.includes('CARD PAYMENT')) return 'CARD'

  return 'OTHER'
}

/**
 * Check if transaction type is perp-related
 */
const isPerpRelatedType = (type: CoinbaseTransactionType): boolean => {
  return ['FUNDING_LOSS', 'FUNDING_PROFIT', 'BUY', 'SELL', 'REBATE', 'USDC_INTEREST'].includes(type)
}

/**
 * Check if transaction is margin-related (USDC deposits/withdrawals for perp trading)
 */
const isMarginRelated = (type: CoinbaseTransactionType, title: string, symbol?: string): boolean => {
  // USDC deposits to margin account
  if (type === 'DEPOSIT' && (symbol === 'USDC' || title.toLowerCase().includes('usdc'))) {
    return true
  }
  // USDC withdrawals from margin account
  if (type === 'WITHDRAWAL' && (symbol === 'USDC' || title.toLowerCase().includes('usdc'))) {
    return true
  }
  // "Deposited funds" is typically a margin deposit
  if (type === 'OTHER' && title.toLowerCase().includes('deposited funds')) {
    return true
  }
  return false
}

/**
 * Parse date from Coinbase format (e.g., "Jan 6, 2026") to ISO (YYYY-MM-DD)
 */
const parseCoinbaseDateToISO = (dateText: string): string => {
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  }

  // Match "Jan 6, 2026" or "January 6, 2026"
  const match = dateText.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (!match || !match[1] || !match[2] || !match[3]) {
    log.warn(`[Coinbase] Unable to parse date: ${dateText}`)
    return new Date().toISOString().split('T')[0] ?? new Date().toISOString().substring(0, 10)
  }

  const monthKey = match[1].toLowerCase().substring(0, 3)
  const month = months[monthKey] ?? '01'
  const day = match[2].padStart(2, '0')
  const year = match[3]

  return `${year}-${month}-${day}`
}

/**
 * Parse amount string to number (handles "$1,234.56", "-$50.00", "+$10.00")
 */
const parseCoinbaseAmount = (amountText: string): number => {
  const cleaned = amountText.replace(/[,$]/g, '').trim()
  const num = parseFloat(cleaned)
  return isNaN(num) ? 0 : num
}

/**
 * Extract symbol from title (e.g., "Bought BTC PERP" -> "BTC")
 */
const extractSymbolFromTitle = (title: string): string | undefined => {
  // Match patterns like "BTC PERP", "USDC reward", "BTC reward"
  const perpMatch = title.match(/([A-Z]{2,5})\s+PERP/i)
  if (perpMatch?.[1]) return perpMatch[1].toUpperCase()

  const rewardMatch = title.match(/([A-Z]{2,5})\s+reward/i)
  if (rewardMatch?.[1]) return rewardMatch[1].toUpperCase()

  return undefined
}

/**
 * Extract contracts from secondary amount (e.g., "+1 contract" -> 1)
 */
const extractContracts = (secondaryText: string): number | undefined => {
  const match = secondaryText.match(/([+-]?\d+)\s*contracts?/i)
  if (match?.[1]) return Math.abs(parseInt(match[1], 10))
  return undefined
}

/**
 * Load or create Coinbase transactions archive
 */
const loadCoinbaseTransactionsArchive = async (): Promise<CoinbaseTransactionArchive> => {
  await mkdir(SCRAPE_ARCHIVE_DIR, { recursive: true })
  const archivePath = join(SCRAPE_ARCHIVE_DIR, 'coinbase-transactions.json')

  const content = await readFile(archivePath, 'utf-8').catch(() => null)
  if (content) {
    return JSON.parse(content) as CoinbaseTransactionArchive
  }

  return {
    platform: 'coinbase-transactions',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    transactions: []
  }
}

/**
 * Save Coinbase transactions archive
 */
const saveCoinbaseTransactionsArchive = async (archive: CoinbaseTransactionArchive): Promise<void> => {
  await mkdir(SCRAPE_ARCHIVE_DIR, { recursive: true })
  const archivePath = join(SCRAPE_ARCHIVE_DIR, 'coinbase-transactions.json')
  archive.updatedAt = new Date().toISOString()
  await writeFile(archivePath, JSON.stringify(archive, null, 2), 'utf-8')
}

/**
 * Add transaction to Coinbase archive if not already present
 */
const addToCoinbaseTransactionsArchive = (
  archive: CoinbaseTransactionArchive,
  tx: CoinbaseScrapedTransaction
): boolean => {
  const exists = archive.transactions.some(t => t.id === tx.id)
  if (!exists) {
    archive.transactions.push(tx)
    // Sort by date descending (newest first)
    archive.transactions.sort((a, b) => b.date.localeCompare(a.date))
    return true
  }
  return false
}

/**
 * Find Coinbase transactions page in browser
 */
const findCoinbaseTransactionsPage = async (browser: Browser): Promise<Page | null> => {
  const contexts = browser.contexts()
  log.debug(`[Coinbase TX] Found ${contexts.length} browser contexts`)

  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!
    const pages = context.pages()
    log.debug(`[Coinbase TX] Context ${i} has ${pages.length} pages`)

    for (const page of pages) {
      const pageUrl = page.url()
      log.debug(`[Coinbase TX]   Page URL: ${pageUrl}`)

      // Match any Coinbase page (not just /transactions) so we can handle modals
      if (pageUrl.includes('coinbase.com') &&
          !pageUrl.includes('/signin') && !pageUrl.includes('/login')) {
        log.debug(`[Coinbase TX] Found Coinbase page: ${pageUrl}`)
        return page
      }
    }
  }

  return null
}

/**
 * Handles the Coinbase "Advanced Trade" modal that blocks the transactions page.
 * If the modal is present, clicks "Turn off Advanced" to dismiss it.
 * Returns true if modal was handled, false if no modal was present.
 *
 * NOTE: The selectors below rely on Coinbase's internal `data-testid` attributes.
 * These are brittle and may change when Coinbase updates their UI. If this logic
 * stops working, verify the modal structure in browser DevTools and update the
 * selectors accordingly.
 */
const handleAdvancedTradeModal = async (
  page: Page,
  sendEvent?: (event: string, data: Record<string, unknown>) => void
): Promise<boolean> => {
  // Brittle selectors based on Coinbase's current UI - see JSDoc note above
  const modalSelector = '[data-testid="simple-mode-feature-nux-modal"]'
  const confirmButtonSelector = '[data-testid="simple-nux-confirm-button"]'

  log.debug('[Coinbase TX] Checking for Advanced Trade modal...')

  // Wait briefly for the modal to potentially appear (it may load after page)
  await page.waitForTimeout(500)

  // Try to wait for the modal with a short timeout
  const modal = await page.waitForSelector(modalSelector, { timeout: 1500 }).catch(() => null)
  if (!modal) {
    log.debug('[Coinbase TX] No Advanced Trade modal detected')
    return false
  }

  log.debug('[Coinbase TX] Advanced Trade modal detected, turning off Advanced mode...')
  sendEvent?.('status', { message: 'Turning off Advanced Trade mode...', phase: 'navigating' })

  // Wait for the confirm button to be visible and clickable
  const confirmButton = await page.waitForSelector(confirmButtonSelector, {
    state: 'visible',
    timeout: 5000
  }).catch(() => null)

  if (confirmButton) {
    // Use page.click for more reliable clicking
    await page.click(confirmButtonSelector)
    log.debug('[Coinbase TX] Clicked "Turn off Advanced" button')

    // Wait for navigation/reload after clicking
    await page.waitForTimeout(2000)

    // Wait for the transactions page to be ready
    await page.waitForLoadState('networkidle').catch(() => null)

    log.debug('[Coinbase TX] Advanced Trade mode disabled')
    sendEvent?.('status', { message: 'Advanced Trade mode disabled', phase: 'navigating' })
    return true
  }

  log.debug('[Coinbase TX] Could not find confirm button in modal')
  return false
}

/**
 * Closes any open detail dialog reliably
 */
const closeDetailDialog = async (page: Page): Promise<void> => {
  const dialogSelector = '[data-testid="advanced-trade-details-body"]'

  // Check if dialog is open
  const dialog = await page.$(dialogSelector)
  if (!dialog) return

  log.debug('[Coinbase TX] Closing open dialog...')

  // Try close button first
  const closeButton = await page.$('[data-testid="close-cta"]')
  if (closeButton) {
    await closeButton.click()
  } else {
    await page.keyboard.press('Escape')
  }

  // Wait for dialog to close
  await page.waitForSelector(dialogSelector, { state: 'hidden', timeout: 3000 }).catch(() => {
    log.warn('[Coinbase TX] Dialog did not close via button/Escape')
  })

  // Double-check and try clicking outside if still open
  const stillOpen = await page.$(dialogSelector)
  if (stillOpen) {
    await page.click('body', { position: { x: 10, y: 10 } }).catch(() => null)
    await page.waitForTimeout(500)
    await page.waitForSelector(dialogSelector, { state: 'hidden', timeout: 2000 }).catch(() => {
      log.error('[Coinbase TX] Dialog STILL open after all close attempts!')
    })
  }

  await page.waitForTimeout(200)
}

/**
 * Extract fee from transaction detail dialog.
 * Clicks on the row to open the dialog, extracts fee info, then closes it.
 * Returns the total fee (sum of Coinbase fee + Reg and exchange fee if present).
 *
 * IMPORTANT: This function re-queries the row by ID before clicking to avoid stale
 * element handles. It also verifies the dialog content after opening to ensure we
 * clicked on the correct row.
 */
const extractFeeFromDetailDialog = async (
  page: Page,
  rowId: string,
  rowSelector: string,
  expectedTitle: string
): Promise<number | undefined> => {
  const dialogSelector = '[data-testid="advanced-trade-details-body"]'

  // First, ensure no dialog is already open
  await closeDetailDialog(page)

  // Re-query for the row by ID to get a fresh element handle
  // This avoids stale element handles that might point to wrong content after DOM changes
  const freshRow = await page.$(`${rowSelector}[id="${rowId}"]`)
  if (!freshRow) {
    log.debug(`[Coinbase TX] Row with ID "${rowId.substring(0, 30)}..." no longer exists, skipping fee extraction`)
    return undefined
  }

  // Verify the row title is still a BUY/SELL
  const rowTitle = await freshRow.$('p[class*="headline"]').then(el => el?.textContent()).catch(() => null)
  if (!rowTitle) {
    log.debug('[Coinbase TX] Row headline not found, skipping fee extraction')
    return undefined
  }

  const titleUpper = rowTitle.toUpperCase()
  if (!titleUpper.includes('BOUGHT') && !titleUpper.includes('SOLD')) {
    log.warn(`[Coinbase TX] Row title "${rowTitle}" is not a BUY/SELL, skipping click (expected: "${expectedTitle}")`)
    return undefined
  }

  // Extra safety: verify title matches what we expected
  if (rowTitle.trim() !== expectedTitle.trim()) {
    log.warn(`[Coinbase TX] Row title mismatch! Found "${rowTitle}" but expected "${expectedTitle}", skipping click`)
    return undefined
  }

  log.debug(`[Coinbase TX] Clicking on row: "${rowTitle}" (ID: ${rowId.substring(0, 20)}...)`)

  // Click on the freshly queried row
  await freshRow.click()

  // Wait for the detail dialog to appear
  const dialog = await page.waitForSelector(dialogSelector, {
    timeout: 5000
  }).catch(() => null)

  if (!dialog) {
    log.debug('[Coinbase TX] Could not open detail dialog for fee extraction')
    return undefined
  }

  // Small delay to ensure dialog is fully rendered
  await page.waitForTimeout(500)

  // CRITICAL: Verify the dialog is for a BUY/SELL, not a Funding entry
  // The dialog title should contain "Bought" or "Sold"
  // Target the h1 title element specifically (e.g., "Bought 1 BTC Perpetual contract")
  // NOTE: This selector uses partial class match [class*="title"] which may break if
  // Coinbase changes their styling. If scraping fails, check the dialog structure.
  // Expected: h1 with a class containing "title" inside the trade details body.
  // FALLBACK: If selector fails (returns null), we skip title verification and attempt
  // to parse the transaction anyway. This allows scraping to continue even if the
  // dialog structure changes, though it may occasionally parse non-trade entries.
  const dialogTitle = await page.$eval(
    '[data-testid="advanced-trade-details-body"] h1[class*="title"]',
    el => el.textContent
  ).catch(() => null)

  if (dialogTitle) {
    const dialogTitleUpper = dialogTitle.toUpperCase()
    if (!dialogTitleUpper.includes('BOUGHT') && !dialogTitleUpper.includes('SOLD')) {
      log.error(`[Coinbase TX] WRONG DIALOG OPENED! Dialog title: "${dialogTitle}", expected BUY/SELL. Closing immediately.`)
      await closeDetailDialog(page)
      return undefined
    }
    log.debug(`[Coinbase TX] Dialog title verified: "${dialogTitle}"`)
  }

  let totalFee = 0

  // Find all base-row elements that might contain fee info
  const feeRows = await page.$$('[data-testid="base-row"]')

  for (const feeRow of feeRows) {
    const rowText = await feeRow.textContent()
    if (!rowText) continue

    const lowerText = rowText.toLowerCase()

    // Check if this row contains fee information
    // Look for: "Coinbase fee", "Reg and exchange fee", or just "Fee"
    if (lowerText.includes('fee')) {
      // Extract the dollar amount from this row
      // The format is typically: "Coinbase fee$0.68" or "Fee$8.45"
      const dollarMatch = rowText.match(/\$([0-9,.]+)/)
      if (dollarMatch && dollarMatch[1]) {
        const feeValue = parseFloat(dollarMatch[1].replace(/,/g, ''))
        if (!isNaN(feeValue)) {
          totalFee += feeValue
        }
      }
    }
  }

  // Close the dialog
  await closeDetailDialog(page)

  return totalFee > 0 ? totalFee : undefined
}

/**
 * Parse a single Coinbase transaction row
 */
const parseCoinbaseTransactionRow = async (
  row: ElementHandle<Element>
): Promise<CoinbaseScrapedTransaction | null> => {
  // Get row ID (base64 encoded transaction ID)
  const rowId = await row.getAttribute('id')
  if (!rowId) return null

  // Decode the ID (it's typically base64)
  const idMatch = rowId.match(/id="([^"]+)"/) || [null, rowId]
  const decodedId = idMatch[1] ?? rowId

  // Get all cells
  const cells = await row.$$('td')
  if (cells.length < 3) return null

  // First cell: title (headline)
  const firstCell = cells[0]
  if (!firstCell) return null

  // Find headline element - look for paragraph with headline class
  const headlineEl = await firstCell.$('p[class*="headline"]')
  const title = (await headlineEl?.textContent() ?? '').trim()
  if (!title) return null

  // Second cell: amounts
  const secondCell = cells[1]
  if (!secondCell) return null

  const amountParagraphs = await secondCell.$$('p')
  const primaryAmountText = await amountParagraphs[0]?.textContent() ?? ''
  const secondaryAmountText = await amountParagraphs[1]?.textContent() ?? ''

  // Third cell: date
  const thirdCell = cells[2]
  if (!thirdCell) return null

  const dateEl = await thirdCell.$('p')
  const dateText = await dateEl?.textContent() ?? ''

  // Parse the data
  const type = determineCoinbaseTransactionType(title)
  const amount = parseCoinbaseAmount(primaryAmountText)
  const date = parseCoinbaseDateToISO(dateText)
  const symbol = extractSymbolFromTitle(title)
  const contracts = extractContracts(secondaryAmountText)

  // Calculate price for trades
  let price: number | undefined
  if (contracts && contracts > 0 && Math.abs(amount) > 0) {
    price = Math.abs(amount) / contracts
  }

  const result: CoinbaseScrapedTransaction = {
    id: decodedId,
    date,
    type,
    title,
    amount,
    isPerpRelated: isPerpRelatedType(type) || isMarginRelated(type, title, symbol)
  }

  // Add optional properties only if they have values
  if (secondaryAmountText) result.secondaryAmount = secondaryAmountText
  if (contracts !== undefined) result.contracts = contracts
  if (price !== undefined) result.price = price
  if (symbol) result.symbol = symbol

  return result
}

/**
 * Scrape Coinbase transactions with progress updates
 */
const scrapeCoinbaseTransactionsWithProgress = async (
  page: Page,
  archive: CoinbaseTransactionArchive,
  onProgress: (current: number, total: number, tx: CoinbaseScrapedTransaction | null) => void,
  stopDate?: string,
  maxScrolls = 500,
  onNewTransaction?: (tx: CoinbaseScrapedTransaction) => Promise<void>
): Promise<{ newCount: number; totalScraped: number; stoppedAtDate: boolean }> => {
  // Wait for transaction rows to load
  await page.waitForSelector('tr[data-testid="transaction-history-row"]', {
    timeout: 15000
  }).catch(() => null)

  await page.waitForTimeout(2000)

  let totalScraped = 0
  let newCount = 0
  let previousItemCount = 0
  let noNewItemsCount = 0
  let stoppedAtDate = false
  let consecutiveExisting = 0  // Track consecutive already-scraped transactions
  const MAX_CONSECUTIVE_EXISTING = 50  // Stop early if we've seen this many existing txns in a row

  const rowSelector = 'tr[data-testid="transaction-history-row"]'

  // Helper to close any open dialog - uses the shared closeDetailDialog function
  const closeAnyOpenDialog = async () => {
    await closeDetailDialog(page)
  }

  // Track processed row IDs to avoid reprocessing after DOM changes
  const processedRowIds = new Set<string>()

  // Process items and scroll loop
  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    // Ensure no dialog is open before processing rows
    await closeAnyOpenDialog()

    // Keep processing rows until we've handled all visible ones
    let madeProgress = true
    while (madeProgress) {
      madeProgress = false

      // Re-fetch rows each iteration since DOM may have changed
      const rows = await page.$$(rowSelector)

      for (const row of rows) {
        // Get the row ID to check if we've already processed it
        const rowId = await row.getAttribute('id')
        if (!rowId || processedRowIds.has(rowId)) continue

        // Safety check: close any dialog that might have been opened unexpectedly
        await closeAnyOpenDialog()

        const tx = await parseCoinbaseTransactionRow(row)
        if (!tx) {
          // Mark as processed even if we couldn't parse it
          processedRowIds.add(rowId)
          continue
        }

        // Mark as processed
        processedRowIds.add(rowId)
        madeProgress = true

        // Check if we've reached the stop date
        if (stopDate && tx.date < stopDate) {
          log.debug(`[Coinbase TX] Reached stop date ${stopDate}, stopping at ${tx.date}`)
          stoppedAtDate = true
          await saveCoinbaseTransactionsArchive(archive)
          return { newCount, totalScraped, stoppedAtDate }
        }

        // Check if this is a new transaction before extracting fees (expensive operation)
        const existsInArchive = archive.transactions.some(t => t.id === tx.id)

        // For BUY/SELL transactions, extract fee from detail dialog (only for new transactions)
        // Double-check title contains "Bought" or "Sold" to avoid clicking on funding/other entries
        const titleUpper = tx.title.toUpperCase()
        const isBuySellTitle = titleUpper.includes('BOUGHT') || titleUpper.includes('SOLD')

        let didExtractFee = false
        if (!existsInArchive && (tx.type === 'BUY' || tx.type === 'SELL') && isBuySellTitle) {
          log.debug(`[Coinbase TX] Extracting fee for: "${tx.title}" (type: ${tx.type}, rowId: ${rowId.substring(0, 20)}...)`)
          // Pass rowId and rowSelector so the function can re-query the row by ID
          // This ensures we click on the correct row even if DOM shifted
          const fee = await extractFeeFromDetailDialog(page, rowId, rowSelector, tx.title)
          if (fee !== undefined) {
            tx.fee = fee
            log.debug(`[Coinbase TX] Extracted fee $${fee.toFixed(2)} for ${tx.type} ${tx.contracts} contracts`)
          }
          didExtractFee = true
        } else if (!existsInArchive && (tx.type === 'BUY' || tx.type === 'SELL') && !isBuySellTitle) {
          // Log a warning if type detection is wrong
          log.warn(`[Coinbase TX] Skipping fee extraction - type is ${tx.type} but title is "${tx.title}"`)
        }

        totalScraped++
        const isNew = addToCoinbaseTransactionsArchive(archive, tx)
        if (isNew) {
          newCount++
          consecutiveExisting = 0  // Reset counter when we find a new transaction
          // Save incrementally every 10 new transactions
          if (newCount % 10 === 0) {
            await saveCoinbaseTransactionsArchive(archive)
          }
          // Call real-time apply callback if provided
          if (onNewTransaction) {
            await onNewTransaction(tx)
          }
        } else {
          consecutiveExisting++
          // Early exit: if we've seen many consecutive existing transactions, we're caught up
          if (consecutiveExisting >= MAX_CONSECUTIVE_EXISTING) {
            log.debug(`[Coinbase TX] Early exit: ${consecutiveExisting} consecutive existing transactions, stopping scrape`)
            await saveCoinbaseTransactionsArchive(archive)
            return { newCount, totalScraped, stoppedAtDate: false }
          }
        }
        onProgress(totalScraped, rows.length, tx)

        // After opening a dialog for fee extraction, break and re-fetch rows since DOM may have shifted
        if (didExtractFee) {
          break
        }
      }
    }

    // Ensure no dialog is open before scrolling
    await closeAnyOpenDialog()

    // Scroll to load more
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await page.waitForTimeout(2000)

    // Try scrolling specific container if main scroll doesn't work
    await page.evaluate(() => {
      const scrollableContainers = document.querySelectorAll('[class*="scroll"], [style*="overflow"]')
      scrollableContainers.forEach(container => {
        if (container instanceof HTMLElement && container.scrollHeight > container.clientHeight) {
          container.scrollTop = container.scrollHeight
        }
      })
    })
    await page.waitForTimeout(500)

    // Check if we got new items
    const newRows = await page.$$(rowSelector)
    const currentRowCount = newRows.length
    if (currentRowCount === previousItemCount) {
      noNewItemsCount++
      // Wait for 5 consecutive scrolls with no new items
      if (noNewItemsCount >= 5) {
        // Try one more aggressive scroll before giving up
        await page.evaluate(() => {
          window.scrollBy(0, 5000)
        })
        await page.waitForTimeout(3000)
        const finalCheck = await page.$$(rowSelector)
        if (finalCheck.length === currentRowCount) {
          log.debug(`[Coinbase TX] End of list detected after ${totalScraped} transactions`)
          break
        }
        // Aggressive scroll loaded more items - reset counter to continue normal scrolling
        log.debug(`[Coinbase TX] Aggressive scroll loaded ${finalCheck.length - currentRowCount} more items`)
        noNewItemsCount = 0
      }
    } else {
      noNewItemsCount = 0
    }
    previousItemCount = currentRowCount

    // Safety limit
    if (totalScraped > 10000) {
      break
    }
  }

  // Final save
  await saveCoinbaseTransactionsArchive(archive)

  return { newCount, totalScraped, stoppedAtDate }
}

/**
 * Load or create Coinbase derivatives archive
 */
const loadCoinbaseArchive = async (): Promise<CoinbaseDerivativesArchive> => {
  await mkdir(SCRAPE_ARCHIVE_DIR, { recursive: true })
  const archivePath = join(SCRAPE_ARCHIVE_DIR, 'coinbase-btcd.json')

  const content = await readFile(archivePath, 'utf-8').catch(() => null)
  if (content) {
    return JSON.parse(content) as CoinbaseDerivativesArchive
  }

  return {
    platform: 'coinbase-btcd',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fundingPayments: [],
    rewards: []
  }
}

/**
 * Save Coinbase derivatives archive
 */
const saveCoinbaseArchive = async (archive: CoinbaseDerivativesArchive): Promise<void> => {
  await mkdir(SCRAPE_ARCHIVE_DIR, { recursive: true })
  const archivePath = join(SCRAPE_ARCHIVE_DIR, 'coinbase-btcd.json')
  archive.updatedAt = new Date().toISOString()
  await writeFile(archivePath, JSON.stringify(archive, null, 2), 'utf-8')
}

/**
 * Generate unique ID for funding entry
 */
const generateFundingId = (date: string, amount: number): string => {
  return `funding-${date}-${amount.toFixed(2).replace(/[-.]/g, '_')}`
}

/**
 * Generate unique ID for reward entry
 */
const generateRewardId = (date: string, amount: number, type: string): string => {
  return `reward-${date}-${type}-${amount.toFixed(2).replace(/[-.]/g, '_')}`
}

/**
 * Add funding entry to archive if not already present
 */
const addFundingToArchive = (archive: CoinbaseDerivativesArchive, entry: CoinbaseFundingEntry): boolean => {
  const exists = archive.fundingPayments.some(f => f.id === entry.id)
  if (!exists) {
    archive.fundingPayments.push(entry)
    // Sort by date descending
    archive.fundingPayments.sort((a, b) => b.date.localeCompare(a.date))
    return true
  }
  return false
}

/**
 * Add reward entry to archive if not already present
 */
const addRewardToArchive = (archive: CoinbaseDerivativesArchive, entry: CoinbaseRewardEntry): boolean => {
  const exists = archive.rewards.some(r => r.id === entry.id)
  if (!exists) {
    archive.rewards.push(entry)
    // Sort by date descending
    archive.rewards.sort((a, b) => b.date.localeCompare(a.date))
    return true
  }
  return false
}

/**
 * Find Coinbase perpetual futures page in browser
 */
const findCoinbaseFuturesPage = async (browser: Browser): Promise<Page | null> => {
  const contexts = browser.contexts()
  log.debug(`[Coinbase] Found ${contexts.length} browser contexts`)

  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!
    const pages = context.pages()
    for (const page of pages) {
      const pageUrl = page.url()
      // Look for perpetual futures or portfolio pages
      if (pageUrl.includes('coinbase.com') &&
          (pageUrl.includes('perpetual') || pageUrl.includes('portfolio') || pageUrl.includes('intx')) &&
          !pageUrl.includes('/signin') && !pageUrl.includes('/login')) {
        log.debug(`[Coinbase] Found Coinbase page: ${pageUrl}`)
        return page
      }
    }
  }

  return null
}

/**
 * Fetch cash balance from Coinbase home page
 * Navigates to coinbase.com/home and extracts cash balance from the balance breakdown
 */
const fetchCoinbaseCashBalance = async (
  page: Page,
  sendEvent?: (event: string, data: Record<string, unknown>) => void
): Promise<number | null> => {
  const currentUrl = page.url()
  log.debug(`[Coinbase] Fetching cash balance, current URL: ${currentUrl}`)

  // Navigate to home page if not already there
  if (!currentUrl.includes('coinbase.com/home')) {
    sendEvent?.('status', { message: 'Fetching cash balance from Coinbase...', phase: 'loading' })

    const navResult = await page.goto('https://www.coinbase.com/home', {
      waitUntil: 'load',
      timeout: 30000
    }).catch((err: Error) => err)

    if (navResult instanceof Error) {
      log.debug(`[Coinbase] Failed to navigate to home: ${navResult.message}`)
      return null
    }

    // Wait for balance to load
    await page.waitForTimeout(2000)
  }

  // Find the cash balance cell using aria-label
  // Format: aria-label="Your Cash balance is $528,143.20, view assets"
  const cashButton = await page.$('[data-testid="cash-balance-cell-cell-pressable"]').catch(() => null)

  if (!cashButton) {
    log.debug('[Coinbase] Cash balance cell not found')
    return null
  }

  const ariaLabel = await cashButton.getAttribute('aria-label').catch(() => null)
  log.debug(`[Coinbase] Cash balance aria-label: ${ariaLabel}`)

  if (!ariaLabel) return null

  // Extract amount from "Your Cash balance is $528,143.20, view assets"
  const match = ariaLabel.match(/Your Cash balance is \$([\d,]+\.?\d*)/)
  if (!match || !match[1]) {
    log.debug('[Coinbase] Could not parse cash balance from aria-label')
    return null
  }

  const cashBalance = parseFloat(match[1].replace(/,/g, ''))
  log.debug(`[Coinbase] Extracted cash balance: ${cashBalance}`)

  return cashBalance
}

/**
 * Position data scraped from Coinbase Advanced Trade
 */
interface CoinbasePositionData {
  symbol: string           // e.g., "BTC PERP"
  contracts: number        // e.g., 430
  value: number            // Position value at mark price
  avgEntry: number         // Average entry price
  markPrice: number        // Current mark/spot price
  estLiqPrice: number | null  // Estimated liquidation price (null if not shown)
  pnl: number              // Unrealized P&L (can be negative)
  funding: number          // Funding (can be negative)
}

/**
 * Build the Coinbase Advanced Trade URL for a given product ID
 * Futures contracts (BIP-*) go under /futures/, perpetuals go directly under /advanced-trade/
 */
const buildAdvancedTradeUrl = (productId: string): string => {
  // Futures contracts start with BIP- (Bitcoin Index Price futures)
  if (productId.startsWith('BIP-')) {
    return `https://www.coinbase.com/advanced-trade/futures/${productId}`
  }
  // Perpetuals like BTC-PERP-INTX go directly under advanced-trade
  return `https://www.coinbase.com/advanced-trade/${productId}`
}

/**
 * Fetch position data from Coinbase Advanced Trade positions tab
 * Navigates to advanced-trade and extracts position info including liquidation price
 */
const fetchCoinbasePositionData = async (
  page: Page,
  productId?: string,
  sendEvent?: (event: string, data: Record<string, unknown>) => void
): Promise<CoinbasePositionData | null> => {
  const currentUrl = page.url()
  log.info(`[Coinbase Position] Fetching position data, current URL: ${currentUrl}, productId: ${productId}`)

  // Build target URL based on product ID
  const targetProductId = productId || 'BTC-PERP-INTX'
  const targetUrl = buildAdvancedTradeUrl(targetProductId)

  // Navigate to Advanced Trade if not already there or on wrong product
  if (!currentUrl.includes('coinbase.com/advanced-trade') || !currentUrl.includes(targetProductId)) {
    sendEvent?.('status', { message: 'Fetching position data from Advanced Trade...', phase: 'loading' })
    log.debug(`[Coinbase] Navigating to: ${targetUrl}`)

    const navResult = await page.goto(targetUrl, {
      waitUntil: 'load',
      timeout: 30000
    }).catch((err: Error) => err)

    if (navResult instanceof Error) {
      log.debug(`[Coinbase] Failed to navigate to Advanced Trade: ${navResult.message}`)
      return null
    }

    // Wait for page to fully load
    await page.waitForTimeout(3000)
  }

  // Handle "Turn on Advanced" modal if it appears
  const turnOnAdvancedBtn = await page.$('[data-testid="advanced-nux-confirm-button"]').catch(() => null)
  if (turnOnAdvancedBtn) {
    log.debug('[Coinbase] Found "Turn on Advanced" modal, clicking confirm button...')
    await turnOnAdvancedBtn.click().catch(() => {})
    await page.waitForTimeout(2000)
  }

  // Click on Positions tab if not already selected
  const positionsTab = await page.$('button:has-text("Positions")').catch(() => null)
  if (positionsTab) {
    await positionsTab.click().catch(() => {})
    await page.waitForTimeout(1000)
  }

  // Wait for positions table to load
  await page.waitForSelector('[data-testid="positions-table-content"]', { timeout: 5000 }).catch(() => null)

  // Try to find position row by product display name first, then fallback to first row
  const displayName = targetProductId.split('-').slice(0, 2).join(' ')
  let positionRow = await page.$(`[data-testid="positions-table-content"] tbody tr:has-text("${displayName}")`).catch(() => null)

  // Fallback to first row in positions table
  if (!positionRow) {
    positionRow = await page.$('[data-testid="positions-table-content"] tbody tr').catch(() => null)
  }

  if (!positionRow) {
    log.info('[Coinbase Position] No position row found in positions table')
    return null
  }

  // Extract all cell values from the position row
  const cells = await positionRow.$$('td').catch(() => [])
  if (cells.length < 10) {
    log.info(`[Coinbase Position] Position row has ${cells.length} cells, expected at least 10`)
    return null
  }

  // Parse cell values based on column order in the screenshot:
  // Name | Amount | Value | Avg Entry | Mark Price | Est Liq Price | TP/SL | Initial Margin | Margin Ratio | Funding | PnL | Actions
  const getText = async (cell: typeof cells[0] | undefined): Promise<string> => {
    const text = await cell?.innerText().catch(() => '') ?? ''
    return text.trim()
  }

  const parseNumber = (text: string): number => {
    // Remove $, commas, and handle direction arrows (↓↑↘↗ indicate negative/positive)
    // ↘ (southeast arrow) means negative/down, ↗ (northeast arrow) means positive/up
    let cleaned = text.replace(/[$,]/g, '').trim()
    // Handle arrows - ↘ and ↓ indicate negative values
    if (cleaned.includes('↘') || cleaned.includes('↓')) {
      cleaned = cleaned.replace(/[↘↓]/g, '')
      const num = parseFloat(cleaned)
      return isNaN(num) ? 0 : -Math.abs(num)
    }
    // ↗ and ↑ indicate positive values (just remove the arrow)
    cleaned = cleaned.replace(/[↗↑]/g, '')
    const num = parseFloat(cleaned)
    return isNaN(num) ? 0 : num
  }

  // Log all cell values to help debug column alignment issues
  const allCellTexts: string[] = []
  for (let i = 0; i < cells.length; i++) {
    const text = await getText(cells[i])
    allCellTexts.push(`[${i}]="${text.substring(0, 30)}"`)
  }
  log.info(`[Coinbase Position] All cells (${cells.length}): ${allCellTexts.join(', ')}`)

  const nameCell = await getText(cells[0])
  const amountText = await getText(cells[1])
  const valueText = await getText(cells[2])
  const avgEntryText = await getText(cells[3])
  const markPriceText = await getText(cells[4])
  const estLiqPriceText = await getText(cells[5])
  const fundingText = cells[9] ? await getText(cells[9]) : ''
  const pnlText = cells[10] ? await getText(cells[10]) : ''

  log.info(`[Coinbase Position] Raw: estLiqPrice="${estLiqPriceText}", markPrice="${markPriceText}", pnl="${pnlText}"`)

  // Extract contracts count (e.g., "430 contracts" -> 430)
  const contractsMatch = amountText.match(/([\d,]+)\s*contracts?/i)
  const contracts = contractsMatch ? parseNumber(contractsMatch[1] ?? '0') : 0

  // Parse liquidation price (may be "--" or empty)
  let estLiqPrice: number | null = null
  if (estLiqPriceText && estLiqPriceText !== '--' && !estLiqPriceText.includes('--')) {
    const parsedLiqPrice = parseNumber(estLiqPriceText)
    estLiqPrice = parsedLiqPrice === 0 ? null : parsedLiqPrice
  }

  const positionData: CoinbasePositionData = {
    symbol: nameCell,
    contracts,
    value: parseNumber(valueText),
    avgEntry: parseNumber(avgEntryText),
    markPrice: parseNumber(markPriceText),
    estLiqPrice,
    pnl: parseNumber(pnlText),
    funding: parseNumber(fundingText)
  }

  log.info(`[Coinbase Position] Parsed: estLiqPrice=${positionData.estLiqPrice}, markPrice=${positionData.markPrice}, pnl=${positionData.pnl}`)

  return positionData
}

/**
 * Find Coinbase rewards/interest page
 */
const findCoinbaseRewardsPage = async (browser: Browser): Promise<Page | null> => {
  const contexts = browser.contexts()

  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!
    const pages = context.pages()
    for (const page of pages) {
      const pageUrl = page.url()
      if (pageUrl.includes('coinbase.com') &&
          (pageUrl.includes('rewards') || pageUrl.includes('earn')) &&
          !pageUrl.includes('/signin') && !pageUrl.includes('/login')) {
        log.debug(`[Coinbase] Found Coinbase rewards page: ${pageUrl}`)
        return page
      }
    }
  }

  return null
}

/**
 * GET /import/coinbase-btcd/archive
 * Get the Coinbase derivatives scrape archive with summary.
 */
importRouter.get('/coinbase-btcd/archive', async (_req, res) => {
  const archive = await loadCoinbaseArchive()

  // Calculate summary
  let totalFundingProfit = 0
  let totalFundingLoss = 0
  let totalRewards = 0

  for (const funding of archive.fundingPayments) {
    if (funding.amount >= 0) {
      totalFundingProfit += funding.amount
    } else {
      totalFundingLoss += Math.abs(funding.amount)
    }
  }

  for (const reward of archive.rewards) {
    totalRewards += reward.amount
  }

  res.json({
    platform: archive.platform,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    summary: {
      fundingPaymentCount: archive.fundingPayments.length,
      rewardCount: archive.rewards.length,
      totalFundingProfit,
      totalFundingLoss,
      netFunding: totalFundingProfit - totalFundingLoss,
      totalRewards
    },
    fundingPayments: archive.fundingPayments,
    rewards: archive.rewards
  })
})

/**
 * POST /import/coinbase-btcd/funding/manual
 * Add manual funding entry (for funding not captured by API or scraping).
 *
 * Body: { date: string, amount: number, productId?: string }
 */
importRouter.post('/coinbase-btcd/funding/manual', async (req, res) => {
  const { date, amount, productId } = req.body as {
    date?: string
    amount?: number
    productId?: string
  }

  if (!date || amount === undefined) {
    res.status(400).json({ error: 'Missing required fields: date, amount' })
    return
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
    return
  }

  const archive = await loadCoinbaseArchive()

  const entry: CoinbaseFundingEntry = {
    id: generateFundingId(date, amount),
    date,
    amount,
    productId: productId ?? 'BIP-20DEC30-CDE'
  }

  const added = addFundingToArchive(archive, entry)

  if (added) {
    await saveCoinbaseArchive(archive)
    res.json({
      success: true,
      message: `Added funding entry for ${date}: ${amount >= 0 ? '+' : ''}${amount.toFixed(2)}`,
      entry
    })
  } else {
    res.json({
      success: false,
      message: `Funding entry already exists for ${date} with amount ${amount}`,
      entry
    })
  }
})

/**
 * POST /import/coinbase-btcd/rewards/manual
 * Add manual reward entry (USDC interest, etc.).
 *
 * Body: { date: string, amount: number, type?: string, description?: string }
 */
importRouter.post('/coinbase-btcd/rewards/manual', async (req, res) => {
  const { date, amount, type, description } = req.body as {
    date?: string
    amount?: number
    type?: 'usdc_interest' | 'staking' | 'other'
    description?: string
  }

  if (!date || amount === undefined) {
    res.status(400).json({ error: 'Missing required fields: date, amount' })
    return
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
    return
  }

  const archive = await loadCoinbaseArchive()

  const rewardType = type ?? 'usdc_interest'
  const entry: CoinbaseRewardEntry = {
    id: generateRewardId(date, amount, rewardType),
    date,
    amount,
    type: rewardType,
    ...(description && { description })
  }

  const added = addRewardToArchive(archive, entry)

  if (added) {
    await saveCoinbaseArchive(archive)
    res.json({
      success: true,
      message: `Added reward entry for ${date}: +${amount.toFixed(2)}`,
      entry
    })
  } else {
    res.json({
      success: false,
      message: `Reward entry already exists for ${date}`,
      entry
    })
  }
})

/**
 * POST /import/coinbase-btcd/funding/bulk
 * Import funding entries in bulk from JSON format (like funding-manual.json).
 *
 * Body: { entries: Record<string, number> }  // { "YYYY-MM-DD": amount, ... }
 */
importRouter.post('/coinbase-btcd/funding/bulk', async (req, res) => {
  const { entries, productId } = req.body as {
    entries?: Record<string, number>
    productId?: string
  }

  if (!entries || typeof entries !== 'object') {
    res.status(400).json({ error: 'Missing required field: entries (object of date -> amount)' })
    return
  }

  const archive = await loadCoinbaseArchive()
  let added = 0
  let skipped = 0

  for (const [date, amount] of Object.entries(entries)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      log.debug(`[Coinbase] Skipping invalid date format: ${date}`)
      skipped++
      continue
    }

    const entry: CoinbaseFundingEntry = {
      id: generateFundingId(date, amount),
      date,
      amount,
      productId: productId ?? 'BIP-20DEC30-CDE'
    }

    if (addFundingToArchive(archive, entry)) {
      added++
    } else {
      skipped++
    }
  }

  await saveCoinbaseArchive(archive)

  res.json({
    success: true,
    message: `Imported ${added} funding entries, ${skipped} skipped (duplicates or invalid)`,
    added,
    skipped,
    total: archive.fundingPayments.length
  })
})

/**
 * POST /import/coinbase-btcd/rewards/bulk
 * Import reward entries in bulk from JSON format (like rewards-manual.json).
 *
 * Body: { entries: Record<string, number>, type?: string }
 */
importRouter.post('/coinbase-btcd/rewards/bulk', async (req, res) => {
  const { entries, type } = req.body as {
    entries?: Record<string, number>
    type?: 'usdc_interest' | 'staking' | 'other'
  }

  if (!entries || typeof entries !== 'object') {
    res.status(400).json({ error: 'Missing required field: entries (object of date -> amount)' })
    return
  }

  const archive = await loadCoinbaseArchive()
  let added = 0
  let skipped = 0
  const rewardType = type ?? 'usdc_interest'

  for (const [date, amount] of Object.entries(entries)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      log.debug(`[Coinbase] Skipping invalid date format: ${date}`)
      skipped++
      continue
    }

    const entry: CoinbaseRewardEntry = {
      id: generateRewardId(date, amount, rewardType),
      date,
      amount,
      type: rewardType
    }

    if (addRewardToArchive(archive, entry)) {
      added++
    } else {
      skipped++
    }
  }

  await saveCoinbaseArchive(archive)

  res.json({
    success: true,
    message: `Imported ${added} reward entries, ${skipped} skipped (duplicates or invalid)`,
    added,
    skipped,
    total: archive.rewards.length
  })
})

/**
 * GET /import/browser/status/coinbase
 * Check if Coinbase is open and logged in the browser.
 */
importRouter.get('/browser/status/coinbase', async (_req, res) => {
  const browser = await connectToBrowser().catch(() => null)

  if (!browser) {
    res.json({
      browserConnected: false,
      coinbaseFound: false,
      loggedIn: false,
      message: 'Browser not connected. Launch browser first.'
    })
    return
  }

  const futuresPage = await findCoinbaseFuturesPage(browser)

  if (!futuresPage) {
    res.json({
      browserConnected: true,
      coinbaseFound: false,
      loggedIn: false,
      message: 'No Coinbase perpetual futures page found. Navigate to coinbase.com/portfolio/perpetual-futures and log in.'
    })
    return
  }

  // Check if logged in by looking for user-specific elements
  const isLoggedIn = await futuresPage.evaluate(() => {
    // Look for signs of being logged in
    const hasPortfolio = document.querySelector('[data-testid="portfolio"]') !== null
    const hasBalance = document.body.innerText.includes('Total Balance') ||
                       document.body.innerText.includes('Portfolio Value') ||
                       document.body.innerText.includes('USDC')
    const hasSignInPrompt = document.body.innerText.includes('Sign in') &&
                           !document.body.innerText.includes('Signed in')
    return (hasPortfolio || hasBalance) && !hasSignInPrompt
  }).catch(() => false)

  res.json({
    browserConnected: true,
    coinbaseFound: true,
    loggedIn: isLoggedIn,
    currentUrl: futuresPage.url(),
    message: isLoggedIn
      ? 'Coinbase is connected and logged in'
      : 'Coinbase page found but may not be logged in'
  })
})

/**
 * POST /import/scrape/coinbase/funding
 * Scrape funding payments from Coinbase perpetual futures UI.
 * Note: Scraping may not capture all data - use API where possible.
 *
 * This is a placeholder for future implementation.
 * The Coinbase API (fetchFundingPayments) is the preferred method.
 */
importRouter.post('/scrape/coinbase/funding', async (_req, res, next) => {
  const browser = await connectToBrowser().catch((err: Error) => {
    return next(badRequest(`Failed to connect to browser: ${err.message}`))
  })

  if (!browser || !(browser instanceof Object && 'contexts' in browser)) {
    return next(badRequest('Browser connection failed'))
  }

  const page = await findCoinbaseFuturesPage(browser as Browser)
  if (!page) {
    res.status(400).json({
      error: 'Coinbase perpetual futures page not found',
      hint: 'Navigate to coinbase.com/portfolio/perpetual-futures and log in first'
    })
    return
  }

  // For now, return guidance since Coinbase API is the better source
  res.json({
    message: 'Coinbase funding scraping not yet implemented',
    hint: 'Use the API endpoints at /api/v1/derivatives/funding/:productId for funding data. The API provides more reliable data than UI scraping.',
    alternatives: [
      'POST /api/v1/import/coinbase-btcd/funding/manual - Add individual entries',
      'POST /api/v1/import/coinbase-btcd/funding/bulk - Import from JSON',
      'GET /api/v1/derivatives/funding/:productId - Fetch from Coinbase API'
    ]
  })
})

/**
 * POST /import/scrape/coinbase/rewards
 * Scrape USDC rewards/interest from Coinbase UI.
 *
 * This is a placeholder for future implementation.
 */
importRouter.post('/scrape/coinbase/rewards', async (_req, res, next) => {
  const browser = await connectToBrowser().catch((err: Error) => {
    return next(badRequest(`Failed to connect to browser: ${err.message}`))
  })

  if (!browser || !(browser instanceof Object && 'contexts' in browser)) {
    return next(badRequest('Browser connection failed'))
  }

  const page = await findCoinbaseRewardsPage(browser as Browser)
  if (!page) {
    res.status(400).json({
      error: 'Coinbase rewards page not found',
      hint: 'Navigate to coinbase.com rewards or earnings page and log in first'
    })
    return
  }

  // For now, return guidance
  res.json({
    message: 'Coinbase rewards scraping not yet implemented',
    hint: 'Use manual entry endpoints for now. USDC interest is typically paid weekly.',
    alternatives: [
      'POST /api/v1/import/coinbase-btcd/rewards/manual - Add individual entries',
      'POST /api/v1/import/coinbase-btcd/rewards/bulk - Import from JSON'
    ]
  })
})

/**
 * DELETE /import/coinbase-btcd/funding/:date
 * Delete a funding entry by date and amount.
 *
 * Query: { amount: number }
 */
importRouter.delete('/coinbase-btcd/funding/:date', async (req, res) => {
  const date = req.params['date']
  const amount = parseFloat(req.query['amount'] as string)

  if (!date) {
    res.status(400).json({ error: 'Missing date parameter' })
    return
  }

  if (isNaN(amount)) {
    res.status(400).json({ error: 'Missing or invalid amount query parameter' })
    return
  }

  const archive = await loadCoinbaseArchive()
  const id = generateFundingId(date, amount)
  const index = archive.fundingPayments.findIndex(f => f.id === id)

  if (index === -1) {
    res.status(404).json({ error: `Funding entry not found for ${date} with amount ${amount}` })
    return
  }

  archive.fundingPayments.splice(index, 1)
  await saveCoinbaseArchive(archive)

  res.json({
    success: true,
    message: `Deleted funding entry for ${date}`,
    remaining: archive.fundingPayments.length
  })
})

/**
 * DELETE /import/coinbase-btcd/rewards/:date
 * Delete a reward entry by date.
 *
 * Query: { amount: number, type?: string }
 */
importRouter.delete('/coinbase-btcd/rewards/:date', async (req, res) => {
  const date = req.params['date']
  const amount = parseFloat(req.query['amount'] as string)
  const type = (req.query['type'] as string) ?? 'usdc_interest'

  if (!date) {
    res.status(400).json({ error: 'Missing date parameter' })
    return
  }

  if (isNaN(amount)) {
    res.status(400).json({ error: 'Missing or invalid amount query parameter' })
    return
  }

  const archive = await loadCoinbaseArchive()
  const id = generateRewardId(date, amount, type)
  const index = archive.rewards.findIndex(r => r.id === id)

  if (index === -1) {
    res.status(404).json({ error: `Reward entry not found for ${date} with amount ${amount}` })
    return
  }

  archive.rewards.splice(index, 1)
  await saveCoinbaseArchive(archive)

  res.json({
    success: true,
    message: `Deleted reward entry for ${date}`,
    remaining: archive.rewards.length
  })
})

// ============================================================================
// Coinbase Transactions Page Scraping Endpoints
// ============================================================================

/**
 * GET /import/coinbase/transactions/archive
 * Get the Coinbase transactions scrape archive with summary.
 */
importRouter.get('/coinbase/transactions/archive', async (_req, res) => {
  const archive = await loadCoinbaseTransactionsArchive()

  // Calculate summary
  let fundingProfit = 0
  let fundingLoss = 0
  let usdcInterest = 0
  let rebates = 0
  let perpTradeCount = 0
  let nonPerpCount = 0

  for (const tx of archive.transactions) {
    if (tx.type === 'FUNDING_PROFIT') fundingProfit += tx.amount
    else if (tx.type === 'FUNDING_LOSS') fundingLoss += Math.abs(tx.amount)
    else if (tx.type === 'USDC_INTEREST') usdcInterest += tx.amount
    else if (tx.type === 'REBATE') rebates += tx.amount
    else if (tx.type === 'BUY' || tx.type === 'SELL') perpTradeCount++

    if (tx.isPerpRelated) continue
    nonPerpCount++
  }

  res.json({
    platform: archive.platform,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    summary: {
      totalTransactions: archive.transactions.length,
      perpRelatedCount: archive.transactions.length - nonPerpCount,
      nonPerpCount,
      fundingProfit,
      fundingLoss,
      netFunding: fundingProfit - fundingLoss,
      usdcInterest,
      rebates,
      perpTradeCount
    },
    transactions: archive.transactions
  })
})

/**
 * Group Coinbase transactions by date and consolidate same-type entries.
 * For REBATE, FUNDING, INTEREST, DEPOSIT, WITHDRAW: combine amounts into single entry per type per day.
 * For BUY/SELL: keep individual entries since they have distinct contracts/prices.
 */
const consolidateCoinbaseTransactionsByDate = (transactions: CoinbaseScrapedTransaction[]): FundEntry[] => {
  const txByDate = new Map<string, {
    deposits: number
    withdrawals: number
    funding: number
    interest: number
    rebate: number
    trades: { type: string; amount: number; contracts?: number; price?: number; fee?: number }[]
  }>()

  for (const tx of transactions) {
    if (!txByDate.has(tx.date)) {
      txByDate.set(tx.date, { deposits: 0, withdrawals: 0, funding: 0, interest: 0, rebate: 0, trades: [] })
    }
    const day = txByDate.get(tx.date)!

    if (tx.type === 'DEPOSIT') {
      day.deposits += tx.amount
    } else if (tx.type === 'WITHDRAWAL') {
      day.withdrawals += Math.abs(tx.amount)
    } else if (tx.type === 'OTHER' && tx.title.toLowerCase().includes('deposited funds')) {
      day.deposits += tx.amount
    } else if (tx.type === 'FUNDING_PROFIT' || tx.type === 'FUNDING_LOSS') {
      day.funding += tx.amount // FUNDING_LOSS is already negative
    } else if (tx.type === 'USDC_INTEREST') {
      day.interest += tx.amount
    } else if (tx.type === 'REBATE') {
      day.rebate += tx.amount
    } else if (tx.type === 'BUY' || tx.type === 'SELL') {
      const tradeEntry: { type: string; amount: number; contracts?: number; price?: number; fee?: number } = {
        type: tx.type,
        amount: tx.amount
      }
      if (tx.contracts !== undefined) tradeEntry.contracts = tx.contracts
      if (tx.price !== undefined) tradeEntry.price = tx.price
      if (tx.fee !== undefined) tradeEntry.fee = tx.fee
      day.trades.push(tradeEntry)
    }
  }

  // Convert to fund entries
  const entries: FundEntry[] = []

  for (const [date, day] of txByDate) {
    if (day.deposits > 0) {
      entries.push({ date, value: 0, action: 'DEPOSIT', amount: day.deposits })
    }
    if (day.withdrawals > 0) {
      entries.push({ date, value: 0, action: 'WITHDRAW', amount: day.withdrawals })
    }
    if (day.interest !== 0) {
      entries.push({ date, value: 0, action: 'INTEREST', amount: day.interest })
    }
    if (day.rebate !== 0) {
      entries.push({ date, value: 0, action: 'REBATE', amount: day.rebate })
    }
    if (day.funding !== 0) {
      entries.push({ date, value: 0, action: 'FUNDING', amount: day.funding })
    }
    for (const trade of day.trades) {
      const entry: FundEntry = {
        date,
        value: 0,
        action: trade.type as 'BUY' | 'SELL',
        amount: Math.abs(trade.amount)
      }
      if (trade.contracts !== undefined) entry.contracts = trade.contracts
      if (trade.price !== undefined) entry.price = trade.price
      if (trade.fee !== undefined && trade.fee > 0) entry.fee = trade.fee
      entries.push(entry)
    }
  }

  return entries
}

/**
 * Sort fund entries by date and action priority
 */
const sortFundEntries = (entries: FundEntry[]): FundEntry[] => {
  const actionOrder: Record<string, number> = {
    'DEPOSIT': 1,
    'WITHDRAW': 2,
    'INTEREST': 3,
    'REBATE': 4,
    'BUY': 5,
    'SELL': 6,
    'FEE': 7,  // Fee comes after the trade it's associated with
    'FUNDING': 8,
    'HOLD': 9
  }

  return [...entries].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date)
    if (dateCompare !== 0) return dateCompare

    const aAction = a.action ?? 'HOLD'
    const bAction = b.action ?? 'HOLD'
    const aPriority = actionOrder[aAction] ?? 99
    const bPriority = actionOrder[bAction] ?? 99
    return aPriority - bPriority
  })
}

/**
 * GET /import/coinbase/transactions/scrape-stream
 * Stream Coinbase transactions scraping progress via SSE.
 *
 * Query params:
 *   - stopDate: ISO date to stop scraping at (default: scrape all)
 *   - fundId: Fund ID to get start date from and apply transactions to after scraping
 *   - clearFundEntries: If true, clear fund entries immediately before scraping
 */
importRouter.get('/coinbase/transactions/scrape-stream', async (req, res) => {
  const { stopDate: stopDateParam, fundId, clearFundEntries } = req.query as {
    stopDate?: string
    fundId?: string
    clearFundEntries?: string
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: Record<string, unknown>) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  sendEvent('status', { message: 'Connecting to browser...', phase: 'connecting' })

  // Connect to browser
  const browser = await connectToBrowser().catch((err: Error) => {
    sendEvent('error', { message: `Failed to connect: ${err.message}` })
    return null
  })

  if (!browser) {
    res.end()
    return
  }

  sendEvent('status', { message: 'Looking for Coinbase transactions page...', phase: 'navigating' })

  // Try to find existing transactions page
  let page = await findCoinbaseTransactionsPage(browser)

  if (page) {
    log.debug(`[Coinbase TX] Using existing Coinbase page: ${page.url()}`)
    sendEvent('status', { message: 'Found Coinbase page', phase: 'navigating' })

    // If not on transactions page, navigate there
    if (!page.url().includes('/transactions')) {
      log.debug('[Coinbase TX] Navigating existing page to transactions...')
      sendEvent('status', { message: 'Navigating to transactions...', phase: 'navigating' })

      const navResult = await page.goto('https://www.coinbase.com/transactions', {
        waitUntil: 'load',
        timeout: 30000
      }).catch((err: Error) => err)

      if (navResult instanceof Error) {
        log.debug(`[Coinbase TX] Navigation failed: ${navResult.message}`)
        sendEvent('error', { message: `Navigation failed: ${navResult.message}` })
        res.end()
        return
      }

      await page.waitForTimeout(2000)
    }
  } else {
    // No existing page - create new one
    log.debug('[Coinbase TX] No Coinbase page found, creating new one')
    sendEvent('status', { message: 'Opening Coinbase transactions...', phase: 'navigating' })

    page = await createNewPage(browser).catch((err: Error) => {
      sendEvent('error', { message: err.message })
      return null
    }) as Page | null

    if (!page) {
      res.end()
      return
    }

    // Navigate to Coinbase transactions
    log.debug('[Coinbase TX] Navigating new page to transactions...')
    const navResult = await page.goto('https://www.coinbase.com/transactions', {
      waitUntil: 'load',
      timeout: 30000
    }).catch((err: Error) => err)

    log.debug(`[Coinbase TX] Navigation result: ${navResult instanceof Error ? navResult.message : 'success'}`)

    if (navResult instanceof Error) {
      sendEvent('error', { message: `Navigation failed: ${navResult.message}` })
      await page.close().catch(() => {})
      res.end()
      return
    }

    await page.waitForTimeout(2000)
    log.debug(`[Coinbase TX] After navigation, URL: ${page.url()}`)

    // Check if redirected to login
    if (page.url().includes('/signin') || page.url().includes('/login')) {
      log.debug('[Coinbase TX] Redirected to login - user needs to log in manually')
      sendEvent('error', {
        message: 'Please log in to Coinbase in your browser first, then navigate to the transactions page and try again.'
      })
      res.end()
      return
    }
  }

  // Check for and handle the Advanced Trade modal that blocks the transactions page
  await handleAdvancedTradeModal(page, sendEvent)

  // Determine stop date
  let stopDate = stopDateParam

  // If fundId provided, try to get first entry date as stop date
  if (fundId && !stopDate) {
    sendEvent('status', { message: 'Loading fund data...', phase: 'loading' })

    const fundData = await readFund(join(FUNDS_DIR, `${fundId}.tsv`)).catch(() => null)
    if (fundData?.entries?.length) {
      // Use first entry date (entries are chronological)
      const sorted = [...fundData.entries].sort((a, b) => a.date.localeCompare(b.date))
      stopDate = sorted[0]!.date
      log.debug(`[Coinbase TX] Using first entry date as stop date: ${stopDate}`)
    }
  }

  sendEvent('status', {
    message: stopDate
      ? `Scraping transactions until ${stopDate}...`
      : 'Scraping all transactions...',
    phase: 'loading',
    stopDate
  })

  // Set up fund for clearing and batch apply
  let fund: FundData | null = null
  let fundPath: string | null = null
  const shouldClearFund = clearFundEntries === 'true' && fundId
  const shouldApplyToFund = fundId !== undefined
  let entriesApplied = 0

  // Always load fund when fundId is provided (needed for cash balance update)
  if (fundId) {
    fundPath = join(FUNDS_DIR, `${fundId}.tsv`)
    fund = await readFund(fundPath).catch(() => null)
  }

  if (fundId && shouldClearFund && fund && fundPath) {
    // Clear fund entries immediately
    const previousCount = fund.entries.length
    fund.entries = []
    await writeFund(fundPath, fund)
    sendEvent('status', {
      message: `Cleared ${previousCount} existing entries from fund`,
      phase: 'loading',
      cleared: previousCount
    })
    log.debug(`[Coinbase TX] Cleared ${previousCount} entries from fund ${fundId}`)
  }

  // Load existing archive
  const archive = await loadCoinbaseTransactionsArchive()
  const existingCount = archive.transactions.length

  sendEvent('status', {
    message: existingCount > 0
      ? `Found ${existingCount} existing transactions. Scraping for new data...`
      : 'Starting fresh scrape...',
    phase: 'scraping',
    existingCount
  })

  // Scrape with progress updates (no real-time apply - we'll batch apply at the end)
  const result = await scrapeCoinbaseTransactionsWithProgress(
    page,
    archive,
    (current, total, tx) => {
      sendEvent('progress', {
        current,
        total,
        newCount: archive.transactions.length - existingCount,
        entriesApplied: 0, // Will be set after batch apply
        lastTransaction: tx ? {
          date: tx.date,
          type: tx.type,
          symbol: tx.symbol,
          amount: tx.amount,
          title: tx.title.substring(0, 50),
          isPerpRelated: tx.isPerpRelated
        } : null
      })
    },
    stopDate,
    500,
    undefined // No real-time apply callback
  ).catch((err: Error) => {
    sendEvent('error', { message: `Scraping error: ${err.message}` })
    return null
  })

  // Batch apply all perp-related transactions to fund after scraping completes
  if (result && shouldApplyToFund && fundId && fund && fundPath) {
    sendEvent('status', {
      message: 'Applying transactions to fund...',
      phase: 'applying'
    })

    // Fund was already loaded earlier (and cleared if clearFundEntries was set)
    // Preserve any existing HOLD entries with cash balance (from scrapes)
    const existingCashHolds = fund.entries.filter(e =>
      e.action === 'HOLD' && e.cash !== undefined && e.cash > 0
    )

    // Convert all perp-related transactions to fund entries
    const perpTxns = archive.transactions.filter(t => t.isPerpRelated)
    const allEntries: FundEntry[] = []

    // Consolidate transactions by date (combine same-day REBATE, FUNDING, INTEREST into single entries)
    const consolidatedEntries = consolidateCoinbaseTransactionsByDate(perpTxns)

    // Add initial deposit from config if set (for derivatives funds)
    // Use earliest transaction date as the deposit date
    const initialDeposit = (fund.config as { initial_deposit?: number }).initial_deposit
    if (initialDeposit && initialDeposit > 0) {
      const sortedConsolidated = [...consolidatedEntries].sort((a, b) => a.date.localeCompare(b.date))
      const earliestTxDate = sortedConsolidated.length > 0
        ? sortedConsolidated[0]!.date
        : new Date().toISOString().slice(0, 10)
      allEntries.push({
        date: earliestTxDate,
        value: 0,
        action: 'DEPOSIT',
        amount: initialDeposit,
        notes: 'Initial margin deposit'
      })
    }
    allEntries.push(...consolidatedEntries)

    // Re-add preserved HOLD entries with cash balance
    allEntries.push(...existingCashHolds)

    // Sort all entries properly and add to fund
    fund.entries = sortFundEntries(allEntries)
    entriesApplied = fund.entries.length

    await writeFund(fundPath, fund)
    log.debug(`[Coinbase TX] Batch applied ${entriesApplied} entries to fund ${fundId}`)

    sendEvent('applied', { entriesApplied, lastDate: fund.entries[fund.entries.length - 1]?.date || '' })
  }

  // Keep the Coinbase page open for user reference (don't close it)

  // Fetch current cash balance from Coinbase home page
  log.debug(`[Coinbase TX] Calling fetchCoinbaseCashBalance...`)
  const cashBalance = await fetchCoinbaseCashBalance(page, sendEvent)
  log.debug(`[Coinbase TX] Cash balance result: ${cashBalance}`)

  // For derivatives funds, also fetch position data (liquidation price, mark price, etc.)
  const isDerivativesFund = fund?.config.fund_type === 'derivatives'
  let positionData: CoinbasePositionData | null = null
  if (isDerivativesFund) {
    const productId = (fund?.config as { product_id?: string }).product_id
    log.info(`[Coinbase TX] Fetching position data for derivatives fund, productId: ${productId}...`)
    positionData = await fetchCoinbasePositionData(page, productId, sendEvent)
    log.info(`[Coinbase TX] Position data result: estLiqPrice=${positionData?.estLiqPrice}, markPrice=${positionData?.markPrice}`)
  }

  // Update or create cash entry if we have a fund and cash balance
  let cashUpdated = false
  if ((cashBalance !== null || positionData !== null) && fundId && fund && fundPath) {
    // Check if we need to update - compare to latest entry's cash
    const latestEntry = fund.entries[fund.entries.length - 1]
    const latestCash = latestEntry?.cash ?? 0
    const today = new Date().toISOString().slice(0, 10)

    const cashChanged = cashBalance !== null && Math.abs(cashBalance - latestCash) > CASH_BALANCE_UPDATE_THRESHOLD
    const hasPositionData = positionData !== null && positionData.estLiqPrice !== null

    // Only update if cash changed significantly or we have new position data
    if (cashChanged || hasPositionData) {
      // Check if latest entry is from today and is HOLD - update it
      if (latestEntry && latestEntry.date === today && latestEntry.action === 'HOLD') {
        if (cashBalance !== null) latestEntry.cash = cashBalance
        // Add position data if available
        if (positionData) {
          if (positionData.estLiqPrice !== null) latestEntry.liquidation_price = positionData.estLiqPrice
          if (positionData.pnl !== null) latestEntry.unrealized_pnl = positionData.pnl
        }
        log.debug(`[Coinbase TX] Updated today's HOLD entry with cash: ${cashBalance}, liqPrice: ${positionData?.estLiqPrice}`)
      } else {
        // Create new HOLD entry with cash and position data
        const holdEntry: FundEntry = {
          date: today,
          value: 0,
          action: 'HOLD',
          notes: 'Cash balance update from scrape'
        }
        if (cashBalance !== null) holdEntry.cash = cashBalance
        if (positionData) {
          if (positionData.estLiqPrice !== null) holdEntry.liquidation_price = positionData.estLiqPrice
          if (positionData.pnl !== null) holdEntry.unrealized_pnl = positionData.pnl
        }
        fund.entries.push(holdEntry)
        log.debug(`[Coinbase TX] Created new HOLD entry with cash: ${cashBalance}, liqPrice: ${positionData?.estLiqPrice}`)
      }

      await writeFund(fundPath, fund)
      cashUpdated = true
      sendEvent('cashUpdated', {
        cashBalance,
        date: today,
        positionData: positionData ? {
          estLiqPrice: positionData.estLiqPrice,
          markPrice: positionData.markPrice,
          pnl: positionData.pnl
        } : null
      })
    }
  }

  if (result) {
    // Calculate summary of scraped data
    const perpTxns = archive.transactions.filter(t => t.isPerpRelated)

    const message = entriesApplied > 0
      ? `Scraped ${result.totalScraped} transactions, applied ${entriesApplied} entries to fund`
      : result.newCount > 0
        ? `Scraped ${result.totalScraped} transactions, ${result.newCount} new (${perpTxns.length} perp-related)`
        : `Scraped ${result.totalScraped} transactions, all already in archive`

    sendEvent('complete', {
      totalScraped: result.totalScraped,
      newCount: result.newCount,
      archiveTotal: archive.transactions.length,
      perpRelatedCount: perpTxns.length,
      stoppedAtDate: result.stoppedAtDate,
      entriesApplied,
      cashBalance,
      cashUpdated,
      message
    })
  }

  res.end()
})

/**
 * DELETE /import/coinbase/transactions/archive
 * Clear the Coinbase transactions archive.
 */
importRouter.delete('/coinbase/transactions/archive', async (_req, res) => {
  const archive: CoinbaseTransactionArchive = {
    platform: 'coinbase-transactions',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    transactions: []
  }
  await saveCoinbaseTransactionsArchive(archive)

  res.json({
    success: true,
    message: 'Coinbase transactions archive cleared'
  })
})

/**
 * POST /import/coinbase/transactions/apply
 * Apply selected Coinbase transactions to a fund.
 */
importRouter.post('/coinbase/transactions/apply', async (req, res) => {
  const { fundId, transactionIds, selectedTypes, clearBeforeImport } = req.body as {
    fundId: string
    transactionIds: string[]
    selectedTypes: string[]
    clearBeforeImport: boolean
  }

  if (!fundId) {
    res.status(400).json({ error: 'Missing fundId' })
    return
  }

  if (!transactionIds || transactionIds.length === 0) {
    res.status(400).json({ error: 'No transactions to import' })
    return
  }

  // Load the fund
  const fundPath = join(FUNDS_DIR, `${fundId}.tsv`)
  const fund = await readFund(fundPath).catch(() => null)
  if (!fund) {
    res.status(404).json({ error: `Fund not found: ${fundId}` })
    return
  }

  // Load the archive
  const archive = await loadCoinbaseTransactionsArchive()
  if (archive.transactions.length === 0) {
    res.status(400).json({ error: 'No transactions in archive' })
    return
  }

  // Get selected transactions
  const selectedTxIds = new Set(transactionIds)
  const selectedTxTypes = new Set(selectedTypes)
  const selectedTxs = archive.transactions.filter(tx =>
    selectedTxIds.has(tx.id) &&
    selectedTxTypes.has(tx.type) &&
    tx.isPerpRelated
  )

  if (selectedTxs.length === 0) {
    res.status(400).json({ error: 'No matching transactions found' })
    return
  }

  // Clear existing entries if requested
  if (clearBeforeImport) {
    fund.entries = []

    // Add initial deposit from config if set (for derivatives funds)
    const initialDeposit = (fund.config as { initial_deposit?: number }).initial_deposit
    if (initialDeposit && initialDeposit > 0) {
      // Use earliest selected transaction date as deposit date
      const sortedTxs = [...selectedTxs].sort((a, b) => a.date.localeCompare(b.date))
      const earliestTxDate = sortedTxs.length > 0 ? sortedTxs[0]!.date : new Date().toISOString().slice(0, 10)
      fund.entries.push({
        date: earliestTxDate,
        value: 0,
        action: 'DEPOSIT',
        amount: initialDeposit,
        notes: 'Initial margin deposit'
      })
    }
  }

  // Get existing entry dates to check for duplicates
  const existingDates = new Set(fund.entries.map(e => e.date))

  // Group transactions by date and aggregate by type
  const txByDate = new Map<string, {
    deposits: number     // Margin deposits (USDC)
    withdrawals: number  // Margin withdrawals (USDC)
    funding: number      // Net funding (profit - loss)
    interest: number     // USDC interest
    rebate: number       // Trading rebates
    trades: { type: string; amount: number; contracts?: number; price?: number; fee?: number }[]
  }>()

  for (const tx of selectedTxs) {
    if (!txByDate.has(tx.date)) {
      txByDate.set(tx.date, { deposits: 0, withdrawals: 0, funding: 0, interest: 0, rebate: 0, trades: [] })
    }
    const day = txByDate.get(tx.date)!

    if (tx.type === 'DEPOSIT') {
      day.deposits += tx.amount
    } else if (tx.type === 'WITHDRAWAL') {
      day.withdrawals += Math.abs(tx.amount)  // Store as positive
    } else if (tx.type === 'OTHER' && tx.title.toLowerCase().includes('deposited funds')) {
      // "Deposited funds" is a margin deposit
      day.deposits += tx.amount
    } else if (tx.type === 'FUNDING_PROFIT') {
      day.funding += tx.amount
    } else if (tx.type === 'FUNDING_LOSS') {
      day.funding += tx.amount // Already negative
    } else if (tx.type === 'USDC_INTEREST') {
      day.interest += tx.amount
    } else if (tx.type === 'REBATE') {
      day.rebate += tx.amount
    } else if (tx.type === 'BUY' || tx.type === 'SELL') {
      const tradeEntry: { type: string; amount: number; contracts?: number; price?: number; fee?: number } = {
        type: tx.type,
        amount: tx.amount
      }
      if (tx.contracts !== undefined) {
        tradeEntry.contracts = tx.contracts
      }
      if (tx.price !== undefined) {
        tradeEntry.price = tx.price
      }
      if (tx.fee !== undefined) {
        tradeEntry.fee = tx.fee
      }
      day.trades.push(tradeEntry)
    }
  }

  // Convert to fund entries - use derivatives-specific action types
  let applied = 0
  let skipped = 0
  const newEntries: FundEntry[] = []

  for (const [date, day] of txByDate) {
    // Skip dates that already have entries (unless cleared)
    if (!clearBeforeImport && existingDates.has(date)) {
      skipped++
      continue
    }

    // Create separate entries for each type of transaction using derivatives actions

    // DEPOSIT entry (margin deposits)
    if (day.deposits > 0) {
      newEntries.push({
        date,
        value: 0,
        action: 'DEPOSIT',
        amount: day.deposits
      })
      applied++
    }

    // WITHDRAW entry (margin withdrawals)
    if (day.withdrawals > 0) {
      newEntries.push({
        date,
        value: 0,
        action: 'WITHDRAW',
        amount: day.withdrawals
      })
      applied++
    }

    // FUNDING entry (combines profit and loss for the day)
    if (day.funding !== 0) {
      newEntries.push({
        date,
        value: 0,
        action: 'FUNDING',
        amount: day.funding  // Can be positive or negative
      })
      applied++
    }

    // INTEREST entry (USDC rewards)
    if (day.interest !== 0) {
      newEntries.push({
        date,
        value: 0,
        action: 'INTEREST',
        amount: day.interest
      })
      applied++
    }

    // REBATE entry (trading rebates)
    if (day.rebate !== 0) {
      newEntries.push({
        date,
        value: 0,
        action: 'REBATE',
        amount: day.rebate
      })
      applied++
    }

    // Trade entries (BUY/SELL)
    for (const trade of day.trades) {
      const entry: FundEntry = {
        date,
        value: 0,
        action: trade.type as 'BUY' | 'SELL',
        amount: Math.abs(trade.amount)
      }
      // Use contracts field for derivatives (not shares)
      if (trade.contracts !== undefined) {
        entry.contracts = trade.contracts
      }
      // Store entry price
      if (trade.price !== undefined) {
        entry.price = trade.price
      }
      // Add fee directly to the BUY/SELL entry
      if (trade.fee !== undefined && trade.fee > 0) {
        entry.fee = trade.fee
      }
      newEntries.push(entry)
      applied++
    }
  }

  // Add new entries to fund
  fund.entries.push(...newEntries)

  // Sort entries by date and action priority
  fund.entries = sortFundEntries(fund.entries)

  // Save the fund
  await writeFund(fundPath, fund)

  log.debug(`[Coinbase Import] Applied ${applied} entries to ${fundId}, skipped ${skipped} duplicates`)

  res.json({
    success: true,
    applied,
    skipped,
    message: `Imported ${applied} entries to ${fundId}`
  })
})

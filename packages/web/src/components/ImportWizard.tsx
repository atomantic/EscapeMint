import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  previewRobinhoodImport,
  applyRobinhoodImport,
  applyM1CashImport,
  readFileAsText,
  getBrowserStatus,
  navigateBrowser,
  launchBrowser,
  connectBrowser,
  scrapeRobinhoodHistoryStream,
  scrapeRobinhoodHistory,
  scrapeM1CashHistoryStream,
  killBrowser,
  getScrapeArchive,
  getLocalCryptoStatements,
  parseAllCryptoStatements,
  importCryptoToFund,
  downloadCryptoStatementsStream,
  getLocalM1Statements,
  parseAllM1Statements,
  applyM1StatementTransactions,
  downloadM1StatementsStream,
  scrapeCoinbaseTransactionsStream,
  getCoinbaseTransactionsArchive,
  type CoinbaseTransactionArchive,
  type ImportPreview,
  type ScrapeProgressEvent,
  type ScrapeStatusEvent,
  type ScrapeArchive,
  type ParsedTransaction,
  type CryptoParseAllResponse,
  type CryptoStatementsResponse,
  type M1StatementsListResponse,
  type M1StatementsParseAllResponse,
  type CoinbaseScrapeStatusEvent,
  type CoinbaseScrapeProgressEvent
} from '../api/import'
import { notifyFundsChanged, fetchFunds, type FundSummary } from '../api/funds'

/**
 * Coinbase Scrape Step Component
 * Inline component for handling Coinbase transactions scraping within the ImportWizard
 */
function CoinbaseScrapeStep({
  onDataReady,
  onClose
}: {
  onDataReady: (archive: CoinbaseTransactionArchive) => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<'loading' | 'idle' | 'scraping' | 'complete' | 'error'>('loading')
  const [status, setStatus] = useState('')
  const [current, setCurrent] = useState(0)
  const [total, setTotal] = useState(0)
  const [existingArchive, setExistingArchive] = useState<CoinbaseTransactionArchive | null>(null)
  const [lastTx, setLastTx] = useState<{
    date: string
    type: string
    symbol?: string
    amount: number
    title: string
    isPerpRelated: boolean
  } | null>(null)

  const scrapeStreamRef = useRef<{ close: () => void } | null>(null)

  // Check for existing archive on mount
  useEffect(() => {
    getCoinbaseTransactionsArchive().then(result => {
      if (result.data && result.data.transactions.length > 0) {
        setExistingArchive(result.data)
      }
      setPhase('idle')
    })
  }, [])

  const handleStartScrape = useCallback(() => {
    setPhase('scraping')
    setStatus('Connecting to browser...')
    setCurrent(0)
    setTotal(0)

    scrapeStreamRef.current = scrapeCoinbaseTransactionsStream(
      {},
      {
        onStatus: (data: CoinbaseScrapeStatusEvent) => {
          setStatus(data.message)
        },
        onProgress: (data: CoinbaseScrapeProgressEvent) => {
          setCurrent(data.current)
          setTotal(data.total)
          setLastTx(data.lastTransaction)
          setStatus(`Scraped ${data.current} transactions (${data.newCount} new)`)
        },
        onComplete: () => {
          // Re-fetch archive to get updated data with summary
          getCoinbaseTransactionsArchive().then(result => {
            if (result.data) {
              setPhase('complete')
              setStatus(`Scraped ${result.data.transactions.length} transactions`)
              setExistingArchive(result.data)
              toast.success(`Scraped ${result.data.transactions.length} transactions`)
            }
          })
        },
        onError: (data) => {
          setPhase('error')
          setStatus(data.message)
          toast.error(data.message)
        }
      }
    )
  }, [])

  const handleCancel = useCallback(() => {
    scrapeStreamRef.current?.close()
    setPhase('idle')
    setStatus('')
    toast.info('Scraping cancelled')
  }, [])

  const handleUseSavedData = useCallback(() => {
    if (existingArchive) {
      onDataReady(existingArchive)
    }
  }, [existingArchive, onDataReady])

  const handleContinueAfterScrape = useCallback(() => {
    if (existingArchive) {
      onDataReady(existingArchive)
    }
  }, [existingArchive, onDataReady])

  useEffect(() => {
    return () => {
      scrapeStreamRef.current?.close()
    }
  }, [])

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  return (
    <div className="space-y-6">
      <div className="text-center py-4">
        <div className="text-6xl mb-4">🪙</div>
        <h3 className="text-xl font-medium text-white mb-2">Coinbase Transactions Scrape</h3>
        <p className="text-slate-400 max-w-md mx-auto">
          Scrape funding payments, trades, and rewards from your Coinbase transactions page.
        </p>
      </div>

      {phase === 'loading' && (
        <div className="text-center py-8">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Checking for saved data...</p>
        </div>
      )}

      {phase === 'idle' && existingArchive && (
        <div className="space-y-4">
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
            <div className="flex items-start gap-3">
              <div className="text-2xl">📁</div>
              <div className="flex-1 min-w-0">
                <h4 className="text-white font-medium">Saved Data Available</h4>
                <p className="text-slate-400 text-sm mt-1">
                  {existingArchive.transactions.length.toLocaleString()} transactions saved
                  <span className="text-slate-500"> • </span>
                  {existingArchive.summary.perpRelatedCount.toLocaleString()} perp-related
                </p>
                <p className="text-slate-500 text-xs mt-1">
                  Last updated: {formatDate(existingArchive.updatedAt)}
                </p>
                {existingArchive.summary && (
                  <div className="mt-2 text-xs text-slate-400 space-y-1">
                    <div className="flex gap-4">
                      <span>Net Funding: <span className={existingArchive.summary.netFunding >= 0 ? 'text-green-400' : 'text-red-400'}>
                        ${existingArchive.summary.netFunding.toFixed(2)}
                      </span></span>
                      <span>USDC Interest: <span className="text-green-400">${existingArchive.summary.usdcInterest.toFixed(2)}</span></span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={handleUseSavedData}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              Use Saved Data
            </button>
            <button
              onClick={handleStartScrape}
              className="px-6 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
            >
              Re-scrape for Updates
            </button>
          </div>
        </div>
      )}

      {phase === 'idle' && !existingArchive && (
        <div className="text-center">
          <p className="text-sm text-slate-400 mb-6">
            Make sure you have the Coinbase transactions page open in your browser and are logged in.
          </p>
          <button
            onClick={handleStartScrape}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Start Scraping
          </button>
        </div>
      )}

      {phase === 'scraping' && (
        <div className="bg-slate-800/50 rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-slate-300">{status}</span>
          </div>

          {total > 0 && (
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${Math.min((current / total) * 100, 100)}%` }}
              />
            </div>
          )}

          {lastTx && (
            <div className="text-xs text-slate-400 flex items-center gap-2 flex-wrap">
              <span className={lastTx.isPerpRelated ? 'text-blue-400' : 'text-slate-500'}>
                {lastTx.isPerpRelated ? 'PERP' : 'Other'}
              </span>
              <span>{lastTx.date}</span>
              <span className="text-slate-600">|</span>
              <span>{lastTx.type}</span>
              <span className="text-slate-600">|</span>
              <span className={lastTx.amount >= 0 ? 'text-green-400' : 'text-red-400'}>
                ${lastTx.amount.toFixed(2)}
              </span>
            </div>
          )}

          <div className="text-center pt-2">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm bg-red-600/30 hover:bg-red-600/50 text-red-400 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'complete' && existingArchive && (
        <div className="text-center space-y-4">
          <div className="text-6xl mb-2">✅</div>
          <p className="text-green-400 font-medium">{status}</p>
          <p className="text-slate-400 text-sm">
            {existingArchive.summary.perpRelatedCount} perp-related transactions found
          </p>
          <button
            onClick={handleContinueAfterScrape}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Continue to Import
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div className="text-center space-y-4">
          <div className="text-6xl mb-2">❌</div>
          <p className="text-red-400 font-medium">{status}</p>
          <div className="flex gap-4 justify-center">
            <button
              onClick={() => setPhase('idle')}
              className="px-6 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors font-medium"
            >
              Try Again
            </button>
            <button
              onClick={onClose}
              className="px-6 py-3 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface ImportWizardProps {
  onClose: () => void
  onImported?: () => void
  platform?: string | undefined  // Optional platform filter (e.g., 'robinhood', 'm1')
}

type ImportMethod = 'csv' | 'scrape' | 'archive' | 'crypto-pdf' | 'm1-cash' | 'm1-statements' | 'coinbase-scrape'
type WizardStep = 'method' | 'archive' | 'browser' | 'url' | 'upload' | 'preview' | 'scraping' | 'importing' | 'done' | 'crypto-pdf' | 'crypto-download' | 'crypto-preview' | 'm1-cash-url' | 'm1-statements' | 'm1-statements-download' | 'm1-statements-preview' | 'checking-login' | 'coinbase-scrape' | 'coinbase-summary' | 'coinbase-fund-select' | 'coinbase-preview' | 'coinbase-importing'
type BrowserState = 'idle' | 'launching' | 'launched' | 'connecting' | 'connected'

// Define which import methods are available for each platform
const PLATFORM_IMPORT_METHODS: Record<string, ImportMethod[]> = {
  robinhood: ['csv', 'scrape', 'archive', 'crypto-pdf'],
  m1: ['m1-cash', 'm1-statements'],
  coinbase: ['coinbase-scrape'],
  cashapp: ['csv'],
  // Default: show all methods (for dashboard or unknown platforms)
  _default: ['csv', 'scrape', 'archive', 'crypto-pdf', 'm1-cash', 'm1-statements', 'coinbase-scrape']
}

// Platforms with dedicated CSV parser support in the backend
const CSV_SUPPORTED_PLATFORMS = ['robinhood', 'cashapp']

// Get available methods for a platform
const getAvailableMethods = (platform?: string): ImportMethod[] => {
  const defaultMethods = PLATFORM_IMPORT_METHODS._default ?? ['csv']
  if (!platform) return defaultMethods
  const normalized = platform.toLowerCase().replace(/-cash$/, '')
  return PLATFORM_IMPORT_METHODS[normalized] ?? defaultMethods
}

const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  robinhood: 'Robinhood',
  cashapp: 'Cash App',
  m1: 'M1',
  coinbase: 'Coinbase',
  schwab: 'Schwab',
  vanguard: 'Vanguard'
}

const formatPlatformName = (p: string): string =>
  PLATFORM_DISPLAY_NAMES[p.toLowerCase()] ?? p.charAt(0).toUpperCase() + p.slice(1)

interface ScrapeProgress {
  status: string
  phase: 'navigating' | 'loading' | 'scraping' | 'complete' | 'error'
  current: number
  total: number
  newCount: number
  lastTx: {
    date: string
    type: string
    symbol?: string
    amount: number
    title: string
  } | null
}

export function ImportWizard({ onClose, onImported, platform: rawPlatform }: ImportWizardProps) {
  const platform = rawPlatform?.toLowerCase().replace(/-cash$/, '')
  const availableMethods = getAvailableMethods(platform)
  const [step, setStep] = useState<WizardStep>('method')
  const [method, setMethod] = useState<ImportMethod | null>(null)
  const [browserState, setBrowserState] = useState<BrowserState>('idle')
  const [scrapeUrl, setScrapeUrl] = useState('https://robinhood.com/account/history')
  const [m1CashUrl, setM1CashUrl] = useState('https://dashboard.m1.com/d/save/savings/transactions')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [archive, setArchive] = useState<ScrapeArchive | null>(null)
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set())
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())
  const [clearBeforeImport, setClearBeforeImport] = useState(false)
  const [includeCashImpact, setIncludeCashImpact] = useState(false)
  const [fullSync, setFullSync] = useState(false)
  const [scrapeProgress, setScrapeProgress] = useState<ScrapeProgress>({
    status: '',
    phase: 'navigating',
    current: 0,
    total: 0,
    newCount: 0,
    lastTx: null
  })
  const [cryptoStatements, setCryptoStatements] = useState<CryptoStatementsResponse | null>(null)
  const [cryptoParseResult, setCryptoParseResult] = useState<CryptoParseAllResponse | null>(null)
  const [cryptoDownloadProgress, setCryptoDownloadProgress] = useState<{
    phase: 'idle' | 'downloading' | 'complete' | 'error'
    current: number
    total: number
    downloaded: number
    message: string
  }>({ phase: 'idle', current: 0, total: 0, downloaded: 0, message: '' })
  const [cryptoSelectedSymbols, setCryptoSelectedSymbols] = useState<Set<string>>(new Set())
  const [cryptoConsolidate, setCryptoConsolidate] = useState(true)
  const [cryptoClearBeforeImport, setCryptoClearBeforeImport] = useState(false)
  const [cryptoImportProgress, setCryptoImportProgress] = useState<{
    phase: 'idle' | 'importing' | 'complete' | 'error'
    current: number
    total: number
    results: Array<{ symbol: string; success: boolean; imported: number; error?: string }>
  }>({ phase: 'idle', current: 0, total: 0, results: [] })
  const [m1Statements, setM1Statements] = useState<M1StatementsListResponse | null>(null)
  const [m1ParseResult, setM1ParseResult] = useState<M1StatementsParseAllResponse | null>(null)
  const [m1DownloadProgress, setM1DownloadProgress] = useState<{
    phase: 'idle' | 'downloading' | 'complete' | 'error'
    current: number
    total: number
    downloaded: number
    message: string
  }>({ phase: 'idle', current: 0, total: 0, downloaded: 0, message: '' })
  // Coinbase import state
  const [coinbaseArchive, setCoinbaseArchive] = useState<CoinbaseTransactionArchive | null>(null)
  const [availableFunds, setAvailableFunds] = useState<FundSummary[]>([])
  const [selectedCoinbaseFund, setSelectedCoinbaseFund] = useState<string | null>(null)
  const [selectedCoinbaseTypes, setSelectedCoinbaseTypes] = useState<Set<string>>(new Set(['DEPOSIT', 'OTHER', 'FUNDING_PROFIT', 'FUNDING_LOSS', 'BUY', 'SELL', 'USDC_INTEREST', 'REBATE']))
  const [coinbaseImportProgress, setCoinbaseImportProgress] = useState<{
    phase: 'idle' | 'importing' | 'complete' | 'error'
    applied: number
    skipped: number
    message: string
  }>({ phase: 'idle', applied: 0, skipped: 0, message: '' })
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrapeStreamRef = useRef<{ close: () => void } | null>(null)
  const cryptoStreamRef = useRef<{ close: () => void } | null>(null)
  const m1StreamRef = useRef<{ close: () => void } | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
      if (scrapeStreamRef.current) {
        scrapeStreamRef.current.close()
      }
      if (cryptoStreamRef.current) {
        cryptoStreamRef.current.close()
      }
      if (m1StreamRef.current) {
        m1StreamRef.current.close()
      }
    }
  }, [])

  // Poll for browser status when in browser step
  useEffect(() => {
    if (step === 'browser' && browserState === 'launched') {
      pollIntervalRef.current = setInterval(async () => {
        const result = await getBrowserStatus()
        if (result.data?.connected) {
          setBrowserState('connected')
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
          }
        }
      }, 2000)

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
        }
      }
    }
  }, [step, browserState])

  const handleSelectMethod = useCallback(async (m: ImportMethod) => {
    setMethod(m)
    if (m === 'csv') {
      setStep('upload')
    } else if (m === 'archive') {
      setStep('archive')
      setIsProcessing(true)
      const result = await getScrapeArchive('robinhood')
      setIsProcessing(false)
      if (result.data) {
        setArchive(result.data)
        // Pre-select symbols that have matching funds
        const matched = new Set<string>()
        if (result.data.summary?.bySymbol) {
          Object.entries(result.data.summary.bySymbol).forEach(([symbol, data]) => {
            if (data.fundExists) matched.add(symbol)
          })
        }
        setSelectedSymbols(matched)
        // Select importable types by default
        setSelectedTypes(new Set(['buy', 'sell', 'dividend', 'interest', 'stock_lending', 'deposit', 'withdrawal']))
      }
    } else if (m === 'crypto-pdf') {
      setStep('crypto-pdf')
      setIsProcessing(true)
      // Load existing local PDF statements
      const result = await getLocalCryptoStatements()
      setIsProcessing(false)
      if (result.data) {
        setCryptoStatements(result.data)
      }
    } else if (m === 'm1-cash') {
      // M1 Cash import - go to browser step first
      setStep('browser')
      getBrowserStatus().then(result => {
        if (result.data?.connected) {
          setBrowserState('connected')
        } else if (result.data?.launched) {
          setBrowserState('launched')
        }
      })
    } else if (m === 'm1-statements') {
      // M1 Statements PDF import
      setStep('m1-statements')
      setIsProcessing(true)
      // Load existing local PDF statements
      const result = await getLocalM1Statements()
      setIsProcessing(false)
      if (result.data) {
        setM1Statements(result.data)
      }
    } else if (m === 'coinbase-scrape') {
      // Coinbase transactions scrape - go directly to coinbase-scrape step
      setStep('coinbase-scrape')
    } else {
      setStep('browser')
      // Check if browser is already running
      getBrowserStatus().then(result => {
        if (result.data?.connected) {
          setBrowserState('connected')
        } else if (result.data?.launched) {
          setBrowserState('launched')
        }
      })
    }
  }, [])

  // Get platform name for display in messages
  const getPlatformDisplayName = (m: ImportMethod | null): string => {
    if (m === 'm1-cash' || m === 'm1-statements') return 'M1 Finance'
    if (m === 'coinbase-scrape') return 'Coinbase'
    return 'Robinhood'
  }

  // Get platform identifier for API calls
  const getLaunchPlatform = (m: ImportMethod | null): string => {
    if (m === 'm1-cash' || m === 'm1-statements') return 'm1'
    if (m === 'coinbase-scrape') return 'coinbase'
    return 'robinhood'
  }

  const handleLaunchBrowser = useCallback(async () => {
    setBrowserState('launching')
    const platformForLaunch = getLaunchPlatform(method)
    const platformName = getPlatformDisplayName(method)
    const result = await launchBrowser(platformForLaunch)
    if (result.error) {
      toast.error(result.error)
      setBrowserState('idle')
      return
    }
    if (result.data?.alreadyRunning) {
      // Try to connect immediately
      setBrowserState('connecting')
      const connectResult = await connectBrowser()
      if (connectResult.error) {
        setBrowserState('launched')
        toast.info(`Browser running. Please log in to ${platformName}.`)
      } else {
        setBrowserState('connected')
        toast.success('Connected to browser!')
      }
    } else {
      setBrowserState('launched')
      toast.success(`Chrome launched! Please log in to ${platformName}.`)
    }
  }, [method])

  const handleConnectBrowser = useCallback(async () => {
    setBrowserState('connecting')
    const result = await connectBrowser()
    if (result.error) {
      toast.error(result.error)
      setBrowserState('launched')
      return
    }
    setBrowserState('connected')
    toast.success('Connected to browser!')
  }, [])

  const handleProceedToUrl = useCallback(() => {
    if (method === 'm1-cash') {
      setStep('m1-cash-url')
    } else {
      setStep('url')
    }
  }, [method])

  // Coinbase data ready handler - fetch funds and go to summary
  const handleCoinbaseDataReady = useCallback(async (archive: CoinbaseTransactionArchive) => {
    setCoinbaseArchive(archive)
    // Load available funds (filter to derivatives/crypto funds)
    const fundsResult = await fetchFunds()
    if (fundsResult.data) {
      // Filter to funds that can receive Coinbase transactions
      const eligibleFunds = fundsResult.data.filter(f =>
        f.config.fund_type === 'derivatives' ||
        f.config.fund_type === 'crypto' ||
        f.platform === 'coinbase'
      )
      setAvailableFunds(eligibleFunds)
      // Auto-select first derivatives fund if available
      const derivativesFund = eligibleFunds.find(f => f.config.fund_type === 'derivatives')
      if (derivativesFund) {
        setSelectedCoinbaseFund(derivativesFund.id)
      }
    }
    setStep('coinbase-summary')
  }, [])

  // Go to fund selection
  const handleCoinbaseProceedToFundSelect = useCallback(() => {
    setStep('coinbase-fund-select')
  }, [])

  // Go to preview
  const handleCoinbaseProceedToPreview = useCallback(() => {
    setStep('coinbase-preview')
  }, [])

  // Toggle Coinbase transaction type selection
  const handleToggleCoinbaseType = useCallback((type: string) => {
    setSelectedCoinbaseTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }, [])

  const handleScrapeUrl = useCallback(async () => {
    if (!scrapeUrl.trim()) {
      toast.error('Please enter a Robinhood URL')
      return
    }

    const isValidUrl = scrapeUrl.includes('robinhood.com') && (
      scrapeUrl.includes('history') || scrapeUrl.includes('/account/')
    )
    if (!isValidUrl) {
      toast.error('Please enter a valid Robinhood history URL')
      return
    }

    setIsProcessing(true)
    setStep('scraping')
    setScrapeProgress({
      status: 'Connecting to browser...',
      phase: 'navigating',
      current: 0,
      total: 0,
      newCount: 0,
      lastTx: null
    })

    // Use streaming API for real-time progress
    scrapeStreamRef.current = scrapeRobinhoodHistoryStream(scrapeUrl, 'robinhood', {
      onStatus: (data: ScrapeStatusEvent) => {
        setScrapeProgress(prev => ({
          ...prev,
          status: data.message,
          phase: data.phase
        }))
      },
      onProgress: (data: ScrapeProgressEvent) => {
        setScrapeProgress(prev => ({
          ...prev,
          current: data.current,
          total: data.total,
          newCount: data.newCount,
          lastTx: data.lastTransaction,
          phase: 'scraping',
          status: `Scraped ${data.current} transactions (${data.newCount} new)`
        }))
      },
      onComplete: async (data) => {
        setScrapeProgress(prev => ({
          ...prev,
          phase: 'complete',
          status: data.message
        }))

        // Now fetch the full preview data
        const result = await scrapeRobinhoodHistory(scrapeUrl, 'robinhood')
        setIsProcessing(false)

        if (result.error) {
          toast.error(result.error)
          setStep('url')
          return
        }

        if (!result.data || result.data.transactions.length === 0) {
          toast.info('No transactions found. Archive is empty.')
          setStep('url')
          return
        }

        setPreview(result.data)
        toast.success(data.message)
        setStep('preview')
      },
      onError: (data) => {
        setScrapeProgress(prev => ({
          ...prev,
          phase: 'error',
          status: data.message
        }))
        toast.error(data.message)
        setIsProcessing(false)
        setStep('url')
      }
    }, fullSync)
  }, [scrapeUrl, fullSync])

  const handleScrapeM1Cash = useCallback(async () => {
    if (!m1CashUrl.trim()) {
      toast.error('Please enter an M1 Finance URL')
      return
    }

    if (!m1CashUrl.includes('m1.com')) {
      toast.error('Please enter a valid M1 Finance URL')
      return
    }

    setIsProcessing(true)
    setStep('scraping')
    setScrapeProgress({
      status: 'Connecting to browser...',
      phase: 'navigating',
      current: 0,
      total: 0,
      newCount: 0,
      lastTx: null
    })

    // Use streaming API for real-time progress
    scrapeStreamRef.current = scrapeM1CashHistoryStream(m1CashUrl, 'm1-cash', {
      onStatus: (data: ScrapeStatusEvent) => {
        setScrapeProgress(prev => ({
          ...prev,
          status: data.message,
          phase: data.phase
        }))
      },
      onProgress: (data: ScrapeProgressEvent) => {
        setScrapeProgress(prev => ({
          ...prev,
          current: data.current,
          total: data.total,
          newCount: data.newCount,
          lastTx: data.lastTransaction,
          phase: 'scraping',
          status: `Scraped ${data.current} transactions (${data.newCount} new)`
        }))
      },
      onComplete: async (data) => {
        setScrapeProgress(prev => ({
          ...prev,
          phase: 'complete',
          status: data.message
        }))

        // Load the archive to show results
        const result = await getScrapeArchive('m1-cash')
        setIsProcessing(false)

        if (result.error) {
          toast.error(result.error)
          setStep('m1-cash-url')
          return
        }

        if (!result.data || result.data.transactionCount === 0) {
          toast.info('No transactions found. Archive is empty.')
          setStep('m1-cash-url')
          return
        }

        setArchive(result.data)
        // Pre-select interest transactions
        setSelectedTypes(new Set(['interest', 'deposit', 'withdrawal']))
        toast.success(data.message)
        setStep('archive')
      },
      onError: (data) => {
        setScrapeProgress(prev => ({
          ...prev,
          phase: 'error',
          status: data.message
        }))
        toast.error(data.message)
        setIsProcessing(false)
        setStep('m1-cash-url')
      }
    })
  }, [m1CashUrl])

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast.error('Please upload a CSV file')
      return
    }

    setIsProcessing(true)
    setStep('importing')
    const content = await readFileAsText(file).catch(() => null)

    if (!content) {
      toast.error('Failed to read file')
      setStep('upload')
      setIsProcessing(false)
      return
    }

    const result = await previewRobinhoodImport(content, platform ?? 'robinhood', includeCashImpact)
    setIsProcessing(false)

    if (result.error) {
      toast.error(result.error)
      setStep('upload')
      return
    }

    if (!result.data || result.data.transactions.length === 0) {
      toast.error('No valid transactions found in CSV')
      setStep('upload')
      return
    }

    setPreview(result.data)
    // Pre-select symbols that have matching funds
    const matchedSymbols = new Set<string>()
    if (result.data.summary?.bySymbol) {
      Object.entries(result.data.summary.bySymbol).forEach(([symbol, data]) => {
        if (data.fundExists) matchedSymbols.add(symbol)
      })
    }
    setSelectedSymbols(matchedSymbols)
    setClearBeforeImport(false)
    setStep('preview')
  }, [includeCashImpact, platform])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleApply = useCallback(async () => {
    if (!preview) return

    // Filter transactions by selected symbols
    const selected = preview.transactions.filter(tx => selectedSymbols.has(tx.symbol))
    if (selected.length === 0) {
      toast.error('No transactions selected')
      return
    }

    setIsProcessing(true)
    const result = await applyRobinhoodImport(selected, true, clearBeforeImport)
    setIsProcessing(false)

    if (result.error) {
      toast.error(result.error)
      return
    }

    if (result.data) {
      const { applied, skipped, errors } = result.data
      if (errors.length > 0) {
        toast.error(`Import completed with errors: ${errors.join(', ')}`)
      } else if (applied > 0) {
        toast.success(`Imported ${applied} transaction${applied !== 1 ? 's' : ''} (${skipped} skipped)`)
        notifyFundsChanged()
        onImported?.()
        // Clean up browser if we used it
        if (method === 'scrape') {
          killBrowser().catch(() => {})
        }
        onClose()
      } else {
        toast.info(`No new transactions imported (${skipped} skipped as duplicates)`)
      }
    }
  }, [preview, selectedSymbols, clearBeforeImport, method, onImported, onClose])

  const handleBack = useCallback(() => {
    if (step === 'upload' || step === 'browser' || step === 'archive' || step === 'crypto-pdf' || step === 'm1-statements') {
      setStep('method')
      setMethod(null)
      setArchive(null)
      setCryptoStatements(null)
      setCryptoParseResult(null)
      setCryptoSelectedSymbols(new Set())
      setCryptoImportProgress({ phase: 'idle', current: 0, total: 0, results: [] })
      setM1Statements(null)
      setM1ParseResult(null)
    } else if (step === 'url') {
      setStep('browser')
    } else if (step === 'm1-cash-url') {
      setStep('browser')
    } else if (step === 'scraping') {
      // Cancel the scrape
      if (scrapeStreamRef.current) {
        scrapeStreamRef.current.close()
        scrapeStreamRef.current = null
      }
      setIsProcessing(false)
      if (method === 'm1-cash') {
        setStep('m1-cash-url')
      } else {
        setStep('url')
      }
    } else if (step === 'crypto-download') {
      // Cancel the download
      if (cryptoStreamRef.current) {
        cryptoStreamRef.current.close()
        cryptoStreamRef.current = null
      }
      setIsProcessing(false)
      setStep('crypto-pdf')
    } else if (step === 'm1-statements-download') {
      // Cancel the download
      if (m1StreamRef.current) {
        m1StreamRef.current.close()
        m1StreamRef.current = null
      }
      setIsProcessing(false)
      setStep('m1-statements')
    } else if (step === 'checking-login') {
      setIsProcessing(false)
      setStep('m1-statements')
    } else if (step === 'crypto-preview') {
      setStep('crypto-pdf')
      setCryptoParseResult(null)
      setCryptoSelectedSymbols(new Set())
      setCryptoImportProgress({ phase: 'idle', current: 0, total: 0, results: [] })
    } else if (step === 'm1-statements-preview') {
      setStep('m1-statements')
      setM1ParseResult(null)
    } else if (step === 'preview') {
      if (method === 'csv') {
        setStep('upload')
      } else if (method === 'archive') {
        setStep('archive')
      } else if (method === 'm1-cash') {
        setStep('m1-cash-url')
      } else {
        setStep('url')
      }
      setPreview(null)
    }
  }, [step, method])

  const handleClose = useCallback(() => {
    // Clean up browser if we launched it
    if (browserState !== 'idle') {
      killBrowser().catch(() => {})
    }
    onClose()
  }, [browserState, onClose])

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2
    }).format(amount)
  }

  // Step indicator
  const getStepNumber = () => {
    if (step === 'method') return 1
    if (step === 'upload' || step === 'browser' || step === 'archive' || step === 'crypto-pdf' || step === 'm1-statements' || step === 'coinbase-scrape') return 2
    if (step === 'url' || step === 'crypto-download' || step === 'm1-cash-url' || step === 'm1-statements-download' || step === 'checking-login' || step === 'coinbase-summary') return 3
    if (step === 'scraping' || step === 'coinbase-fund-select') return 4
    if (step === 'crypto-preview' || step === 'm1-statements-preview' || step === 'coinbase-preview') return method === 'coinbase-scrape' ? 5 : 3
    if (step === 'coinbase-importing') return 6
    if (step === 'preview' || step === 'importing') return method === 'csv' ? 3 : method === 'archive' ? 3 : method === 'crypto-pdf' ? 3 : method === 'm1-statements' ? 3 : method === 'm1-cash' ? 4 : 5
    return 1
  }

  const getTotalSteps = () => {
    if (method === 'csv') return 3
    if (method === 'archive') return 3
    if (method === 'crypto-pdf') return 3
    if (method === 'm1-statements') return 3
    if (method === 'm1-cash') return 4
    if (method === 'coinbase-scrape') return 6
    return 5
  }

  const formatCurrencyShort = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-slate-800 rounded-lg w-full max-w-4xl border border-slate-700 max-h-[90vh] flex flex-col">
        {/* Header with progress */}
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold text-white">Import Transactions</h2>
            {step !== 'method' && (
              <span className="text-sm text-slate-400">
                Step {getStepNumber()} of {getTotalSteps()}
              </span>
            )}
          </div>

          {/* Progress bar */}
          {step !== 'method' && (
            <div className="mt-4 flex gap-2">
              {Array.from({ length: getTotalSteps() }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    i < getStepNumber() ? 'bg-mint-500' : 'bg-slate-600'
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Step 1: Choose Method */}
          {step === 'method' && (
            <div className="space-y-4">
              <p className="text-slate-300">
                {platform
                  ? `How would you like to import your ${platform} transactions?`
                  : 'How would you like to import your transactions?'
                }
              </p>

              <div className={`grid gap-4 mt-6 ${availableMethods.length === 1 ? 'grid-cols-1 max-w-md mx-auto' : 'grid-cols-2'}`}>
                {availableMethods.includes('csv') && (
                  <button
                    onClick={() => handleSelectMethod('csv')}
                    className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-mint-500 hover:bg-slate-700 transition-all text-left group"
                  >
                    <div className="text-4xl mb-3">📄</div>
                    <h3 className="text-lg font-medium text-white group-hover:text-mint-400 transition-colors">
                      Upload CSV File
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {platform && CSV_SUPPORTED_PLATFORMS.includes(platform)
                        ? `Import from a downloaded ${formatPlatformName(platform)} transaction history CSV file`
                        : 'Import from a downloaded transaction history CSV file'
                      }
                    </p>
                    <p className="text-xs text-slate-500 mt-3">
                      {platform === 'cashapp'
                        ? 'Best for: Cash App investing transactions (stocks & bitcoin)'
                        : platform && CSV_SUPPORTED_PLATFORMS.includes(platform)
                          ? `Best for: ${formatPlatformName(platform)} transactions`
                          : 'Best for: Stock & crypto transactions'
                      }
                    </p>
                  </button>
                )}

                {availableMethods.includes('crypto-pdf') && (
                  <button
                    onClick={() => handleSelectMethod('crypto-pdf')}
                    className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-amber-500 hover:bg-slate-700 transition-all text-left group"
                  >
                    <div className="text-4xl mb-3">🪙</div>
                    <h3 className="text-lg font-medium text-white group-hover:text-amber-400 transition-colors">
                      Crypto PDF Statements
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      Parse monthly crypto account statements from Robinhood PDFs
                    </p>
                    <p className="text-xs text-slate-500 mt-3">
                      Best for: BTC, ETH, DOGE, etc.
                    </p>
                  </button>
                )}

                {availableMethods.includes('archive') && (
                  <button
                    onClick={() => handleSelectMethod('archive')}
                    className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-mint-500 hover:bg-slate-700 transition-all text-left group"
                  >
                    <div className="text-4xl mb-3">📦</div>
                    <h3 className="text-lg font-medium text-white group-hover:text-mint-400 transition-colors">
                      View Saved Archive
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      Browse previously scraped transactions and select which to import
                    </p>
                    <p className="text-xs text-slate-500 mt-3">
                      Best for: Re-importing or reviewing data
                    </p>
                  </button>
                )}

                {availableMethods.includes('scrape') && (
                  <button
                    onClick={() => handleSelectMethod('scrape')}
                    className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-mint-500 hover:bg-slate-700 transition-all text-left group"
                  >
                    <div className="text-4xl mb-3">🌐</div>
                    <h3 className="text-lg font-medium text-white group-hover:text-mint-400 transition-colors">
                      Scrape from Browser
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      Launch a browser, log in to Robinhood, and scrape transaction history
                    </p>
                    <p className="text-xs text-slate-500 mt-3">
                      Best for: Crypto history (web scraping)
                    </p>
                  </button>
                )}

                {availableMethods.includes('m1-cash') && (
                  <>
                    <button
                      onClick={async () => {
                        // Check if we have existing M1 cash data
                        setIsProcessing(true)
                        const result = await getScrapeArchive('m1-cash')
                        setIsProcessing(false)
                        if (result.data && result.data.transactionCount > 0) {
                          setMethod('m1-cash')
                          setArchive(result.data)
                          setSelectedTypes(new Set(['interest', 'deposit', 'withdrawal']))
                          setStep('archive')
                        } else {
                          // No existing data, go to scrape flow
                          handleSelectMethod('m1-cash')
                        }
                      }}
                      className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-cyan-500 hover:bg-slate-700 transition-all text-left group"
                    >
                      <div className="text-4xl mb-3">📦</div>
                      <h3 className="text-lg font-medium text-white group-hover:text-cyan-400 transition-colors">
                        View M1 Saved Data
                      </h3>
                      <p className="text-sm text-slate-400 mt-1">
                        View previously scraped M1 cash transactions and import them
                      </p>
                      <p className="text-xs text-slate-500 mt-3">
                        Best for: Importing from existing data
                      </p>
                    </button>
                    <button
                      onClick={() => handleSelectMethod('m1-cash')}
                      className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-cyan-500 hover:bg-slate-700 transition-all text-left group"
                    >
                      <div className="text-4xl mb-3">💰</div>
                      <h3 className="text-lg font-medium text-white group-hover:text-cyan-400 transition-colors">
                        Scrape M1 Cash
                      </h3>
                      <p className="text-sm text-slate-400 mt-1">
                        Scrape interest payments from M1 Finance savings account
                      </p>
                      <p className="text-xs text-slate-500 mt-3">
                        Best for: Getting new transaction data
                      </p>
                    </button>
                  </>
                )}

                {availableMethods.includes('m1-statements') && (
                  <button
                    onClick={() => handleSelectMethod('m1-statements')}
                    className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-teal-500 hover:bg-slate-700 transition-all text-left group"
                  >
                    <div className="text-4xl mb-3">📑</div>
                    <h3 className="text-lg font-medium text-white group-hover:text-teal-400 transition-colors">
                      M1 Statement PDFs
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      Parse monthly M1 Earn/Save PDF statements for complete history
                    </p>
                    <p className="text-xs text-slate-500 mt-3">
                      Best for: Complete historical data from PDFs
                    </p>
                  </button>
                )}

                {availableMethods.includes('coinbase-scrape') && (
                  <button
                    onClick={() => handleSelectMethod('coinbase-scrape')}
                    className="p-6 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-blue-500 hover:bg-slate-700 transition-all text-left group"
                  >
                    <div className="text-4xl mb-3">🪙</div>
                    <h3 className="text-lg font-medium text-white group-hover:text-blue-400 transition-colors">
                      Scrape Coinbase Transactions
                    </h3>
                    <p className="text-sm text-slate-400 mt-1">
                      Scrape funding payments, trades, and rewards from Coinbase transactions page
                    </p>
                    <p className="text-xs text-slate-500 mt-3">
                      Best for: Perpetual futures data, USDC rewards
                    </p>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Step 2 (Archive): View Saved Archive */}
          {step === 'archive' && (
            <div className="space-y-6">
              {isProcessing ? (
                <div className="text-center py-12">
                  <div className="animate-spin text-4xl mb-4">⏳</div>
                  <p className="text-slate-400">Loading archive...</p>
                </div>
              ) : !archive || archive.transactionCount === 0 ? (
                <div className="text-center py-12">
                  <div className="text-6xl mb-4">📭</div>
                  <h3 className="text-xl font-medium text-white mb-2">No Archive Found</h3>
                  <p className="text-slate-400 mb-6">
                    No scraped data found. Use the browser scraper to capture transactions first.
                  </p>
                  <button
                    onClick={() => handleSelectMethod('scrape')}
                    className="px-6 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors font-medium"
                  >
                    Start Browser Scrape
                  </button>
                </div>
              ) : (
                <>
                  {/* Archive Summary */}
                  <div className="bg-slate-700/30 rounded-lg p-4">
                    <h3 className="text-lg font-medium text-white mb-4">Archive Summary</h3>
                    <div className="grid grid-cols-4 gap-4 mb-4">
                      <div className="bg-slate-700/50 rounded p-3">
                        <div className="text-2xl font-bold text-white">{archive.transactionCount}</div>
                        <div className="text-xs text-slate-400">Total Transactions</div>
                      </div>
                      <div className="bg-slate-700/50 rounded p-3">
                        <div className="text-lg font-bold text-mint-400">{formatCurrencyShort(archive.summary?.totalAmount ?? 0)}</div>
                        <div className="text-xs text-slate-400">Total Value</div>
                      </div>
                      <div className="bg-slate-700/50 rounded p-3">
                        <div className="text-sm font-medium text-white">{archive.summary?.dateRange?.oldest ?? '-'}</div>
                        <div className="text-xs text-slate-400">Oldest</div>
                      </div>
                      <div className="bg-slate-700/50 rounded p-3">
                        <div className="text-sm font-medium text-white">{archive.summary?.dateRange?.newest ?? '-'}</div>
                        <div className="text-xs text-slate-400">Newest</div>
                      </div>
                    </div>

                    {/* By Year */}
                    {archive.summary?.byYear && (
                      <div className="mb-4">
                        <h4 className="text-sm font-medium text-slate-300 mb-2">By Year</h4>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(archive.summary.byYear).sort(([a], [b]) => b.localeCompare(a)).map(([year, count]) => (
                            <span key={year} className="px-3 py-1 bg-slate-600/50 rounded text-sm text-white">
                              {year}: <span className="text-mint-400">{count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* By Type */}
                    {archive.summary?.byType && (
                      <div className="mb-4">
                        <h4 className="text-sm font-medium text-slate-300 mb-2">By Type (click to filter)</h4>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(archive.summary.byType).sort(([, a], [, b]) => b - a).map(([type, count]) => {
                            const isSelected = selectedTypes.has(type)
                            return (
                              <button
                                key={type}
                                onClick={() => {
                                  const next = new Set(selectedTypes)
                                  if (isSelected) next.delete(type)
                                  else next.add(type)
                                  setSelectedTypes(next)
                                }}
                                className={`px-3 py-1 rounded text-sm transition-colors ${
                                  isSelected
                                    ? type === 'buy' ? 'bg-green-500/30 text-green-300 border border-green-500/50' :
                                      type === 'sell' ? 'bg-red-500/30 text-red-300 border border-red-500/50' :
                                      type === 'dividend' || type === 'interest' || type === 'stock_lending' ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50' :
                                      type === 'deposit' || type === 'withdrawal' ? 'bg-purple-500/30 text-purple-300 border border-purple-500/50' :
                                      'bg-slate-500/30 text-slate-300 border border-slate-500/50'
                                    : 'bg-slate-700/50 text-slate-500 border border-transparent'
                                }`}
                              >
                                {type}: {count}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* M1 Cash Fund Status */}
                    {method === 'm1-cash' && (
                      <div className="mb-4">
                        <h4 className="text-sm font-medium text-slate-300 mb-2">Cash Fund Status</h4>
                        <div className={`p-3 rounded ${
                          (archive.summary as { cashFundExists?: boolean })?.cashFundExists
                            ? 'bg-green-500/20 border border-green-500/30'
                            : 'bg-amber-500/20 border border-amber-500/30'
                        }`}>
                          {(archive.summary as { cashFundExists?: boolean })?.cashFundExists ? (
                            <div className="flex items-center gap-2">
                              <span className="text-green-400">✓</span>
                              <span className="text-green-300">m1-cash fund exists</span>
                              <span className="text-slate-400 text-sm ml-2">
                                ({(archive.summary as { cashTransactionCount?: number })?.cashTransactionCount ?? 0} cash transactions can be imported)
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-amber-400">⚠</span>
                              <span className="text-amber-300">m1-cash fund not found</span>
                              <span className="text-slate-400 text-sm ml-2">
                                Please create the m1-cash fund first to import transactions
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* By Symbol (not shown for M1 cash) */}
                    {method !== 'm1-cash' && archive.summary?.bySymbol && (
                      <div>
                        <h4 className="text-sm font-medium text-slate-300 mb-2">By Symbol (click to select for import)</h4>
                        <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                          {Object.entries(archive.summary.bySymbol)
                            .sort(([, a], [, b]) => b.count - a.count)
                            .map(([symbol, data]) => {
                              const isSelected = selectedSymbols.has(symbol)
                              return (
                                <button
                                  key={symbol}
                                  onClick={() => {
                                    const next = new Set(selectedSymbols)
                                    if (isSelected) next.delete(symbol)
                                    else next.add(symbol)
                                    setSelectedSymbols(next)
                                  }}
                                  className={`px-3 py-1 rounded text-sm transition-colors ${
                                    isSelected
                                      ? data.fundExists
                                        ? 'bg-green-500/30 text-green-300 border border-green-500/50'
                                        : 'bg-amber-500/30 text-amber-300 border border-amber-500/50'
                                      : 'bg-slate-700/50 text-slate-500 border border-transparent'
                                  }`}
                                  title={data.fundExists ? `Maps to ${data.fundId}` : 'No matching fund'}
                                >
                                  {symbol}: {data.count}
                                  {!data.fundExists && <span className="ml-1 text-amber-400">⚠</span>}
                                </button>
                              )
                            })}
                        </div>
                        <p className="text-xs text-slate-500 mt-2">
                          ⚠ = No matching fund (won't be imported)
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-4">
                    {method === 'm1-cash' ? (
                      <>
                        <button
                          onClick={async () => {
                            // Import M1 cash transactions directly
                            if (!(archive.summary as { cashFundExists?: boolean })?.cashFundExists) {
                              toast.error('Please create the m1-cash fund first')
                              return
                            }

                            setIsProcessing(true)

                            // Get full archive to get all transactions
                            const fullArchive = await getScrapeArchive('m1-cash', true)
                            if (!fullArchive.data) {
                              toast.error('Failed to load archive')
                              setIsProcessing(false)
                              return
                            }

                            // Filter transactions by selected types
                            const cashTypes = ['interest', 'deposit', 'withdrawal']
                            const filteredTxns = fullArchive.data.transactions.filter(tx =>
                              selectedTypes.has(tx.type) && cashTypes.includes(tx.type)
                            )

                            // Convert to ParsedTransaction format
                            const parsedTxns: ParsedTransaction[] = filteredTxns.map(tx => ({
                              date: tx.date,
                              action: tx.type === 'interest' ? 'INTEREST' :
                                      tx.type === 'deposit' ? 'DEPOSIT' :
                                      tx.type === 'withdrawal' ? 'WITHDRAW' : 'OTHER',
                              symbol: '',
                              quantity: 0,
                              price: 0,
                              amount: tx.amount,
                              description: tx.title,
                              fundId: 'm1-cash',
                              fundExists: true
                            }))

                            // Apply the import
                            const result = await applyM1CashImport(parsedTxns, true)
                            setIsProcessing(false)

                            if (result.error) {
                              toast.error(result.error)
                              return
                            }

                            if (result.data) {
                              const { applied, skipped, errors } = result.data
                              if (errors.length > 0) {
                                toast.error(`Import completed with errors: ${errors.join(', ')}`)
                              } else if (applied > 0) {
                                toast.success(`Imported ${applied} transaction${applied !== 1 ? 's' : ''} (${skipped} skipped)`)
                                notifyFundsChanged()
                                onImported?.()
                                onClose()
                              } else {
                                toast.info(`No new transactions imported (${skipped} skipped as duplicates)`)
                              }
                            }
                          }}
                          disabled={selectedTypes.size === 0 || !(archive.summary as { cashFundExists?: boolean })?.cashFundExists}
                          className="flex-1 px-4 py-3 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                        >
                          Import {['interest', 'deposit', 'withdrawal'].filter(t => selectedTypes.has(t)).join(', ')} Transactions
                        </button>
                        <button
                          onClick={() => handleSelectMethod('m1-cash')}
                          className="px-4 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                        >
                          Add More Data
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={async () => {
                            // Convert archive to preview format for the preview step
                            setIsProcessing(true)
                            const result = await scrapeRobinhoodHistory(scrapeUrl, 'robinhood')
                            setIsProcessing(false)
                            if (result.data) {
                              // Filter by selected symbols and types
                              const filtered = result.data.transactions.filter(tx => {
                                const typeMatch = selectedTypes.has(tx.action.toLowerCase())
                                const symbolMatch = !tx.symbol || selectedSymbols.has(tx.symbol)
                                return typeMatch && symbolMatch
                              })
                              setPreview({ ...result.data, transactions: filtered })
                              setStep('preview')
                            }
                          }}
                          disabled={selectedSymbols.size === 0 || selectedTypes.size === 0}
                          className="flex-1 px-4 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                        >
                          Preview {selectedSymbols.size} Symbol{selectedSymbols.size !== 1 ? 's' : ''} for Import
                        </button>
                        <button
                          onClick={() => handleSelectMethod('scrape')}
                          className="px-4 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                        >
                          Add More Data
                        </button>
                      </>
                    )}
                  </div>

                  <p className="text-xs text-slate-500 text-center">
                    Last updated: {new Date(archive.updatedAt).toLocaleString()}
                  </p>
                </>
              )}
            </div>
          )}

          {/* Step 2 (Crypto PDF): Local PDF Statements */}
          {step === 'crypto-pdf' && (
            <div className="space-y-6">
              {isProcessing ? (
                <div className="text-center py-12">
                  <div className="animate-spin text-4xl mb-4">⏳</div>
                  <p className="text-slate-400">Loading statements...</p>
                </div>
              ) : (
                <>
                  <div className="text-center mb-4">
                    <div className="text-4xl mb-2">🪙</div>
                    <h3 className="text-lg font-medium text-white">Crypto Statement PDFs</h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {cryptoStatements && cryptoStatements.count > 0
                        ? `Found ${cryptoStatements.count} PDF statement${cryptoStatements.count !== 1 ? 's' : ''}`
                        : 'No PDF statements found locally'}
                    </p>
                  </div>

                  {cryptoStatements && cryptoStatements.count > 0 && (
                    <div className="bg-slate-700/30 rounded-lg p-4">
                      <h4 className="text-sm font-medium text-slate-300 mb-3">Downloaded Statements</h4>
                      <div className="grid grid-cols-4 gap-2 max-h-32 overflow-y-auto">
                        {cryptoStatements.statements.map(stmt => (
                          <div key={stmt.filename} className="px-3 py-2 bg-slate-600/50 rounded text-sm text-white">
                            {stmt.monthYear}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-4">
                    {cryptoStatements && cryptoStatements.count > 0 && (
                      <button
                        onClick={async () => {
                          setIsProcessing(true)
                          const result = await parseAllCryptoStatements()
                          setIsProcessing(false)
                          if (result.data) {
                            setCryptoParseResult(result.data)
                            // Pre-select matched funds
                            const matched = new Set<string>()
                            Object.entries(result.data.bySymbol).forEach(([symbol, data]) => {
                              if (data.fundExists) matched.add(symbol)
                            })
                            setCryptoSelectedSymbols(matched)
                            setCryptoImportProgress({ phase: 'idle', current: 0, total: 0, results: [] })
                            setStep('crypto-preview')
                            if (result.data.errors && result.data.errors.length > 0) {
                              toast.error(`Parsed with ${result.data.errors.length} error(s)`)
                            } else {
                              toast.success(`Parsed ${result.data.transactionCount} transactions from ${result.data.statementCount} statements`)
                            }
                          } else if (result.error) {
                            toast.error(result.error)
                          }
                        }}
                        className="flex-1 px-4 py-3 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium"
                      >
                        Parse All PDFs ({cryptoStatements.count})
                      </button>
                    )}
                    <button
                      onClick={() => {
                        // Need browser for downloading
                        setMethod('crypto-pdf')
                        setStep('browser')
                      }}
                      className="flex-1 px-4 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                    >
                      Download More from Robinhood
                    </button>
                  </div>

                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-slate-300 mb-2">How to get PDF statements:</h4>
                    <ol className="text-sm text-slate-400 space-y-2 list-decimal list-inside">
                      <li>Log in to Robinhood in Chrome</li>
                      <li>Navigate to: Account → Documents → Account Statements → Crypto</li>
                      <li>Download all monthly PDF statements to <code className="text-amber-400">data/crypto-statements/</code></li>
                      <li>Click "Download More from Robinhood" to automate this process</li>
                    </ol>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Crypto PDF Preview */}
          {step === 'crypto-preview' && cryptoParseResult && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-700/50 rounded p-4">
                  <div className="text-2xl font-bold text-white">{cryptoParseResult.statementCount}</div>
                  <div className="text-sm text-slate-400">PDFs Parsed</div>
                </div>
                <div className="bg-slate-700/50 rounded p-4">
                  <div className="text-2xl font-bold text-amber-400">{cryptoParseResult.transactionCount}</div>
                  <div className="text-sm text-slate-400">Transactions</div>
                </div>
                <div className="bg-slate-700/50 rounded p-4">
                  <div className="text-2xl font-bold text-white">{cryptoParseResult.holdings.length}</div>
                  <div className="text-sm text-slate-400">Crypto Holdings</div>
                </div>
              </div>

              {/* Fund Selection */}
              <div className="bg-slate-700/30 rounded-lg p-4">
                <h3 className="text-sm font-medium text-slate-300 mb-3">Select Funds to Import</h3>

                {/* Matched Funds */}
                {Object.entries(cryptoParseResult.bySymbol).some(([, d]) => d.fundExists) && (
                  <div className="mb-4">
                    <h4 className="text-xs font-medium text-green-400 mb-2">Matched Funds (click to select)</h4>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(cryptoParseResult.bySymbol)
                        .filter(([, data]) => data.fundExists)
                        .sort(([, a], [, b]) => (b.buys + b.sells) - (a.buys + a.sells))
                        .map(([symbol, data]) => {
                          const isSelected = cryptoSelectedSymbols.has(symbol)
                          return (
                            <button
                              key={symbol}
                              onClick={() => {
                                const next = new Set(cryptoSelectedSymbols)
                                if (isSelected) next.delete(symbol)
                                else next.add(symbol)
                                setCryptoSelectedSymbols(next)
                              }}
                              className={`px-3 py-2 rounded text-sm transition-colors ${
                                isSelected
                                  ? 'bg-green-500/30 text-green-300 border border-green-500/50'
                                  : 'bg-slate-700/50 text-slate-400 border border-transparent hover:border-slate-500'
                              }`}
                              title={`${data.fundId} - ${data.buys + data.sells} transactions`}
                            >
                              <span className="font-medium">{symbol}</span>
                              <span className="text-slate-400 ml-2">{data.buys + data.sells}</span>
                              <div className="text-xs mt-1">
                                <span className="text-green-400">{data.buys}B</span>
                                {' / '}
                                <span className="text-red-400">{data.sells}S</span>
                              </div>
                            </button>
                          )
                        })}
                    </div>
                  </div>
                )}

                {/* Unmatched Funds */}
                {Object.entries(cryptoParseResult.bySymbol).some(([, d]) => !d.fundExists) && (
                  <div>
                    <h4 className="text-xs font-medium text-amber-400 mb-2">Unmatched (no fund exists)</h4>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(cryptoParseResult.bySymbol)
                        .filter(([, data]) => !data.fundExists)
                        .sort(([, a], [, b]) => (b.buys + b.sells) - (a.buys + a.sells))
                        .map(([symbol, data]) => (
                          <div
                            key={symbol}
                            className="px-3 py-2 rounded text-sm bg-slate-800/50 text-slate-500 border border-slate-700"
                            title={`Would map to ${data.fundId} - create fund first`}
                          >
                            <span>{symbol}</span>
                            <span className="ml-2">{data.buys + data.sells}</span>
                            <span className="ml-1 text-amber-500">⚠</span>
                          </div>
                        ))}
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      Create funds for these symbols to enable import
                    </p>
                  </div>
                )}

                {/* Quick Actions */}
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => {
                      const matched = new Set<string>()
                      Object.entries(cryptoParseResult.bySymbol).forEach(([symbol, data]) => {
                        if (data.fundExists) matched.add(symbol)
                      })
                      setCryptoSelectedSymbols(matched)
                    }}
                    className="px-3 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                  >
                    Select All Matched
                  </button>
                  <button
                    onClick={() => setCryptoSelectedSymbols(new Set())}
                    className="px-3 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              {/* Import Options */}
              <div className="bg-slate-700/30 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-medium text-slate-300 mb-2">Import Options</h3>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cryptoConsolidate}
                    onChange={(e) => setCryptoConsolidate(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 text-mint-500 focus:ring-mint-500 focus:ring-offset-slate-800"
                  />
                  <div>
                    <span className="text-white">Consolidate same-day transactions</span>
                    <p className="text-xs text-slate-400">Combine multiple buys/sells on the same day into single entries</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cryptoClearBeforeImport}
                    onChange={(e) => setCryptoClearBeforeImport(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 text-red-500 focus:ring-red-500 focus:ring-offset-slate-800"
                  />
                  <div>
                    <span className="text-white">Clear fund entries before import</span>
                    <p className="text-xs text-red-400/80">Warning: This will delete all existing entries in selected funds</p>
                  </div>
                </label>
              </div>

              {/* Import Progress */}
              {cryptoImportProgress.phase !== 'idle' && (
                <div className="bg-slate-700/30 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    {cryptoImportProgress.phase === 'importing' && <span className="animate-spin">⏳</span>}
                    {cryptoImportProgress.phase === 'complete' && <span>✅</span>}
                    {cryptoImportProgress.phase === 'error' && <span>❌</span>}
                    <span className="text-white font-medium">
                      {cryptoImportProgress.phase === 'importing' && `Importing ${cryptoImportProgress.current}/${cryptoImportProgress.total}...`}
                      {cryptoImportProgress.phase === 'complete' && 'Import Complete'}
                      {cryptoImportProgress.phase === 'error' && 'Import Error'}
                    </span>
                  </div>
                  {cryptoImportProgress.results.length > 0 && (
                    <div className="space-y-1 text-sm">
                      {cryptoImportProgress.results.map((r, i) => (
                        <div key={i} className={r.success ? 'text-green-400' : 'text-red-400'}>
                          {r.symbol}: {r.success ? `${r.imported} transactions imported` : r.error}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Import Summary */}
              {cryptoSelectedSymbols.size > 0 && cryptoImportProgress.phase === 'idle' && (
                <div className="bg-mint-500/10 border border-mint-500/30 rounded p-4 text-center">
                  <p className="text-mint-300">
                    Ready to import{' '}
                    <strong>
                      {Array.from(cryptoSelectedSymbols).reduce((sum, symbol) => {
                        const data = cryptoParseResult.bySymbol[symbol]
                        return sum + (data ? data.buys + data.sells : 0)
                      }, 0)}
                    </strong>{' '}
                    transactions from{' '}
                    <strong>{cryptoSelectedSymbols.size}</strong> fund{cryptoSelectedSymbols.size !== 1 ? 's' : ''}
                    {cryptoClearBeforeImport && (
                      <span className="text-amber-400 ml-1">(funds will be cleared first)</span>
                    )}
                  </p>
                </div>
              )}

              {/* Transaction Preview (collapsible) */}
              <details className="border border-slate-700 rounded overflow-hidden">
                <summary className="bg-slate-700/50 p-3 cursor-pointer hover:bg-slate-700/70 transition-colors">
                  <span className="text-sm font-medium text-slate-300">
                    Transaction Preview (first 50)
                  </span>
                </summary>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800 sticky top-0">
                      <tr>
                        <th className="p-2 text-left text-slate-400">Date</th>
                        <th className="p-2 text-left text-slate-400">Type</th>
                        <th className="p-2 text-left text-slate-400">Symbol</th>
                        <th className="p-2 text-right text-slate-400">Quantity</th>
                        <th className="p-2 text-right text-slate-400">Price</th>
                        <th className="p-2 text-right text-slate-400">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cryptoParseResult.transactions.slice(0, 50).map((tx, i) => (
                        <tr key={i} className="border-t border-slate-700">
                          <td className="p-2 text-slate-300">{tx.date}</td>
                          <td className="p-2">
                            <span className={`px-2 py-0.5 rounded text-xs ${
                              tx.type === 'buy' ? 'bg-green-500/20 text-green-300' :
                              tx.type === 'sell' ? 'bg-red-500/20 text-red-300' :
                              'bg-slate-500/20 text-slate-300'
                            }`}>
                              {tx.type.toUpperCase()}
                            </span>
                          </td>
                          <td className="p-2 text-white font-medium">{tx.symbol}</td>
                          <td className="p-2 text-right text-slate-300">{tx.quantity.toFixed(8)}</td>
                          <td className="p-2 text-right text-slate-300">{formatCurrency(tx.price)}</td>
                          <td className="p-2 text-right text-white">{formatCurrency(tx.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              {/* Errors if any */}
              {cryptoParseResult.errors && cryptoParseResult.errors.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
                  <h4 className="text-sm font-medium text-red-400 mb-2">Parse Errors</h4>
                  <ul className="text-sm text-red-300 space-y-1">
                    {cryptoParseResult.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Import Button */}
              {cryptoSelectedSymbols.size > 0 && cryptoImportProgress.phase === 'idle' && (
                <div className="flex justify-center">
                  <button
                    onClick={async () => {
                      setCryptoImportProgress({ phase: 'importing', current: 0, total: cryptoSelectedSymbols.size, results: [] })
                      const symbols = Array.from(cryptoSelectedSymbols)
                      const results: Array<{ symbol: string; success: boolean; imported: number; error?: string }> = []

                      for (let i = 0; i < symbols.length; i++) {
                        const symbol = symbols[i]
                        if (!symbol) continue
                        const data = cryptoParseResult.bySymbol[symbol]
                        if (!data) continue

                        setCryptoImportProgress(prev => ({ ...prev, current: i + 1 }))

                        const result = await importCryptoToFund({
                          fundId: data.fundId,
                          symbol,
                          mode: cryptoClearBeforeImport ? 'replace' : 'append',
                          consolidate: cryptoConsolidate
                        })

                        if (result.data?.success) {
                          results.push({ symbol, success: true, imported: result.data.imported })
                        } else {
                          results.push({ symbol, success: false, imported: 0, error: result.error ?? 'Unknown error' })
                        }

                        setCryptoImportProgress(prev => ({ ...prev, results: [...results] }))
                      }

                      setCryptoImportProgress(prev => ({ ...prev, phase: 'complete' }))

                      const successCount = results.filter(r => r.success).length
                      const totalImported = results.reduce((sum, r) => sum + r.imported, 0)

                      if (successCount === symbols.length) {
                        toast.success(`Imported ${totalImported} transactions to ${successCount} fund(s)`)
                      } else {
                        toast.error(`Import completed with errors: ${successCount}/${symbols.length} funds succeeded`)
                      }

                      notifyFundsChanged()
                    }}
                    className="px-6 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors font-medium"
                  >
                    Import {cryptoSelectedSymbols.size} Fund{cryptoSelectedSymbols.size !== 1 ? 's' : ''}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step 2 (M1 Statements): Local PDF Statements */}
          {step === 'm1-statements' && (
            <div className="space-y-6">
              {isProcessing ? (
                <div className="text-center py-12">
                  <div className="animate-spin text-4xl mb-4">⏳</div>
                  <p className="text-slate-400">Loading statements...</p>
                </div>
              ) : (
                <>
                  <div className="text-center mb-4">
                    <div className="text-4xl mb-2">📑</div>
                    <h3 className="text-lg font-medium text-white">M1 Statement PDFs</h3>
                    <p className="text-sm text-slate-400 mt-1">
                      {m1Statements && m1Statements.count > 0
                        ? `Found ${m1Statements.count} PDF statement${m1Statements.count !== 1 ? 's' : ''}`
                        : 'No PDF statements found locally'}
                    </p>
                  </div>

                  {m1Statements && m1Statements.count > 0 && (
                    <div className="bg-slate-700/30 rounded-lg p-4">
                      <h4 className="text-sm font-medium text-slate-300 mb-3">Downloaded Statements</h4>
                      <div className="grid grid-cols-4 gap-2 max-h-32 overflow-y-auto">
                        {m1Statements.statements.map(stmt => (
                          <div key={stmt.filename} className={`px-3 py-2 rounded text-sm ${
                            stmt.accountType === 'earn' ? 'bg-teal-600/30 text-teal-300' :
                            stmt.accountType === 'invest' ? 'bg-blue-600/30 text-blue-300' :
                            stmt.accountType === 'crypto' ? 'bg-amber-600/30 text-amber-300' :
                            'bg-slate-600/50 text-white'
                          }`}>
                            {stmt.monthYear}
                            <span className="text-xs text-slate-400 ml-1">
                              ({stmt.accountType})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-4">
                    {m1Statements && m1Statements.count > 0 && (
                      <button
                        onClick={async () => {
                          setIsProcessing(true)
                          const result = await parseAllM1Statements('earn')
                          setIsProcessing(false)
                          if (result.data) {
                            setM1ParseResult(result.data)
                            setStep('m1-statements-preview')
                            if (result.data.errors && result.data.errors.length > 0) {
                              toast.error(`Parsed with ${result.data.errors.length} error(s)`)
                            } else {
                              toast.success(`Parsed ${result.data.transactionCount} transactions from ${result.data.statementCount} statements`)
                            }
                          } else if (result.error) {
                            toast.error(result.error)
                          }
                        }}
                        className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors font-medium"
                      >
                        Parse Earn/Save PDFs ({m1Statements.statements.filter(s => s.accountType === 'earn').length})
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        // Check browser status and login
                        setMethod('m1-statements')
                        setStep('checking-login')
                        setIsProcessing(true)

                        const status = await getBrowserStatus('m1')
                        if (status.error || !status.data?.connected) {
                          toast.error('Browser not running. Start with: pm2 start escapemint-browser')
                          setStep('m1-statements')
                          setIsProcessing(false)
                          return
                        }

                        // If logged in, go directly to download
                        if (status.data.loggedIn) {
                          setIsProcessing(false)
                          setBrowserState('connected')
                          setStep('m1-statements-download')
                          // Trigger download automatically
                          m1StreamRef.current = downloadM1StatementsStream({}, {
                            onStatus: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, message: data.message, phase: 'downloading' }))
                            },
                            onProgress: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, ...data, phase: 'downloading' }))
                            },
                            onComplete: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, ...data, phase: 'complete' }))
                              // Reload statements list
                              getLocalM1Statements().then(result => {
                                if (result.data) setM1Statements(result.data)
                              })
                            },
                            onError: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, message: data.message, phase: 'error' }))
                            }
                          })
                          return
                        }

                        // Not logged in - navigate to M1 and wait for login
                        const navResult = await navigateBrowser('https://dashboard.m1.com', 'm1')
                        if (navResult.error) {
                          toast.error(navResult.error)
                          setStep('m1-statements')
                          setIsProcessing(false)
                          return
                        }

                        // If navigated and now logged in, proceed
                        if (navResult.data?.isLoggedIn) {
                          setIsProcessing(false)
                          setBrowserState('connected')
                          setStep('m1-statements-download')
                          return
                        }

                        // Still not logged in, keep checking
                        setIsProcessing(false)
                        // Stay on checking-login step - it will poll
                      }}
                      className="flex-1 px-4 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                    >
                      Download More from M1
                    </button>
                  </div>

                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-slate-300 mb-2">How to get PDF statements:</h4>
                    <ol className="text-sm text-slate-400 space-y-2 list-decimal list-inside">
                      <li>Log in to M1 Finance in Chrome</li>
                      <li>Navigate to: Settings → Documents → Statements</li>
                      <li>Download all monthly PDF statements to <code className="text-teal-400">data/m1-statements/</code></li>
                      <li>Click "Download More from M1" to automate this process</li>
                    </ol>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Checking Login Step */}
          {step === 'checking-login' && (
            <div className="space-y-6 py-6">
              <div className="text-center">
                <div className="text-4xl mb-4 animate-pulse">🔐</div>
                <h3 className="text-lg font-medium text-white mb-2">
                  {isProcessing ? 'Checking browser...' : 'Waiting for M1 login...'}
                </h3>
                <p className="text-slate-400">
                  {isProcessing
                    ? 'Connecting to browser and checking login status'
                    : 'Please log in to M1 Finance in the browser window'}
                </p>
              </div>

              {!isProcessing && (
                <>
                  <div className="bg-slate-700/50 rounded-lg p-4 text-center">
                    <p className="text-sm text-slate-300 mb-3">
                      A browser window should be open. Log in to M1 Finance to continue.
                    </p>
                    <button
                      onClick={async () => {
                        setIsProcessing(true)
                        const status = await getBrowserStatus('m1')
                        setIsProcessing(false)

                        if (status.data?.loggedIn) {
                          setBrowserState('connected')
                          setStep('m1-statements-download')
                          // Trigger download
                          m1StreamRef.current = downloadM1StatementsStream({}, {
                            onStatus: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, message: data.message, phase: 'downloading' }))
                            },
                            onProgress: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, ...data, phase: 'downloading' }))
                            },
                            onComplete: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, ...data, phase: 'complete' }))
                              getLocalM1Statements().then(result => {
                                if (result.data) setM1Statements(result.data)
                              })
                            },
                            onError: (data) => {
                              setM1DownloadProgress(prev => ({ ...prev, message: data.message, phase: 'error' }))
                            }
                          })
                        } else {
                          toast.error('Still not logged in. Please log in to M1 Finance.')
                        }
                      }}
                      className="px-6 py-2 bg-teal-600 text-white rounded hover:bg-teal-700 transition-colors"
                    >
                      Check Login Status
                    </button>
                  </div>

                  <button
                    onClick={() => setStep('m1-statements')}
                    className="w-full px-4 py-2 text-slate-400 hover:text-white transition-colors text-sm"
                  >
                    ← Back to statements
                  </button>
                </>
              )}
            </div>
          )}

          {/* M1 Statements Download Progress */}
          {step === 'm1-statements-download' && (
            <div className="space-y-6 py-6">
              <div className="text-center">
                <div className="text-4xl mb-4">
                  {m1DownloadProgress.phase === 'error' ? '❌' :
                   m1DownloadProgress.phase === 'complete' ? '✅' :
                   '📥'}
                </div>
                <h3 className="text-lg font-medium text-white mb-2">
                  {m1DownloadProgress.phase === 'downloading' ? 'Downloading M1 Statements' :
                   m1DownloadProgress.phase === 'complete' ? 'Download Complete' :
                   m1DownloadProgress.phase === 'error' ? 'Download Failed' :
                   'Starting...'}
                </h3>
                <p className="text-slate-400">{m1DownloadProgress.message}</p>
              </div>

              {/* Progress bar */}
              {m1DownloadProgress.total > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-slate-400">
                    <span>Progress</span>
                    <span>{m1DownloadProgress.current} / {m1DownloadProgress.total}</span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-teal-500 transition-all duration-300"
                      style={{ width: `${Math.min(100, (m1DownloadProgress.current / m1DownloadProgress.total) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-teal-400">{m1DownloadProgress.downloaded} downloaded</span>
                    <span className="text-slate-500">{m1DownloadProgress.current - m1DownloadProgress.downloaded} skipped</span>
                  </div>
                </div>
              )}

              {m1DownloadProgress.phase === 'complete' && (
                <div className="text-center text-sm text-slate-400">
                  Returning to parse statements...
                </div>
              )}
            </div>
          )}

          {/* M1 Statements Preview */}
          {step === 'm1-statements-preview' && m1ParseResult && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-700/50 rounded p-4">
                  <div className="text-2xl font-bold text-white">{m1ParseResult.statementCount}</div>
                  <div className="text-sm text-slate-400">PDFs Parsed</div>
                </div>
                <div className="bg-slate-700/50 rounded p-4">
                  <div className="text-2xl font-bold text-teal-400">{m1ParseResult.transactionCount}</div>
                  <div className="text-sm text-slate-400">Transactions</div>
                </div>
                <div className="bg-slate-700/50 rounded p-4">
                  <div className="text-sm text-slate-300">
                    {m1ParseResult.dateRange ? (
                      <>{m1ParseResult.dateRange.oldest} → {m1ParseResult.dateRange.newest}</>
                    ) : '-'}
                  </div>
                  <div className="text-sm text-slate-400">Date Range</div>
                </div>
              </div>

              {/* By Type Summary */}
              <div className="bg-slate-700/30 rounded-lg p-4">
                <h3 className="text-sm font-medium text-slate-300 mb-3">By Transaction Type</h3>
                <div className="grid grid-cols-3 gap-4">
                  {Object.entries(m1ParseResult.byType).map(([type, data]) => (
                    <div key={type} className={`rounded p-3 ${
                      type === 'interest' ? 'bg-green-500/20' :
                      type === 'deposit' ? 'bg-blue-500/20' :
                      type === 'withdrawal' ? 'bg-red-500/20' :
                      type === 'fee' ? 'bg-amber-500/20' :
                      'bg-slate-700/50'
                    }`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-white font-medium capitalize">{type}</span>
                        <span className="text-sm text-slate-400">{data.count} txns</span>
                      </div>
                      <div className={`text-lg font-bold ${
                        type === 'interest' ? 'text-green-400' :
                        type === 'deposit' ? 'text-blue-400' :
                        type === 'withdrawal' ? 'text-red-400' :
                        type === 'fee' ? 'text-amber-400' :
                        'text-white'
                      }`}>
                        {formatCurrency(data.total)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Transaction Preview */}
              <div className="border border-slate-700 rounded overflow-hidden">
                <div className="bg-slate-700/50 p-3 flex justify-between items-center">
                  <span className="text-sm font-medium text-slate-300">
                    Transactions (showing first 50)
                  </span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800 sticky top-0">
                      <tr>
                        <th className="p-2 text-left text-slate-400">Date</th>
                        <th className="p-2 text-left text-slate-400">Type</th>
                        <th className="p-2 text-left text-slate-400">Description</th>
                        <th className="p-2 text-right text-slate-400">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m1ParseResult.transactions.slice(0, 50).map((tx, i) => (
                        <tr key={i} className="border-t border-slate-700">
                          <td className="p-2 text-slate-300">{tx.date}</td>
                          <td className="p-2">
                            <span className={`px-2 py-0.5 rounded text-xs ${
                              tx.type === 'interest' ? 'bg-green-500/20 text-green-300' :
                              tx.type === 'deposit' ? 'bg-blue-500/20 text-blue-300' :
                              tx.type === 'withdrawal' ? 'bg-red-500/20 text-red-300' :
                              tx.type === 'fee' ? 'bg-amber-500/20 text-amber-300' :
                              'bg-slate-500/20 text-slate-300'
                            }`}>
                              {tx.type.toUpperCase()}
                            </span>
                          </td>
                          <td className="p-2 text-slate-300 truncate max-w-xs">{tx.description}</td>
                          <td className={`p-2 text-right font-medium ${
                            tx.amount >= 0 ? 'text-green-400' : 'text-red-400'
                          }`}>
                            {formatCurrency(tx.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Errors if any */}
              {m1ParseResult.errors && m1ParseResult.errors.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
                  <h4 className="text-sm font-medium text-red-400 mb-2">Parse Errors</h4>
                  <ul className="text-sm text-red-300 space-y-1">
                    {m1ParseResult.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Apply Button */}
              <div className="flex gap-4">
                <button
                  onClick={async () => {
                    setIsProcessing(true)
                    // Filter to just cash-related transactions
                    const cashTxns = m1ParseResult.transactions.filter(tx =>
                      ['interest', 'deposit', 'withdrawal', 'fee'].includes(tx.type)
                    )
                    const result = await applyM1StatementTransactions(cashTxns, true)
                    setIsProcessing(false)
                    if (result.error) {
                      toast.error(result.error)
                    } else if (result.data) {
                      const { applied, skipped, errors } = result.data
                      if (errors.length > 0) {
                        toast.error(`Import completed with errors: ${errors.join(', ')}`)
                      } else if (applied > 0) {
                        toast.success(`Imported ${applied} transaction${applied !== 1 ? 's' : ''} (${skipped} skipped)`)
                        notifyFundsChanged()
                        onImported?.()
                        onClose()
                      } else {
                        toast.info(`No new transactions imported (${skipped} skipped as duplicates)`)
                      }
                    }
                  }}
                  disabled={isProcessing || m1ParseResult.transactionCount === 0}
                  className="flex-1 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  {isProcessing ? 'Importing...' : `Import ${m1ParseResult.transactionCount} Transactions to m1-cash`}
                </button>
              </div>
            </div>
          )}

          {/* Coinbase Transactions Scrape Step */}
          {step === 'coinbase-scrape' && (
            <CoinbaseScrapeStep
              onDataReady={handleCoinbaseDataReady}
              onClose={onClose}
            />
          )}

          {/* Coinbase Summary Step */}
          {step === 'coinbase-summary' && coinbaseArchive && (
            <div className="space-y-6">
              <div className="text-center py-4">
                <div className="text-5xl mb-4">📊</div>
                <h3 className="text-xl font-medium text-white mb-2">Transaction Summary</h3>
                <p className="text-slate-400">
                  Review your Coinbase transaction data before importing.
                </p>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                  <div className="text-sm text-slate-400 mb-1">Total Transactions</div>
                  <div className="text-2xl font-bold text-white">{coinbaseArchive.transactions.length.toLocaleString()}</div>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-4 border border-blue-500/30">
                  <div className="text-sm text-blue-400 mb-1">Perp-Related</div>
                  <div className="text-2xl font-bold text-blue-400">{coinbaseArchive.summary.perpRelatedCount.toLocaleString()}</div>
                </div>
              </div>

              {/* Perp Breakdown */}
              <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                <h4 className="text-white font-medium mb-3">Perp Trading Summary</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-slate-400">Trades</div>
                    <div className="text-white font-medium">{coinbaseArchive.summary.perpTradeCount}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Net Funding</div>
                    <div className={`font-medium ${coinbaseArchive.summary.netFunding >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${coinbaseArchive.summary.netFunding.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">USDC Interest</div>
                    <div className="text-green-400 font-medium">${coinbaseArchive.summary.usdcInterest.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Rebates</div>
                    <div className="text-green-400 font-medium">${coinbaseArchive.summary.rebates.toFixed(2)}</div>
                  </div>
                </div>
              </div>

              {/* Transaction Type Breakdown */}
              <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                <h4 className="text-white font-medium mb-3">Select Transaction Types to Import</h4>
                <div className="space-y-2">
                  {[
                    // Margin deposits/withdrawals
                    { type: 'DEPOSIT', label: 'Margin Deposits (USDC)', count: coinbaseArchive.transactions.filter(t => t.type === 'DEPOSIT' && t.isPerpRelated).length, amount: coinbaseArchive.transactions.filter(t => t.type === 'DEPOSIT' && t.isPerpRelated).reduce((sum, t) => sum + t.amount, 0) },
                    { type: 'OTHER', label: 'Other Deposits', count: coinbaseArchive.transactions.filter(t => t.type === 'OTHER' && t.isPerpRelated).length, amount: coinbaseArchive.transactions.filter(t => t.type === 'OTHER' && t.isPerpRelated).reduce((sum, t) => sum + t.amount, 0) },
                    // Funding
                    { type: 'FUNDING_PROFIT', label: 'Funding Profit', count: coinbaseArchive.transactions.filter(t => t.type === 'FUNDING_PROFIT').length, amount: coinbaseArchive.summary.fundingProfit },
                    { type: 'FUNDING_LOSS', label: 'Funding Loss', count: coinbaseArchive.transactions.filter(t => t.type === 'FUNDING_LOSS').length, amount: -coinbaseArchive.summary.fundingLoss },
                    // Trades
                    { type: 'BUY', label: 'Perp Buys', count: coinbaseArchive.transactions.filter(t => t.type === 'BUY' && t.isPerpRelated).length },
                    { type: 'SELL', label: 'Perp Sells', count: coinbaseArchive.transactions.filter(t => t.type === 'SELL' && t.isPerpRelated).length },
                    // Income
                    { type: 'USDC_INTEREST', label: 'USDC Interest', count: coinbaseArchive.transactions.filter(t => t.type === 'USDC_INTEREST').length, amount: coinbaseArchive.summary.usdcInterest },
                    { type: 'REBATE', label: 'Rebates', count: coinbaseArchive.transactions.filter(t => t.type === 'REBATE').length, amount: coinbaseArchive.summary.rebates },
                  ].map(({ type, label, count, amount }) => (
                    <label key={type} className="flex items-center gap-3 p-2 rounded hover:bg-slate-700/50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCoinbaseTypes.has(type)}
                        onChange={() => handleToggleCoinbaseType(type)}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                      />
                      <span className="flex-1 text-slate-300">{label}</span>
                      <span className="text-slate-500 text-sm">{count}</span>
                      {amount !== undefined && (
                        <span className={`text-sm ${amount >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          ${Math.abs(amount).toFixed(2)}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>

              <div className="text-center">
                <button
                  onClick={handleCoinbaseProceedToFundSelect}
                  disabled={selectedCoinbaseTypes.size === 0}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue to Fund Selection
                </button>
              </div>
            </div>
          )}

          {/* Coinbase Fund Selection Step */}
          {step === 'coinbase-fund-select' && coinbaseArchive && (
            <div className="space-y-6">
              <div className="text-center py-4">
                <div className="text-5xl mb-4">🎯</div>
                <h3 className="text-xl font-medium text-white mb-2">Select Target Fund</h3>
                <p className="text-slate-400">
                  Choose which fund to import the Coinbase transactions into.
                </p>
              </div>

              {availableFunds.length === 0 ? (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-center">
                  <p className="text-yellow-400">
                    No eligible funds found. Please create a derivatives or crypto fund first.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {availableFunds.map(fund => (
                    <label
                      key={fund.id}
                      className={`flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-colors ${
                        selectedCoinbaseFund === fund.id
                          ? 'bg-blue-500/10 border-blue-500'
                          : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name="coinbase-fund"
                        checked={selectedCoinbaseFund === fund.id}
                        onChange={() => setSelectedCoinbaseFund(fund.id)}
                        className="w-4 h-4 text-blue-500 focus:ring-blue-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-medium">{fund.id}</div>
                        <div className="text-sm text-slate-400">
                          {fund.platform} • {fund.config.fund_type || 'standard'} fund
                          {fund.entryCount > 0 && ` • ${fund.entryCount} entries`}
                        </div>
                      </div>
                      {fund.latestEquity && (
                        <div className="text-right">
                          <div className="text-white font-medium">
                            ${fund.latestEquity.value.toLocaleString()}
                          </div>
                          <div className="text-xs text-slate-500">{fund.latestEquity.date}</div>
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {/* Option to clear existing data */}
              {selectedCoinbaseFund && (
                <label className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
                  <input
                    type="checkbox"
                    checked={clearBeforeImport}
                    onChange={(e) => setClearBeforeImport(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-red-500 focus:ring-red-500"
                  />
                  <div>
                    <span className="text-slate-300">Clear existing entries before import</span>
                    <p className="text-xs text-slate-500">Warning: This will delete all existing entries in the fund</p>
                  </div>
                </label>
              )}

              <div className="flex gap-4 justify-center">
                <button
                  onClick={() => setStep('coinbase-summary')}
                  className="px-6 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleCoinbaseProceedToPreview}
                  disabled={!selectedCoinbaseFund}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Preview Import
                </button>
              </div>
            </div>
          )}

          {/* Coinbase Preview Step */}
          {step === 'coinbase-preview' && coinbaseArchive && selectedCoinbaseFund && (
            <div className="space-y-6">
              <div className="text-center py-4">
                <div className="text-5xl mb-4">👁️</div>
                <h3 className="text-xl font-medium text-white mb-2">Preview Import</h3>
                <p className="text-slate-400">
                  Review the transactions that will be imported.
                </p>
              </div>

              {/* Summary */}
              <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-white font-medium">Import Summary</h4>
                  <span className="text-sm text-slate-400">
                    Target: <span className="text-blue-400">{selectedCoinbaseFund}</span>
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-slate-400">Selected Types</div>
                    <div className="text-white font-medium">{selectedCoinbaseTypes.size}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Transactions</div>
                    <div className="text-white font-medium">
                      {coinbaseArchive.transactions.filter(t =>
                        selectedCoinbaseTypes.has(t.type) && t.isPerpRelated
                      ).length}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Clear First</div>
                    <div className={`font-medium ${clearBeforeImport ? 'text-red-400' : 'text-slate-500'}`}>
                      {clearBeforeImport ? 'Yes' : 'No'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Transaction Preview */}
              <div className="bg-slate-800/50 rounded-lg border border-slate-700 max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-800">
                    <tr className="text-left text-slate-400 border-b border-slate-700">
                      <th className="p-2">Date</th>
                      <th className="p-2">Type</th>
                      <th className="p-2">Title</th>
                      <th className="p-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coinbaseArchive.transactions
                      .filter(t => selectedCoinbaseTypes.has(t.type) && t.isPerpRelated)
                      .slice(0, 50)
                      .map((tx, i) => (
                        <tr key={tx.id} className={i % 2 === 0 ? 'bg-slate-800/30' : ''}>
                          <td className="p-2 text-slate-300">{tx.date}</td>
                          <td className="p-2 text-slate-400">{tx.type}</td>
                          <td className="p-2 text-slate-300 truncate max-w-[200px]">{tx.title}</td>
                          <td className={`p-2 text-right ${tx.amount >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            ${tx.amount.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {coinbaseArchive.transactions.filter(t => selectedCoinbaseTypes.has(t.type) && t.isPerpRelated).length > 50 && (
                  <div className="text-center text-slate-500 text-sm py-2 border-t border-slate-700">
                    ... and {coinbaseArchive.transactions.filter(t => selectedCoinbaseTypes.has(t.type) && t.isPerpRelated).length - 50} more
                  </div>
                )}
              </div>

              <div className="flex gap-4 justify-center">
                <button
                  onClick={() => setStep('coinbase-fund-select')}
                  className="px-6 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={async () => {
                    setStep('coinbase-importing')
                    setCoinbaseImportProgress({ phase: 'importing', applied: 0, skipped: 0, message: 'Importing transactions...' })

                    // Get transactions to import
                    const toImport = coinbaseArchive.transactions.filter(t =>
                      selectedCoinbaseTypes.has(t.type) && t.isPerpRelated
                    )

                    // Call import API
                    const response = await fetch(`/api/v1/import/coinbase/transactions/apply`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({
                        fundId: selectedCoinbaseFund,
                        transactionIds: toImport.map(t => t.id),
                        selectedTypes: Array.from(selectedCoinbaseTypes),
                        clearBeforeImport
                      })
                    })

                    if (!response.ok) {
                      const error = await response.text()
                      setCoinbaseImportProgress({ phase: 'error', applied: 0, skipped: 0, message: error || 'Import failed' })
                      toast.error('Import failed')
                      return
                    }

                    const result = await response.json()
                    toast.success(`Imported ${result.applied} transactions (${result.skipped} skipped)`)
                    notifyFundsChanged()
                    onImported?.()
                    onClose()
                  }}
                  disabled={coinbaseArchive.transactions.filter(t => selectedCoinbaseTypes.has(t.type) && t.isPerpRelated).length === 0}
                  className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Import Transactions
                </button>
              </div>
            </div>
          )}

          {/* Coinbase Importing Step */}
          {step === 'coinbase-importing' && (
            <div className="space-y-6">
              <div className="text-center py-8">
                {coinbaseImportProgress.phase === 'importing' && (
                  <>
                    <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <h3 className="text-xl font-medium text-white mb-2">Importing Transactions</h3>
                    <p className="text-slate-400">{coinbaseImportProgress.message}</p>
                  </>
                )}
                {coinbaseImportProgress.phase === 'complete' && (
                  <>
                    <div className="text-6xl mb-4">✅</div>
                    <h3 className="text-xl font-medium text-white mb-2">Import Complete</h3>
                    <p className="text-green-400 font-medium mb-2">{coinbaseImportProgress.message}</p>
                    <button
                      onClick={onClose}
                      className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                    >
                      Done
                    </button>
                  </>
                )}
                {coinbaseImportProgress.phase === 'error' && (
                  <>
                    <div className="text-6xl mb-4">❌</div>
                    <h3 className="text-xl font-medium text-white mb-2">Import Failed</h3>
                    <p className="text-red-400 font-medium mb-4">{coinbaseImportProgress.message}</p>
                    <div className="flex gap-4 justify-center">
                      <button
                        onClick={() => setStep('coinbase-preview')}
                        className="px-6 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                      >
                        Back
                      </button>
                      <button
                        onClick={onClose}
                        className="px-6 py-3 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors"
                      >
                        Close
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Step 2 (Scrape): Browser Launch/Login */}
          {step === 'browser' && (
            <div className="space-y-6">
              <div className="text-center py-8">
                {browserState === 'idle' && (
                  <>
                    <div className="text-6xl mb-4">🚀</div>
                    <h3 className="text-xl font-medium text-white mb-2">Launch Browser</h3>
                    <p className="text-slate-400 mb-6 max-w-md mx-auto">
                      We'll launch Chrome and open the {getPlatformDisplayName(method)} login page.
                      Log in to your account to continue.
                    </p>
                    <button
                      onClick={handleLaunchBrowser}
                      className="px-6 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors font-medium"
                    >
                      Launch Chrome
                    </button>
                  </>
                )}

                {browserState === 'launching' && (
                  <>
                    <div className="animate-spin text-6xl mb-4">⏳</div>
                    <h3 className="text-xl font-medium text-white mb-2">Launching Chrome...</h3>
                    <p className="text-slate-400">Please wait while we start the browser.</p>
                  </>
                )}

                {browserState === 'launched' && (
                  <>
                    <div className="text-6xl mb-4">🔐</div>
                    <h3 className="text-xl font-medium text-white mb-2">Log in to {getPlatformDisplayName(method)}</h3>
                    <p className="text-slate-400 mb-6 max-w-md mx-auto">
                      A Chrome window has opened. Please log in to your {getPlatformDisplayName(method)} account,
                      then click the button below to continue.
                    </p>
                    <button
                      onClick={handleConnectBrowser}
                      className="px-6 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors font-medium"
                    >
                      I'm Logged In - Continue
                    </button>
                    <p className="text-xs text-slate-500 mt-4">
                      We'll automatically detect when you're logged in
                    </p>
                  </>
                )}

                {browserState === 'connecting' && (
                  <>
                    <div className="animate-spin text-6xl mb-4">⏳</div>
                    <h3 className="text-xl font-medium text-white mb-2">Connecting...</h3>
                    <p className="text-slate-400">Establishing connection to browser.</p>
                  </>
                )}

                {browserState === 'connected' && (
                  <>
                    <div className="text-6xl mb-4">✅</div>
                    <h3 className="text-xl font-medium text-green-400 mb-2">Connected!</h3>
                    <p className="text-slate-400 mb-6">
                      Successfully connected to Chrome. {method === 'crypto-pdf' ? 'Ready to download crypto statements.' : method === 'm1-statements' ? 'Ready to download M1 statements.' : 'You can now proceed to enter a URL.'}
                    </p>
                    <button
                      onClick={() => {
                        if (method === 'crypto-pdf') {
                          // Go directly to crypto download
                          setStep('crypto-download')
                          setCryptoDownloadProgress({ phase: 'downloading', current: 0, total: 0, downloaded: 0, message: 'Navigating to crypto statements...' })
                          cryptoStreamRef.current = downloadCryptoStatementsStream(false, {
                            onStatus: (data) => {
                              setCryptoDownloadProgress(prev => ({
                                ...prev,
                                message: data.message,
                                total: data.total ?? prev.total
                              }))
                            },
                            onProgress: (data) => {
                              setCryptoDownloadProgress({
                                phase: 'downloading',
                                current: data.current,
                                total: data.total,
                                downloaded: data.downloaded,
                                message: data.status
                              })
                            },
                            onComplete: async (data) => {
                              setCryptoDownloadProgress({
                                phase: 'complete',
                                current: data.total,
                                total: data.total,
                                downloaded: data.downloaded,
                                message: data.message
                              })
                              // Refresh local statements list
                              const result = await getLocalCryptoStatements()
                              if (result.data) {
                                setCryptoStatements(result.data)
                              }
                              toast.success(data.message)
                              // Go back to crypto-pdf step to parse
                              setTimeout(() => setStep('crypto-pdf'), 1500)
                            },
                            onError: (data) => {
                              setCryptoDownloadProgress(prev => ({
                                ...prev,
                                phase: 'error',
                                message: data.message
                              }))
                              toast.error(data.message)
                            }
                          })
                        } else if (method === 'm1-statements') {
                          // Go directly to M1 statements download
                          setStep('m1-statements-download')
                          setM1DownloadProgress({ phase: 'downloading', current: 0, total: 0, downloaded: 0, message: 'Navigating to M1 statements...' })
                          m1StreamRef.current = downloadM1StatementsStream({ accountType: 'earn' }, {
                            onStatus: (data) => {
                              setM1DownloadProgress(prev => ({
                                ...prev,
                                message: data.message,
                                total: data.total ?? prev.total
                              }))
                            },
                            onProgress: (data) => {
                              setM1DownloadProgress({
                                phase: 'downloading',
                                current: data.current,
                                total: data.total,
                                downloaded: data.downloaded,
                                message: data.status
                              })
                            },
                            onComplete: async (data) => {
                              setM1DownloadProgress({
                                phase: 'complete',
                                current: data.total,
                                total: data.total,
                                downloaded: data.downloaded,
                                message: data.message
                              })
                              // Refresh local statements list
                              const result = await getLocalM1Statements()
                              if (result.data) {
                                setM1Statements(result.data)
                              }
                              toast.success(data.message)
                              // Go back to m1-statements step to parse
                              setTimeout(() => setStep('m1-statements'), 1500)
                            },
                            onError: (data) => {
                              setM1DownloadProgress(prev => ({
                                ...prev,
                                phase: 'error',
                                message: data.message
                              }))
                              toast.error(data.message)
                            }
                          })
                        } else {
                          handleProceedToUrl()
                        }
                      }}
                      className="px-6 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors font-medium"
                    >
                      {method === 'crypto-pdf' ? 'Download Crypto Statements' : method === 'm1-statements' ? 'Download M1 Statements' : 'Continue to URL Entry'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Step 3 (Scrape): Enter URL */}
          {step === 'url' && (
            <div className="space-y-6">
              <div className="text-center mb-6">
                <div className="text-4xl mb-2">🔗</div>
                <h3 className="text-lg font-medium text-white">Navigate to History Page</h3>
              </div>

              {/* Recommended: Full history */}
              <div className="bg-mint-500/10 border border-mint-500/30 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <span className="text-xl">✨</span>
                  <div>
                    <h4 className="text-sm font-medium text-mint-400 mb-1">Recommended: Import All History</h4>
                    <p className="text-sm text-slate-300 mb-2">
                      In the Chrome window, navigate to your full account history:
                    </p>
                    <code className="block bg-slate-800 text-mint-400 text-sm px-3 py-2 rounded font-mono">
                      robinhood.com/account/history
                    </code>
                    <p className="text-xs text-slate-400 mt-2">
                      This page shows all transactions. We'll scroll through the entire history automatically.
                    </p>
                  </div>
                </div>
              </div>

              {/* Alternative: Single asset */}
              <div className="bg-slate-700/50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-slate-300 mb-2">Alternative: Single Asset History</h4>
                <p className="text-sm text-slate-400">
                  You can also navigate to a specific asset's history page (e.g., Bitcoin → History).
                </p>
              </div>

              <div className="space-y-3">
                <label className="block text-sm font-medium text-slate-300">
                  Paste the URL from Chrome
                </label>
                <input
                  type="url"
                  value={scrapeUrl}
                  onChange={(e) => setScrapeUrl(e.target.value)}
                  placeholder="https://robinhood.com/account/history"
                  className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-mint-500"
                />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fullSync}
                  onChange={(e) => setFullSync(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-0"
                />
                <div>
                  <span className="text-sm font-medium text-slate-300">Full Sync</span>
                  <p className="text-xs text-slate-500">Scrape all history instead of stopping at existing data</p>
                </div>
              </label>

              <button
                onClick={handleScrapeUrl}
                disabled={!scrapeUrl.trim() || isProcessing}
                className="w-full px-4 py-3 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {fullSync ? 'Full Sync Transactions' : 'Scrape Transactions'}
              </button>

              <p className="text-xs text-slate-500 text-center">
                {fullSync
                  ? 'Full sync will scrape ALL history (may take longer). Use when data is missing.'
                  : "We'll automatically scroll to load your entire transaction history."
                }
              </p>
            </div>
          )}

          {/* Step 3 (M1 Cash): Enter URL */}
          {step === 'm1-cash-url' && (
            <div className="space-y-6">
              <div className="text-center mb-6">
                <div className="text-4xl mb-2">💰</div>
                <h3 className="text-lg font-medium text-white">Navigate to M1 Savings Transactions</h3>
              </div>

              {/* Instructions */}
              <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <span className="text-xl">✨</span>
                  <div>
                    <h4 className="text-sm font-medium text-cyan-400 mb-1">Import Cash Interest</h4>
                    <p className="text-sm text-slate-300 mb-2">
                      In the Chrome window, log in to M1 and navigate to your savings transactions:
                    </p>
                    <code className="block bg-slate-800 text-cyan-400 text-sm px-3 py-2 rounded font-mono">
                      dashboard.m1.com/d/save/savings/transactions
                    </code>
                    <p className="text-xs text-slate-400 mt-2">
                      We'll scrape all transaction pages to capture your interest payments.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <label className="block text-sm font-medium text-slate-300">
                  M1 Savings Transactions URL
                </label>
                <input
                  type="url"
                  value={m1CashUrl}
                  onChange={(e) => setM1CashUrl(e.target.value)}
                  placeholder="https://dashboard.m1.com/d/save/savings/transactions"
                  className="w-full px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <button
                onClick={handleScrapeM1Cash}
                disabled={!m1CashUrl.trim() || isProcessing}
                className="w-full px-4 py-3 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                Scrape M1 Cash Transactions
              </button>

              <p className="text-xs text-slate-500 text-center">
                We'll automatically navigate through all pages to capture your transaction history.
              </p>
            </div>
          )}

          {/* Step 2 (CSV): File Upload */}
          {step === 'upload' && (
            <div
              className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
                isDragging
                  ? 'border-mint-500 bg-mint-500/10'
                  : 'border-slate-600 hover:border-slate-500'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <div className="text-4xl mb-4">📄</div>
              <p className="text-white font-medium mb-2">
                {platform
                  ? `Drop your ${formatPlatformName(platform)} CSV file here`
                  : 'Drop your CSV file here'}
              </p>
              <p className="text-slate-400 text-sm mb-4">
                or click to browse
              </p>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileInput}
                className="hidden"
                id="csv-file-input"
              />
              <label
                htmlFor="csv-file-input"
                className="inline-block px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 cursor-pointer transition-colors"
              >
                Select File
              </label>

              {/* Include cash impact option */}
              <div className="mt-6 p-4 bg-slate-700/30 rounded-lg text-left max-w-md mx-auto">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeCashImpact}
                    onChange={(e) => setIncludeCashImpact(e.target.checked)}
                    className="w-4 h-4 mt-0.5 rounded border-slate-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800"
                  />
                  <div>
                    <span className="text-white font-medium">Include cash impact from all trading</span>
                    <p className="text-xs text-slate-400 mt-1">
                      Generate cash entries for all BUY/SELL/DIVIDEND transactions.
                      Use this for platforms like Robinhood where cash and investing are unified.
                    </p>
                  </div>
                </label>
              </div>

              <p className="text-slate-500 text-xs mt-4">
                {platform?.toLowerCase().replace(/-cash$/, '') === 'cashapp'
                  ? 'Export from Cash App: Profile → Documents → Statements → Export CSV'
                  : 'Export from Robinhood: Account → Documents → Account Statements → Transaction History'
                }
              </p>
            </div>
          )}

          {/* Scraping Progress */}
          {step === 'scraping' && (
            <div className="space-y-6 py-6">
              <div className="text-center">
                <div className="text-4xl mb-4">
                  {scrapeProgress.phase === 'error' ? '❌' :
                   scrapeProgress.phase === 'complete' ? '✅' :
                   scrapeProgress.phase === 'scraping' ? '📊' : '🔄'}
                </div>
                <h3 className="text-lg font-medium text-white mb-2">
                  {scrapeProgress.phase === 'scraping' ? 'Scraping Transactions' :
                   scrapeProgress.phase === 'complete' ? 'Scrape Complete' :
                   scrapeProgress.phase === 'error' ? 'Scrape Failed' :
                   'Connecting...'}
                </h3>
                <p className="text-slate-400">{scrapeProgress.status}</p>
              </div>

              {/* Progress bar */}
              {scrapeProgress.total > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-slate-400">
                    <span>Progress</span>
                    <span>{scrapeProgress.current} / {scrapeProgress.total}</span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-mint-500 transition-all duration-300"
                      style={{ width: `${Math.min(100, (scrapeProgress.current / scrapeProgress.total) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-green-400">{scrapeProgress.newCount} new</span>
                    <span className="text-slate-500">{scrapeProgress.current - scrapeProgress.newCount} existing</span>
                  </div>
                </div>
              )}

              {/* Latest transaction */}
              {scrapeProgress.lastTx && (
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-slate-300 mb-3">Latest Transaction</h4>
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500 block">Date</span>
                      <span className="text-white">{scrapeProgress.lastTx.date}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Type</span>
                      <span className={`capitalize ${
                        scrapeProgress.lastTx.type === 'buy' ? 'text-green-400' :
                        scrapeProgress.lastTx.type === 'sell' ? 'text-red-400' :
                        scrapeProgress.lastTx.type === 'dividend' ? 'text-blue-400' :
                        scrapeProgress.lastTx.type === 'interest' ? 'text-purple-400' :
                        'text-white'
                      }`}>{scrapeProgress.lastTx.type}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Symbol</span>
                      <span className="text-white font-medium">{scrapeProgress.lastTx.symbol || '-'}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Amount</span>
                      <span className="text-white">{formatCurrencyShort(scrapeProgress.lastTx.amount)}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500 truncate">
                    {scrapeProgress.lastTx.title}
                  </div>
                </div>
              )}

              {/* Scrolling indicator */}
              {scrapeProgress.phase === 'scraping' && (
                <div className="text-center text-sm text-slate-500">
                  <span className="inline-block animate-bounce mr-1">↓</span>
                  Auto-scrolling to load more history...
                </div>
              )}
            </div>
          )}

          {/* Crypto Download Progress */}
          {step === 'crypto-download' && (
            <div className="space-y-6 py-6">
              <div className="text-center">
                <div className="text-4xl mb-4">
                  {cryptoDownloadProgress.phase === 'error' ? '❌' :
                   cryptoDownloadProgress.phase === 'complete' ? '✅' :
                   '📥'}
                </div>
                <h3 className="text-lg font-medium text-white mb-2">
                  {cryptoDownloadProgress.phase === 'downloading' ? 'Downloading Crypto Statements' :
                   cryptoDownloadProgress.phase === 'complete' ? 'Download Complete' :
                   cryptoDownloadProgress.phase === 'error' ? 'Download Failed' :
                   'Starting...'}
                </h3>
                <p className="text-slate-400">{cryptoDownloadProgress.message}</p>
              </div>

              {/* Progress bar */}
              {cryptoDownloadProgress.total > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-slate-400">
                    <span>Progress</span>
                    <span>{cryptoDownloadProgress.current} / {cryptoDownloadProgress.total}</span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all duration-300"
                      style={{ width: `${Math.min(100, (cryptoDownloadProgress.current / cryptoDownloadProgress.total) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-amber-400">{cryptoDownloadProgress.downloaded} downloaded</span>
                    <span className="text-slate-500">{cryptoDownloadProgress.current - cryptoDownloadProgress.downloaded} skipped</span>
                  </div>
                </div>
              )}

              {cryptoDownloadProgress.phase === 'complete' && (
                <div className="text-center text-sm text-slate-400">
                  Returning to parse statements...
                </div>
              )}
            </div>
          )}

          {/* Loading State */}
          {step === 'importing' && (
            <div className="text-center py-12">
              <div className="animate-spin text-4xl mb-4">⏳</div>
              <p className="text-slate-400">
                {method === 'scrape' ? 'Loading transactions...' : 'Parsing CSV...'}
              </p>
            </div>
          )}

          {/* Preview Step */}
          {step === 'preview' && preview && (
            <div className="space-y-6">
              {/* Header */}
              <div className="text-center">
                <div className="text-4xl mb-2">📊</div>
                <h3 className="text-lg font-medium text-white">Select Funds to Import</h3>
                <p className="text-sm text-slate-400 mt-1">
                  {preview.summary.total} transactions found • Click to select/deselect funds
                </p>
              </div>

              {/* Matched Funds (fundExists = true) */}
              {Object.keys(preview.summary.bySymbol).length > 0 && (
                <div className="space-y-4">
                  {/* Matched funds section */}
                  {Object.entries(preview.summary.bySymbol).some(([, d]) => d.fundExists) && (
                    <div>
                      <h4 className="text-sm font-medium text-green-400 mb-2">Matched Funds</h4>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(preview.summary.bySymbol)
                          .filter(([, data]) => data.fundExists)
                          .sort(([, a], [, b]) => b.count - a.count)
                          .map(([symbol, data]) => {
                            const isSelected = selectedSymbols.has(symbol)
                            return (
                              <button
                                key={symbol}
                                onClick={() => {
                                  const next = new Set(selectedSymbols)
                                  if (isSelected) next.delete(symbol)
                                  else next.add(symbol)
                                  setSelectedSymbols(next)
                                }}
                                className={`px-3 py-2 rounded text-sm transition-colors ${
                                  isSelected
                                    ? 'bg-green-500/30 text-green-300 border border-green-500/50'
                                    : 'bg-slate-700/50 text-slate-400 border border-transparent hover:border-slate-500'
                                }`}
                                title={`${data.fundId} - ${data.count} transactions`}
                              >
                                <span className="font-medium">{symbol}</span>
                                <span className="text-slate-400 ml-2">{data.count}</span>
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  )}

                  {/* Unmatched funds section */}
                  {Object.entries(preview.summary.bySymbol).some(([, d]) => !d.fundExists) && (
                    <div>
                      <h4 className="text-sm font-medium text-amber-400 mb-2">Unmatched (no fund exists)</h4>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(preview.summary.bySymbol)
                          .filter(([, data]) => !data.fundExists)
                          .sort(([, a], [, b]) => b.count - a.count)
                          .map(([symbol, data]) => (
                            <div
                              key={symbol}
                              className="px-3 py-2 rounded text-sm bg-slate-800/50 text-slate-500 border border-slate-700"
                              title={`Would map to ${data.fundId} - create fund first`}
                            >
                              <span>{symbol}</span>
                              <span className="ml-2">{data.count}</span>
                              <span className="ml-1 text-amber-500">⚠</span>
                            </div>
                          ))}
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        Create funds for these symbols to enable import
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Quick actions */}
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => {
                    const all = new Set<string>()
                    Object.entries(preview.summary.bySymbol).forEach(([symbol, data]) => {
                      if (data.fundExists) all.add(symbol)
                    })
                    setSelectedSymbols(all)
                  }}
                  className="px-3 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                >
                  Select All Matched
                </button>
                <button
                  onClick={() => setSelectedSymbols(new Set())}
                  className="px-3 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                >
                  Deselect All
                </button>
              </div>

              {/* Clear before import toggle */}
              <div className="bg-slate-700/30 rounded-lg p-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={clearBeforeImport}
                    onChange={(e) => setClearBeforeImport(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 text-mint-500 focus:ring-mint-500 focus:ring-offset-slate-800"
                  />
                  <div>
                    <span className="text-white font-medium">Clear fund entries before import</span>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Delete all existing entries in selected funds before importing new data
                    </p>
                  </div>
                </label>
              </div>

              {/* Import summary */}
              {selectedSymbols.size > 0 && (
                <div className="bg-mint-500/10 border border-mint-500/30 rounded p-4 text-center">
                  <p className="text-mint-300">
                    Ready to import{' '}
                    <strong>
                      {preview.transactions.filter(tx => selectedSymbols.has(tx.symbol)).length}
                    </strong>{' '}
                    transactions from{' '}
                    <strong>{selectedSymbols.size}</strong> fund{selectedSymbols.size !== 1 ? 's' : ''}
                    {clearBeforeImport && (
                      <span className="text-amber-400 ml-1">(funds will be cleared first)</span>
                    )}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-slate-700 flex justify-between items-center">
          <div className="text-sm text-slate-400">
            {step === 'preview' && selectedSymbols.size > 0 && preview && (
              <span>
                {selectedSymbols.size} fund{selectedSymbols.size !== 1 ? 's' : ''} selected
                ({preview.transactions.filter(tx => selectedSymbols.has(tx.symbol)).length} transactions)
              </span>
            )}
            {step === 'scraping' && scrapeProgress.newCount > 0 && (
              <span className="text-green-400">
                Data is being saved to archive as it's scraped
              </span>
            )}
          </div>
          <div className="flex gap-3">
            {step !== 'method' && step !== 'importing' && (
              <button
                type="button"
                onClick={handleBack}
                className="px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 transition-colors"
              >
                {step === 'scraping' ? 'Cancel Scrape' : 'Back'}
              </button>
            )}
            {step !== 'scraping' && (
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
            )}
            {step === 'preview' && (
              <button
                type="button"
                onClick={handleApply}
                disabled={isProcessing || selectedSymbols.size === 0}
                className="px-4 py-2 bg-mint-600 text-white rounded hover:bg-mint-700 transition-colors disabled:opacity-50"
              >
                {isProcessing ? 'Importing...' : `Import ${selectedSymbols.size} Fund${selectedSymbols.size !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

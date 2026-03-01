/**
 * CoinbaseScrapeButton Component
 * Button that triggers Coinbase transactions page scraping with real-time progress.
 */

import { useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import {
  scrapeCoinbaseTransactionsStream,
  type CoinbaseScrapeStatusEvent,
  type CoinbaseScrapeProgressEvent,
  type CoinbaseScrapeCompleteEvent
} from '../api/import'

interface ScrapeProgress {
  status: string
  phase: 'connecting' | 'navigating' | 'loading' | 'scraping' | 'complete' | 'error'
  current: number
  total: number
  newCount: number
  perpRelatedCount?: number
  cashBalance?: number | null
  lastTx: {
    date: string
    type: string
    symbol?: string
    amount: number
    title: string
    isPerpRelated: boolean
  } | null
}

interface CoinbaseScrapeButtonProps {
  fundId?: string | undefined
  stopDate?: string | undefined
  onComplete?: (result: CoinbaseScrapeCompleteEvent) => void
  className?: string
  variant?: 'primary' | 'secondary'
}

export function CoinbaseScrapeButton({
  fundId,
  stopDate,
  onComplete,
  className = '',
  variant = 'primary'
}: CoinbaseScrapeButtonProps) {
  const [isScraping, setIsScraping] = useState(false)
  const [showProgress, setShowProgress] = useState(false)
  const [progress, setProgress] = useState<ScrapeProgress>({
    status: '',
    phase: 'connecting',
    current: 0,
    total: 0,
    newCount: 0,
    lastTx: null
  })

  const scrapeStreamRef = useRef<{ close: () => void } | null>(null)

  const handleScrape = useCallback(() => {
    setIsScraping(true)
    setShowProgress(true)
    setProgress({
      status: 'Connecting to browser...',
      phase: 'connecting',
      current: 0,
      total: 0,
      newCount: 0,
      lastTx: null
    })

    scrapeStreamRef.current = scrapeCoinbaseTransactionsStream(
      { stopDate, fundId },
      {
        onStatus: (data: CoinbaseScrapeStatusEvent) => {
          setProgress(prev => ({
            ...prev,
            status: data.message,
            phase: data.phase as ScrapeProgress['phase']
          }))
        },
        onProgress: (data: CoinbaseScrapeProgressEvent) => {
          setProgress({
            status: `Scraped ${data.current} transactions (${data.newCount} new)`,
            phase: 'scraping',
            current: data.current,
            total: data.total,
            newCount: data.newCount,
            lastTx: data.lastTransaction
          })
        },
        onComplete: (data: CoinbaseScrapeCompleteEvent) => {
          setProgress(prev => ({
            ...prev,
            phase: 'complete',
            status: data.message,
            perpRelatedCount: data.perpRelatedCount,
            cashBalance: data.cashBalance ?? null
          }))
          toast.success(data.message)
          setIsScraping(false)
          onComplete?.(data)

          // Hide progress after a delay
          setTimeout(() => {
            setShowProgress(false)
          }, 3000)
        },
        onError: (data) => {
          setProgress(prev => ({
            ...prev,
            phase: 'error',
            status: data.message
          }))
          toast.error(data.message)
          setIsScraping(false)
        }
      }
    )
  }, [stopDate, fundId, onComplete])

  const handleCancel = useCallback(() => {
    scrapeStreamRef.current?.close()
    setIsScraping(false)
    setShowProgress(false)
    toast.info('Scraping cancelled')
  }, [])

  const buttonClasses = variant === 'primary'
    ? 'bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-800'
    : 'bg-slate-700 hover:bg-slate-600 text-white disabled:bg-slate-800'

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        <button
          onClick={handleScrape}
          disabled={isScraping}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors disabled:opacity-50 ${buttonClasses}`}
        >
          {isScraping ? 'Scraping...' : 'Scrape Transactions'}
        </button>
        {isScraping && (
          <button
            onClick={handleCancel}
            className="px-2 py-1.5 text-xs bg-red-600/30 hover:bg-red-600/50 text-red-400 rounded transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress Display */}
      {showProgress && (
        <div className="bg-slate-800/50 rounded-lg p-3 text-sm space-y-2 border border-slate-700">
          {/* Status */}
          <div className="flex items-center gap-2">
            {progress.phase === 'scraping' && (
              <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            )}
            {progress.phase === 'complete' && (
              <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {progress.phase === 'error' && (
              <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            <span className={`${
              progress.phase === 'complete' ? 'text-green-400' :
              progress.phase === 'error' ? 'text-red-400' :
              'text-slate-300'
            }`}>
              {progress.status}
            </span>
          </div>

          {/* Progress Bar */}
          {progress.phase === 'scraping' && progress.total > 0 && (
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${Math.min((progress.current / progress.total) * 100, 100)}%` }}
              />
            </div>
          )}

          {/* Last Transaction */}
          {progress.lastTx && (
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span className={progress.lastTx.isPerpRelated ? 'text-blue-400' : 'text-slate-500'}>
                {progress.lastTx.isPerpRelated ? 'PERP' : 'Other'}
              </span>
              <span>{progress.lastTx.date}</span>
              <span className="text-slate-500">|</span>
              <span>{progress.lastTx.type}</span>
              <span className="text-slate-500">|</span>
              <span className={progress.lastTx.amount >= 0 ? 'text-green-400' : 'text-red-400'}>
                ${progress.lastTx.amount.toFixed(2)}
              </span>
            </div>
          )}

          {/* Summary */}
          {progress.phase === 'complete' && (
            <div className="text-xs text-slate-400 space-y-1">
              {progress.perpRelatedCount !== undefined && (
                <div>{progress.perpRelatedCount} perp-related transactions found</div>
              )}
              {progress.cashBalance !== undefined && progress.cashBalance !== null && (
                <div className="text-blue-400">
                  Cash Balance: ${progress.cashBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

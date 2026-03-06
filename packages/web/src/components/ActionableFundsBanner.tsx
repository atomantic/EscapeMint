import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { fetchActionableFunds, FUNDS_CHANGED_EVENT, type ActionableFund } from '../api/funds'
import { getFundTypeFeatures } from '@escapemint/engine'
import { useSettings } from '../contexts/SettingsContext'
import { isStockMarketClosed } from '../utils/format'

// Days overdue threshold for high urgency styling (red border)
const URGENCY_THRESHOLD_DAYS = 7

// Storage key for dismissed items
const DISMISSED_STORAGE_KEY = 'actionable-funds-dismissed'

// Event to notify other components when actionable funds visibility changes
export const ACTIONABLE_DISMISSED_EVENT = 'escapemint:actionable-dismissed'

export function notifyActionableDismissed(visibleCount: number) {
  window.dispatchEvent(new CustomEvent(ACTIONABLE_DISMISSED_EVENT, { detail: { visibleCount } }))
}

// Get dismissed fund IDs from sessionStorage (shared helper for Layout)
export function getDismissedFundIds(): Set<string> {
  const saved = sessionStorage.getItem(DISMISSED_STORAGE_KEY)
  if (!saved) return new Set()
  try {
    const parsed = JSON.parse(saved) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'date' in parsed && 'ids' in parsed) {
      const { date, ids } = parsed as { date: unknown; ids: unknown }
      if (typeof date !== 'string' || !Array.isArray(ids)) return new Set()
      const today = new Date().toISOString().split('T')[0]
      if (date !== today) {
        sessionStorage.removeItem(DISMISSED_STORAGE_KEY)
        return new Set()
      }
      return new Set(ids.filter((id): id is string => typeof id === 'string'))
    }
    return new Set()
  } catch (e: unknown) {
    console.warn('Failed to parse dismissed fund IDs:', e)
    sessionStorage.removeItem(DISMISSED_STORAGE_KEY)
    return new Set()
  }
}

export function ActionableFundsBanner() {
  const { settings } = useSettings()
  const [actionableFunds, setActionableFunds] = useState<ActionableFund[]>([])
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState<Set<string>>(() => getDismissedFundIds())

  const loadActionableFunds = useCallback(async () => {
    setLoading(true)
    const result = await fetchActionableFunds(settings.testFundsMode)
    if (result.data) {
      setActionableFunds(result.data.actionableFunds)
    }
    setLoading(false)
  }, [settings.testFundsMode])

  useEffect(() => {
    loadActionableFunds()

    // Refresh when funds change (e.g., after adding an entry)
    const handleFundsChange = () => loadActionableFunds()
    window.addEventListener(FUNDS_CHANGED_EVENT, handleFundsChange)
    return () => window.removeEventListener(FUNDS_CHANGED_EVENT, handleFundsChange)
  }, [loadActionableFunds])

  const dismissFund = (id: string) => {
    const newDismissed = new Set(dismissed)
    newDismissed.add(id)
    setDismissed(newDismissed)
    const today = new Date().toISOString().split('T')[0]
    sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ date: today, ids: [...newDismissed] }))
    // Notify other components (like nav badge) about the change
    const newVisibleCount = actionableFunds.filter(f => !newDismissed.has(f.id)).length
    notifyActionableDismissed(newVisibleCount)
  }

  // Check if stock market is closed (weekend or holiday)
  // No memoization needed - lightweight check that updates correctly when data refreshes
  const marketClosed = isStockMarketClosed()

  // Filter out dismissed funds and stock funds when market is closed
  const visibleFunds = actionableFunds.filter(f => {
    if (dismissed.has(f.id)) return false
    // Skip stock funds on weekends/holidays since market is closed
    if (marketClosed && f.fundType === 'stock') return false
    return true
  })

  // Notify on initial load and when actionable funds change
  useEffect(() => {
    if (!loading) {
      notifyActionableDismissed(visibleFunds.length)
    }
  }, [loading, visibleFunds.length])

  if (loading || visibleFunds.length === 0) {
    return null
  }

  return (
    <div className="bg-amber-900/30 border border-amber-600/50 rounded-lg p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-amber-400 text-lg">⏰</span>
          <h3 className="text-amber-200 font-medium text-sm sm:text-base">
            {visibleFunds.length} {visibleFunds.length === 1 ? 'fund needs' : 'funds need'} attention
          </h3>
        </div>
        {visibleFunds.length > 3 && (
          <span className="text-amber-400/60 text-xs">Scroll for more →</span>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-thin">
        {visibleFunds.map(fund => {
          const features = getFundTypeFeatures(fund.fundType)
          const isOverdue = fund.daysOverdue > 0
          // Solid backgrounds for contrast - using slate-800 base with colored borders
          const urgencyClass = fund.daysOverdue >= URGENCY_THRESHOLD_DAYS ? 'border-red-400 bg-slate-800' :
            fund.daysOverdue > 0 ? 'border-amber-400 bg-slate-800' :
              'border-yellow-400 bg-slate-800'

          return (
            <div
              key={fund.id}
              className={`flex-shrink-0 rounded-lg border-2 p-2 sm:p-3 ${urgencyClass} min-w-[140px] sm:min-w-[180px]`}
            >
              <div className="flex items-start justify-between gap-1">
                <Link
                  to={`/fund/${fund.id}/add`}
                  className="flex-1 min-w-0"
                >
                  <div className="flex items-center gap-1 mb-1">
                    <span className={`text-xs sm:text-sm font-bold uppercase ${features.textColorClass}`}>
                      {fund.ticker}
                    </span>
                    <span className="text-slate-300 text-[10px] sm:text-xs capitalize">
                      {fund.platform}
                    </span>
                  </div>
                  <div className="text-[10px] sm:text-xs">
                    {isOverdue ? (
                      <span className="text-amber-300 font-medium">
                        {fund.daysOverdue}d overdue
                      </span>
                    ) : (
                      <span className="text-yellow-300 font-medium">Due today</span>
                    )}
                    <span className="text-slate-400 ml-1">
                      ({fund.intervalDays}d interval)
                    </span>
                  </div>
                </Link>
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    dismissFund(fund.id)
                  }}
                  className="text-slate-500 hover:text-slate-300 active:text-slate-200 p-1 -m-1 touch-manipulation"
                  title="Dismiss for this session"
                  aria-label="Dismiss this fund notification for today"
                >
                  <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {dismissed.size > 0 && (
        <button
          onClick={() => {
            setDismissed(new Set())
            sessionStorage.removeItem(DISMISSED_STORAGE_KEY)
            // Notify nav badge that all items are visible again
            notifyActionableDismissed(actionableFunds.length)
          }}
          className="mt-2 text-xs text-slate-500 hover:text-slate-400 active:text-slate-300"
        >
          Show {dismissed.size} dismissed
        </button>
      )}
    </div>
  )
}

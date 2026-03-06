import { useState, useEffect, useMemo, useCallback } from 'react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { fetchFunds, fetchActionableFunds, FUNDS_CHANGED_EVENT, type FundSummary } from '../api/funds'
import { fetchPlatforms, type Platform } from '../api/platforms'
import { useSettings } from '../contexts/SettingsContext'
import { ACTIONABLE_DISMISSED_EVENT, getDismissedFundIds } from './ActionableFundsBanner'
import { isStockMarketClosed } from '../utils/format'

const SIDEBAR_COLLAPSED_KEY = 'escapemint-sidebar-collapsed'
const EXPANDED_PLATFORMS_KEY = 'escapemint-expanded-platforms'
const API_BASE = '/api'

// Custom event for sidebar toggle - charts listen for this to resize
export const SIDEBAR_TOGGLED_EVENT = 'escapemint-sidebar-toggled'

const navItems = [
  { path: '/', label: 'Dashboard', icon: '📊' },
  { path: '/backtest', label: 'Backtest', icon: '📈' },
  { path: '/audit', label: 'Audit Trail', icon: '📋' },
  { path: '/platforms', label: 'Platforms', icon: '🏦' }
]

interface GroupedFunds {
  platform: Platform
  funds: FundSummary[]
}

export function Layout() {
  const location = useLocation()
  const { settings } = useSettings()
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
    return saved === 'true'
  })
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [funds, setFunds] = useState<FundSummary[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [version, setVersion] = useState<string>('')
  const [actionableFundsCount, setActionableFundsCount] = useState(0)
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(EXPANDED_PLATFORMS_KEY)
    if (!saved) return new Set()
    try { return new Set(JSON.parse(saved)) } catch { return new Set() }
  })

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    // Dispatch event after transition completes (200ms transition duration)
    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLED_EVENT))
    }, 220)
    return () => clearTimeout(timer)
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem(EXPANDED_PLATFORMS_KEY, JSON.stringify([...expandedPlatforms]))
  }, [expandedPlatforms])

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  // Load funds and platforms based on testFundsMode setting
  const loadFundsAndPlatforms = useCallback(() => {
    fetchFunds(settings.testFundsMode).then(result => {
      if (result.error) {
        console.warn('Failed to fetch funds:', result.error)
        toast.error('Failed to load funds')
        setFunds([])
        return
      }
      if (result.data) setFunds(result.data)
    }).catch((e: unknown) => {
      console.warn('Failed to fetch funds:', e)
      toast.error('Failed to load funds')
      setFunds([])
    })
    fetchPlatforms(settings.testFundsMode).then(result => {
      if (result.error) {
        console.warn('Failed to fetch platforms:', result.error)
        toast.error('Failed to load platforms')
        setPlatforms([])
        return
      }
      if (result.data) setPlatforms(result.data)
    }).catch((e: unknown) => {
      console.warn('Failed to fetch platforms:', e)
      toast.error('Failed to load platforms')
      setPlatforms([])
    })
    fetchActionableFunds(settings.testFundsMode).then(result => {
      if (result.error) {
        console.warn('Failed to fetch actionable funds:', result.error)
        setActionableFundsCount(0)
        return
      }
      if (result.data) {
        // Filter out dismissed funds and stock funds when market is closed
        // Market status recalculates on each data fetch, which handles day transitions
        const dismissed = getDismissedFundIds()
        const marketClosed = isStockMarketClosed()
        const visibleCount = result.data.actionableFunds.filter(f => {
          if (dismissed.has(f.id)) return false
          // Skip stock funds on weekends/holidays since market is closed
          if (marketClosed && f.fundType === 'stock') return false
          return true
        }).length
        setActionableFundsCount(visibleCount)
      }
    }).catch((e: unknown) => {
      console.warn('Failed to fetch actionable funds:', e)
      setActionableFundsCount(0)
    })
  }, [settings.testFundsMode])

  // Fetch funds, platforms, and version on mount and when testFundsMode changes
  useEffect(() => {
    loadFundsAndPlatforms()
    fetch(`${API_BASE}/version`)
      .then(res => res.json())
      .then(data => setVersion(data.version))
      .catch((e: unknown) => {
        console.warn('Failed to fetch version:', e)
      })
  }, [loadFundsAndPlatforms])

  // Listen for funds changed event
  useEffect(() => {
    const handleFundsChanged = () => loadFundsAndPlatforms()
    window.addEventListener(FUNDS_CHANGED_EVENT, handleFundsChanged)
    return () => window.removeEventListener(FUNDS_CHANGED_EVENT, handleFundsChanged)
  }, [loadFundsAndPlatforms])

  // Listen for actionable funds dismissed event (to sync nav badge with banner)
  useEffect(() => {
    const handleDismissed = (e: Event) => {
      const customEvent = e as CustomEvent<{ visibleCount: number }>
      setActionableFundsCount(customEvent.detail.visibleCount)
    }
    window.addEventListener(ACTIONABLE_DISMISSED_EVENT, handleDismissed)
    return () => window.removeEventListener(ACTIONABLE_DISMISSED_EVENT, handleDismissed)
  }, [])

  // Group funds by platform, separating active from closed
  const { activeFunds, closedFunds } = useMemo(() => {
    const platformMap = new Map<string, Platform>()
    for (const p of platforms) {
      platformMap.set(p.id, p)
    }

    const activeGroups = new Map<string, FundSummary[]>()
    const closedGroups = new Map<string, FundSummary[]>()

    for (const fund of funds) {
      const platformId = fund.platform.toLowerCase()
      const isClosed = fund.config.status === 'closed'
      const groups = isClosed ? closedGroups : activeGroups

      if (!groups.has(platformId)) {
        groups.set(platformId, [])
      }
      groups.get(platformId)!.push(fund)
    }

    // Sort funds within each group by ticker
    for (const fundList of [...activeGroups.values(), ...closedGroups.values()]) {
      fundList.sort((a, b) => a.ticker.localeCompare(b.ticker))
    }

    const toGroupedFunds = (groups: Map<string, FundSummary[]>): GroupedFunds[] =>
      Array.from(groups.entries())
        .map(([platformId, platformFunds]) => ({
          platform: platformMap.get(platformId) || { id: platformId, name: platformId.charAt(0).toUpperCase() + platformId.slice(1) },
          funds: platformFunds
        }))
        .sort((a, b) => a.platform.name.localeCompare(b.platform.name))

    return {
      activeFunds: toGroupedFunds(activeGroups),
      closedFunds: toGroupedFunds(closedGroups)
    }
  }, [funds, platforms])

  const togglePlatform = (platformId: string) => {
    setExpandedPlatforms(prev => {
      const next = new Set(prev)
      if (next.has(platformId)) {
        next.delete(platformId)
      } else {
        next.add(platformId)
      }
      return next
    })
  }

  const isActiveFund = (fundId: string) => location.pathname === `/fund/${fundId}`
  const isPlatformPage = (platformId: string) => location.pathname === `/platform/${platformId}`
  const isPlatformActive = (platformId: string) => {
    return isPlatformPage(platformId) || funds.some(f => f.platform.toLowerCase() === platformId && isActiveFund(f.id))
  }

  const renderFundNav = (showLabels: boolean, groups: GroupedFunds[], keyPrefix = '') => (
    <div className={`${showLabels ? 'mt-1' : 'mt-1'} space-y-1`}>
      {groups.map(({ platform, funds: platformFunds }) => {
        const expandKey = keyPrefix + platform.id
        const isExpanded = expandedPlatforms.has(expandKey)
        const hasActiveFund = isPlatformActive(platform.id)

        return (
          <div key={expandKey}>
            {/* Platform Header */}
            <div className="flex items-baseline mx-1">
              <button
                onClick={() => togglePlatform(expandKey)}
                className={`flex-shrink-0 px-1 py-1.5 text-xs leading-none transition-colors ${
                  hasActiveFund
                    ? 'text-mint-400'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
              <Link
                to={`/platform/${platform.id}`}
                className={`flex-1 py-1.5 rounded text-xs transition-colors ${
                  isPlatformPage(platform.id)
                    ? 'text-mint-400 font-bold'
                    : hasActiveFund
                      ? 'text-mint-400 font-medium'
                      : 'text-slate-500 hover:text-slate-300 font-medium'
                }`}
                title={!showLabels ? `${platform.name} Dashboard` : undefined}
              >
                {showLabels ? (
                  <span className="truncate">{platform.name}</span>
                ) : (
                  <span>{platform.name.charAt(0)}</span>
                )}
              </Link>
            </div>

            {/* Fund Links */}
            {isExpanded && (
              <div className={`${showLabels ? 'ml-4' : ''} space-y-0.5`}>
                {platformFunds.map(fund => (
                  <Link
                    key={fund.id}
                    to={`/fund/${fund.id}`}
                    className={`flex items-center gap-2 px-3 py-1 mx-1 rounded text-xs transition-colors ${
                      isActiveFund(fund.id)
                        ? 'bg-slate-700 text-mint-400'
                        : 'text-slate-400 hover:bg-slate-700/50 hover:text-white'
                    }`}
                    title={!showLabels ? fund.ticker.toUpperCase() : undefined}
                  >
                    {showLabels ? (
                      <span className="uppercase truncate">{fund.ticker}</span>
                    ) : (
                      <span className="uppercase text-[10px]">{fund.ticker.slice(0, 4)}</span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="h-screen bg-slate-900 flex overflow-hidden">
      {/* Sidebar - Desktop */}
      <div className="hidden md:block relative flex-shrink-0">
        <aside
          className={`flex flex-col h-screen sticky top-0 bg-slate-800 border-r border-slate-700 transition-all duration-200 overflow-x-hidden ${
            collapsed ? 'w-14' : 'w-48'
          }`}
        >
        {/* Logo */}
        <div className="h-11 flex-shrink-0 flex items-center px-3 border-b border-slate-700">
          <Link to="/" className="flex items-center gap-2 overflow-hidden">
            <span className="text-lg flex-shrink-0">🌱</span>
            {!collapsed && <span className="text-sm font-bold text-mint-400 whitespace-nowrap">EscapeMint</span>}
          </Link>
        </div>

        {/* Nav Items */}
        <nav className="py-2 flex-shrink-0">
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-2 px-3 py-2 mx-1 rounded text-sm transition-colors ${
                location.pathname === item.path
                  ? 'bg-slate-700 text-mint-400'
                  : 'text-slate-400 hover:bg-slate-700/50 hover:text-white'
              }`}
              title={collapsed ? item.label : undefined}
            >
              <span className="flex-shrink-0 relative">
                {item.icon}
                {item.path === '/' && actionableFundsCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] bg-amber-500 text-slate-900 text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                    {actionableFundsCount > 9 ? '9+' : actionableFundsCount}
                  </span>
                )}
              </span>
              {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
            </Link>
          ))}
        </nav>

        {/* Divider */}
        <div className="mx-3 flex-shrink-0 border-t border-slate-700" />

        {/* Fund Navigation - Scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin scrollbar-thumb-slate-700">
          {!collapsed && (
            <div className="px-3 py-1 text-[10px] text-slate-600 uppercase tracking-wider">
              Active Funds
            </div>
          )}
          {renderFundNav(!collapsed, activeFunds)}

          {/* Closed Funds Section */}
          {closedFunds.length > 0 && (
            <>
              <div className="mx-3 my-2 border-t border-slate-700" />
              {!collapsed && (
                <div className="px-3 py-1 text-[10px] text-slate-600 uppercase tracking-wider">
                  Closed Funds
                </div>
              )}
              {renderFundNav(!collapsed, closedFunds, 'closed:')}
            </>
          )}
        </div>

        {/* Version & Settings - Fixed Footer */}
        <div className={`flex-shrink-0 border-t border-slate-700 px-3 py-2 flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {version && (
            <span className="text-[10px] text-slate-600">
              v{version}
            </span>
          )}
          <Link
            to="/settings"
            className={`text-slate-500 hover:text-white transition-colors ${location.pathname === '/settings' ? 'text-mint-400' : ''}`}
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>
        </div>
        </aside>
        {/* Expand/Collapse button - outside aside to avoid overflow clipping */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={`absolute top-3 z-10 p-1 bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white rounded transition-all duration-200 shadow-md ${
            collapsed ? 'right-[-8px]' : 'right-2'
          }`}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg
            className={`w-4 h-4 transition-transform ${collapsed ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar - Mobile */}
      <aside
        className={`fixed inset-y-0 left-0 w-56 flex flex-col bg-slate-800 border-r border-slate-700 z-50 transform transition-transform md:hidden ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="h-11 flex-shrink-0 flex items-center justify-between px-3 border-b border-slate-700">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg">🌱</span>
            <span className="text-sm font-bold text-mint-400">EscapeMint</span>
          </Link>
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="text-slate-400 hover:text-white p-1"
          >
            ✕
          </button>
        </div>

        {/* Nav Items */}
        <nav className="py-2 flex-shrink-0">
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-2 px-3 py-2 mx-1 rounded text-sm transition-colors ${
                location.pathname === item.path
                  ? 'bg-slate-700 text-mint-400'
                  : 'text-slate-400 hover:bg-slate-700/50 hover:text-white'
              }`}
            >
              <span className="relative">
                {item.icon}
                {item.path === '/' && actionableFundsCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] bg-amber-500 text-slate-900 text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                    {actionableFundsCount > 9 ? '9+' : actionableFundsCount}
                  </span>
                )}
              </span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* Divider */}
        <div className="mx-3 flex-shrink-0 border-t border-slate-700" />

        {/* Fund Navigation - Mobile */}
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          <div className="px-3 py-1 text-[10px] text-slate-600 uppercase tracking-wider">
            Active Funds
          </div>
          {renderFundNav(true, activeFunds)}

          {/* Closed Funds Section - Mobile */}
          {closedFunds.length > 0 && (
            <>
              <div className="mx-3 my-2 border-t border-slate-700" />
              <div className="px-3 py-1 text-[10px] text-slate-600 uppercase tracking-wider">
                Closed Funds
              </div>
              {renderFundNav(true, closedFunds, 'closed:')}
            </>
          )}
        </div>

        {/* Version & Settings - Mobile */}
        <div className="flex-shrink-0 px-3 py-2 border-t border-slate-700 flex items-center justify-between">
          {version && (
            <span className="text-[10px] text-slate-600">
              v{version}
            </span>
          )}
          <Link
            to="/settings"
            className={`text-slate-500 hover:text-white transition-colors ${location.pathname === '/settings' ? 'text-mint-400' : ''}`}
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-screen">
        {/* Mobile Header */}
        <header className="md:hidden h-11 flex-shrink-0 bg-slate-800 border-b border-slate-700 flex items-center px-3 gap-3">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="text-slate-400 hover:text-white p-1"
          >
            ☰
          </button>
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg">🌱</span>
            <span className="text-sm font-bold text-mint-400">EscapeMint</span>
          </Link>
        </header>

        {/* Page Content */}
        <main className="flex-1 min-h-0 p-2 md:p-3 lg:p-4 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

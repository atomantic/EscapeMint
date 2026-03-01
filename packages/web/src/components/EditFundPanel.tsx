import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { updateFund, deleteFund, syncFromSubfunds, notifyFundsChanged, type FundConfig, type FundStatus, type FundType, type FundCategory, type CategoryAllocation } from '../api/funds'
import { fetchPlatforms, type Platform } from '../api/platforms'
import { useSettings } from '../contexts/SettingsContext'
import {
  isCashFund as checkIsCashFund,
  getFundTypeFeatures,
  FUND_TYPE_DEFAULTS,
  FUND_CATEGORIES,
  FUND_CATEGORY_CONFIG
} from '@escapemint/engine'

interface EditFundPanelProps {
  fundId: string
  fundPlatform: string
  fundTicker: string
  config: FundConfig
  onUpdated: () => void
}

// Round to avoid floating point precision issues
const round = (value: number, decimals: number = 2): number => {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

export function EditFundPanel({ fundId, fundPlatform, fundTicker, config, onUpdated }: EditFundPanelProps) {
  const navigate = useNavigate()
  const { settings } = useSettings()
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatform, setSelectedPlatform] = useState(fundPlatform.toLowerCase())
  const [ticker, setTicker] = useState(fundTicker.toLowerCase())
  const [fundType, setFundType] = useState<FundType>(config.fund_type ?? 'stock')
  const [category, setCategory] = useState<FundCategory | ''>(config.category ?? '')
  const [isMultiCategory, setIsMultiCategory] = useState(
    config.category_allocations && config.category_allocations.length > 0
  )
  const [categoryAllocations, setCategoryAllocations] = useState<CategoryAllocation[]>(
    config.category_allocations ?? []
  )
  const [formData, setFormData] = useState({
    status: config.status ?? 'active' as FundStatus,
    fund_size_usd: config.fund_size_usd,
    target_apy: round(config.target_apy * 100),
    interval_days: config.interval_days,
    input_min_usd: config.input_min_usd,
    input_mid_usd: config.input_mid_usd,
    input_max_usd: config.input_max_usd,
    max_at_pct: round(config.max_at_pct * 100),
    min_profit_usd: config.min_profit_usd,
    cash_apy: round(config.cash_apy * 100),
    margin_apr: round(config.margin_apr * 100),
    margin_access_usd: config.margin_access_usd,
    accumulate: config.accumulate,
    manage_cash: config.manage_cash ?? true,
    margin_enabled: config.margin_enabled ?? false,
    dividend_reinvest: config.dividend_reinvest ?? true,
    interest_reinvest: config.interest_reinvest ?? true,
    expense_from_fund: config.expense_from_fund ?? true
  })

  const isCashFund = checkIsCashFund(fundType)
  const features = getFundTypeFeatures(fundType)
  const defaults = FUND_TYPE_DEFAULTS[fundType]

  useEffect(() => {
    fetchPlatforms().then(result => {
      if (result.data) {
        setPlatforms(result.data)
      }
    })
  }, [])

  const handleClose = () => {
    navigate(`/fund/${fundId}`)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    // For non-trading funds, use defaults for trading-related fields
    const updatedConfig: Partial<FundConfig> = {
      status: formData.status,
      fund_type: fundType,
      // Always send both fields to clear stale values on the server
      category: !isMultiCategory && category ? category : null,
      category_allocations: isMultiCategory && categoryAllocations.length > 0 ? categoryAllocations : null,
      fund_size_usd: formData.fund_size_usd,
      target_apy: features.allowsTrading ? round(formData.target_apy / 100, 4) : (defaults.target_apy ?? 0),
      interval_days: features.allowsTrading ? formData.interval_days : (defaults.interval_days ?? 1),
      input_min_usd: features.allowsTrading ? formData.input_min_usd : (defaults.input_min_usd ?? 0),
      input_mid_usd: features.allowsTrading ? formData.input_mid_usd : (defaults.input_mid_usd ?? 0),
      input_max_usd: features.allowsTrading ? formData.input_max_usd : (defaults.input_max_usd ?? 0),
      max_at_pct: features.allowsTrading ? round(formData.max_at_pct / 100, 4) : (defaults.max_at_pct ?? 0),
      min_profit_usd: features.allowsTrading ? formData.min_profit_usd : (defaults.min_profit_usd ?? 0),
      cash_apy: round(formData.cash_apy / 100, 4),
      margin_apr: round(formData.margin_apr / 100, 4),
      margin_access_usd: formData.margin_access_usd,
      accumulate: features.allowsTrading ? formData.accumulate : (defaults.accumulate ?? true),
      manage_cash: features.allowsTrading ? formData.manage_cash : (defaults.manage_cash ?? true),
      margin_enabled: features.allowsTrading ? formData.margin_enabled : (defaults.margin_enabled ?? false),
      dividend_reinvest: formData.dividend_reinvest,
      interest_reinvest: formData.interest_reinvest,
      expense_from_fund: formData.expense_from_fund
    }

    const platformChanged = selectedPlatform !== fundPlatform.toLowerCase()
    const tickerChanged = ticker.toLowerCase() !== fundTicker.toLowerCase()
    const updatePayload: { config: Partial<FundConfig>; platform?: string; ticker?: string } = { config: updatedConfig }
    if (platformChanged) {
      updatePayload.platform = selectedPlatform
    }
    if (tickerChanged) {
      updatePayload.ticker = ticker.toLowerCase()
    }
    const result = await updateFund(fundId, updatePayload)

    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Fund configuration updated')
      notifyFundsChanged()
      if ((platformChanged || tickerChanged) && result.data) {
        navigate(`/fund/${result.data.id}`)
      } else {
        onUpdated()
        navigate(`/fund/${fundId}`)
      }
    }

    setLoading(false)
  }

  const handleDelete = async () => {
    setDeleting(true)
    const result = await deleteFund(fundId)

    if (result.error) {
      toast.error(result.error)
      setDeleting(false)
    } else {
      toast.success(`Deleted ${fundTicker.toUpperCase()}`)
      notifyFundsChanged()
      navigate('/')
    }
  }

  const handleSyncFromSubfunds = async () => {
    setSyncing(true)
    const result = await syncFromSubfunds(fundId)

    if (result.error) {
      toast.error(result.error)
    } else if (result.data) {
      const { added, skipped, finalBalance, subFundsSynced } = result.data
      if (added > 0) {
        toast.success(`Synced ${added} entries from ${subFundsSynced.length} sub-funds. Balance: $${finalBalance.toFixed(2)}`)
      } else if (skipped > 0) {
        toast.info(`No new entries to sync (${skipped} already existed)`)
      } else {
        toast.info('No trading activity found in sub-funds')
      }
      onUpdated()
    }
    setSyncing(false)
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={handleClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-slate-800 border-l border-slate-700 z-50 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">Edit {fundTicker.toUpperCase()}</h2>
            <p className="text-slate-400 text-xs">Update fund configuration</p>
          </div>
          <button
            onClick={handleClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Fund Type Selection */}
          <div>
            <label className="block text-xs text-slate-400 mb-2">Fund Type</label>
            <div className="flex gap-2">
              {(['stock', 'crypto', 'cash', 'derivatives'] as FundType[]).map(type => {
                const typeFeatures = getFundTypeFeatures(type)
                const bgColorClass = fundType === type
                  ? type === 'cash' ? 'bg-blue-600'
                    : type === 'crypto' ? 'bg-yellow-600'
                    : type === 'derivatives' ? 'bg-orange-600'
                    : 'bg-green-600'
                  : 'bg-slate-700 hover:bg-slate-600'
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setFundType(type)}
                    className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${bgColorClass} ${
                      fundType === type ? 'text-white' : 'text-slate-300'
                    }`}
                  >
                    {typeFeatures.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Category Selection - not shown for cash funds (always liquidity) */}
          {fundType !== 'cash' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-xs text-slate-400">Category (for portfolio balance)</label>
                <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isMultiCategory}
                    onChange={e => {
                      setIsMultiCategory(e.target.checked)
                      if (e.target.checked && categoryAllocations.length === 0) {
                        setCategoryAllocations([{ category: 'volatility', percentage: 100 }])
                      }
                    }}
                    className="rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                  />
                  Multi-category (pie fund)
                </label>
              </div>

              {!isMultiCategory ? (
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value as FundCategory | '')}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                >
                  <option value="">No category</option>
                  {FUND_CATEGORIES.map(cat => {
                    const catConfig = FUND_CATEGORY_CONFIG[cat]
                    return (
                      <option key={cat} value={cat}>
                        {catConfig.label} - {catConfig.description}
                      </option>
                    )
                  })}
                </select>
              ) : (
                <div className="space-y-2">
                  {categoryAllocations.map((alloc, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <select
                        value={alloc.category}
                        onChange={e => {
                          const newAllocations = [...categoryAllocations]
                          newAllocations[index] = { ...alloc, category: e.target.value as FundCategory }
                          setCategoryAllocations(newAllocations)
                        }}
                        className="flex-1 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      >
                        {FUND_CATEGORIES.map(cat => (
                          <option key={cat} value={cat}>
                            {FUND_CATEGORY_CONFIG[cat].label}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={alloc.percentage}
                          onChange={e => {
                            const newAllocations = [...categoryAllocations]
                            newAllocations[index] = { ...alloc, percentage: parseFloat(e.target.value) || 0 }
                            setCategoryAllocations(newAllocations)
                          }}
                          className="w-16 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-white text-right focus:outline-none focus:border-mint-500"
                          min="0"
                          max="100"
                          step="1"
                        />
                        <span className="text-slate-400 text-sm">%</span>
                      </div>
                      {categoryAllocations.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setCategoryAllocations(categoryAllocations.filter((_, i) => i !== index))}
                          className="p-1 text-slate-400 hover:text-red-400"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setCategoryAllocations([...categoryAllocations, { category: 'liquidity', percentage: 0 }])}
                      className="text-xs text-mint-400 hover:text-mint-300"
                    >
                      + Add category
                    </button>
                    {(() => {
                      const total = categoryAllocations.reduce((sum, a) => sum + a.percentage, 0)
                      const isValid = Math.abs(total - 100) < 0.01
                      return (
                        <span className={`text-xs ${isValid ? 'text-slate-400' : 'text-amber-400'}`}>
                          Total: {total.toFixed(0)}%{!isValid && ' (should be 100%)'}
                        </span>
                      )
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Platform & Ticker */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Platform</label>
              <select
                value={selectedPlatform}
                onChange={e => setSelectedPlatform(e.target.value)}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
              >
                {platforms.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Ticker</label>
              <input
                type="text"
                value={ticker}
                onChange={e => setTicker(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white uppercase focus:outline-none focus:border-mint-500"
                required
              />
            </div>
          </div>
          {(selectedPlatform !== fundPlatform.toLowerCase() || ticker !== fundTicker.toLowerCase()) && (
            <p className="text-xs text-amber-400 -mt-3">
              Fund will be renamed from {fundId} to {selectedPlatform}-{ticker.toLowerCase()}
            </p>
          )}

          {/* Status and Start Date - Fund Size is tracked in entries, not config */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Status</label>
              <select
                value={formData.status}
                onChange={e => setFormData({ ...formData, status: e.target.value as FundStatus })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
              >
                <option value="active">Active</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>

          {/* Trading Fund: Full configuration */}
          {features.allowsTrading && (
            <>
              {/* Target APY and Interval */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Target APY (%)</label>
                  <input
                    type="number"
                    value={formData.target_apy}
                    onChange={e => setFormData({ ...formData, target_apy: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                    step="1"
                    min="0"
                    max="500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Interval (days)</label>
                  <input
                    type="number"
                    value={formData.interval_days}
                    onChange={e => setFormData({ ...formData, interval_days: parseInt(e.target.value) || 1 })}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                    min="1"
                    required
                  />
                </div>
              </div>

              {/* DCA Amounts */}
              <div>
                <label className="block text-xs text-slate-400 mb-2">DCA Amounts ($)</label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">Min (on target)</label>
                    <input
                      type="number"
                      value={formData.input_min_usd}
                      onChange={e => setFormData({ ...formData, input_min_usd: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      step="10"
                      min="0"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">Mid (below)</label>
                    <input
                      type="number"
                      value={formData.input_mid_usd}
                      onChange={e => setFormData({ ...formData, input_mid_usd: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      step="10"
                      min="0"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">Max (loss)</label>
                    <input
                      type="number"
                      value={formData.input_max_usd}
                      onChange={e => setFormData({ ...formData, input_max_usd: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      step="10"
                      min="0"
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Max At % and Min Profit */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Max DCA Threshold (%)</label>
                  <input
                    type="number"
                    value={formData.max_at_pct}
                    onChange={e => setFormData({ ...formData, max_at_pct: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                    step="1"
                    placeholder="e.g., -25"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">Use max DCA when loss exceeds this %</p>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Min Profit to Sell ($)</label>
                  <input
                    type="number"
                    value={formData.min_profit_usd}
                    onChange={e => setFormData({ ...formData, min_profit_usd: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                    step="10"
                    min="0"
                  />
                </div>
              </div>

              {/* Accumulate Toggle */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="accumulate"
                  checked={formData.accumulate}
                  onChange={e => setFormData({ ...formData, accumulate: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                />
                <label htmlFor="accumulate" className="text-sm text-white">
                  Accumulate Mode
                  <span className="text-slate-400 text-xs ml-2">(sell only DCA amount)</span>
                </label>
              </div>

              {/* Cash Management Section */}
              <div className="border border-slate-600 rounded p-3 space-y-3">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="manage_cash"
                    checked={formData.manage_cash}
                    onChange={e => setFormData({ ...formData, manage_cash: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                  />
                  <label htmlFor="manage_cash" className="text-sm text-white font-medium">
                    Manage Cash
                  </label>
                  <span className="text-slate-400 text-xs">(maintain cash pile)</span>
                </div>
              </div>

              {/* Margin Section */}
              <div className="border border-slate-600 rounded p-3 space-y-3">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="margin_enabled"
                    checked={formData.margin_enabled}
                    onChange={e => setFormData({ ...formData, margin_enabled: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                  />
                  <label htmlFor="margin_enabled" className="text-sm text-white font-medium">
                    Margin Trading
                  </label>
                  <span className="text-slate-400 text-xs">(enable borrowing)</span>
                </div>
                {formData.margin_enabled && (
                  <div className="ml-7 grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Margin APR (%)</label>
                      <input
                        type="number"
                        value={formData.margin_apr}
                        onChange={e => setFormData({ ...formData, margin_apr: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Margin Access ($)</label>
                      <input
                        type="number"
                        value={formData.margin_access_usd}
                        onChange={e => setFormData({ ...formData, margin_access_usd: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                        step="100"
                        min="0"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Income & Expense Handling */}
              <div className="border border-slate-600 rounded p-3 space-y-3">
                <p className="text-sm text-white font-medium">Income & Expense Handling</p>
                <div className="space-y-2 ml-2">
                  {features.supportsDividends && (
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="dividend_reinvest"
                        checked={formData.dividend_reinvest}
                        onChange={e => setFormData({ ...formData, dividend_reinvest: e.target.checked })}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                      />
                      <label htmlFor="dividend_reinvest" className="text-sm text-white">
                        Reinvest Dividends
                        <span className="text-slate-400 text-xs ml-2">{formData.dividend_reinvest ? '(adds to fund)' : '(extract)'}</span>
                      </label>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="interest_reinvest"
                      checked={formData.interest_reinvest}
                      onChange={e => setFormData({ ...formData, interest_reinvest: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                    />
                    <label htmlFor="interest_reinvest" className="text-sm text-white">
                      Reinvest Cash Interest
                      <span className="text-slate-400 text-xs ml-2">{formData.interest_reinvest ? '(adds to fund)' : '(extract)'}</span>
                    </label>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="expense_from_fund"
                      checked={formData.expense_from_fund}
                      onChange={e => setFormData({ ...formData, expense_from_fund: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                    />
                    <label htmlFor="expense_from_fund" className="text-sm text-white">
                      Expenses From Fund
                      <span className="text-slate-400 text-xs ml-2">{formData.expense_from_fund ? '(reduces fund)' : '(external)'}</span>
                    </label>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Sync from Sub-funds (Cash funds only, requires Advanced Tools setting) */}
          {isCashFund && settings.advancedTools && (
            <div className="border border-yellow-600/30 rounded p-3 bg-yellow-900/10">
              <p className="text-sm text-white font-medium mb-2">
                <span className="text-yellow-400">[Advanced]</span> Sync Trading Activity
              </p>
              <p className="text-xs text-slate-400 mb-3">
                Import historical BUY/SELL activity from related sub-funds (e.g., {fundPlatform.toLowerCase()}-btc, {fundPlatform.toLowerCase()}-eth).
                BUYs become withdrawals, SELLs become deposits. Use with caution - may create duplicates if data already exists.
              </p>
              <button
                type="button"
                onClick={handleSyncFromSubfunds}
                disabled={syncing}
                className="px-3 py-1.5 text-sm bg-yellow-600 text-white rounded hover:bg-yellow-700 transition-colors disabled:opacity-50"
              >
                {syncing ? 'Syncing...' : 'Sync from Sub-funds'}
              </button>
            </div>
          )}

          {/* Delete Section */}
          <div className="border-t border-slate-700 pt-4">
            {!showDeleteConfirm ? (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-sm text-red-400 hover:text-red-300 transition-colors"
              >
                Delete this fund...
              </button>
            ) : (
              <div className="bg-red-900/20 border border-red-800 rounded p-3">
                <p className="text-red-400 text-sm mb-3">
                  Delete <strong>{fundTicker.toUpperCase()}</strong>? This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-600 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-slate-700 flex-shrink-0">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || deleting}
            className="flex-1 px-4 py-2 bg-mint-600 text-white rounded hover:bg-mint-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  )
}

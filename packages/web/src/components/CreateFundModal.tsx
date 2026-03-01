import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { createFund, notifyFundsChanged, type FundConfig, type FundType, type FundCategory, type CategoryAllocation } from '../api/funds'
import { fetchPlatforms, createPlatform, deletePlatform, type Platform } from '../api/platforms'
import {
  getFundTypeFeatures,
  FUND_TYPE_DEFAULTS,
  FUND_CATEGORIES,
  FUND_CATEGORY_CONFIG,
  DEFAULT_CATEGORY_BY_TYPE
} from '@escapemint/engine'

interface CreateFundModalProps {
  onClose: () => void
  onCreated?: () => void
}

const round = (value: number, decimals: number = 2): number => {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

export function CreateFundModal({ onClose, onCreated }: CreateFundModalProps) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatform, setSelectedPlatform] = useState('')
  const [isCreatingPlatform, setIsCreatingPlatform] = useState(false)
  const [newPlatformName, setNewPlatformName] = useState('')
  const [ticker, setTicker] = useState('')
  const [fundType, setFundType] = useState<FundType>('stock')
  const [category, setCategory] = useState<FundCategory | ''>('')
  const [isMultiCategory, setIsMultiCategory] = useState(false)
  const [categoryAllocations, setCategoryAllocations] = useState<CategoryAllocation[]>([])
  const [formData, setFormData] = useState({
    fund_size_usd: 10000,
    target_apy: 25, // Display as percentage
    interval_days: 7,
    input_min_usd: 100,
    input_mid_usd: 200,
    input_max_usd: 500,
    max_at_pct: -25, // Display as percentage
    min_profit_usd: 100,
    cash_apy: 4, // Display as percentage
    margin_apr: 7, // Display as percentage
    margin_access_usd: 0,
    accumulate: true,
    manage_cash: true,
    margin_enabled: false,
    dividend_reinvest: true,
    interest_reinvest: true,
    expense_from_fund: true
  })

  const features = getFundTypeFeatures(fundType)
  const defaults = FUND_TYPE_DEFAULTS[fundType]

  useEffect(() => {
    fetchPlatforms().then(result => {
      if (result.data) {
        setPlatforms(result.data)
        if (result.data.length === 0) {
          setIsCreatingPlatform(true)
        } else {
          // Default to Robinhood if available, otherwise first platform
          const robinhood = result.data.find(p => p.id === 'robinhood')
          const defaultPlatform = robinhood || result.data[0]
          if (defaultPlatform) {
            setSelectedPlatform(defaultPlatform.id)
          }
        }
      }
    })
  }, [])

  // Update manage_cash default and category when fund type changes
  useEffect(() => {
    // Set default category based on fund type
    const defaultCategory = DEFAULT_CATEGORY_BY_TYPE[fundType]
    setCategory(defaultCategory || '')

    if (fundType === 'stock' || fundType === 'crypto') {
      setFormData(prev => ({
        ...prev,
        manage_cash: false,
        dividend_reinvest: false,
        interest_reinvest: false,
        expense_from_fund: false
      }))
    } else {
      setFormData(prev => ({
        ...prev,
        manage_cash: true,
        dividend_reinvest: true,
        interest_reinvest: true,
        expense_from_fund: true
      }))
    }
  }, [fundType])

  // Auto-assign category based on ticker
  useEffect(() => {
    if (!category) {
      const t = ticker.toLowerCase()
      if (t === 'btc') {
        setCategory('sov')
      } else if (t === 'strc') {
        setCategory('yield')
      }
    }
  }, [ticker, category])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    let platformId = selectedPlatform
    if (isCreatingPlatform) {
      if (!newPlatformName.trim()) {
        toast.error('Platform name is required')
        return
      }
      platformId = newPlatformName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      if (!platformId) {
        toast.error('Platform name must contain letters or numbers')
        return
      }
      if (platformId.startsWith('test')) {
        toast.error("Platform names starting with 'test' are reserved")
        return
      }
    }

    if (!platformId || !ticker) {
      toast.error('Platform and ticker are required')
      return
    }
    setLoading(true)
    let createdNewPlatform = false

    try {
      if (isCreatingPlatform) {
        const platformResult = await createPlatform({
          id: platformId,
          name: newPlatformName.trim()
        })
        if (platformResult.error) {
          // If platform already exists (e.g. retry after fund creation failed), treat as success
          if (!platformResult.error.toLowerCase().includes('already exists')) {
            toast.error(platformResult.error)
            return
          }
        } else {
          createdNewPlatform = true
        }
      }

      // For non-trading funds, use defaults for trading-related fields
      const config: Partial<FundConfig> = {
        status: 'active',
        fund_type: fundType,
        // Multi-category takes precedence, clear single category when using allocations
        ...(!isMultiCategory && category ? { category } : {}),
        ...(isMultiCategory && categoryAllocations.length > 0 ? { category_allocations: categoryAllocations } : {}),
        fund_size_usd: fundType === 'cash' ? formData.fund_size_usd : 0,
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

      const result = await createFund({
        platform: platformId,
        ticker: ticker.toLowerCase(),
        config
      })

      if (result.error) {
        if (createdNewPlatform) {
          deletePlatform(platformId).catch(() => {})
        }
        toast.error(result.error)
      } else {
        toast.success(`Created ${ticker.toUpperCase()} fund`)
        notifyFundsChanged()
        onClose()
        onCreated?.()
        if (result.data) {
          navigate(`/fund/${result.data.id}`)
        }
      }
    } catch {
      if (createdNewPlatform) {
        deletePlatform(platformId).catch(() => {})
      }
      toast.error('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div role="dialog" data-testid="create-fund-modal" className="bg-slate-800 rounded-lg p-6 w-full max-w-lg border border-slate-700 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-2">Create New Fund</h2>
        <p className="text-slate-400 text-sm mb-4">Set up a new investment tracking fund</p>

        <form onSubmit={handleSubmit} className="space-y-4">
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
            <p className="text-[10px] text-slate-500 mt-1">
              {fundType === 'cash'
                ? 'Cash funds track deposits/withdrawals and earn interest'
                : fundType === 'crypto'
                ? 'Crypto funds track buy/sell without dividends'
                : fundType === 'derivatives'
                ? 'Futures funds track perpetual contracts with FIFO cost basis'
                : 'Stock funds support full trading, dividends, and DCA strategies'}
            </p>
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
              {isCreatingPlatform ? (
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={newPlatformName}
                    onChange={e => setNewPlatformName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                    placeholder="e.g., Robinhood"
                    autoFocus
                  />
                  {platforms.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsCreatingPlatform(false)
                        setNewPlatformName('')
                        if (!selectedPlatform || !platforms.some(p => p.id === selectedPlatform)) {
                          if (platforms.length > 0) setSelectedPlatform(platforms[0]!.id)
                        }
                      }}
                      className="px-2 py-2 text-slate-400 hover:text-white shrink-0"
                      aria-label="Cancel new platform"
                    >
                      <svg className="w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ) : (
                <select
                  value={selectedPlatform}
                  onChange={e => {
                    if (e.target.value === '__new__') {
                      setIsCreatingPlatform(true)
                    } else {
                      setSelectedPlatform(e.target.value)
                    }
                  }}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                  required
                >
                  {platforms.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                  <option value="__new__">+ New Platform</option>
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Ticker</label>
              <input
                type="text"
                name="ticker"
                id="ticker"
                value={ticker}
                onChange={e => setTicker(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white uppercase focus:outline-none focus:border-mint-500"
                placeholder={!features.allowsTrading ? 'e.g., cash, savings' : 'e.g., SPY, AAPL'}
                required
              />
            </div>
          </div>

          {/* Fund Size (cash only) and Start Date */}
          <div className={`grid gap-3 ${fundType === 'cash' ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {fundType === 'cash' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">Initial Balance ($)</label>
                <input
                  type="number"
                  name="fund_size_usd"
                  id="fund-size"
                  value={formData.fund_size_usd}
                  onChange={e => setFormData({ ...formData, fund_size_usd: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                  step="100"
                  min="0"
                  required
                />
              </div>
            )}
          </div>

          {/* Trading Fund: Target APY and Interval */}
          {features.allowsTrading && (
            <>
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
                    <label className="block text-[10px] text-slate-500 mb-1">Min</label>
                    <input
                      type="number"
                      value={formData.input_min_usd}
                      onChange={e => setFormData({ ...formData, input_min_usd: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      step="10"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">Mid</label>
                    <input
                      type="number"
                      value={formData.input_mid_usd}
                      onChange={e => setFormData({ ...formData, input_mid_usd: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      step="10"
                      min="0"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">Max</label>
                    <input
                      type="number"
                      value={formData.input_max_usd}
                      onChange={e => setFormData({ ...formData, input_max_usd: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-mint-500"
                      step="10"
                      min="0"
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
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Min Profit ($)</label>
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

              {/* Toggles */}
              <div className="space-y-2">
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
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="manage_cash"
                      checked={formData.manage_cash}
                      onChange={e => setFormData({ ...formData, manage_cash: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                    />
                    <label htmlFor="manage_cash" className="text-sm text-white">
                      Manage Cash in Fund
                      <span className="text-slate-400 text-xs ml-2">(maintain dedicated cash pile)</span>
                    </label>
                  </div>
                  {!formData.manage_cash && (
                    <p className="text-[10px] text-slate-500 ml-7">
                      Cash will be managed at the platform level and shared with other funds
                    </p>
                  )}
                </div>
              </div>

            </>
          )}

          {/* Buttons */}
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-mint-600 text-white rounded hover:bg-mint-700 transition-colors disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Fund'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { updateFund, deleteFund, notifyFundsChanged, type FundConfig, type FundStatus } from '../api/funds'
import { fetchPlatforms, type Platform } from '../api/platforms'
import { defaultFallbackTicker } from '@escapemint/engine'

interface EditFundConfigModalProps {
  fundId: string
  fundPlatform: string
  fundTicker: string
  config: FundConfig
  onClose: () => void
  onUpdated: () => void
}

// Round to avoid floating point precision issues
const round = (value: number, decimals: number = 2): number => {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

export function EditFundConfigModal({ fundId, fundPlatform, fundTicker, config, onClose, onUpdated }: EditFundConfigModalProps) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatform, setSelectedPlatform] = useState(fundPlatform.toLowerCase())
  const [ticker, setTicker] = useState(fundTicker.toLowerCase())
  const [formData, setFormData] = useState({
    status: config.status ?? 'active' as FundStatus,
    fund_size_usd: config.fund_size_usd,
    target_apy: round(config.target_apy * 100), // Display as percentage
    interval_days: config.interval_days,
    input_min_usd: config.input_min_usd,
    input_mid_usd: config.input_mid_usd,
    input_max_usd: config.input_max_usd,
    max_at_pct: round(config.max_at_pct * 100), // Display as percentage
    min_profit_usd: config.min_profit_usd,
    cash_apy: round(config.cash_apy * 100), // Display as percentage
    margin_apr: round(config.margin_apr * 100), // Display as percentage
    margin_access_usd: config.margin_access_usd,
    accumulate: config.accumulate,
    manage_cash: config.manage_cash ?? true,
    margin_enabled: config.margin_enabled ?? false,
    fallback_enabled: config.fallback_enabled ?? false,
    fallback_drawdown_pct: round((config.fallback_drawdown_pct ?? 0.6) * 100),
    fallback_ma_days: config.fallback_ma_days ?? 200,
    fallback_ticker: config.fallback_ticker ?? '',
    dividend_reinvest: config.dividend_reinvest ?? true,
    interest_reinvest: config.interest_reinvest ?? true,
    expense_from_fund: config.expense_from_fund ?? true
  })

  useEffect(() => {
    fetchPlatforms().then(result => {
      if (result.data) {
        setPlatforms(result.data)
      }
    })
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (formData.fallback_enabled) {
      if (!formData.fallback_ticker.trim()) {
        toast.error('1x fallback needs a ticker (QQQ, SOXX, SPY, or VOO)')
        return
      }
      if (formData.fallback_drawdown_pct < 0 || formData.fallback_drawdown_pct > 100) {
        toast.error('Fallback drawdown must be between 0 and 100')
        return
      }
      if (formData.fallback_ma_days < 1) {
        toast.error('Fallback moving average must be at least 1 day')
        return
      }
    }
    setLoading(true)

    const updatedConfig: Partial<FundConfig> = {
      status: formData.status,
      fund_size_usd: formData.fund_size_usd,
      target_apy: round(formData.target_apy / 100, 4),
      interval_days: formData.interval_days,
      input_min_usd: formData.input_min_usd,
      input_mid_usd: formData.input_mid_usd,
      input_max_usd: formData.input_max_usd,
      max_at_pct: round(formData.max_at_pct / 100, 4),
      min_profit_usd: formData.min_profit_usd,
      cash_apy: round(formData.cash_apy / 100, 4),
      margin_apr: round(formData.margin_apr / 100, 4),
      margin_access_usd: formData.margin_access_usd,
      accumulate: formData.accumulate,
      manage_cash: formData.manage_cash,
      margin_enabled: formData.margin_enabled,
      fallback_enabled: formData.fallback_enabled,
      ...(formData.fallback_enabled
        ? {
            fallback_drawdown_pct: round(formData.fallback_drawdown_pct / 100, 4),
            fallback_ma_days: Math.round(formData.fallback_ma_days),
            fallback_ticker: formData.fallback_ticker.trim().toUpperCase()
          }
        : {}),
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
      onClose()
      // If platform or ticker changed, navigate to the new fund URL
      // Skip onUpdated() since old fund no longer exists
      if ((platformChanged || tickerChanged) && result.data) {
        navigate(`/fund/${result.data.id}`)
      } else {
        onUpdated()
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
      onClose()
      navigate('/')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-slate-800 rounded-lg p-6 w-full max-w-2xl border border-slate-700 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-2">Edit Configuration</h2>
        <p className="text-slate-400 text-sm mb-4">Update settings for {fundTicker.toUpperCase()}</p>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Platform & Ticker */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Platform</label>
              <select
                value={selectedPlatform}
                onChange={e => setSelectedPlatform(e.target.value)}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
              >
                {platforms.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Ticker</label>
              <input
                type="text"
                value={ticker}
                onChange={e => setTicker(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white uppercase focus:outline-none focus:border-mint-500"
                required
              />
            </div>
          </div>
          {(selectedPlatform !== fundPlatform.toLowerCase() || ticker !== fundTicker.toLowerCase()) && (
            <p className="text-xs text-amber-400 -mt-4">
              Fund will be renamed from {fundId} to {selectedPlatform}-{ticker.toLowerCase()}
            </p>
          )}

          {/* Status and Start Date - Fund Size is tracked in entries, not config */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Status</label>
              <select
                value={formData.status}
                onChange={e => setFormData({ ...formData, status: e.target.value as FundStatus })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
              >
                <option value="active">Active</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>

          {/* Target APY and Interval */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Target APY (%)</label>
              <input
                type="number"
                value={formData.target_apy}
                onChange={e => setFormData({ ...formData, target_apy: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                step="1"
                min="0"
                max="500"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Interval (days)</label>
              <input
                type="number"
                value={formData.interval_days}
                onChange={e => setFormData({ ...formData, interval_days: parseInt(e.target.value) || 1 })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                min="1"
                required
              />
            </div>
          </div>

          {/* DCA Amounts */}
          <div>
            <label className="block text-sm text-slate-400 mb-2">DCA Amounts ($)</label>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Min (on target)</label>
                <input
                  type="number"
                  value={formData.input_min_usd}
                  onChange={e => setFormData({ ...formData, input_min_usd: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  step="10"
                  min="0"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Mid (below target)</label>
                <input
                  type="number"
                  value={formData.input_mid_usd}
                  onChange={e => setFormData({ ...formData, input_mid_usd: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  step="10"
                  min="0"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Max (significant loss)</label>
                <input
                  type="number"
                  value={formData.input_max_usd}
                  onChange={e => setFormData({ ...formData, input_max_usd: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  step="10"
                  min="0"
                  required
                />
              </div>
            </div>
          </div>

          {/* Max At % and Min Profit */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Max DCA Threshold (%)</label>
              <input
                type="number"
                value={formData.max_at_pct}
                onChange={e => setFormData({ ...formData, max_at_pct: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                step="1"
                placeholder="e.g., -25"
              />
              <p className="text-xs text-slate-500 mt-1">Use max DCA when loss exceeds this %</p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Min Profit to Sell ($)</label>
              <input
                type="number"
                value={formData.min_profit_usd}
                onChange={e => setFormData({ ...formData, min_profit_usd: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                step="10"
                min="0"
              />
            </div>
          </div>

          {/* Trading Mode */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="accumulate"
              checked={formData.accumulate}
              onChange={e => setFormData({ ...formData, accumulate: e.target.checked })}
              className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
            />
            <label htmlFor="accumulate" className="text-white">
              Accumulate Mode
              <span className="text-slate-400 text-sm ml-2">(sell only DCA amount instead of full liquidation)</span>
            </label>
          </div>

          {/* Cash Management Section */}
          <div className="border border-slate-600 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="manage_cash"
                checked={formData.manage_cash}
                onChange={e => setFormData({ ...formData, manage_cash: e.target.checked })}
                className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
              />
              <label htmlFor="manage_cash" className="text-white font-medium">
                Manage Cash
              </label>
              <span className="text-slate-400 text-sm">(maintain cash pile; if off, sells auto-withdraw)</span>
            </div>
          </div>

          {/* Margin Section */}
          <div className="border border-slate-600 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="margin_enabled"
                checked={formData.margin_enabled}
                onChange={e => setFormData({ ...formData, margin_enabled: e.target.checked })}
                className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
              />
              <label htmlFor="margin_enabled" className="text-white font-medium">
                Margin Trading
              </label>
              <span className="text-slate-400 text-sm">(enable margin borrowing and tracking)</span>
            </div>
            {formData.margin_enabled && (
              <div className="ml-7 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Margin APR (%)</label>
                  <input
                    type="number"
                    value={formData.margin_apr}
                    onChange={e => setFormData({ ...formData, margin_apr: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                    step="0.01"
                    min="0"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Margin Access ($)</label>
                  <input
                    type="number"
                    value={formData.margin_access_usd}
                    onChange={e => setFormData({ ...formData, margin_access_usd: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                    step="100"
                    min="0"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 1x fallback — new buys only, never margin, off unless checked */}
          <div className="border border-slate-600 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="fallback_enabled"
                checked={formData.fallback_enabled}
                onChange={e => {
                  const enabled = e.target.checked
                  setFormData(prev => ({
                    ...prev,
                    fallback_enabled: enabled,
                    fallback_ticker: enabled && !prev.fallback_ticker.trim()
                      ? (defaultFallbackTicker(ticker) ?? '')
                      : prev.fallback_ticker
                  }))
                }}
                className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
              />
              <label htmlFor="fallback_enabled" className="text-white font-medium">
                1x fallback
              </label>
              <span className="text-slate-400 text-sm">(route new buys off a deep 3x drawdown)</span>
            </div>
            {formData.fallback_enabled && (
              <div className="ml-7 space-y-3">
                <p className="text-xs text-slate-400">
                  New buys go to the 1x ticker while this fund is down past the threshold or its underlying closes below the moving average. Buys return here only after both have recovered. Shares already held are not sold. This rule does not use margin. The fund page applies the drawdown test from cost; the moving average is used when underlying closes are available.
                </p>
                {formData.margin_enabled && (
                  <p className="text-xs text-amber-400">
                    Leave margin off while the fallback is on. The two do not combine.
                  </p>
                )}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">1x ticker</label>
                    <input
                      type="text"
                      value={formData.fallback_ticker}
                      onChange={e => setFormData({ ...formData, fallback_ticker: e.target.value.toUpperCase() })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white uppercase focus:outline-none focus:border-mint-500"
                      placeholder="QQQ"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Drawdown (%)</label>
                    <input
                      type="number"
                      value={formData.fallback_drawdown_pct}
                      onChange={e => setFormData({ ...formData, fallback_drawdown_pct: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                      step="1"
                      min="0"
                      max="100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">MA days</label>
                    <input
                      type="number"
                      value={formData.fallback_ma_days}
                      onChange={e => setFormData({ ...formData, fallback_ma_days: parseInt(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                      step="1"
                      min="1"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Income & Expense Handling */}
          <div className="border border-slate-600 rounded-lg p-4 space-y-3">
            <p className="text-white font-medium mb-2">Income & Expense Handling</p>
            <div className="space-y-3 ml-2">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="dividend_reinvest"
                  checked={formData.dividend_reinvest}
                  onChange={e => setFormData({ ...formData, dividend_reinvest: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                />
                <label htmlFor="dividend_reinvest" className="text-white">
                  Reinvest Dividends
                  <span className="text-slate-400 text-sm ml-2">{formData.dividend_reinvest ? '(adds to cash & fund size)' : '(extract as profit)'}</span>
                </label>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="interest_reinvest"
                  checked={formData.interest_reinvest}
                  onChange={e => setFormData({ ...formData, interest_reinvest: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-mint-500 focus:ring-mint-500"
                />
                <label htmlFor="interest_reinvest" className="text-white">
                  Reinvest Cash Interest
                  <span className="text-slate-400 text-sm ml-2">{formData.interest_reinvest ? '(adds to cash & fund size)' : '(extract as profit)'}</span>
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
                <label htmlFor="expense_from_fund" className="text-white">
                  Expenses From Fund
                  <span className="text-slate-400 text-sm ml-2">{formData.expense_from_fund ? '(reduces fund size)' : '(covered externally)'}</span>
                </label>
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || deleting}
              className="flex-1 px-4 py-2 bg-mint-600 text-white rounded-lg hover:bg-mint-700 transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>

          {/* Delete Section */}
          <div className="border-t border-slate-700 pt-4 mt-2">
            {!showDeleteConfirm ? (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-sm text-red-400 hover:text-red-300 transition-colors"
              >
                Delete this fund...
              </button>
            ) : (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3">
                <p className="text-red-400 text-sm mb-3">
                  Are you sure you want to delete <strong>{fundTicker.toUpperCase()}</strong>? This will permanently remove all entries and cannot be undone.
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
                    {deleting ? 'Deleting...' : 'Yes, Delete Fund'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

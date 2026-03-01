import { useMemo, useEffect, useCallback, useRef, useState, forwardRef } from 'react'
import { toast } from 'sonner'
import type { FundEntry, FundType } from '../api/funds'
import {
  isCashFund as checkIsCashFund
} from '@escapemint/engine'
import { formatCurrency, formatLocalDate, getPriorEquity, detectDigitError } from '../utils/format'

// Re-export for consumers that import from EntryForm
export { detectDigitError }

export type ActionType = '' | 'BUY' | 'SELL' | 'HOLD'

export interface EntryFormData {
  date: string
  value: string
  cash: string  // Actual cash available in account
  action: ActionType
  amount: string
  shares: string
  price: string
  deposit: string
  withdrawal: string
  dividend: string
  expense: string
  cash_interest: string
  fund_size: string
  margin_available: string
  margin_borrowed: string
  margin_expense: string  // Margin interest expense for cash funds with margin
  notes: string
  // Derivatives-specific
  margin: string  // Actual margin locked for BUY/SELL trades
}

export interface EntryFormProps {
  formData: EntryFormData
  setFormData: React.Dispatch<React.SetStateAction<EntryFormData>>
  existingEntries?: FundEntry[]
  baseFundSize?: number
  showFundSizeAdjustment?: boolean
  cashAvailable?: number | undefined
  marginAvailable?: number | undefined
  currentFundSize?: number | undefined
  fundType?: FundType | undefined
  manageCash?: boolean | undefined
  marginEnabled?: boolean | undefined
  platform?: string | undefined
}

// Parse deposit/withdrawal from notes (legacy format)
export const parseDepositFromNotes = (notes: string | undefined): string => {
  if (!notes) return ''
  const match = notes.match(/Deposit:\s*\$?([\d.]+)/)
  return match ? match[1] ?? '' : ''
}

export const parseWithdrawalFromNotes = (notes: string | undefined): string => {
  if (!notes) return ''
  const match = notes.match(/Withdrawal:\s*\$?([\d.]+)/)
  return match ? match[1] ?? '' : ''
}

export const cleanNotesOfDepositWithdrawal = (notes: string | undefined): string => {
  if (!notes) return ''
  return notes
    .replace(/\s*\|\s*Deposit:\s*\$?[\d.]+/g, '')
    .replace(/Deposit:\s*\$?[\d.]+\s*\|\s*/g, '')
    .replace(/Deposit:\s*\$?[\d.]+/g, '')
    .replace(/\s*\|\s*Withdrawal:\s*\$?[\d.]+/g, '')
    .replace(/Withdrawal:\s*\$?[\d.]+\s*\|\s*/g, '')
    .replace(/Withdrawal:\s*\$?[\d.]+/g, '')
    .trim()
}

// Parse formula value (e.g., "=500.97+459.55" -> 960.52) or plain number
// Supports +, -, *, / with proper operator precedence
export const parseFormulaValue = (input: string): number => {
  if (!input) return 0
  const trimmed = input.trim().replace(/,/g, '')
  if (!trimmed.startsWith('=')) return parseFloat(trimmed) || 0

  const expr = trimmed.slice(1).replace(/\s/g, '')
  if (!expr) return 0

  let pos = 0

  const parseNumber = (): number => {
    // Skip leading + (e.g., "=+5+10")
    if (pos < expr.length && expr[pos] === '+') pos++
    const start = pos
    if (pos < expr.length && expr[pos] === '-') pos++
    while (pos < expr.length && (/[\d.]/).test(expr[pos]!)) pos++
    const num = parseFloat(expr.slice(start, pos))
    return isNaN(num) ? 0 : num
  }

  const parseTerm = (): number => {
    let result = parseNumber()
    while (pos < expr.length && (expr[pos] === '*' || expr[pos] === '/')) {
      const op = expr[pos++]
      const right = parseNumber()
      result = op === '*' ? result * right : (right !== 0 ? result / right : 0)
    }
    return result
  }

  const parseExpr = (): number => {
    let result = parseTerm()
    while (pos < expr.length && (expr[pos] === '+' || expr[pos] === '-')) {
      const op = expr[pos++]
      const right = parseTerm()
      result = op === '+' ? result + right : result - right
    }
    return result
  }

  const result = parseExpr()
  return isFinite(result) ? result : 0
}

// Formula-capable numeric input - shows computed result when formula is entered
function FormulaInputInner({ value, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>, ref: React.ForwardedRef<HTMLInputElement>) {
  const strValue = String(value ?? '')
  // Only show hint when formula contains at least one digit
  const isFormula = strValue.startsWith('=') && /\d/.test(strValue)
  const computed = isFormula ? parseFormulaValue(strValue) : null

  return (
    <>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={value}
        {...props}
      />
      {isFormula && computed !== null && (
        <p className="text-xs text-mint-400 mt-0.5">= {computed.toLocaleString(undefined, { maximumFractionDigits: 8 })}</p>
      )}
    </>
  )
}
const FormulaInput = forwardRef(FormulaInputInner)

// Wizard indicator component - animated arrow pointing to a field
// Uses absolute positioning to avoid affecting vertical layout
function WizardIndicator({ label }: { label: string }) {
  return (
    <div className="absolute right-0 top-0 flex items-center gap-1">
      <span className="text-mint-400 text-lg animate-wizard-arrow">→</span>
      <span className="text-mint-400 text-xs font-medium animate-pulse">{label}</span>
    </div>
  )
}

export function EntryForm({ formData, setFormData, existingEntries = [], baseFundSize = 0, showFundSizeAdjustment = false, cashAvailable, marginAvailable, currentFundSize, fundType = 'stock', manageCash = true, marginEnabled = false, platform }: EntryFormProps) {
  const isCashFund = checkIsCashFund(fundType)
  const isCryptoFund = fundType === 'crypto'

  // Wizard step: 1 = update equity, 2 = update margin available, 0 = done
  // Start at step 1 for non-derivatives funds
  const [wizardStep, setWizardStep] = useState<number>(fundType === 'derivatives' ? 0 : 1)

  // Track initial equity value to detect when user has changed it
  // Note: This component is always remounted fresh when the modal opens (not reused)
  const initialEquityRef = useRef<string>(formData.value)

  // Ref for auto-focusing and selecting the equity input
  const equityInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus and select equity input on mount (for non-derivatives funds)
  useEffect(() => {
    if (fundType !== 'derivatives' && equityInputRef.current) {
      equityInputRef.current.focus()
      equityInputRef.current.select()
    }
  }, [fundType])

  // Move wizard to next step when equity is changed
  useEffect(() => {
    if (wizardStep === 1 && formData.value !== initialEquityRef.current) {
      // User changed equity, move to margin available step if margin is enabled
      setWizardStep(marginEnabled ? 2 : 0)
    }
  }, [formData.value, wizardStep, marginEnabled])

  // Track which values we've already warned about to avoid duplicate toasts
  const warnedValueRef = useRef<string>('')

  // Get the prior entry's equity for digit error detection
  const priorEquity = useMemo(() => getPriorEquity(existingEntries), [existingEntries])

  // Check for digit errors on blur (when user finishes typing)
  const handleEquityBlur = useCallback(() => {
    if (priorEquity === null) return
    const newValue = parseFormulaValue(formData.value)
    if (!newValue) return

    // Skip if we've already warned about this exact value
    if (warnedValueRef.current === formData.value) return

    const digitError = detectDigitError(newValue, priorEquity)
    if (digitError) {
      warnedValueRef.current = formData.value
      const errorType = digitError === 'extra' ? 'extra' : 'missing'
      toast.warning(
        `Possible ${errorType} digit? Prior equity was ${formatCurrency(priorEquity)}, you entered ${formatCurrency(newValue)}`,
        { duration: 8000 }
      )
    }
  }, [formData.value, priorEquity])

  // Get cumulative shares from entries BEFORE the current date
  const getCumulativeShares = useCallback((beforeDate: string) => {
    let total = 0
    // Sort entries by date and only count those before the given date
    const sorted = [...existingEntries].sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
    )
    for (const e of sorted) {
      if (e.date >= beforeDate) break // Stop when we reach the current date
      if (e?.shares) {
        // BUY adds shares, SELL subtracts shares
        const sharesAbs = Math.abs(e.shares)
        total += e.action === 'SELL' ? -sharesAbs : sharesAbs
      }
    }
    return total
  }, [existingEntries])

  // Calculate price from amount/shares, then equity from prior holdings at that price
  const calculatePriceEquity = () => {
    const amount = parseFormulaValue(formData.amount)
    const shares = parseFormulaValue(formData.shares)

    if (!amount || !shares) {
      toast.error('Enter amount and shares first')
      return
    }

    if (!formData.date) {
      toast.error('Enter date first')
      return
    }

    // Calculate price per share from this transaction
    const price = amount / Math.abs(shares)

    // Get cumulative shares from entries BEFORE the selected date
    const priorShares = getCumulativeShares(formData.date)

    if (priorShares === 0) {
      toast.error('No prior share history before this date to calculate equity from')
      return
    }

    // Equity = prior holdings × current price
    const equity = priorShares * price

    setFormData(prev => ({
      ...prev,
      price: price.toFixed(8),
      value: equity.toFixed(2)
    }))
    toast.success(`Price: $${price.toFixed(8)} | Prior shares: ${priorShares.toLocaleString()} | Equity: $${equity.toFixed(2)}`)
  }

  // Calculate fund size adjustment from deposit/withdrawal/dividend/expense/interest
  const fundSizeAdjustment = useMemo(() => {
    const deposit = parseFormulaValue(formData.deposit)
    const withdrawal = parseFormulaValue(formData.withdrawal)
    const dividend = parseFormulaValue(formData.dividend)
    const expense = parseFormulaValue(formData.expense)
    const cashInterest = parseFormulaValue(formData.cash_interest)
    return deposit - withdrawal + dividend - expense + cashInterest
  }, [formData.deposit, formData.withdrawal, formData.dividend, formData.expense, formData.cash_interest])

  // Auto-update fund size when adjustments change (only for edit mode with baseFundSize)
  useEffect(() => {
    if (showFundSizeAdjustment && baseFundSize > 0) {
      const newFundSize = baseFundSize + fundSizeAdjustment
      setFormData(prev => ({ ...prev, fund_size: newFundSize.toFixed(2) }))
    }
  }, [fundSizeAdjustment, baseFundSize, showFundSizeAdjustment, setFormData])

  // Auto-update fund size when deposit/withdrawal changes in add mode (using currentFundSize from preview)
  useEffect(() => {
    if (!showFundSizeAdjustment && currentFundSize !== undefined && currentFundSize > 0) {
      const deposit = parseFormulaValue(formData.deposit)
      const withdrawal = parseFormulaValue(formData.withdrawal)
      const adjustment = deposit - withdrawal
      if (adjustment !== 0) {
        const newFundSize = currentFundSize + adjustment
        setFormData(prev => {
          // Only update if fund_size is empty or was auto-set (avoid overwriting manual entry)
          const currentVal = parseFormulaValue(prev.fund_size)
          const expectedPrev = currentFundSize + parseFormulaValue(prev.deposit) - parseFormulaValue(prev.withdrawal)
          if (prev.fund_size === '' || Math.abs(currentVal - expectedPrev) < 0.01) {
            return { ...prev, fund_size: newFundSize.toFixed(2) }
          }
          return prev
        })
      }
    }
  }, [formData.deposit, formData.withdrawal, currentFundSize, showFundSizeAdjustment, setFormData])

  // Track the initial margin_borrowed value for M1 auto-borrow calculation
  // Captures value on first render - intentionally not updated on formData changes since
  // we want to compare against the original value before any auto-adjustments
  // Note: This component is always remounted fresh when the modal opens (not reused)
  const initialMarginBorrowedRef = useRef<number>(parseFormulaValue(formData.margin_borrowed))

  // Track auto-adjustment amount for display purposes
  const [marginAutoAdjustment, setMarginAutoAdjustment] = useState<number>(0)

  // Auto-update margin_borrowed for M1 platform when there's a shortfall on BUY
  // M1 automatically borrows from margin, so we should reflect the expected new total
  useEffect(() => {
    const isM1Platform = platform?.toLowerCase() === 'm1'
    if (!isM1Platform) {
      setMarginAutoAdjustment(0)
      return
    }
    if (formData.action !== 'BUY') {
      setMarginAutoAdjustment(0)
      return
    }
    if (cashAvailable === undefined) {
      setMarginAutoAdjustment(0)
      return
    }

    const amount = parseFormulaValue(formData.amount)
    const shortfall = amount - cashAvailable

    if (shortfall > 0.01) {
      // Calculate expected new margin borrowed total from the INITIAL value + shortfall
      const expectedNewTotal = initialMarginBorrowedRef.current + shortfall

      setFormData(prev => {
        const currentValue = parseFormulaValue(prev.margin_borrowed)
        // Only update if the value would actually change
        if (Math.abs(currentValue - expectedNewTotal) > 0.01) {
          return { ...prev, margin_borrowed: expectedNewTotal.toFixed(2) }
        }
        return prev
      })
      setMarginAutoAdjustment(shortfall)
    } else {
      // No shortfall - reset to initial value if needed
      setFormData(prev => {
        const currentValue = parseFormulaValue(prev.margin_borrowed)
        if (Math.abs(currentValue - initialMarginBorrowedRef.current) > 0.01) {
          return { ...prev, margin_borrowed: initialMarginBorrowedRef.current.toFixed(2) }
        }
        return prev
      })
      setMarginAutoAdjustment(0)
    }
  }, [formData.action, formData.amount, cashAvailable, platform, setFormData])

  // Simplified form for cash funds - single Amount field with sign
  if (isCashFund) {
    // Parse amount to show appropriate styling
    const amountValue = parseFormulaValue(formData.amount)
    const formatCurrency = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
    const amountColorClass = amountValue > 0 ? 'border-green-500' : amountValue < 0 ? 'border-red-500' : 'border-slate-600'

    return (
      <div className="space-y-4">
        {/* CASH FUND ENTRY */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-blue-400 border-b border-slate-700 pb-1">Cash Balance Entry</h3>

          {/* Row 1: Date, Cash Balance, Amount */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <div className="relative mb-1 h-5">
                <label className="text-sm text-slate-400">Date</label>
              </div>
              <input
                type="date"
                value={formData.date}
                onChange={e => setFormData(prev => ({ ...prev, date: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                required
              />
            </div>
            <div>
              <div className="relative mb-1 h-5">
                <label className="text-sm text-slate-400">Cash Balance ($)</label>
                {wizardStep === 1 && <WizardIndicator label="Update first" />}
              </div>
              <FormulaInput
                ref={equityInputRef}
                value={formData.value}
                onChange={e => {
                  setFormData(prev => ({ ...prev, value: e.target.value }))
                  if (wizardStep === 1) setWizardStep(0)
                }}
                onBlur={handleEquityBlur}
                className={`w-full px-3 py-2 bg-slate-700 border rounded-lg text-white focus:outline-none focus:border-blue-500 ${wizardStep === 1 ? 'border-mint-500 ring-2 ring-mint-500/30' : 'border-slate-600'}`}
                placeholder="Current cash balance"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Amount ($)</label>
              <FormulaInput
                value={formData.amount}
                onChange={e => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                className={`w-full px-3 py-2 bg-slate-700 border rounded-lg text-white focus:outline-none focus:border-blue-500 ${amountColorClass}`}
                placeholder="+100 or =50+75"
              />
              <p className="text-xs text-slate-500 mt-1">
                {amountValue > 0 ? (
                  <span className="text-green-400">Deposit: +{formatCurrency(amountValue)}</span>
                ) : amountValue < 0 ? (
                  <span className="text-red-400">Withdraw: {formatCurrency(amountValue)}</span>
                ) : (
                  'Positive = deposit, negative = withdraw'
                )}
              </p>
            </div>
          </div>

          {/* Row 2: Interest, Fee, Margin Expense (if margin enabled), Margin Available, Margin Borrowed, Notes */}
          <div className={`grid grid-cols-1 sm:grid-cols-2 ${marginEnabled ? 'lg:grid-cols-6' : 'lg:grid-cols-5'} gap-4`}>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Interest Earned ($)</label>
              <FormulaInput
                value={formData.cash_interest}
                onChange={e => setFormData(prev => ({ ...prev, cash_interest: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder="0 or =10+20"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Fee ($)</label>
              <FormulaInput
                value={formData.expense}
                onChange={e => setFormData(prev => ({ ...prev, expense: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-red-600/50 rounded-lg text-white focus:outline-none focus:border-red-500"
                placeholder="0 or =10+20"
              />
              <p className="text-xs text-slate-500 mt-1">Trading fees, broker fees, account fees, etc.</p>
            </div>
            {marginEnabled && (
              <div>
                <label className="block text-sm text-slate-400 mb-1">Margin Expense ($)</label>
                <FormulaInput
                  value={formData.margin_expense}
                  onChange={e => setFormData(prev => ({ ...prev, margin_expense: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-red-600/50 rounded-lg text-white focus:outline-none focus:border-red-500"
                  placeholder="0 or =10+20"
                />
                <p className="text-xs text-slate-500 mt-1">Interest charged on margin</p>
              </div>
            )}
            <div>
              <label className="block text-sm text-slate-400 mb-1">Margin Available ($)</label>
              <FormulaInput
                value={formData.margin_available}
                onChange={e => setFormData(prev => ({ ...prev, margin_available: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Margin Borrowed ($)</label>
              <FormulaInput
                value={formData.margin_borrowed}
                onChange={e => setFormData(prev => ({ ...prev, margin_borrowed: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Notes</label>
              <input
                type="text"
                value={formData.notes}
                onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder="Optional"
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Standard trading fund form
  return (
    <div className="space-y-4">
      {/* ACTION SECTION */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-slate-300 border-b border-slate-700 pb-1">Action</h3>

        {/* Row 1: Date, Equity, Action, Amount */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="relative mb-1 h-5">
              <label className="text-sm text-slate-400">Date</label>
            </div>
            <input
              type="date"
              value={formData.date}
              onChange={e => setFormData(prev => ({ ...prev, date: e.target.value }))}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
              required
            />
          </div>
          <div>
            <div className="relative mb-1 h-5">
              <label className="text-sm text-slate-400">
                {fundType === 'derivatives' ? 'Equity ($) - calculated' : 'Equity ($)'}
              </label>
              {wizardStep === 1 && <WizardIndicator label="Update first" />}
            </div>
            <FormulaInput
              ref={equityInputRef}
              name="value"
              id="value"
              value={formData.value}
              onChange={e => setFormData(prev => ({ ...prev, value: e.target.value }))}
              onBlur={handleEquityBlur}
              className={`w-full px-3 py-2 bg-slate-700 border rounded-lg text-white focus:outline-none focus:border-mint-500 ${fundType === 'derivatives' ? 'opacity-60' : ''} ${wizardStep === 1 ? 'border-mint-500 ring-2 ring-mint-500/30' : 'border-slate-600'}`}
              placeholder={fundType === 'derivatives' ? '0 (auto-calculated)' : 'Asset value'}
              required={fundType !== 'derivatives'}
            />
            {fundType === 'derivatives' && (
              <p className="text-xs text-slate-500 mt-1">Leave as 0 - equity is calculated from margin + P&L</p>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Action</label>
            <select
              name="action"
              id="action"
              value={formData.action}
              onChange={e => {
                const action = e.target.value as ActionType
                setFormData(prev => ({
                  ...prev,
                  action,
                  // Clear amount when HOLD is selected
                  amount: action === 'HOLD' ? '' : prev.amount
                }))
              }}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
            >
              <option value="">Select...</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="HOLD">HOLD</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Amount ($)</label>
            <FormulaInput
              value={formData.amount}
              onChange={e => setFormData(prev => ({ ...prev, amount: e.target.value }))}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500 disabled:opacity-50"
              placeholder="0 or =500+460"
              disabled={!formData.action || formData.action === 'HOLD'}
            />
            {/* Shortfall helper - show info when amount exceeds cash (skip for M1 - shown on Margin Borrowed field) */}
            {formData.action === 'BUY' && cashAvailable !== undefined && platform?.toLowerCase() !== 'm1' && (() => {
              const amount = parseFormulaValue(formData.amount)
              const shortfall = amount - cashAvailable
              if (shortfall > 0.01) {
                return (
                  <div className="mt-1 flex gap-2 flex-wrap items-center">
                    <span className="text-xs text-amber-400">
                      Shortfall: {formatCurrency(shortfall)} - deposit to platform cash fund
                    </span>
                    {(marginAvailable ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const borrowAmount = Math.min(Math.ceil(shortfall), marginAvailable ?? 0)
                          setFormData(prev => ({
                            ...prev,
                            margin_borrowed: (parseFormulaValue(prev.margin_borrowed || '0') + borrowAmount).toFixed(2)
                          }))
                          toast.success(`Margin borrow ${formatCurrency(borrowAmount)} added`)
                        }}
                        className="px-2 py-0.5 text-xs bg-purple-700 hover:bg-purple-600 text-white rounded transition-colors"
                      >
                        Borrow ${Math.min(Math.ceil(shortfall), marginAvailable ?? 0)}
                      </button>
                    )}
                  </div>
                )
              }
              return null
            })()}
          </div>
        </div>

        {/* Derivatives: Margin input for BUY trades */}
        {fundType === 'derivatives' && formData.action === 'BUY' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
            <div className="sm:col-span-2">
              <label className="block text-sm text-slate-400 mb-1">Margin Locked ($)</label>
              <FormulaInput
                value={formData.margin}
                onChange={e => setFormData(prev => ({ ...prev, margin: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-amber-500"
                placeholder={`Default: ${(parseFormulaValue(formData.amount) * 0.20).toFixed(2)} (20%)`}
              />
              <p className="text-xs text-slate-500 mt-1">
                Actual margin required by exchange (from trade confirmation)
              </p>
            </div>
          </div>
        )}

        {/* Margin tracking inputs for funds with margin enabled */}
        {marginEnabled && !isCashFund && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
            <div>
              <div className="relative mb-1 h-5">
                <label className="text-sm text-slate-400">Margin Available ($)</label>
                {wizardStep === 2 && <WizardIndicator label="Update next" />}
              </div>
              <FormulaInput
                value={formData.margin_available}
                onChange={e => {
                  setFormData(prev => ({ ...prev, margin_available: e.target.value }))
                  if (wizardStep === 2) setWizardStep(0)
                }}
                className={`w-full px-3 py-2 bg-slate-700 border rounded-lg text-white focus:outline-none focus:border-purple-500 ${wizardStep === 2 ? 'border-purple-500 ring-2 ring-purple-500/30' : 'border-slate-600'}`}
                placeholder="Current margin available"
              />
              <p className="text-xs text-slate-500 mt-1">
                Current margin available from platform (changes with equity)
              </p>
            </div>
            <div>
              <div className="relative mb-1 h-5">
                <label className="text-sm text-slate-400">Margin Borrowed ($)</label>
              </div>
              <FormulaInput
                value={formData.margin_borrowed}
                onChange={e => setFormData(prev => ({ ...prev, margin_borrowed: e.target.value }))}
                className={`w-full px-3 py-2 bg-slate-700 border rounded-lg text-white focus:outline-none focus:border-purple-500 ${marginAutoAdjustment > 0 ? 'border-purple-500' : 'border-slate-600'}`}
                placeholder="0"
              />
              {marginAutoAdjustment > 0 ? (
                <p className="text-xs text-purple-400 mt-1">
                  Auto-adjusted: +{formatCurrency(marginAutoAdjustment)} for shortfall (M1 auto-borrows from margin)
                </p>
              ) : (
                <p className="text-xs text-slate-500 mt-1">
                  Margin borrowed in this entry (may be auto-filled by some platforms, but can be adjusted)
                </p>
              )}
            </div>
          </div>
        )}

      </div>

      {/* OPTIONAL FIELDS SECTION - Collapsible */}
      <details className="group">
        <summary className="text-sm font-medium text-slate-300 border-b border-slate-700 pb-1 cursor-pointer hover:text-slate-200 list-none flex items-center gap-2">
          <span className="text-slate-500 group-open:rotate-90 transition-transform">▶</span>
          Optional
        </summary>
        <div className="space-y-3 pt-3">
          {/* Shares, Price, Calc Button, Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Shares/Units</label>
              <FormulaInput
                value={formData.shares}
                onChange={e => setFormData(prev => ({ ...prev, shares: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Price ($)</label>
              <FormulaInput
                value={formData.price}
                onChange={e => setFormData(prev => ({ ...prev, price: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                placeholder="Per unit"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={calculatePriceEquity}
                className="w-full px-3 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-500 transition-colors text-sm"
                title="Calculate price from amount/shares, then equity from prior holdings"
              >
                Calc Price/Equity
              </button>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Notes</label>
              <input
                type="text"
                value={formData.notes}
                onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                placeholder="Optional"
              />
            </div>
          </div>

          {/* Fund Size + trading-specific fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Fund Size ($)</label>
              <FormulaInput
                value={formData.fund_size}
                onChange={e => setFormData(prev => ({ ...prev, fund_size: e.target.value }))}
                className={`w-full px-3 py-2 bg-slate-700 border rounded-lg text-white focus:outline-none focus:border-mint-500 ${
                  showFundSizeAdjustment && fundSizeAdjustment !== 0 ? 'border-mint-500' : 'border-slate-600'
                }`}
                placeholder="Override"
              />
              {showFundSizeAdjustment && fundSizeAdjustment !== 0 && (
                <p className={`text-xs mt-1 ${fundSizeAdjustment > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {fundSizeAdjustment > 0 ? '+' : ''}{fundSizeAdjustment.toFixed(2)} adjustment
                  {baseFundSize > 0 && <span className="text-slate-500"> (base: ${baseFundSize.toFixed(2)})</span>}
                </p>
              )}
            </div>
            {/* Cash field - only show when fund manages its own cash */}
            {manageCash ? (
              <div>
                <label className="block text-sm text-slate-400 mb-1">Cash ($)</label>
                <FormulaInput
                  value={formData.cash}
                  onChange={e => setFormData(prev => ({ ...prev, cash: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  placeholder="Optional"
                />
              </div>
            ) : (
              <div className={isCryptoFund ? 'sm:col-span-2 lg:col-span-3' : 'sm:col-span-1 lg:col-span-2'}>
                <div className="flex items-center h-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg">
                  <span className="text-sm text-slate-400">
                    Cash is managed at the platform level. Use the platform's cash fund for deposits/withdrawals.
                  </span>
                </div>
              </div>
            )}
            {!isCryptoFund && (
              <div>
                <label className="block text-sm text-slate-400 mb-1">Dividend ($)</label>
                <FormulaInput
                  value={formData.dividend}
                  onChange={e => setFormData(prev => ({ ...prev, dividend: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  placeholder="0 or =10+20"
                />
              </div>
            )}
          </div>

          {/* Row 2: Expense, Interest, Margin Available, Margin Borrowed - only show if manageCash is true */}
          {manageCash && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Expense ($)</label>
                <FormulaInput
                  value={formData.expense}
                  onChange={e => setFormData(prev => ({ ...prev, expense: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  placeholder="0 or =10+20"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Interest ($)</label>
                <FormulaInput
                  value={formData.cash_interest}
                  onChange={e => setFormData(prev => ({ ...prev, cash_interest: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  placeholder="0 or =10+20"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Margin Available ($)</label>
                <FormulaInput
                  value={formData.margin_available}
                  onChange={e => setFormData(prev => ({ ...prev, margin_available: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Margin Borrowed ($)</label>
                <FormulaInput
                  value={formData.margin_borrowed}
                  onChange={e => setFormData(prev => ({ ...prev, margin_borrowed: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:border-mint-500"
                  placeholder="0"
                />
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

// Helper to build FundEntry from form data
export function buildEntryFromForm(formData: EntryFormData, fundType?: FundType): Partial<FundEntry> {
  const entry: Partial<FundEntry> = {
    date: formData.date,
    value: parseFormulaValue(formData.value)
  }

  const isCashFund = fundType === 'cash'
  let notes = formData.notes

  // Cash fund: use signed amount field directly
  // Positive amount = DEPOSIT (external money in), Negative amount = WITHDRAW (external money out)
  // MARGIN action for margin expense (interest charged on borrowed margin)
  if (isCashFund) {
    const signedAmount = parseFormulaValue(formData.amount)
    const marginExpense = parseFormulaValue(formData.margin_expense)

    // Store margin expense in a structured field if present
    if (marginExpense > 0) {
      entry.margin_expense = marginExpense
    }

    // Determine action: deposit/withdraw takes priority over pure margin expense
    if (signedAmount > 0) {
      entry.action = 'DEPOSIT'
      entry.amount = signedAmount
      if (marginExpense > 0) {
        notes = (notes ? notes + ' | ' : '') + `Margin expense: $${marginExpense}`
      }
    } else if (signedAmount < 0) {
      entry.action = 'WITHDRAW'
      entry.amount = signedAmount // Store as negative
      if (marginExpense > 0) {
        notes = (notes ? notes + ' | ' : '') + `Margin expense: $${marginExpense}`
      }
    } else if (marginExpense > 0) {
      // Pure margin expense with no external cash flow
      entry.action = 'MARGIN'
      entry.amount = marginExpense
    } else {
      entry.action = 'HOLD'
    }
  } else {
    // Trading funds: use separate deposit/withdrawal fields (legacy support)
    const depositVal = parseFormulaValue(formData.deposit)
    const withdrawalVal = parseFormulaValue(formData.withdrawal)

    // Handle action - DEPOSIT/WITHDRAW are tracked cumulatively for fund_size calculation
    if (depositVal > 0 && (!formData.action || formData.action === 'HOLD')) {
      entry.action = 'DEPOSIT'
      entry.amount = depositVal
    } else if (withdrawalVal > 0 && (!formData.action || formData.action === 'HOLD')) {
      entry.action = 'WITHDRAW'
      entry.amount = withdrawalVal
    } else if (formData.action && formData.action !== 'HOLD') {
      entry.action = formData.action
      entry.amount = parseFormulaValue(formData.amount)
      if (depositVal > 0) {
        notes = (notes ? notes + ' | ' : '') + `Deposit: $${depositVal}`
      }
      if (withdrawalVal > 0) {
        notes = (notes ? notes + ' | ' : '') + `Withdrawal: $${withdrawalVal}`
      }
    } else {
      // formData.action is either 'HOLD' or '' (empty), both default to HOLD
      // TypeScript ensures all ActionType values are handled above
      entry.action = 'HOLD'
    }
  }

  if (formData.shares) entry.shares = parseFormulaValue(formData.shares)
  if (formData.price) entry.price = parseFormulaValue(formData.price)

  const fundSize = parseFormulaValue(formData.fund_size)
  if (fundSize > 0) entry.fund_size = fundSize

  if (notes) entry.notes = notes
  if (formData.dividend) entry.dividend = parseFormulaValue(formData.dividend)
  if (formData.expense) entry.expense = parseFormulaValue(formData.expense)
  if (formData.cash_interest) entry.cash_interest = parseFormulaValue(formData.cash_interest)
  if (formData.margin_available) entry.margin_available = parseFormulaValue(formData.margin_available)
  if (formData.margin_borrowed) entry.margin_borrowed = parseFormulaValue(formData.margin_borrowed)
  if (formData.cash) entry.cash = parseFormulaValue(formData.cash)
  // Derivatives-specific: actual margin locked for BUY/SELL trades
  if (fundType === 'derivatives' && formData.margin) {
    entry.margin = parseFormulaValue(formData.margin)
  }

  return entry
}

// Helper to create initial form data for new entry
export function createEmptyFormData(): EntryFormData {
  return {
    date: formatLocalDate(new Date()),
    value: '',
    cash: '',
    action: '' as ActionType,
    amount: '',
    shares: '',
    price: '',
    deposit: '',
    withdrawal: '',
    dividend: '',
    expense: '',
    cash_interest: '',
    fund_size: '',
    margin_available: '',
    margin_borrowed: '',
    margin_expense: '',
    notes: '',
    margin: ''
  }
}

// Helper to create form data from existing entry
export function createFormDataFromEntry(entry: FundEntry, calculatedFundSize?: number, fundType?: FundType): EntryFormData {
  const isCashFund = fundType === 'cash'

  const getActionType = (): ActionType => {
    if (entry.action === 'BUY' || entry.action === 'SELL') return entry.action
    return entry.action ? 'HOLD' : ''
  }

  // For cash funds: convert to signed amount for the unified Amount field
  // DEPOSIT = positive, WITHDRAW = negative (handle old format where WITHDRAW had positive amount)
  // MARGIN = margin expense, shown in separate field
  const getCashFundAmount = (): string => {
    // MARGIN entries have amount in margin_expense field, not amount field
    if (entry.action === 'MARGIN') {
      return ''
    }
    if (entry.action === 'DEPOSIT' && entry.amount) {
      return entry.amount.toFixed(2) // Keep positive
    }
    if (entry.action === 'WITHDRAW' && entry.amount) {
      // Old format stored as positive, new format as negative
      // Convert to negative for form display
      return entry.amount > 0 ? (-entry.amount).toFixed(2) : entry.amount.toFixed(2)
    }
    // HOLD with amount - already signed
    if (entry.amount) {
      return entry.amount.toFixed(2)
    }
    return ''
  }

  // Get margin expense for MARGIN action entries
  const getMarginExpense = (): string => {
    if (entry.action === 'MARGIN' && entry.amount) {
      return entry.amount.toFixed(2)
    }
    return ''
  }

  // For trading funds: use separate deposit/withdrawal fields (legacy support)
  const getDeposit = (): string => {
    if (entry.action === 'DEPOSIT' && entry.amount) {
      return entry.amount.toFixed(2)
    }
    // HOLD with positive amount = deposit
    if (entry.action === 'HOLD' && entry.amount && entry.amount > 0) {
      return entry.amount.toFixed(2)
    }
    return parseDepositFromNotes(entry.notes)
  }

  const getWithdrawal = (): string => {
    if (entry.action === 'WITHDRAW' && entry.amount) {
      return Math.abs(entry.amount).toFixed(2) // Show as positive in withdrawal field
    }
    // HOLD with negative amount = withdrawal
    if (entry.action === 'HOLD' && entry.amount && entry.amount < 0) {
      return Math.abs(entry.amount).toFixed(2)
    }
    return parseWithdrawalFromNotes(entry.notes)
  }

  return {
    date: entry.date,
    value: entry.value.toFixed(2),
    cash: entry.cash?.toFixed(2) ?? '',
    action: getActionType(),
    // For cash funds, use signed amount; for trading funds, use raw amount
    amount: isCashFund ? getCashFundAmount() : (entry.amount?.toFixed(2) ?? ''),
    shares: entry.shares?.toString() ?? '',
    price: entry.price?.toFixed(8) ?? '',
    deposit: getDeposit(),
    withdrawal: getWithdrawal(),
    dividend: entry.dividend?.toFixed(2) ?? '',
    expense: entry.expense?.toFixed(2) ?? '',
    cash_interest: entry.cash_interest?.toFixed(2) ?? '',
    fund_size: (entry.fund_size ?? calculatedFundSize)?.toFixed(2) ?? '',
    margin_available: entry.margin_available?.toFixed(2) ?? '',
    margin_borrowed: entry.margin_borrowed?.toFixed(2) ?? '',
    margin_expense: getMarginExpense(),
    notes: cleanNotesOfDepositWithdrawal(entry.notes),
    margin: entry.margin?.toFixed(2) ?? ''
  }
}

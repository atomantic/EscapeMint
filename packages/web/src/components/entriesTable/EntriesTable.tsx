import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import { updateFundConfig, updateFundEntry, recalculateFund, interpolateColumn, type FundEntry, type FundType, type InterpolatableColumn } from '../../api/funds'
import { getColumnsForFundType, getDefaultColumns, getDefaultColumnOrder, type ColumnId, type ComputedEntry } from './types'
import { PasteColumnModal } from './PasteColumnModal'
import { CoinbaseUpdateButton } from '../CoinbaseUpdateButton'
import { CoinbaseImportButton } from '../CoinbaseImportButton'
import { useSettings } from '../../contexts/SettingsContext'

export interface EntriesTableProps {
  fundId: string
  entries: FundEntry[]
  computedEntries: ComputedEntry[]
  savedColumnOrder?: ColumnId[]
  savedVisibleColumns?: ColumnId[]
  fundType?: FundType | undefined
  onEdit: (index: number, entry: FundEntry, calculatedFundSize: number) => void
  onAddEntry: () => void
  onReload: () => void
  // Optional: for derivatives funds with Coinbase update support
  showCoinbaseUpdate?: boolean
  lastEntryDate?: string | undefined
  fundStartDate?: string | undefined
}

export function EntriesTable({
  fundId,
  entries,
  computedEntries,
  savedColumnOrder,
  savedVisibleColumns,
  fundType = 'stock',
  onEdit,
  onAddEntry,
  onReload,
  showCoinbaseUpdate = false,
  lastEntryDate,
  fundStartDate
}: EntriesTableProps) {
  // Get columns available for this fund type
  const availableColumns = useMemo(() => getColumnsForFundType(fundType), [fundType])
  const { settings } = useSettings()
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [showColumnMenu, setShowColumnMenu] = useState(false)
  const [showPasteModal, setShowPasteModal] = useState(false)
  const [recalculating, setRecalculating] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(() =>
    savedVisibleColumns && savedVisibleColumns.length > 0 ? new Set(savedVisibleColumns) : getDefaultColumns(fundType)
  )
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(() => {
    if (savedColumnOrder && savedColumnOrder.length > 0) {
      const defaultOrder = getDefaultColumnOrder(fundType)
      const savedSet = new Set(savedColumnOrder)
      const missing = defaultOrder.filter(id => !savedSet.has(id))
      return [...savedColumnOrder, ...missing]
    }
    return getDefaultColumnOrder(fundType)
  })
  const [draggedColumn, setDraggedColumn] = useState<ColumnId | null>(null)
  const [showInterpolateMenu, setShowInterpolateMenu] = useState(false)
  const columnMenuRef = useRef<HTMLDivElement>(null)
  const interpolateMenuRef = useRef<HTMLDivElement>(null)

  // Sync column preferences from props
  useEffect(() => {
    if (savedColumnOrder && savedColumnOrder.length > 0) {
      const defaultOrder = getDefaultColumnOrder(fundType)
      const savedSet = new Set(savedColumnOrder)
      const missing = defaultOrder.filter(id => !savedSet.has(id))
      setColumnOrder([...savedColumnOrder, ...missing])
    } else {
      setColumnOrder(getDefaultColumnOrder(fundType))
    }

    if (savedVisibleColumns && savedVisibleColumns.length > 0) {
      setVisibleColumns(new Set(savedVisibleColumns))
    } else {
      setVisibleColumns(getDefaultColumns(fundType))
    }
  }, [savedColumnOrder, savedVisibleColumns, fundType])

  // Close column menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (columnMenuRef.current && !columnMenuRef.current.contains(e.target as Node)) {
        setShowColumnMenu(false)
      }
    }
    if (showColumnMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showColumnMenu])

  // Close interpolate menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (interpolateMenuRef.current && !interpolateMenuRef.current.contains(e.target as Node)) {
        setShowInterpolateMenu(false)
      }
    }
    if (showInterpolateMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showInterpolateMenu])

  // Save column preferences to fund config
  const saveColumnPrefs = useCallback(async (order: ColumnId[], visible: Set<ColumnId>) => {
    await updateFundConfig(fundId, {
      entries_column_order: order,
      entries_visible_columns: [...visible]
    })
  }, [fundId])

  const toggleColumn = (columnId: ColumnId) => {
    setVisibleColumns(prev => {
      const next = new Set(prev)
      if (next.has(columnId)) {
        next.delete(columnId)
      } else {
        next.add(columnId)
      }
      saveColumnPrefs(columnOrder, next)
      return next
    })
  }

  const isColumnVisible = (columnId: ColumnId) => visibleColumns.has(columnId)

  // Drag handlers for column reordering
  const handleDragStart = (columnId: ColumnId) => {
    setDraggedColumn(columnId)
  }

  const handleDragOver = (e: React.DragEvent, targetColumnId: ColumnId) => {
    e.preventDefault()
    if (!draggedColumn || draggedColumn === targetColumnId) return

    setColumnOrder(prev => {
      const newOrder = [...prev]
      const draggedIndex = newOrder.indexOf(draggedColumn)
      const targetIndex = newOrder.indexOf(targetColumnId)
      if (draggedIndex === -1 || targetIndex === -1) return prev
      newOrder.splice(draggedIndex, 1)
      newOrder.splice(targetIndex, 0, draggedColumn)
      return newOrder
    })
  }

  const handleDragEnd = () => {
    setDraggedColumn(null)
    setColumnOrder(currentOrder => {
      saveColumnPrefs(currentOrder, visibleColumns)
      return currentOrder
    })
  }

  // Get columns in user-defined order (filtered by fund type)
  const orderedColumns = useMemo(() => {
    const availableIds = new Set(availableColumns.map(c => c.id))
    return columnOrder
      .filter(id => availableIds.has(id))
      .map(id => availableColumns.find(c => c.id === id)!)
      .filter(Boolean)
  }, [columnOrder, availableColumns])

  // Get visible columns in user-defined order
  const visibleOrderedColumns = useMemo(() => {
    return orderedColumns.filter(col => visibleColumns.has(col.id))
  }, [orderedColumns, visibleColumns])

  const sortedEntries = useMemo(() => {
    if (computedEntries.length === 0) return []
    // TSV is already in chronological order (oldest first)
    // Just reverse for "newest first" display, or use as-is for "oldest first"
    return sortOrder === 'asc' ? computedEntries : [...computedEntries].reverse()
  }, [computedEntries, sortOrder])

  const toggleSort = () => {
    setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value)
  }

  const formatPercent = (value: number) => {
    if (!Number.isFinite(value) || Number.isNaN(value)) return '--'
    const clamped = Math.max(-9999, Math.min(9999, value))
    const pct = clamped * 100
    return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
  }

  // Calculate price from amount and shares
  const calculatePriceFromEntry = (entry: FundEntry): number | null => {
    if (!entry.amount || !entry.shares || entry.shares === 0) return null
    return Math.abs(entry.amount / entry.shares)
  }

  // Update a single entry's price
  const handleCalcPrice = async (originalIndex: number, entry: FundEntry) => {
    const price = calculatePriceFromEntry(entry)
    if (price === null) {
      toast.error('Cannot calculate price: missing amount or shares')
      return
    }
    const updatedEntry: FundEntry = { ...entry, price: Math.round(price * 10000) / 10000 }
    const result = await updateFundEntry(fundId, originalIndex, updatedEntry)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success(`Price calculated: ${formatCurrency(price)}`)
      onReload()
    }
  }

  // Calculate all missing prices
  const handleCalcAllPrices = async () => {
    const entriesToUpdate = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.price && entry.amount && entry.shares && entry.shares !== 0)

    if (entriesToUpdate.length === 0) {
      toast.info('No prices to calculate')
      return
    }

    let successCount = 0
    for (const { entry, index } of entriesToUpdate) {
      const price = calculatePriceFromEntry(entry)
      if (price !== null) {
        const updatedEntry: FundEntry = { ...entry, price: Math.round(price * 10000) / 10000 }
        const result = await updateFundEntry(fundId, index, updatedEntry)
        if (!result.error) successCount++
      }
    }

    if (successCount > 0) {
      toast.success(`Calculated ${successCount} price${successCount > 1 ? 's' : ''}`)
      onReload()
    }
  }

  // Check if any entries can have prices calculated
  const canCalcAnyPrices = useMemo(() => {
    return entries.some(entry => !entry.price && entry.amount && entry.shares && entry.shares !== 0)
  }, [entries])

  // Recalculate fund_size for all entries
  const handleRecalculate = async () => {
    setRecalculating(true)
    const result = await recalculateFund(fundId)
    setRecalculating(false)

    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success(result.data?.message ?? 'Fund recalculated')
      onReload()
    }
  }

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col max-h-[70vh]">
      {/* Fixed Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
        <h2 className="text-base font-semibold text-white">
          Entries ({entries.length})
        </h2>
        <div className="flex items-center gap-2">
          {/* Column Configuration */}
          <div className="relative" ref={columnMenuRef}>
            <button
              onClick={() => setShowColumnMenu(!showColumnMenu)}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
              title="Configure columns"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
            </button>
            {showColumnMenu && (
              <div className="absolute right-0 top-full mt-1 bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-20 py-1 min-w-[200px]">
                <div className="px-3 py-1.5 text-[10px] text-slate-400 uppercase tracking-wider border-b border-slate-600">
                  Columns (drag to reorder)
                </div>
                {orderedColumns.map(col => {
                  const menuLabel = col.id === 'equity' && fundType === 'cash' ? 'Cash' : col.label
                  return (
                    <div
                      key={col.id}
                      draggable
                      onDragStart={() => handleDragStart(col.id)}
                      onDragOver={(e) => handleDragOver(e, col.id)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center gap-2 px-2 py-1.5 hover:bg-slate-600 cursor-grab text-xs ${
                        draggedColumn === col.id ? 'opacity-50 bg-slate-600' : ''
                      }`}
                    >
                      <svg className="w-3 h-3 text-slate-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm6-12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/>
                      </svg>
                      <label className="flex items-center gap-2 flex-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isColumnVisible(col.id)}
                          onChange={() => toggleColumn(col.id)}
                          className="rounded border-slate-500 bg-slate-800 text-mint-500 focus:ring-mint-500"
                        />
                        <span className="text-slate-200">{menuLabel}</span>
                      </label>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {settings.advancedTools && (
            <>
              <button
                onClick={() => setShowPasteModal(true)}
                className="px-2 py-1 text-xs bg-slate-600 text-white rounded hover:bg-slate-500 transition-colors font-medium"
                title="Paste column data to bulk update entries"
              >
                Paste Column
              </button>
              <div className="relative" ref={interpolateMenuRef}>
                <button
                  onClick={() => setShowInterpolateMenu(!showInterpolateMenu)}
                  className="px-2 py-1 text-xs bg-slate-600 text-white rounded hover:bg-slate-500 transition-colors font-medium flex items-center gap-1"
                  title="Interpolate missing values in a column"
                >
                  Interpolate
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showInterpolateMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1 z-20 min-w-[140px]">
                    {(['margin_available', 'margin_borrowed', 'fund_size', 'value'] as InterpolatableColumn[]).map((col) => (
                      <button
                        key={col}
                        onClick={async () => {
                          setShowInterpolateMenu(false)
                          const result = await interpolateColumn(fundId, col)
                          if (result.error) {
                            toast.error(result.error)
                            return
                          }
                          if (result.data) {
                            if (result.data.interpolated > 0) {
                              toast.success(result.data.message)
                              onReload()
                            } else {
                              toast.info(`No ${col.replace(/_/g, ' ')} values needed interpolation`)
                            }
                          }
                        }}
                        className="w-full px-3 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-700 transition-colors"
                      >
                        {col.replace(/_/g, ' ')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleRecalculate}
                disabled={recalculating}
                className="px-2 py-1 text-xs bg-slate-600 text-white rounded hover:bg-slate-500 transition-colors font-medium disabled:opacity-50"
                title="Recalculate fund_size and invested amounts for all entries"
              >
                {recalculating ? 'Recalculating...' : 'Recalculate'}
              </button>
            </>
          )}
          {showCoinbaseUpdate && fundStartDate && (
            <div className="relative">
              <CoinbaseImportButton
                fundId={fundId}
                fundStartDate={fundStartDate}
                hasEntries={entries.length > 0}
                onComplete={onReload}
              />
            </div>
          )}
          {showCoinbaseUpdate && (
            <div className="relative">
              <CoinbaseUpdateButton
                fundId={fundId}
                lastEntryDate={lastEntryDate}
                onComplete={onReload}
              />
            </div>
          )}
          <button
            onClick={onAddEntry}
            className="px-2 py-1 text-xs bg-mint-600 text-white rounded hover:bg-mint-700 transition-colors font-medium"
          >
            + Take Action
          </button>
        </div>
      </div>
      {/* Scrollable Table Container */}
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-slate-800 z-10">
            <tr className="border-b border-slate-700 text-slate-400 text-xs">
              {visibleOrderedColumns.map((col, idx) => {
                const isFirst = idx === 0
                if (col.id === 'date') {
                  return (
                    <th
                      key={col.id}
                      draggable
                      onDragStart={() => handleDragStart(col.id)}
                      onDragOver={(e) => handleDragOver(e, col.id)}
                      onDragEnd={handleDragEnd}
                      className={`px-2 py-2 cursor-grab ${isFirst ? 'sticky left-0 bg-slate-800 z-10' : ''} ${draggedColumn === col.id ? 'opacity-50' : ''}`}
                    >
                      <button
                        onClick={toggleSort}
                        className="flex items-center gap-1 hover:text-white transition-colors"
                      >
                        Date
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {sortOrder === 'desc' ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          )}
                        </svg>
                      </button>
                    </th>
                  )
                }
                if (col.id === 'edit') {
                  return (
                    <th
                      key={col.id}
                      draggable
                      onDragStart={() => handleDragStart(col.id)}
                      onDragOver={(e) => handleDragOver(e, col.id)}
                      onDragEnd={handleDragEnd}
                      className={`px-2 py-2 w-10 cursor-grab ${draggedColumn === col.id ? 'opacity-50' : ''}`}
                    />
                  )
                }
                if (col.id === 'notes') {
                  return (
                    <th
                      key={col.id}
                      draggable
                      onDragStart={() => handleDragStart(col.id)}
                      onDragOver={(e) => handleDragOver(e, col.id)}
                      onDragEnd={handleDragEnd}
                      className={`px-2 py-2 cursor-grab ${draggedColumn === col.id ? 'opacity-50' : ''}`}
                    >
                      {col.label}
                    </th>
                  )
                }
                if (col.id === 'price') {
                  return (
                    <th
                      key={col.id}
                      draggable
                      onDragStart={() => handleDragStart(col.id)}
                      onDragOver={(e) => handleDragOver(e, col.id)}
                      onDragEnd={handleDragEnd}
                      className={`px-2 py-2 text-right cursor-grab ${draggedColumn === col.id ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center justify-end gap-1">
                        {col.label}
                        {canCalcAnyPrices && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCalcAllPrices() }}
                            className="px-1 py-0.5 text-[9px] bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                            title="Calculate all missing prices from amount/shares"
                          >
                            calc
                          </button>
                        )}
                      </div>
                    </th>
                  )
                }
                // For cash funds, show "Cash" instead of "Equity"
                const displayLabel = fundType === 'cash'
                  ? col.id === 'equity' ? 'Cash'
                    : col.id === 'expense' ? 'Fee'
                    : col.id === 'sumExpense' ? 'Σ Fees'
                    : col.label
                  : col.label
                return (
                  <th
                    key={col.id}
                    draggable
                    onDragStart={() => handleDragStart(col.id)}
                    onDragOver={(e) => handleDragOver(e, col.id)}
                    onDragEnd={handleDragEnd}
                    className={`px-2 py-2 text-right cursor-grab ${draggedColumn === col.id ? 'opacity-50' : ''}`}
                  >
                    {displayLabel}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry, i) => (
              <tr
                key={i}
                className={`border-b border-slate-700/50 text-xs hover:bg-slate-700/30 ${
                  entry.hasIntegrityIssue ? 'bg-red-900/40 hover:bg-red-900/50' :
                  entry.hasMarginIntegrityIssue ? 'bg-orange-900/40 hover:bg-orange-900/50' : ''
                }`}
                title={
                  entry.hasIntegrityIssue
                    ? `Data integrity issue: invested ($${entry.totalInvested.toFixed(2)}) exceeds fund size ($${entry.fundSize.toFixed(2)})`
                    : entry.hasMarginIntegrityIssue
                    ? `Margin call: borrowed ($${(entry.margin_borrowed ?? 0).toFixed(2)}) exceeds available ($${(entry.margin_available ?? 0).toFixed(2)})`
                    : undefined
                }
              >
                {visibleOrderedColumns.map((col, idx) => {
                  const isFirst = idx === 0
                  switch (col.id) {
                    case 'date':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-white ${isFirst ? 'sticky left-0 bg-slate-800 z-10' : ''}`}>
                          {entry.date}
                        </td>
                      )
                    case 'equity':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-mint-400">
                          {formatCurrency(entry.value)}
                        </td>
                      )
                    case 'action': {
                      // Show "Close" only when it's a SELL that fully liquidated
                      // Use sumShares check if fund has share tracking, otherwise fall back to value-based check
                      const hasShareTracking = entry.shares !== undefined && entry.shares !== 0
                      const isDerivatives = fundType === 'derivatives'
                      const isClosingEntry = entry.action === 'SELL' && (
                        isDerivatives
                        || (hasShareTracking
                          ? entry.sumShares !== undefined && Math.abs(entry.sumShares) < 0.0001
                          : entry.value > 0 && entry.value <= (entry.amount ?? 0) + 0.01)
                      )
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right">
                          {isClosingEntry ? (
                            <span className="text-slate-500 italic">Close</span>
                          ) : entry.action && (
                            <span className={
                              entry.action === 'BUY' ? 'text-green-400'
                              : entry.action === 'SELL' ? 'text-orange-400'
                              : entry.action === 'HOLD' ? 'text-slate-400'
                              : entry.action === 'DEPOSIT' ? 'text-blue-400'
                              : entry.action === 'WITHDRAW' ? 'text-purple-400'
                              : ''
                            }>
                              {entry.action}
                            </span>
                          )}
                        </td>
                      )
                    }
                    case 'amount': {
                      // For cash funds, amount is signed: positive=deposit, negative=withdraw
                      const isCashFund = fundType === 'cash'
                      const amountValue = entry.amount
                      const colorClass = isCashFund && amountValue
                        ? amountValue > 0 ? 'text-green-400' : 'text-red-400'
                        : 'text-white'
                      const displayAmount = isCashFund && amountValue
                        ? (amountValue > 0 ? '+' : '') + formatCurrency(amountValue)
                        : amountValue ? formatCurrency(amountValue) : '-'
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${colorClass}`}>
                          {displayAmount}
                        </td>
                      )
                    }
                    case 'shares':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-slate-300">
                          {entry.shares ? entry.shares.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 8 }) : '-'}
                        </td>
                      )
                    case 'sumShares': {
                      const displayShares = entry.sumShares && Math.abs(entry.sumShares) < 0.00000001 ? 0 : entry.sumShares
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-slate-300">
                          {displayShares ? displayShares.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 8 }) : entry.sumShares === 0 || displayShares === 0 ? '0' : '-'}
                        </td>
                      )
                    }
                    case 'price': {
                      const canCalcPrice = !entry.price && entry.amount && entry.shares && entry.shares !== 0
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-slate-300">
                          {entry.price ? formatCurrency(entry.price) : canCalcPrice ? (
                            <button
                              onClick={() => handleCalcPrice(entry.originalIndex, entry)}
                              className="px-1 py-0.5 text-[9px] bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                              title={`Calculate: $${entry.amount?.toFixed(2)} ÷ ${Math.abs(entry.shares ?? 0).toFixed(4)} shares`}
                            >
                              calc
                            </button>
                          ) : '-'}
                        </td>
                      )
                    }
                    case 'invested':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-blue-400">
                          {formatCurrency(entry.totalInvested)}
                        </td>
                      )
                    case 'cash': {
                      // Prefer tracked cash from entry, fall back to calculated
                      const displayCash = entry.cash ?? entry.calculatedCash
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-green-300">
                          {formatCurrency(displayCash)}
                        </td>
                      )
                    }
                    case 'fundSize': {
                      // Only show "closed" for true closing entries (SELL with full liquidation)
                      // Use sumShares check if fund has share tracking, otherwise fall back to value-based check
                      const hasShareTrackingForFundSize = entry.shares !== undefined && entry.shares !== 0
                      const isDerivativesForFundSize = fundType === 'derivatives'
                      const isFundClosed = entry.action === 'SELL' && (
                        isDerivativesForFundSize
                        || (hasShareTrackingForFundSize
                          ? entry.sumShares !== undefined && Math.abs(entry.sumShares) < 0.0001
                          : entry.value > 0 && entry.value <= (entry.amount ?? 0) + 0.01)
                      )
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-slate-400">
                          {isFundClosed ? (
                            <span className="text-slate-500 italic">closed</span>
                          ) : (
                            formatCurrency(entry.fundSize)
                          )}
                        </td>
                      )
                    }
                    case 'marginAvail':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-purple-300">
                          {entry.margin_available ? formatCurrency(entry.margin_available) : '-'}
                        </td>
                      )
                    case 'marginBorrowed':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-purple-400">
                          {entry.margin_borrowed ? formatCurrency(entry.margin_borrowed) : '-'}
                        </td>
                      )
                    case 'unrealized':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${entry.unrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(entry.unrealized)}
                        </td>
                      )
                    case 'realized':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${entry.realized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(entry.realized)}
                        </td>
                      )
                    case 'liquidPnl':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${entry.liquidPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatCurrency(entry.liquidPnl)}
                        </td>
                      )
                    case 'realizedApy':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${entry.realizedApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercent(entry.realizedApy)}
                        </td>
                      )
                    case 'liquidApy':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${entry.liquidApy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercent(entry.liquidApy)}
                        </td>
                      )
                    case 'dividend':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-yellow-400">
                          {entry.dividend ? formatCurrency(entry.dividend) : '-'}
                        </td>
                      )
                    case 'sumDividends':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-yellow-400/70">
                          {entry.sumDividends > 0 ? formatCurrency(entry.sumDividends) : '-'}
                        </td>
                      )
                    case 'expense':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-red-400">
                          {entry.expense ? formatCurrency(-entry.expense) : '-'}
                        </td>
                      )
                    case 'sumExpense':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-red-400/70">
                          {entry.sumExpenses > 0 ? formatCurrency(-entry.sumExpenses) : '-'}
                        </td>
                      )
                    case 'cashInt':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-cyan-400">
                          {entry.cash_interest ? formatCurrency(entry.cash_interest) : '-'}
                        </td>
                      )
                    case 'sumCashInt':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-cyan-400/70">
                          {entry.sumCashInterest > 0 ? formatCurrency(entry.sumCashInterest) : '-'}
                        </td>
                      )
                    case 'extracted':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-orange-400">
                          {entry.extracted !== 0 ? formatCurrency(entry.extracted) : '-'}
                        </td>
                      )
                    case 'sumExtracted':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-orange-400/70">
                          {entry.sumExtracted !== 0 ? formatCurrency(entry.sumExtracted) : '-'}
                        </td>
                      )
                    case 'notes':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-slate-400 max-w-[150px] truncate" title={entry.notes || ''}>
                          {entry.notes || '-'}
                        </td>
                      )
                    // Derivatives-specific columns
                    case 'contracts':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-white">
                          {entry.contracts ? entry.contracts.toLocaleString() : '-'}
                        </td>
                      )
                    case 'position':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-blue-400">
                          {entry.derivPosition !== undefined ? entry.derivPosition.toLocaleString() : '-'}
                        </td>
                      )
                    case 'avgEntry':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-slate-300">
                          {entry.derivAvgEntry ? formatCurrency(entry.derivAvgEntry) : '-'}
                        </td>
                      )
                    case 'marginBalance': {
                      // Prefer tracked cash from entry, fall back to calculated margin balance
                      const displayMarginBalance = entry.cash ?? entry.derivMarginBalance
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-cyan-400">
                          {displayMarginBalance !== undefined ? formatCurrency(displayMarginBalance) : '-'}
                        </td>
                      )
                    }
                    case 'derivEquity':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-mint-400">
                          {entry.derivEquity !== undefined ? formatCurrency(entry.derivEquity) : '-'}
                        </td>
                      )
                    case 'sumFunding':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${(entry.derivSumFunding ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {entry.derivSumFunding !== undefined ? formatCurrency(entry.derivSumFunding) : '-'}
                        </td>
                      )
                    case 'sumInterest':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-yellow-400">
                          {entry.derivSumInterest !== undefined ? formatCurrency(entry.derivSumInterest) : '-'}
                        </td>
                      )
                    case 'sumRebates':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-purple-400">
                          {entry.derivSumRebates !== undefined ? formatCurrency(entry.derivSumRebates) : '-'}
                        </td>
                      )
                    case 'sumFees':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-red-400">
                          {entry.derivSumFees !== undefined ? formatCurrency(-entry.derivSumFees) : '-'}
                        </td>
                      )
                    case 'fee':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-red-400">
                          {entry.fee !== undefined && entry.fee > 0 ? formatCurrency(-entry.fee) : '-'}
                        </td>
                      )
                    case 'margin':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-amber-400">
                          {entry.margin !== undefined && entry.margin > 0 ? formatCurrency(entry.margin) : '-'}
                        </td>
                      )
                    case 'marginLocked':
                      return (
                        <td key={col.id} className="px-2 py-1.5 text-right text-amber-400">
                          {entry.derivMarginLocked !== undefined && entry.derivMarginLocked > 0 ? formatCurrency(entry.derivMarginLocked) : '-'}
                        </td>
                      )
                    case 'leverage':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${
                          entry.derivLeverage !== undefined
                            ? entry.derivLeverage < 3 ? 'text-green-400'
                            : entry.derivLeverage < 5 ? 'text-amber-400'
                            : 'text-red-400'
                            : 'text-slate-500'
                        }`}>
                          {entry.derivLeverage !== undefined && entry.derivLeverage > 0 ? `${entry.derivLeverage.toFixed(2)}x` : '-'}
                        </td>
                      )
                    case 'liquidationPrice':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${
                          entry.derivLiquidationPrice !== undefined
                            ? entry.derivLiquidationPrice === 0 ? 'text-slate-400'  // Zero = no position or fully collateralized
                            : entry.derivLiquidationPrice < 0 ? 'text-green-400'  // Negative = over-collateralized (safe)
                            : 'text-orange-400'  // Positive = has liquidation risk
                            : 'text-slate-500'
                        }`}>
                          {entry.derivLiquidationPrice !== undefined
                            ? entry.derivLiquidationPrice === 0 ? '-' : formatCurrency(entry.derivLiquidationPrice)
                            : '-'}
                        </td>
                      )
                    case 'distanceToLiq':
                      return (
                        <td key={col.id} className={`px-2 py-1.5 text-right ${
                          entry.derivDistanceToLiq !== undefined
                            ? entry.derivDistanceToLiq > 0.5 ? 'text-green-400'
                            : entry.derivDistanceToLiq > 0.25 ? 'text-amber-400'
                            : 'text-red-400'
                            : 'text-slate-500'
                        }`}>
                          {entry.derivDistanceToLiq !== undefined && entry.derivDistanceToLiq > 0
                            ? `${(entry.derivDistanceToLiq * 100).toFixed(1)}%`
                            : '-'}
                        </td>
                      )
                    case 'edit':
                      return (
                        <td key={col.id} className="px-2 py-1.5">
                          <button
                            onClick={() => onEdit(entry.originalIndex, entries[entry.originalIndex]!, entry.fundSize)}
                            className="p-1 text-slate-400 hover:text-white hover:bg-slate-600 rounded transition-colors"
                            title="Edit entry"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                          </button>
                        </td>
                      )
                    default:
                      return null
                  }
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Paste Column Modal */}
      {showPasteModal && (
        <PasteColumnModal
          fundId={fundId}
          entries={entries}
          onClose={() => setShowPasteModal(false)}
          onUpdated={onReload}
        />
      )}
    </div>
  )
}

import { useState } from 'react'
import type { TimeSeriesPoint } from './backtest'
import { formatCurrency } from './format'

interface Props {
  timeSeries: TimeSeriesPoint[]
}

type SortOrder = 'asc' | 'desc'

export function EntriesTable({ timeSeries }: Props) {
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  const entries = timeSeries.map((point, index) => {
    const invested = point.invested
    const unrealized = point.equity - Math.max(0, invested)
    const realized = point.sumCashInterest + point.sumDividends + point.totalExtracted
    const liquidPnL = realized + unrealized

    return {
      ...point,
      unrealized,
      realized,
      liquidPnL,
      index
    }
  })

  const sortedEntries = sortOrder === 'asc' ? entries : [...entries].reverse()

  const toggleSort = () => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      <div className="overflow-auto max-h-[600px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-800 z-30">
            <tr className="border-b border-slate-700 text-slate-400 text-xs">
              <th
                className="px-2 py-2 font-medium sticky left-0 bg-slate-800 z-40 cursor-pointer hover:text-slate-200 select-none"
                onClick={toggleSort}
              >
                <span className="flex items-center gap-1">
                  Date
                  <span className="text-[10px]">{sortOrder === 'asc' ? '\u25B2' : '\u25BC'}</span>
                </span>
              </th>
              <th className="px-2 py-2 font-medium text-right">Fund Size</th>
              <th className="px-2 py-2 font-medium text-right">Equity</th>
              <th className="px-2 py-2 font-medium text-right">Cash</th>
              <th className="px-2 py-2 font-medium text-right">Interest</th>
              <th className="px-2 py-2 font-medium text-right">{'\u03A3'} Interest</th>
              <th className="px-2 py-2 font-medium text-right">Dividend</th>
              <th className="px-2 py-2 font-medium text-right">{'\u03A3'} Dividend</th>
              <th className="px-2 py-2 font-medium text-right">Action</th>
              <th className="px-2 py-2 font-medium text-right">Amount</th>
              <th className="px-2 py-2 font-medium text-right">Invested</th>
              <th className="px-2 py-2 font-medium text-right">Unrealized</th>
              <th className="px-2 py-2 font-medium text-right">Realized</th>
              <th className="px-2 py-2 font-medium text-right">Liquid P&L</th>
              <th className="px-2 py-2 font-medium text-right">Target</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <tr
                key={entry.index}
                className={`border-b border-slate-700/50 text-xs hover:bg-slate-700/30 ${
                  entry.action === 'BUY' ? 'bg-green-900/10' :
                  entry.action === 'SELL' ? 'bg-red-900/10' :
                  ''
                }`}
              >
                <td className="px-2 py-1.5 text-white sticky left-0 bg-slate-800">
                  {entry.date}
                </td>
                <td className="px-2 py-1.5 text-right text-slate-300">
                  {formatCurrency(entry.fundSize)}
                </td>
                <td className="px-2 py-1.5 text-right text-mint-400">
                  {formatCurrency(entry.equity)}
                </td>
                <td className="px-2 py-1.5 text-right text-green-300">
                  {formatCurrency(entry.cash)}
                </td>
                <td className="px-2 py-1.5 text-right text-cyan-400">
                  {entry.cashInterest > 0.01 ? formatCurrency(entry.cashInterest) : '-'}
                </td>
                <td className="px-2 py-1.5 text-right text-cyan-300">
                  {formatCurrency(entry.sumCashInterest)}
                </td>
                <td className="px-2 py-1.5 text-right text-emerald-400">
                  {entry.dividend > 0.01 ? formatCurrency(entry.dividend) : '-'}
                </td>
                <td className="px-2 py-1.5 text-right text-emerald-300">
                  {formatCurrency(entry.sumDividends)}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <span className={
                    entry.action === 'BUY' ? 'text-green-400' :
                    entry.action === 'SELL' ? 'text-orange-400' :
                    'text-slate-500'
                  }>
                    {entry.action}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right">
                  {entry.amount > 0 ? (
                    <span className={entry.action === 'BUY' ? 'text-green-400' : 'text-red-400'}>
                      {formatCurrency(entry.amount)}
                    </span>
                  ) : (
                    <span className="text-slate-500">-</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right text-blue-400">
                  {formatCurrency(Math.max(0, entry.invested))}
                </td>
                <td className={`px-2 py-1.5 text-right ${
                  entry.unrealized >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {formatCurrency(entry.unrealized)}
                </td>
                <td className={`px-2 py-1.5 text-right ${
                  entry.realized >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {formatCurrency(entry.realized)}
                </td>
                <td className={`px-2 py-1.5 text-right ${
                  entry.liquidPnL >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {formatCurrency(entry.liquidPnL)}
                </td>
                <td className="px-2 py-1.5 text-right text-cyan-400">
                  {formatCurrency(entry.expectedTarget)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 bg-slate-900 border-t border-slate-700 text-xs text-slate-400">
        {timeSeries.length} entries
      </div>
    </div>
  )
}

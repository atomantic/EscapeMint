import { useMemo, useState } from 'react'
import type { FundEntry } from '../api/funds'
import type { ComputedEntry } from './entriesTable'
import { formatCurrency, formatPercent } from '../utils/format'

interface DerivativesBreakEvenPanelProps {
  entries: FundEntry[]
  computedEntries: ComputedEntry[]
  contractMultiplier: number
  maintenanceMarginRate: number
}

export function DerivativesBreakEvenPanel({
  entries,
  computedEntries,
  contractMultiplier,
  maintenanceMarginRate
}: DerivativesBreakEvenPanelProps) {
  const [targetPrice, setTargetPrice] = useState('')
  const [targetLiq, setTargetLiq] = useState('')

  const latestEntry = useMemo(() => {
    if (computedEntries.length === 0) return null
    return computedEntries[computedEntries.length - 1]
  }, [computedEntries])

  const netDeposits = useMemo(() => {
    let sum = 0
    for (const e of entries) {
      if (e.action === 'DEPOSIT') sum += Math.abs(e.amount ?? 0)
      else if (e.action === 'WITHDRAW') sum -= Math.abs(e.amount ?? 0)
    }
    return sum
  }, [entries])

  const metrics = useMemo(() => {
    if (!latestEntry) return null
    const position = latestEntry.derivPosition ?? 0
    if (position === 0) return null

    const avgEntry = latestEntry.derivAvgEntry ?? 0
    const effectiveCash = latestEntry.cash ?? latestEntry.derivMarginBalance ?? 0
    const costBasis = latestEntry.derivCostBasis ?? 0

    // derivEquity already includes unrealized P&L at the latest known price
    // (computed by engine as: effectiveCash + unrealizedPnl)
    const currentEquity = latestEntry.derivEquity ?? effectiveCash

    // Net break-even: price where equity = netDeposits
    // equityAtPrice(P) = effectiveCash + position * contractMultiplier * P - costBasis
    // Solve for P when equity = netDeposits:
    // netBE = (netDeposits - effectiveCash + costBasis) / (position * contractMultiplier)
    const positionNotional = position * contractMultiplier
    const netBreakEven = positionNotional !== 0
      ? (netDeposits - effectiveCash + costBasis) / positionNotional
      : 0

    return {
      positionBreakEven: avgEntry,
      netBreakEven,
      currentEquity,
      position,
      effectiveCash,
      costBasis
    }
  }, [latestEntry, netDeposits, contractMultiplier])

  const scenario = useMemo(() => {
    if (!metrics) return null
    const price = parseFloat(targetPrice)
    if (!price || price <= 0) return null

    const positionNotional = metrics.position * contractMultiplier
    const equityAtPrice = metrics.effectiveCash + (positionNotional * price) - metrics.costBasis
    const profitAtPrice = equityAtPrice - netDeposits
    const absDeposits = Math.abs(netDeposits)
    const profitPct = absDeposits > 0 ? profitAtPrice / absDeposits : null

    return { equityAtPrice, profitAtPrice, profitPct }
  }, [targetPrice, metrics, contractMultiplier, netDeposits])

  // Position sizing: max contracts to buy at targetPrice while keeping liq ≤ targetLiq
  // Only supported for long positions; short position sizing requires different algebra.
  // Liquidation formula for longs:
  //   liqPrice = (costBasis - marginBalance) / (notionalSize * (1 - mmRate))
  // After buying N contracts at buyPrice:
  //   newCostBasis = costBasis + N * buyPrice * contractMultiplier
  //   newNotionalSize = (position + N) * contractMultiplier
  // Solve for N when liqPrice = targetLiq:
  //   N = (targetLiq * position * cm * (1 - mmRate) - costBasis + marginBalance) /
  //       (cm * (buyPrice - targetLiq * (1 - mmRate)))
  const isLongPosition = metrics ? metrics.position > 0 : false
  const sizing = useMemo(() => {
    if (!metrics || !isLongPosition) return null
    const buyPrice = parseFloat(targetPrice)
    const maxLiq = parseFloat(targetLiq)
    if (!buyPrice || buyPrice <= 0 || !maxLiq || maxLiq <= 0) return null
    if (maxLiq >= buyPrice) return null // target liq must be below buy price

    const { position, effectiveCash, costBasis } = metrics
    const cm = contractMultiplier
    const mmFactor = 1 - maintenanceMarginRate

    const denominator = cm * (buyPrice - maxLiq * mmFactor)
    if (denominator <= 0) return { maxContracts: Infinity, newNetBE: 0, newPositionBE: 0, newPosition: 0, newLiq: 0 }

    const numerator = maxLiq * position * cm * mmFactor - costBasis + effectiveCash
    const maxContracts = Math.floor(numerator / denominator)
    if (maxContracts <= 0) return null

    // Compute new metrics after buying maxContracts
    const newPosition = position + maxContracts
    const addedCost = maxContracts * buyPrice * cm
    const newCostBasis = costBasis + addedCost
    const newNotionalSize = newPosition * cm

    const newPositionBE = newCostBasis / newNotionalSize
    const newNetBE = newNotionalSize !== 0
      ? (netDeposits - effectiveCash + newCostBasis) / newNotionalSize
      : 0

    // Verify liquidation price
    const newLiq = (newCostBasis - effectiveCash) / (newNotionalSize * mmFactor)

    return { maxContracts, newNetBE, newPositionBE, newPosition, newLiq }
  }, [targetPrice, targetLiq, metrics, isLongPosition, contractMultiplier, maintenanceMarginRate, netDeposits])

  if (!latestEntry || !metrics) return null

  const profitColor = (val: number) =>
    val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-slate-300'

  const inputClass = 'w-full bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-slate-200 font-mono text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500'

  return (
    <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-col">
      <h3 className="text-sm font-medium text-slate-400 mb-2">Break-Even & Scenario</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        <div>
          <span className="text-slate-500 text-xs">Position B/E</span>
          <div className="text-slate-200 font-mono">
            {formatCurrency(metrics.positionBreakEven)}
          </div>
        </div>
        <div>
          <span className="text-slate-500 text-xs">Net B/E (all-in)</span>
          <div className="text-slate-200 font-mono">
            {formatCurrency(metrics.netBreakEven)}
          </div>
        </div>
        <div>
          <span className="text-slate-500 text-xs">Net Deposits</span>
          <div className="text-slate-200 font-mono">
            {formatCurrency(netDeposits)}
          </div>
        </div>
        <div>
          <span className="text-slate-500 text-xs">Current Equity</span>
          <div className="text-slate-200 font-mono">
            {formatCurrency(metrics.currentEquity)}
          </div>
        </div>
        <div>
          <span className="text-slate-500 text-xs">Target Price</span>
          <input
            type="number"
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
            placeholder="e.g. 120000"
            className={inputClass}
          />
        </div>
        <div>
          <span className="text-slate-500 text-xs">Modeled P&L</span>
          {scenario ? (
            <div className={`font-mono ${profitColor(scenario.profitAtPrice)}`}>
              {formatCurrency(scenario.profitAtPrice)}{scenario.profitPct !== null ? ` (${formatPercent(scenario.profitPct)})` : ''}
            </div>
          ) : (
            <div className="text-slate-500 font-mono">--</div>
          )}
        </div>
      </div>

      {/* Position Sizing Calculator (long positions only) */}
      <div className="border-t border-slate-700 mt-2.5 pt-2.5">
        <h4 className="text-xs font-medium text-slate-400 mb-1.5">Position Sizing</h4>
        {!isLongPosition ? (
          <div className="text-slate-500 text-xs italic">Position sizing is only available for long positions.</div>
        ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div>
            <span className="text-slate-500 text-xs">Max Liq Price</span>
            <input
              type="number"
              value={targetLiq}
              onChange={(e) => setTargetLiq(e.target.value)}
              placeholder="e.g. 25000"
              className={inputClass}
            />
          </div>
          <div>
            <span className="text-slate-500 text-xs">Max Add&apos;l Contracts</span>
            {sizing ? (
              <div className="text-blue-400 font-mono">
                {sizing.maxContracts === Infinity ? 'No limit' : `+${sizing.maxContracts.toLocaleString()}`}
                {sizing.maxContracts !== Infinity && (
                  <span className="text-slate-500 text-xs ml-1">
                    ({(sizing.newPosition * contractMultiplier).toFixed(2)} BTC)
                  </span>
                )}
              </div>
            ) : (
              <div className="text-slate-500 font-mono">--</div>
            )}
          </div>
          {sizing && sizing.maxContracts !== Infinity && (
            <>
              <div>
                <span className="text-slate-500 text-xs">New Position B/E</span>
                <div className="text-slate-200 font-mono">
                  {formatCurrency(sizing.newPositionBE)}
                  <span className={`text-xs ml-1 ${sizing.newPositionBE < metrics.positionBreakEven ? 'text-green-400' : 'text-red-400'}`}>
                    ({formatCurrency(sizing.newPositionBE - metrics.positionBreakEven)})
                  </span>
                </div>
              </div>
              <div>
                <span className="text-slate-500 text-xs">New Net B/E</span>
                <div className="text-slate-200 font-mono">
                  {formatCurrency(sizing.newNetBE)}
                  <span className={`text-xs ml-1 ${sizing.newNetBE < metrics.netBreakEven ? 'text-green-400' : 'text-red-400'}`}>
                    ({formatCurrency(sizing.newNetBE - metrics.netBreakEven)})
                  </span>
                </div>
              </div>
              <div>
                <span className="text-slate-500 text-xs">Est. Liq Price</span>
                <div className="text-orange-400 font-mono">
                  {formatCurrency(Math.max(0, sizing.newLiq))}
                </div>
              </div>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  )
}

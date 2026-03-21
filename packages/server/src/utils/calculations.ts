/**
 * Shared calculation utilities.
 * Consolidates duplicate calculation patterns from funds.ts.
 */

import type { FundEntry } from '@escapemint/storage'

/**
 * Result of start input calculation with liquidation detection.
 */
export interface StartInputResult {
  /** Net amount currently invested (buys - sells, accounting for full liquidations) */
  startInput: number
  /** Total buys in current cycle */
  totalBuys: number
  /** Total sells in current cycle */
  totalSells: number
  /** Cumulative shares (for share-based liquidation detection) */
  sumShares: number
}

/**
 * Calculate start input (invested amount) with full liquidation detection.
 *
 * When a full liquidation occurs (cumulative shares reaches ~0 or value equals sell amount),
 * the investment cycle resets - totalBuys and totalSells reset to 0.
 *
 * This consolidates the duplicate logic from:
 * - /funds/:id/state endpoint (lines 398-428)
 * - /funds/:id/preview endpoint (lines 747-773)
 * - /funds/:id/entries endpoint (lines 858-890)
 *
 * @param entries - Fund entries (will be sorted by date internally)
 * @param upToDate - Optional: only process entries up to this date (exclusive)
 * @returns Start input calculation result
 */
export function calculateStartInputWithLiquidation(
  entries: FundEntry[],
  upToDate?: string
): StartInputResult {
  let totalBuys = 0
  let totalSells = 0
  let sumShares = 0

  // Check if fund has share tracking
  const hasShareTracking = entries.some(e => e.shares !== undefined && e.shares !== 0)

  // Sort entries by date
  const sortedEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date))

  // Filter entries if upToDate specified
  const entriesToProcess = upToDate
    ? sortedEntries.filter(e => e.date < upToDate)
    : sortedEntries

  for (const entry of entriesToProcess) {
    // Track shares for full liquidation detection
    if (entry.shares) {
      const sharesAbs = Math.abs(entry.shares)
      sumShares += entry.action === 'SELL' ? -sharesAbs : sharesAbs
    }

    if (entry.action === 'BUY' && entry.amount) {
      totalBuys += entry.amount
    } else if (entry.action === 'SELL' && entry.amount) {
      // Check for full liquidation (use OR — either condition triggers)
      const sharesLiquidated = hasShareTracking && Math.abs(sumShares) < 0.0001
      const valueLiquidated = (entry.value ?? 0) > 0 && (entry.value ?? 0) <= entry.amount + 0.01
      const isFullLiquidation = sharesLiquidated || valueLiquidated

      if (isFullLiquidation) {
        // Reset on full liquidation
        totalBuys = 0
        totalSells = 0
        sumShares = 0
      } else {
        totalSells += entry.amount
      }
    }
  }

  return {
    startInput: totalBuys - totalSells,
    totalBuys,
    totalSells,
    sumShares
  }
}

/**
 * Sort entries by date.
 * This consolidates the duplicate pattern used in multiple endpoints.
 */
export function sortEntriesByDate(entries: FundEntry[]): FundEntry[] {
  return [...entries].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  )
}

/**
 * Get effective fund size from entry or config fallback.
 * This consolidates the pattern: latestEntry?.fund_size ?? fund.config.fund_size_usd
 */
export function getEffectiveFundSize(
  entry: FundEntry | undefined | null,
  configFundSize: number
): number {
  return entry?.fund_size ?? configFundSize
}

/**
 * Calculate simple start input without liquidation detection.
 * Used in history endpoint for quick calculations.
 *
 * @param entries - Fund entries to process (already filtered)
 */
export function calculateSimpleStartInput(entries: FundEntry[]): number {
  let startInput = 0
  for (const entry of entries) {
    if (entry.action === 'BUY' && entry.amount) {
      startInput += entry.amount
    } else if (entry.action === 'SELL' && entry.amount) {
      startInput -= entry.amount
    }
  }
  return startInput
}

/**
 * Parse YYYY-MM-DD date string as local time (not UTC).
 * Use this instead of new Date(dateStr) to avoid timezone issues.
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns Date object in local time
 * @throws Error if date format is invalid or date doesn't exist
 */
export function parseLocalDate(dateStr: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('Invalid date format. Please use YYYY-MM-DD.')
  }
  const parts = dateStr.split('-').map(Number) as [number, number, number]
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  // Verify the date components match (catches invalid dates like 2024-02-31)
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) {
    throw new Error('Invalid date. Please enter a real calendar date.')
  }
  return date
}

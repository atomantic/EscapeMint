/**
 * Shared platform configuration utilities.
 * Consolidates duplicate readPlatformsData/writePlatformsData functions from funds.ts and platforms.ts.
 */

import { join } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { DATA_DIR } from '../config/paths.js'

export const PLATFORMS_FILE = join(DATA_DIR, 'platforms.json')

export interface PlatformConfig {
  name: string
  color?: string
  url?: string
  notes?: string
  /** When true, platform manages a shared cash pool via a {platform}-cash fund */
  manage_cash?: boolean
  /** When true, trades (BUY/SELL/dividends) on trading funds auto-create corresponding entries in the cash fund.
   *  Use this for platforms like Robinhood where cash is shared across all trading within the platform.
   *  Defaults to true for robinhood platform. */
  auto_sync_cash?: boolean
  /** Column order for funds table */
  funds_column_order?: string[]
  /** Visible columns for funds table */
  funds_visible_columns?: string[]
}

export interface Platform extends PlatformConfig {
  id: string
}

export type PlatformsData = Record<string, PlatformConfig>

/**
 * Read platforms from JSON file.
 * Returns empty object if file doesn't exist.
 */
export async function readPlatformsData(): Promise<PlatformsData> {
  if (!existsSync(PLATFORMS_FILE)) {
    return {}
  }
  const content = await readFile(PLATFORMS_FILE, 'utf-8')
  return JSON.parse(content) as PlatformsData
}

/**
 * Write platforms to JSON file atomically.
 * Creates parent directory if needed.
 */
export async function writePlatformsData(data: PlatformsData): Promise<void> {
  const dir = join(DATA_DIR)
  await mkdir(dir, { recursive: true })
  const tempPath = join(DATA_DIR, `.${uuidv4()}.tmp`)
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tempPath, PLATFORMS_FILE)
}

/**
 * Get today's date as YYYY-MM-DD.
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]!
}

/**
 * Round to 2 decimal places for monetary values.
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Check if a platform is a test platform.
 * Test platforms have IDs starting with 'test' (e.g., 'test', 'test-plat', 'test-cash').
 */
export function isTestPlatform(platform: string): boolean {
  return platform.startsWith('test')
}

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readAllFunds, writeFund, type FundData } from './fund-store.js'

export interface BackupData {
  version: string
  backup_date: string
  funds: FundData[]
  platforms: Record<string, unknown> | null
  totals_snapshot: unknown | null
  scrape_archives: Record<string, unknown>
}

export interface BackupResult {
  success: boolean
  path: string
  backup_date: string
  fund_count: number
  error?: string
}

export interface RestoreResult {
  success: boolean
  backup_date: string
  fund_count: number
  error?: string
}

/**
 * Get the default iCloud backup directory for EscapeMint.
 */
export function getDefaultBackupDir(): string {
  const home = process.env['HOME'] ?? ''
  return join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'EscapeMint-Backups')
}

/**
 * Read a JSON file if it exists.
 */
async function readJsonFile(filePath: string): Promise<unknown | null> {
  if (!existsSync(filePath)) {
    return null
  }
  const content = await readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

/**
 * Read all scrape archive files from the scrape-archives directory.
 */
async function readScrapeArchives(dataDir: string): Promise<Record<string, unknown>> {
  const archivesDir = join(dataDir, 'scrape-archives')
  if (!existsSync(archivesDir)) {
    return {}
  }

  const files = await readdir(archivesDir)
  const archives: Record<string, unknown> = {}

  for (const file of files) {
    if (file.endsWith('.json')) {
      const name = basename(file, '.json')
      const content = await readJsonFile(join(archivesDir, file))
      if (content) {
        archives[name] = content
      }
    }
  }

  return archives
}

/**
 * Create a timestamped backup filename.
 */
function createBackupFilename(): string {
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `escapemint-backup-${timestamp}.json`
}

/**
 * Create a backup of all fund data and configuration.
 *
 * @param dataDir - The data directory containing funds, platforms.json, etc.
 * @param backupDir - The directory to save the backup to.
 * @returns BackupResult with success status and backup path.
 */
export async function createBackup(dataDir: string, backupDir: string): Promise<BackupResult> {
  const backupDate = new Date().toISOString()

  // Ensure backup directory exists
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true })
  }

  // Read all data
  const fundsDir = join(dataDir, 'funds')
  const funds = await readAllFunds(fundsDir)
  const platforms = await readJsonFile(join(dataDir, 'platforms.json')) as Record<string, unknown> | null
  const totalsSnapshot = await readJsonFile(join(dataDir, 'totals-snapshot.json'))
  const scrapeArchives = await readScrapeArchives(dataDir)

  const backupData: BackupData = {
    version: '1.0.0',
    backup_date: backupDate,
    funds,
    platforms,
    totals_snapshot: totalsSnapshot,
    scrape_archives: scrapeArchives
  }

  // Write backup file
  const filename = createBackupFilename()
  const backupPath = join(backupDir, filename)

  await writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8')

  return {
    success: true,
    path: backupPath,
    backup_date: backupDate,
    fund_count: funds.length
  }
}

/**
 * List all backups in a directory.
 */
export async function listBackups(backupDir: string): Promise<{ name: string; date: string }[]> {
  if (!existsSync(backupDir)) {
    return []
  }

  const files = await readdir(backupDir)
  const backups = files
    .filter(f => f.startsWith('escapemint-backup-') && f.endsWith('.json'))
    .map(name => {
      // Extract date from filename: escapemint-backup-2025-01-05T12-30-45.json
      const match = name.match(/escapemint-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json/)
      const date = match ? match[1]!.replace(/-/g, (m, i) => (i > 9 && i < 17) ? ':' : m).replace('T', ' ') : name
      return { name, date }
    })
    .sort((a, b) => b.name.localeCompare(a.name)) // Most recent first

  return backups
}

/**
 * Read and validate a backup file.
 */
export async function readBackup(backupDir: string, filename: string): Promise<BackupData | null> {
  // Sanitize filename to prevent directory traversal
  const safeFilename = basename(filename)
  const backupPath = join(backupDir, safeFilename)
  if (!existsSync(backupPath)) {
    return null
  }
  const content = await readFile(backupPath, 'utf-8')
  const parsed: unknown = JSON.parse(content)
  if (!validateBackupData(parsed)) {
    return null
  }
  return parsed
}

/**
 * Write scrape archives to the data directory.
 */
async function writeScrapeArchives(dataDir: string, archives: Record<string, unknown>): Promise<void> {
  const archivesDir = join(dataDir, 'scrape-archives')
  if (!existsSync(archivesDir)) {
    await mkdir(archivesDir, { recursive: true })
  }

  for (const [name, content] of Object.entries(archives)) {
    const filePath = join(archivesDir, `${name}.json`)
    await writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8')
  }
}

/**
 * Restore a backup to the data directory.
 * This replaces all existing data with the backup data.
 *
 * @param backupDir - The directory containing backups.
 * @param filename - The backup filename to restore.
 * @param dataDir - The data directory to restore to.
 * @returns RestoreResult with success status.
 */
export async function restoreBackup(backupDir: string, filename: string, dataDir: string): Promise<RestoreResult> {
  const backup = await readBackup(backupDir, filename)
  if (!backup) {
    return {
      success: false,
      backup_date: '',
      fund_count: 0,
      error: `Backup file not found: ${filename}`
    }
  }

  const fundsDir = join(dataDir, 'funds')

  // Clear existing funds directory
  if (existsSync(fundsDir)) {
    await rm(fundsDir, { recursive: true })
  }
  await mkdir(fundsDir, { recursive: true })

  // Restore funds
  for (const fund of backup.funds) {
    const filePath = join(fundsDir, `${fund.id}.tsv`)
    await writeFund(filePath, fund)
  }

  // Restore platforms.json
  if (backup.platforms) {
    await writeFile(
      join(dataDir, 'platforms.json'),
      JSON.stringify(backup.platforms, null, 2),
      'utf-8'
    )
  }

  // Restore totals-snapshot.json
  if (backup.totals_snapshot) {
    await writeFile(
      join(dataDir, 'totals-snapshot.json'),
      JSON.stringify(backup.totals_snapshot, null, 2),
      'utf-8'
    )
  }

  // Restore scrape archives
  if (backup.scrape_archives && Object.keys(backup.scrape_archives).length > 0) {
    await writeScrapeArchives(dataDir, backup.scrape_archives)
  }

  return {
    success: true,
    backup_date: backup.backup_date,
    fund_count: backup.funds.length
  }
}

/**
 * Delete a backup file.
 */
export async function deleteBackup(backupDir: string, filename: string): Promise<{ success: boolean; error?: string }> {
  // Sanitize filename to prevent directory traversal
  const safeFilename = basename(filename)
  const backupPath = join(backupDir, safeFilename)

  if (!existsSync(backupPath)) {
    return {
      success: false,
      error: `Backup file not found: ${safeFilename}`
    }
  }

  // Attempt to delete the file
  const deleteResult = await rm(backupPath).then(
    () => ({ success: true as const }),
    (err: Error) => ({ success: false as const, error: err.message })
  )

  if (!deleteResult.success) {
    return {
      success: false,
      error: `Failed to delete backup: ${deleteResult.error}`
    }
  }

  return {
    success: true
  }
}

/**
 * Normalize backup data from Swift app format to web format.
 * Handles: "exported" → "backup_date", version 1 → "1.0.0", missing optional fields.
 */
export function normalizeBackupData(data: Record<string, unknown>): void {
  if (!data.backup_date && data.exported) {
    data.backup_date = data.exported
  }
  if (data.version === 1) {
    data.version = '1.0.0'
  }
  if (data.scrape_archives === undefined) {
    data.scrape_archives = {}
  }
}

/**
 * Validate backup data structure.
 */
function validateBackupData(data: unknown): data is BackupData {
  if (!data || typeof data !== 'object') return false

  // Normalize Swift app format before validation
  normalizeBackupData(data as Record<string, unknown>)

  const backup = data as Partial<BackupData>

  // Check required fields
  if (!backup.backup_date || typeof backup.backup_date !== 'string') return false
  if (!backup.version || typeof backup.version !== 'string') return false
  if (!Array.isArray(backup.funds)) return false

  // Validate each fund has required structure
  for (const fund of backup.funds) {
    if (!fund || typeof fund !== 'object') return false
    if (!fund.id || typeof fund.id !== 'string') return false
    if (!fund.platform || typeof fund.platform !== 'string') return false
    if (!fund.ticker || typeof fund.ticker !== 'string') return false
    if (!fund.config || typeof fund.config !== 'object') return false
    if (!Array.isArray(fund.entries)) return false
  }

  // Validate optional fields have correct types if present
  if (backup.platforms !== null && backup.platforms !== undefined) {
    if (typeof backup.platforms !== 'object') return false
    // Validate platforms structure - should be a plain object, not an array
    if (Array.isArray(backup.platforms)) return false
  }

  if (backup.scrape_archives !== undefined) {
    if (typeof backup.scrape_archives !== 'object' || backup.scrape_archives === null) return false
    // Validate scrape_archives structure - should be a plain object, not an array
    if (Array.isArray(backup.scrape_archives)) return false
    // Validate that all values in scrape_archives are valid (objects or primitives)
    for (const value of Object.values(backup.scrape_archives)) {
      if (value !== null && value !== undefined && typeof value !== 'object' && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return false
      }
    }
  }

  return true
}

/**
 * Write a backup file from backup data.
 * Used for uploading/importing backup files.
 */
export async function writeBackup(backupDir: string, backupData: BackupData): Promise<{ success: boolean; filename: string; error?: string }> {
  // Validate backup data structure
  if (!validateBackupData(backupData)) {
    return {
      success: false,
      filename: '',
      error: 'Invalid backup data structure'
    }
  }

  // Ensure backup directory exists
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true })
  }

  // Generate filename from backup_date
  const filename = createBackupFilename()
  const backupPath = join(backupDir, filename)

  await writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8')

  return {
    success: true,
    filename
  }
}

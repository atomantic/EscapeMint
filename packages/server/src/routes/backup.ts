import { Router } from 'express'
import { createBackup, listBackups, getDefaultBackupDir, restoreBackup, readBackup, deleteBackup, writeBackup, normalizeBackupData } from '@escapemint/storage'
import { DATA_DIR } from '../config/paths.js'
import { badRequest, createError, notFound } from '../middleware/error-handler.js'
import type { NextFunction, Request, Response } from 'express'

export const backupRouter: ReturnType<typeof Router> = Router()

const BACKUP_DIR = process.env['BACKUP_DIR'] ?? getDefaultBackupDir()

/**
 * GET /backup - Get backup configuration and list of existing backups
 */
backupRouter.get('/', async (_req, res) => {
  const backups = await listBackups(BACKUP_DIR)

  res.json({
    backup_dir: BACKUP_DIR,
    backups
  })
})

/**
 * POST /backup - Create a new backup
 */
backupRouter.post('/', async (_req: Request, res: Response, next: NextFunction) => {
  const result = await createBackup(DATA_DIR, BACKUP_DIR)

  if (result.success) {
    res.json({
      success: true,
      message: `Backup created successfully`,
      path: result.path,
      backup_date: result.backup_date,
      fund_count: result.fund_count
    })
  } else {
    next(createError(result.error ?? 'Unknown error creating backup', 500))
  }
})

/**
 * GET /backup/config - Get backup configuration
 */
backupRouter.get('/config', (_req, res) => {
  res.json({
    data_dir: DATA_DIR,
    backup_dir: BACKUP_DIR,
    is_icloud: BACKUP_DIR.includes('Mobile Documents/com~apple~CloudDocs')
  })
})

/**
 * GET /backup/download/:filename - Download a backup as JSON
 * IMPORTANT: This must come before /:filename to match correctly
 */
backupRouter.get('/download/:filename', async (req: Request<{filename: string}>, res: Response, next: NextFunction) => {
  const { filename } = req.params
  const backup = await readBackup(BACKUP_DIR, filename)

  if (!backup) {
    next(notFound('Backup'))
    return
  }

  res.json(backup)
})

/**
 * POST /backup/restore/:filename - Restore a backup
 */
backupRouter.post('/restore/:filename', async (req: Request<{filename: string}>, res: Response, next: NextFunction) => {
  const { filename } = req.params
  const result = await restoreBackup(BACKUP_DIR, filename, DATA_DIR)

  if (result.success) {
    res.json({
      success: true,
      message: `Backup restored successfully`,
      backup_date: result.backup_date,
      fund_count: result.fund_count
    })
  } else {
    next(createError(result.error ?? 'Unknown error restoring backup', 500))
  }
})

/**
 * GET /backup/:filename - Get backup details
 * IMPORTANT: This must come after more specific routes like /download/:filename
 */
backupRouter.get('/:filename', async (req: Request<{filename: string}>, res: Response, next: NextFunction) => {
  const { filename } = req.params
  const backup = await readBackup(BACKUP_DIR, filename)

  if (!backup) {
    next(notFound('Backup'))
    return
  }

  res.json({
    success: true,
    backup_date: backup.backup_date,
    fund_count: backup.funds.length,
    has_platforms: !!backup.platforms,
    has_totals_snapshot: !!backup.totals_snapshot,
    scrape_archive_count: Object.keys(backup.scrape_archives).length
  })
})

/**
 * DELETE /backup/:filename - Delete a backup
 */
backupRouter.delete('/:filename', async (req: Request<{filename: string}>, res: Response, next: NextFunction) => {
  const { filename } = req.params
  const result = await deleteBackup(BACKUP_DIR, filename)

  if (result.success) {
    res.json({
      success: true,
      message: 'Backup deleted successfully'
    })
  } else {
    const errorMessage = typeof result.error === 'string' ? result.error : String(result.error ?? '')
    const status = errorMessage.toLowerCase().includes('not found') ? 404 : 500
    next(createError(errorMessage || 'Failed to delete backup', status))
  }
})

/**
 * POST /backup/upload - Upload a backup JSON file
 */
backupRouter.post('/upload', async (req: Request, res: Response, next: NextFunction) => {
  const backupData = req.body

  // Normalize Swift app backup format before validation
  if (backupData && typeof backupData === 'object') {
    normalizeBackupData(backupData as Record<string, unknown>)
  }

  // Basic validation
  if (!backupData || !backupData.backup_date || !backupData.funds || !backupData.version) {
    next(badRequest('Invalid backup data: missing required fields'))
    return
  }

  // Validate data types
  if (typeof backupData.backup_date !== 'string' || !Array.isArray(backupData.funds) || typeof backupData.version !== 'string') {
    next(badRequest('Invalid backup data: incorrect data types'))
    return
  }

  // Validate version compatibility (currently only supporting 1.0.0)
  const SUPPORTED_VERSIONS = ['1.0.0']
  if (!SUPPORTED_VERSIONS.includes(backupData.version)) {
    next(badRequest(`Unsupported backup version: ${backupData.version}. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`))
    return
  }

  // Size limit check: prevent excessively large payloads (100MB limit)
  const payloadSize = JSON.stringify(backupData).length
  const MAX_PAYLOAD_SIZE = 100 * 1024 * 1024 // 100MB
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    next(createError('Backup data too large (max 100MB)', 413, 'PAYLOAD_TOO_LARGE'))
    return
  }

  // Validate reasonable fund count (max 10000 funds)
  if (backupData.funds.length > 10000) {
    next(badRequest('Too many funds in backup (max 10000)'))
    return
  }

  const result = await writeBackup(BACKUP_DIR, backupData)

  if (result.success) {
    res.json({
      success: true,
      message: 'Backup uploaded successfully',
      filename: result.filename
    })
  } else {
    next(badRequest(result.error ?? 'Invalid backup data structure'))
  }
})

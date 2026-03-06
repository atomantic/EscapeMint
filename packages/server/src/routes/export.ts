import { Router } from 'express'
import { join } from 'node:path'
import { readdir, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readAllFunds, writeFund, type FundData } from '@escapemint/storage'
import { DATA_DIR, FUNDS_DIR } from '../config/paths.js'
import { badRequest } from '../middleware/error-handler.js'
import { createLogger } from '../utils/logger.js'
import type { NextFunction, Request, Response } from 'express'

const log = createLogger('export')

export const exportRouter: ReturnType<typeof Router> = Router()

/**
 * GET /export - Export all fund data as JSON
 */
exportRouter.get('/', async (_req, res, next) => {
  const funds = await readAllFunds(FUNDS_DIR).catch(next)
  if (!funds) return

  // Also include totals snapshot if it exists
  let totalsSnapshot = null
  const totalsPath = join(DATA_DIR, 'totals-snapshot.json')
  if (existsSync(totalsPath)) {
    const content = await readFile(totalsPath, 'utf-8').catch(() => null)
    if (content) {
      totalsSnapshot = JSON.parse(content)
    }
  }

  res.json({
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    fund_count: funds.length,
    funds,
    totals_snapshot: totalsSnapshot
  })
})

/**
 * GET /export/download - Export as downloadable JSON file
 */
exportRouter.get('/download', async (_req, res, next) => {
  const funds = await readAllFunds(FUNDS_DIR).catch(next)
  if (!funds) return

  const exportData = {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    fund_count: funds.length,
    funds
  }

  const filename = `escapemint-export-${new Date().toISOString().split('T')[0]}.json`
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Type', 'application/json')
  res.json(exportData)
})

/**
 * POST /export/import - Import fund data from JSON
 */
exportRouter.post('/import', async (req: Request, res: Response, next: NextFunction) => {
  const { funds, mode = 'merge' } = req.body as {
    funds: FundData[]
    mode?: 'merge' | 'replace'
  }

  if (!funds || !Array.isArray(funds)) {
    return next(badRequest('funds array is required'))
  }

  // Validate each fund has required fields
  for (let i = 0; i < funds.length; i++) {
    const fund = funds[i]
    if (!fund || typeof fund !== 'object') {
      return next(badRequest(`Invalid fund at index ${i}: must be an object`))
    }
    if (!fund.id || typeof fund.id !== 'string') {
      return next(badRequest(`Invalid fund at index ${i}: id is required`))
    }
    if (!fund.platform || typeof fund.platform !== 'string') {
      return next(badRequest(`Invalid fund at index ${i}: platform is required`))
    }
    if (!fund.ticker || typeof fund.ticker !== 'string') {
      return next(badRequest(`Invalid fund at index ${i}: ticker is required`))
    }
    if (!fund.config || typeof fund.config !== 'object') {
      return next(badRequest(`Invalid fund at index ${i}: config is required`))
    }
    if (!fund.entries || !Array.isArray(fund.entries)) {
      return next(badRequest(`Invalid fund at index ${i}: entries array is required`))
    }
  }

  // Ensure funds directory exists
  await mkdir(FUNDS_DIR, { recursive: true }).catch((e: unknown) => {
    log.warn(`Failed to create funds directory ${FUNDS_DIR}`, e)
  })

  const results = {
    imported: 0,
    skipped: 0,
    errors: [] as string[]
  }

  for (const fund of funds) {
    const filePath = join(FUNDS_DIR, `${fund.id}.tsv`)
    const exists = existsSync(filePath)

    if (mode === 'merge' && exists) {
      results.skipped++
      continue
    }

    const result = await writeFund(filePath, fund).catch((e: Error) => {
      results.errors.push(`${fund.id}: ${e.message}`)
      return null
    })

    if (result !== null) {
      results.imported++
    }
  }

  res.json({
    success: true,
    results
  })
})

/**
 * GET /export/tsv-files - List all TSV files
 */
exportRouter.get('/tsv-files', async (_req, res) => {
  const files = await readdir(FUNDS_DIR).catch(() => [])
  const tsvFiles = files.filter(f => f.endsWith('.tsv'))

  res.json({
    count: tsvFiles.length,
    files: tsvFiles
  })
})

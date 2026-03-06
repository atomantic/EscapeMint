/**
 * Test Data Routes
 *
 * API endpoints for generating and managing test/demo fund data.
 */

import { Router } from 'express'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readAllFunds, writeFund, deleteFund } from '@escapemint/storage'
import { generateTestFunds, checkPriceDataExists } from '../utils/test-data-generator.js'
import { badRequest } from '../middleware/error-handler.js'
import { isTestPlatform } from '../utils/platforms.js'
import { FUNDS_DIR } from '../config/paths.js'

export const testDataRouter: ReturnType<typeof Router> = Router()

/**
 * GET /test-data/status - Check if test data can be generated
 */
testDataRouter.get('/status', async (_req, res) => {
  const priceDataStatus = checkPriceDataExists()

  // Count existing test funds
  const allFunds = await readAllFunds(FUNDS_DIR)
  const testFunds = allFunds.filter(f => isTestPlatform(f.platform))

  res.json({
    priceDataAvailable: priceDataStatus.exists,
    missingPriceData: priceDataStatus.missing,
    existingTestFunds: testFunds.length,
    testFundIds: testFunds.map(f => f.id)
  })
})

/**
 * POST /test-data/generate - Generate test funds with historical DCA simulation
 *
 * Request body (optional):
 *   - initialFundSize: number (default: 10000) - Initial fund size
 *   - deleteExisting: boolean (default: true) - Delete existing test funds first
 */
testDataRouter.post('/generate', async (req, res, next) => {
  const {
    initialFundSize = 10000,
    deleteExisting = true
  } = req.body as {
    initialFundSize?: number
    deleteExisting?: boolean
  }

  // Validate inputs
  if (typeof initialFundSize !== 'number' || initialFundSize < 0) {
    return next(badRequest('initialFundSize must be a non-negative number'))
  }

  // Check price data exists
  const priceDataStatus = checkPriceDataExists()
  if (!priceDataStatus.exists) {
    return next(badRequest(`Missing price data files: ${priceDataStatus.missing.join(', ')}`))
  }

  // Delete existing test funds if requested
  let deletedCount = 0
  if (deleteExisting) {
    const allFunds = await readAllFunds(FUNDS_DIR)
    const testFunds = allFunds.filter(f => isTestPlatform(f.platform))

    for (const fund of testFunds) {
      const filePath = join(FUNDS_DIR, `${fund.id}.tsv`)
      if (existsSync(filePath)) {
        await deleteFund(filePath)
        deletedCount++
      }
    }
  }

  // Generate new test funds
  const funds = generateTestFunds({ initialFundSize })

  // Write funds to disk
  for (const fund of funds) {
    const filePath = join(FUNDS_DIR, `${fund.id}.tsv`)
    await writeFund(filePath, fund)
  }

  // Calculate summary stats
  const summary = funds.map(f => {
    const lastEntry = f.entries[f.entries.length - 1]
    return {
      id: f.id,
      platform: f.platform,
      ticker: f.ticker,
      fundType: f.config.fund_type,
      entryCount: f.entries.length,
      lastDate: lastEntry?.date,
      lastValue: lastEntry?.value
    }
  })

  res.json({
    success: true,
    deletedExisting: deletedCount,
    createdFunds: funds.length,
    funds: summary
  })
})

/**
 * DELETE /test-data - Delete all test funds
 */
testDataRouter.delete('/', async (_req, res) => {
  const allFunds = await readAllFunds(FUNDS_DIR)
  const testFunds = allFunds.filter(f => isTestPlatform(f.platform))

  let deletedCount = 0
  for (const fund of testFunds) {
    const filePath = join(FUNDS_DIR, `${fund.id}.tsv`)
    if (existsSync(filePath)) {
      await deleteFund(filePath)
      deletedCount++
    }
  }

  res.json({
    success: true,
    deletedCount,
    deletedFunds: testFunds.map(f => f.id)
  })
})

import { join } from 'node:path'

export const DATA_DIR = process.env['DATA_DIR'] ?? './data'
export const FUNDS_DIR = join(DATA_DIR, 'funds')

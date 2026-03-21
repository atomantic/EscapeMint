import { describe, it, expect } from 'vitest'
import { normalizeBackupData } from '../src/backup.js'

describe('normalizeBackupData', () => {
  it('converts "exported" to "backup_date"', () => {
    const data: Record<string, unknown> = { exported: '2026-03-21T00:00:00Z' }
    normalizeBackupData(data)
    expect(data.backup_date).toBe('2026-03-21T00:00:00Z')
  })

  it('does not overwrite existing backup_date with exported', () => {
    const data: Record<string, unknown> = {
      backup_date: '2026-03-20T00:00:00Z',
      exported: '2026-03-21T00:00:00Z'
    }
    normalizeBackupData(data)
    expect(data.backup_date).toBe('2026-03-20T00:00:00Z')
  })

  it('converts numeric version 1 to string "1.0.0"', () => {
    const data: Record<string, unknown> = { version: 1 }
    normalizeBackupData(data)
    expect(data.version).toBe('1.0.0')
  })

  it('does not modify string version', () => {
    const data: Record<string, unknown> = { version: '2.0.0' }
    normalizeBackupData(data)
    expect(data.version).toBe('2.0.0')
  })

  it('adds default scrape_archives when missing', () => {
    const data: Record<string, unknown> = {}
    normalizeBackupData(data)
    expect(data.scrape_archives).toEqual({})
  })

  it('does not overwrite existing scrape_archives', () => {
    const archives = { test: { data: 'value' } }
    const data: Record<string, unknown> = { scrape_archives: archives }
    normalizeBackupData(data)
    expect(data.scrape_archives).toBe(archives)
  })

  it('handles all Swift normalizations together', () => {
    const data: Record<string, unknown> = {
      exported: '2026-03-21T00:00:00Z',
      version: 1
    }
    normalizeBackupData(data)
    expect(data.backup_date).toBe('2026-03-21T00:00:00Z')
    expect(data.version).toBe('1.0.0')
    expect(data.scrape_archives).toEqual({})
  })
})

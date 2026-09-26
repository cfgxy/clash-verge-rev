import { describe, expect, it } from 'vitest'

import { normalizeEntryPath, UnsafeEntryPathError } from './entry-path'

describe('normalizeEntryPath', () => {
  it('keeps a bundle-relative path', () => {
    expect(normalizeEntryPath('rules/sequence.yaml')).toBe(
      'rules/sequence.yaml',
    )
    expect(normalizeEntryPath('./manifest.json')).toBe('manifest.json')
    expect(normalizeEntryPath('rules//sequence.yaml')).toBe(
      'rules/sequence.yaml',
    )
  })

  it('normalizes backslash separators written by Windows tooling', () => {
    expect(normalizeEntryPath('rules\\sequence.yaml')).toBe(
      'rules/sequence.yaml',
    )
  })

  it('rejects traversing entries', () => {
    for (const name of [
      '../manifest.json',
      'rules/../../manifest.json',
      'rules/..',
      'a/../b.yaml',
      '..\\manifest.json',
    ]) {
      expect(() => normalizeEntryPath(name)).toThrow(UnsafeEntryPathError)
    }
  })

  it('rejects absolute entries', () => {
    for (const name of [
      '/etc/passwd',
      'C:/Windows/system.ini',
      'C:\\Windows\\system.ini',
    ]) {
      expect(() => normalizeEntryPath(name)).toThrow(UnsafeEntryPathError)
    }
  })

  it('rejects an entry that normalizes to nothing', () => {
    expect(() => normalizeEntryPath('./')).toThrow(UnsafeEntryPathError)
  })
})

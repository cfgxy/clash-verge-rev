import { describe, expect, it } from 'vitest'

import {
  collectProviderHosts,
  describeRejection,
  providerUrlHost,
} from './rejection-message'

describe('describeRejection', () => {
  it('names the offending format version', () => {
    expect(
      describeRejection({ kind: 'format-version-unsupported', version: '2.0' }),
    ).toEqual({
      key: 'rules.feedback.notifications.bundle.rejected.formatVersion',
      params: { version: '2.0' },
    })
  })

  it('does not echo the offending entry name', () => {
    expect(
      describeRejection({
        kind: 'unsafe-entry-path',
        entryName: '../../etc/passwd',
      }),
    ).toEqual({
      key: 'rules.feedback.notifications.bundle.rejected.unsafeEntryPath',
    })
  })
})

describe('providerUrlHost', () => {
  it('keeps only the host so a subscription token is not disclosed', () => {
    expect(
      providerUrlHost('https://sub.example.com/rules?token=secret-token'),
    ).toBe('sub.example.com')
  })

  it('returns nothing for a value that is not a URL', () => {
    expect(providerUrlHost('./local.yaml')).toBeUndefined()
    expect(providerUrlHost(undefined)).toBeUndefined()
  })
})

describe('collectProviderHosts', () => {
  it('deduplicates hosts and skips local files', () => {
    expect(
      collectProviderHosts({
        a: { url: 'https://sub.example.com/a?token=x' },
        b: { url: 'https://sub.example.com/b?token=y' },
        c: { url: 'https://other.example.org/c' },
        d: {},
      }),
    ).toEqual(['other.example.org', 'sub.example.com'])
  })
})

import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import type { RuleProviderConfigMap } from '@/utils/rule-provider'

import { BundleImportError, buildRuleBundle, readRuleBundle } from './bundle'
import {
  MANIFEST_ENTRY,
  PROVIDERS_ENTRY,
  RULES_ENTRY,
  type RuleSequence,
} from './format'
import { sha256Hex } from './sha256'
import { createZipArchive, encodeUtf8 } from './zip'

const sequence: RuleSequence = {
  prepend: ['DOMAIN-SUFFIX,example.com,Proxy', 'RULE-SET,ads,REJECT'],
  append: ['GEOIP,CN,Domestic,no-resolve'],
  delete: ['MATCH,DIRECT'],
}

const providers: RuleProviderConfigMap = {
  ads: {
    type: 'http',
    behavior: 'domain',
    url: 'https://example.com/ads.yaml',
    interval: 86400,
  },
}

async function manifestOf(bytes: Uint8Array) {
  const { bundle } = await readRuleBundle(bytes)
  return bundle.manifest
}

describe('buildRuleBundle', () => {
  it('writes the manifest, rule sequence and provider config', async () => {
    const bytes = await buildRuleBundle({
      sequence,
      providers,
      appVersion: '2.5.6',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    })
    const manifest = await manifestOf(bytes)

    expect(manifest.formatVersion).toBe('1.0')
    expect(manifest.generator).toEqual({
      app: 'clash-verge-rev',
      version: '2.5.6',
    })
    expect(manifest.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(manifest.contents.map((entry) => entry.path)).toEqual([
      RULES_ENTRY,
      PROVIDERS_ENTRY,
    ])
    expect(manifest.contents[0].entryCount).toBe(4)
    expect(manifest.contents[1].entryCount).toBe(1)
  })

  it('lists every policy the added rules reference, excluding deletes', async () => {
    const bytes = await buildRuleBundle({
      sequence,
      providers,
      appVersion: '2.5.6',
    })
    const manifest = await manifestOf(bytes)

    expect(manifest.proxyPolicies).toEqual(['Domestic', 'Proxy', 'REJECT'])
  })

  it('round-trips the three sequence arrays and the provider config', async () => {
    const bytes = await buildRuleBundle({
      sequence,
      providers,
      appVersion: '2.5.6',
    })
    const { bundle, producedByNewerMinor } = await readRuleBundle(bytes)

    expect(bundle.sequence).toEqual(sequence)
    expect(bundle.providers).toEqual(providers)
    expect(producedByNewerMinor).toBe(false)
  })
})

async function zipWith(
  entries: Array<{ name: string; text: string }>,
): Promise<Uint8Array> {
  return createZipArchive(
    entries.map((entry) => ({
      name: entry.name,
      data: encodeUtf8(entry.text),
    })),
  )
}

async function manifestJson(
  overrides: Record<string, unknown> = {},
  contents?: Array<{ path: string; sha256: string; entryCount: number }>,
): Promise<string> {
  const sequenceYaml = dump(sequence, { lineWidth: -1 })
  const providersYaml = dump({ 'rule-providers': providers }, { lineWidth: -1 })
  return JSON.stringify({
    formatVersion: '1.0',
    generator: { app: 'clash-meta-for-android', version: '1.0.0' },
    createdAt: '2026-01-02T03:04:05.000Z',
    proxyPolicies: ['Proxy'],
    contents: contents ?? [
      {
        path: RULES_ENTRY,
        sha256: await sha256Hex(encodeUtf8(sequenceYaml)),
        entryCount: 4,
      },
      {
        path: PROVIDERS_ENTRY,
        sha256: await sha256Hex(encodeUtf8(providersYaml)),
        entryCount: 1,
      },
    ],
    ...overrides,
  })
}

describe('readRuleBundle rejections', () => {
  it('rejects a file that is not a zip', async () => {
    await expect(
      readRuleBundle(encodeUtf8('this is plain text, not an archive')),
    ).rejects.toMatchObject({ rejection: { kind: 'not-a-zip' } })
  })

  it('rejects a zip without a manifest', async () => {
    const bytes = await zipWith([{ name: RULES_ENTRY, text: dump(sequence) }])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'manifest-missing' },
    })
  })

  it('rejects a manifest whose major version is unsupported', async () => {
    const bytes = await zipWith([
      {
        name: MANIFEST_ENTRY,
        text: await manifestJson({ formatVersion: '2.0' }),
      },
      { name: RULES_ENTRY, text: dump(sequence, { lineWidth: -1 }) },
    ])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'format-version-unsupported', version: '2.0' },
    })
  })

  it('rejects an entry whose path escapes the bundle root', async () => {
    const bytes = await zipWith([
      { name: MANIFEST_ENTRY, text: await manifestJson() },
      { name: '../../etc/passwd', text: 'payload' },
      { name: RULES_ENTRY, text: dump(sequence, { lineWidth: -1 }) },
    ])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'unsafe-entry-path', entryName: '../../etc/passwd' },
    })
  })

  it('rejects an entry with an absolute path', async () => {
    const bytes = await zipWith([
      { name: MANIFEST_ENTRY, text: await manifestJson() },
      { name: '/etc/passwd', text: 'payload' },
    ])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'unsafe-entry-path' },
    })
  })

  it('rejects a bundle missing the rule sequence', async () => {
    const bytes = await zipWith([
      { name: MANIFEST_ENTRY, text: await manifestJson() },
    ])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'content-missing', path: RULES_ENTRY },
    })
  })

  it('rejects content whose digest does not match the manifest', async () => {
    const bytes = await zipWith([
      { name: MANIFEST_ENTRY, text: await manifestJson() },
      { name: RULES_ENTRY, text: dump({ prepend: ['tampered'] }) },
    ])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'content-corrupt', path: RULES_ENTRY },
    })
  })

  it('rejects a rule sequence that is not a mapping', async () => {
    const text = dump(['not', 'a', 'mapping'], { lineWidth: -1 })
    const bytes = await zipWith([
      {
        name: MANIFEST_ENTRY,
        text: await manifestJson({}, [
          {
            path: RULES_ENTRY,
            sha256: await sha256Hex(encodeUtf8(text)),
            entryCount: 0,
          },
        ]),
      },
      { name: RULES_ENTRY, text },
    ])
    await expect(readRuleBundle(bytes)).rejects.toMatchObject({
      rejection: { kind: 'content-invalid', path: RULES_ENTRY },
    })
  })

  it('accepts a newer minor version and reports it', async () => {
    const sequenceYaml = dump(sequence, { lineWidth: -1 })
    const bytes = await zipWith([
      {
        name: MANIFEST_ENTRY,
        text: await manifestJson(
          { formatVersion: '1.7', futureKey: 'ignored' },
          [
            {
              path: RULES_ENTRY,
              sha256: await sha256Hex(encodeUtf8(sequenceYaml)),
              entryCount: 4,
            },
          ],
        ),
      },
      { name: RULES_ENTRY, text: sequenceYaml },
    ])
    const { bundle, producedByNewerMinor } = await readRuleBundle(bytes)

    expect(producedByNewerMinor).toBe(true)
    expect(bundle.sequence).toEqual(sequence)
    expect(bundle.providers).toEqual({})
  })

  it('accepts a bundle produced by the Android client', async () => {
    const sequenceYaml = dump(sequence, { lineWidth: -1 })
    const providersYaml = dump(
      { 'rule-providers': providers },
      { lineWidth: -1 },
    )
    const bytes = await zipWith([
      { name: MANIFEST_ENTRY, text: await manifestJson() },
      { name: RULES_ENTRY, text: sequenceYaml },
      { name: PROVIDERS_ENTRY, text: providersYaml },
    ])
    const { bundle } = await readRuleBundle(bytes)

    expect(bundle.manifest.generator.app).toBe('clash-meta-for-android')
    expect(bundle.providers).toEqual(providers)
  })

  it('reports rejections as BundleImportError', async () => {
    await expect(readRuleBundle(new Uint8Array(4))).rejects.toBeInstanceOf(
      BundleImportError,
    )
  })
})

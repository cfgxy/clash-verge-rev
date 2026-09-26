import { dump, load } from 'js-yaml'

import { normalizeEntryPath } from '@/utils/rule-bundle/entry-path'
import {
  BUNDLE_FORMAT_MAJOR,
  BUNDLE_FORMAT_MINOR,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_GENERATOR_APP,
  type BundleContentEntry,
  type BundleManifest,
  collectProxyPolicies,
  countSequenceEntries,
  MANIFEST_ENTRY,
  parseFormatVersion,
  PROVIDERS_ENTRY,
  type RuleBundle,
  RULES_ENTRY,
  type RuleSequence,
} from '@/utils/rule-bundle/format'
import { sha256Hex } from '@/utils/rule-bundle/sha256'
import {
  createZipArchive,
  decodeUtf8,
  encodeUtf8,
  readZipArchive,
  ZipFormatError,
  type ZipEntry,
} from '@/utils/rule-bundle/zip'
import type {
  RuleProviderConfig,
  RuleProviderConfigMap,
} from '@/utils/rule-provider'

/**
 * Import refusals the UI must distinguish. `format-version-unsupported` is the
 * only one carrying the offending version, so the message can name it.
 */
export type BundleImportRejection =
  | { kind: 'not-a-zip'; detail: string }
  | { kind: 'manifest-missing' }
  | { kind: 'manifest-invalid'; detail: string }
  | { kind: 'format-version-unsupported'; version: string }
  | { kind: 'unsafe-entry-path'; entryName: string }
  | { kind: 'content-missing'; path: string }
  | { kind: 'content-corrupt'; path: string }
  | { kind: 'content-invalid'; path: string; detail: string }

export class BundleImportError extends Error {
  constructor(readonly rejection: BundleImportRejection) {
    super(`rule bundle rejected: ${rejection.kind}`)
  }
}

export interface ReadBundleResult {
  bundle: RuleBundle
  /** True when the bundle's minor version is newer than this build supports, so unrecognized fields were dropped. */
  producedByNewerMinor: boolean
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeProviderEntry(raw: unknown): RuleProviderConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const behavior =
    typeof entry.behavior === 'string' ? entry.behavior.toLowerCase() : ''
  const interval = Number(entry.interval)
  return {
    type: entry.type === 'file' ? 'file' : 'http',
    behavior:
      behavior === 'domain'
        ? 'domain'
        : behavior === 'ipcidr'
          ? 'ipcidr'
          : 'classical',
    ...(typeof entry.url === 'string' && entry.url ? { url: entry.url } : {}),
    ...(typeof entry.path === 'string' && entry.path
      ? { path: entry.path }
      : {}),
    ...(Number.isFinite(interval) && interval > 0 ? { interval } : {}),
    ...(typeof entry.format === 'string' && entry.format
      ? { format: entry.format }
      : {}),
  }
}

function normalizeProviderMap(raw: unknown): RuleProviderConfigMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.entries(
    raw as Record<string, unknown>,
  ).reduce<RuleProviderConfigMap>((acc, [name, value]) => {
    const config = normalizeProviderEntry(value)
    if (config) acc[name] = config
    return acc
  }, {})
}

export interface BuildBundleInput {
  sequence: RuleSequence
  providers: RuleProviderConfigMap
  appVersion: string
  createdAt?: Date
}

export async function buildRuleBundle({
  sequence,
  providers,
  appVersion,
  createdAt = new Date(),
}: BuildBundleInput): Promise<Uint8Array> {
  const sequenceYaml = encodeUtf8(
    dump(
      {
        prepend: sequence.prepend,
        append: sequence.append,
        delete: sequence.delete,
      },
      { lineWidth: -1 },
    ),
  )
  const providersYaml = encodeUtf8(
    dump({ 'rule-providers': providers }, { lineWidth: -1 }),
  )

  const contents: BundleContentEntry[] = [
    {
      path: RULES_ENTRY,
      sha256: await sha256Hex(sequenceYaml),
      entryCount: countSequenceEntries(sequence),
    },
    {
      path: PROVIDERS_ENTRY,
      sha256: await sha256Hex(providersYaml),
      entryCount: Object.keys(providers).length,
    },
  ]

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    generator: { app: BUNDLE_GENERATOR_APP, version: appVersion },
    createdAt: createdAt.toISOString(),
    proxyPolicies: collectProxyPolicies(sequence),
    contents,
  }

  const entries: ZipEntry[] = [
    {
      name: MANIFEST_ENTRY,
      data: encodeUtf8(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    { name: RULES_ENTRY, data: sequenceYaml },
    { name: PROVIDERS_ENTRY, data: providersYaml },
  ]
  return createZipArchive(entries)
}

function parseManifest(bytes: Uint8Array): BundleManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(bytes))
  } catch (err) {
    throw new BundleImportError({
      kind: 'manifest-invalid',
      detail: String(err instanceof Error ? err.message : err),
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BundleImportError({
      kind: 'manifest-invalid',
      detail: 'manifest is not a JSON object',
    })
  }
  const raw = parsed as Record<string, unknown>
  const version = parseFormatVersion(raw.formatVersion)
  if (!version) {
    throw new BundleImportError({
      kind: 'manifest-invalid',
      detail: 'formatVersion is missing or not major.minor',
    })
  }
  if (version.major !== BUNDLE_FORMAT_MAJOR) {
    throw new BundleImportError({
      kind: 'format-version-unsupported',
      version: String(raw.formatVersion),
    })
  }

  const generator =
    raw.generator && typeof raw.generator === 'object'
      ? (raw.generator as Record<string, unknown>)
      : {}
  const contents = Array.isArray(raw.contents)
    ? raw.contents.reduce<BundleContentEntry[]>((acc, item) => {
        if (!item || typeof item !== 'object') return acc
        const entry = item as Record<string, unknown>
        if (
          typeof entry.path !== 'string' ||
          typeof entry.sha256 !== 'string'
        ) {
          return acc
        }
        const entryCount = Number(entry.entryCount)
        acc.push({
          path: entry.path,
          sha256: entry.sha256,
          entryCount: Number.isFinite(entryCount) ? entryCount : 0,
        })
        return acc
      }, [])
    : []

  return {
    formatVersion: `${version.major}.${version.minor}`,
    generator: {
      app: typeof generator.app === 'string' ? generator.app : '',
      version: typeof generator.version === 'string' ? generator.version : '',
    },
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    proxyPolicies: asStringArray(raw.proxyPolicies),
    contents,
  }
}

async function takeVerifiedContent(
  entries: Map<string, Uint8Array>,
  manifest: BundleManifest,
  path: string,
): Promise<Uint8Array> {
  const data = entries.get(path)
  if (!data) throw new BundleImportError({ kind: 'content-missing', path })
  const declared = manifest.contents.find((entry) => entry.path === path)
  // A manifest without the digest still identifies the file; only a digest that
  // is present and wrong means the bundle is damaged.
  if (declared && (await sha256Hex(data)) !== declared.sha256) {
    throw new BundleImportError({ kind: 'content-corrupt', path })
  }
  return data
}

function parseSequence(bytes: Uint8Array): RuleSequence {
  let parsed: unknown
  try {
    parsed = load(decodeUtf8(bytes))
  } catch (err) {
    throw new BundleImportError({
      kind: 'content-invalid',
      path: RULES_ENTRY,
      detail: String(err instanceof Error ? err.message : err),
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BundleImportError({
      kind: 'content-invalid',
      path: RULES_ENTRY,
      detail: 'rule sequence is not a YAML mapping',
    })
  }
  const raw = parsed as Record<string, unknown>
  return {
    prepend: asStringArray(raw.prepend),
    append: asStringArray(raw.append),
    delete: asStringArray(raw.delete),
  }
}

function parseProviders(bytes: Uint8Array): RuleProviderConfigMap {
  let parsed: unknown
  try {
    parsed = load(decodeUtf8(bytes))
  } catch (err) {
    throw new BundleImportError({
      kind: 'content-invalid',
      path: PROVIDERS_ENTRY,
      detail: String(err instanceof Error ? err.message : err),
    })
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BundleImportError({
      kind: 'content-invalid',
      path: PROVIDERS_ENTRY,
      detail: 'provider document is not a YAML mapping',
    })
  }
  return normalizeProviderMap(
    (parsed as Record<string, unknown>)['rule-providers'],
  )
}

/**
 * Parses a bundle without touching any profile. Every rejection happens here,
 * so a caller that receives a result is free to write the whole bundle.
 */
export async function readRuleBundle(
  bytes: Uint8Array,
): Promise<ReadBundleResult> {
  let rawEntries: ZipEntry[]
  try {
    rawEntries = await readZipArchive(bytes)
  } catch (err) {
    if (err instanceof ZipFormatError) {
      throw new BundleImportError({ kind: 'not-a-zip', detail: err.message })
    }
    throw err
  }

  const entries = new Map<string, Uint8Array>()
  for (const entry of rawEntries) {
    let normalized: string
    try {
      normalized = normalizeEntryPath(entry.name)
    } catch {
      throw new BundleImportError({
        kind: 'unsafe-entry-path',
        entryName: entry.name,
      })
    }
    entries.set(normalized, entry.data)
  }

  const manifestBytes = entries.get(MANIFEST_ENTRY)
  if (!manifestBytes) {
    throw new BundleImportError({ kind: 'manifest-missing' })
  }
  const manifest = parseManifest(manifestBytes)
  const version = parseFormatVersion(manifest.formatVersion)

  const sequence = parseSequence(
    await takeVerifiedContent(entries, manifest, RULES_ENTRY),
  )
  const providersBytes = entries.get(PROVIDERS_ENTRY)
  const providers = providersBytes
    ? parseProviders(
        await takeVerifiedContent(entries, manifest, PROVIDERS_ENTRY),
      )
    : {}

  return {
    bundle: { manifest, sequence, providers },
    producedByNewerMinor: (version?.minor ?? 0) > BUNDLE_FORMAT_MINOR,
  }
}

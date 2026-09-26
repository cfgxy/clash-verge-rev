import type { RuleProviderConfigMap } from '@/utils/rule-provider'

/**
 * Rule bundle format shared with the Android client. `formatVersion` is
 * `major.minor`: a reader refuses a bundle whose major differs, and accepts a
 * higher minor while reporting that unknown fields were ignored.
 */
export const BUNDLE_FORMAT_VERSION = '1.0'
export const BUNDLE_FORMAT_MAJOR = 1
export const BUNDLE_FORMAT_MINOR = 0

export const MANIFEST_ENTRY = 'manifest.json'
export const RULES_ENTRY = 'rules/sequence.yaml'
export const PROVIDERS_ENTRY = 'providers/providers.yaml'

export const BUNDLE_GENERATOR_APP = 'clash-verge-rev'

/** The three arrays a merge file uses to override the subscription's rules. */
export interface RuleSequence {
  prepend: string[]
  append: string[]
  delete: string[]
}

export interface BundleContentEntry {
  path: string
  sha256: string
  entryCount: number
}

export interface BundleManifest {
  formatVersion: string
  generator: { app: string; version: string }
  createdAt: string
  /** Every proxy policy the bundled rules reference, so the importer can build the mapping UI without parsing rules first. */
  proxyPolicies: string[]
  contents: BundleContentEntry[]
}

export interface RuleBundle {
  manifest: BundleManifest
  sequence: RuleSequence
  providers: RuleProviderConfigMap
}

export interface ParsedFormatVersion {
  major: number
  minor: number
}

export function parseFormatVersion(
  raw: unknown,
): ParsedFormatVersion | undefined {
  if (typeof raw !== 'string') return undefined
  const match = /^(\d+)\.(\d+)$/u.exec(raw.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

export const EMPTY_SEQUENCE: RuleSequence = {
  prepend: [],
  append: [],
  delete: [],
}

export function isSequenceEmpty(sequence: RuleSequence): boolean {
  return (
    sequence.prepend.length === 0 &&
    sequence.append.length === 0 &&
    sequence.delete.length === 0
  )
}

export function countSequenceEntries(sequence: RuleSequence): number {
  return (
    sequence.prepend.length + sequence.append.length + sequence.delete.length
  )
}

/**
 * A rule line's last field is its proxy policy, except for `no-resolve`, which
 * trails the policy on rule types that support it.
 */
export function extractProxyPolicy(ruleLine: string): string | undefined {
  const fields = ruleLine.split(',').map((field) => field.trim())
  if (fields.length < 2) return undefined
  const last = fields[fields.length - 1]
  const policy =
    last.toLowerCase() === 'no-resolve' ? fields[fields.length - 2] : last
  return policy || undefined
}

/**
 * Policies referenced by the rules that will be written on import. `delete`
 * entries are matched against the subscription's own rules rather than added,
 * so they never need a local policy to exist.
 */
export function collectProxyPolicies(sequence: RuleSequence): string[] {
  const policies = new Set<string>()
  for (const line of [...sequence.prepend, ...sequence.append]) {
    const policy = extractProxyPolicy(line)
    if (policy) policies.add(policy)
  }
  return [...policies].sort()
}

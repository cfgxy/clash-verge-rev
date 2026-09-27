import {
  extractProxyPolicy,
  type RuleSequence,
} from '@/utils/rule-bundle/format'
import {
  findReferencingRuleLineIndices,
  findUnremovableReferenceLineIndices,
  type RuleProviderConfigMap,
} from '@/utils/rule-provider'

/** What the user chose to do with a bundled provider whose name already exists. */
export type ProviderConflictResolution =
  | { action: 'overwrite' }
  | { action: 'skip' }
  | { action: 'rename'; newName: string }

interface ProviderConflict {
  name: string
  /** Rule lines in the bundle that reference this provider, so skipping can name them. */
  referencingRules: string[]
}

export interface PolicyMappingTarget {
  /** Policy name as written in the bundle. */
  sourcePolicy: string
  /** Local policy it maps to, or undefined while the user has not chosen one. */
  targetPolicy?: string
}

export interface ImportPreparation {
  /** One entry per distinct policy the bundle's added rules reference. */
  policyMappings: PolicyMappingTarget[]
  providerConflicts: ProviderConflict[]
}

/**
 * Bundle rule lines that reference `name`, including logical rules that embed
 * the reference inside their payload. Reuses the merge-file reference lookups so
 * the import dialog and the provider delete dialog agree on what counts as a
 * reference.
 */
export function findBundleRuleSetReferences(
  sequence: RuleSequence,
  name: string,
): string[] {
  const lines = [...sequence.prepend, ...sequence.append, ...sequence.delete]
  const indices = new Set([
    ...findReferencingRuleLineIndices(lines, name),
    ...findUnremovableReferenceLineIndices(lines, name),
  ])
  return [...indices].sort((a, b) => a - b).map((index) => lines[index])
}

/**
 * Builds the decisions the user has to make before anything is written:
 * which local policy each bundled policy maps to, and what to do with
 * providers whose names already exist locally. Same-name policies are
 * pre-selected so only genuine mismatches need attention.
 */
export function prepareImport(
  sequence: RuleSequence,
  bundleProviders: RuleProviderConfigMap,
  localPolicies: string[],
  localProviderNames: string[],
): ImportPreparation {
  const localPolicySet = new Set(localPolicies)
  const policies = new Set<string>()
  for (const line of [...sequence.prepend, ...sequence.append]) {
    const policy = extractProxyPolicy(line)
    if (policy) policies.add(policy)
  }

  const policyMappings = [...policies].sort().map((sourcePolicy) => ({
    sourcePolicy,
    ...(localPolicySet.has(sourcePolicy) ? { targetPolicy: sourcePolicy } : {}),
  }))

  const localProviderSet = new Set(localProviderNames)
  const providerConflicts = Object.keys(bundleProviders)
    .filter((name) => localProviderSet.has(name))
    .sort()
    .map((name) => ({
      name,
      referencingRules: findBundleRuleSetReferences(sequence, name),
    }))

  return { policyMappings, providerConflicts }
}

export function isMappingComplete(mappings: PolicyMappingTarget[]): boolean {
  return mappings.every((mapping) => Boolean(mapping.targetPolicy))
}

export function findInvalidProviderRenames(
  actions: Record<string, ProviderConflictResolution['action']>,
  newNames: Record<string, string>,
  takenNames: string[],
): string[] {
  const taken = new Set(takenNames)
  const targets = Object.entries(actions)
    .filter(([, action]) => action === 'rename')
    .map(([name]) => [name, (newNames[name] ?? '').trim()] as const)
  const counts = new Map<string, number>()
  for (const [, target] of targets) {
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  return targets
    .filter(
      ([, target]) => !target || taken.has(target) || counts.get(target)! > 1,
    )
    .map(([name]) => name)
}

/** Replaces the policy field of a rule line, leaving a trailing `no-resolve` in place. */
export function applyPolicyToRuleLine(
  ruleLine: string,
  policyMap: Map<string, string>,
): string {
  const fields = ruleLine.split(',')
  if (fields.length < 2) return ruleLine
  const lastIndex = fields.length - 1
  const policyIndex =
    fields[lastIndex].trim().toLowerCase() === 'no-resolve'
      ? lastIndex - 1
      : lastIndex
  if (policyIndex < 1) return ruleLine
  const current = fields[policyIndex].trim()
  const mapped = policyMap.get(current)
  if (!mapped || mapped === current) return ruleLine
  fields[policyIndex] = mapped
  return fields.join(',')
}

/** Rewrites a `RULE-SET,<name>` reference, including inside logical rule payloads. */
export function applyProviderRenameToRuleLine(
  ruleLine: string,
  renames: Map<string, string>,
): string {
  if (renames.size === 0) return ruleLine
  return ruleLine.replace(
    /(^|[^A-Za-z0-9_.-])(RULE-SET\s*,\s*)([^,)]+)/gu,
    (match, prefix: string, keyword: string, name: string) => {
      const renamed = renames.get(name.trim())
      return renamed ? `${prefix}${keyword}${renamed}` : match
    },
  )
}

export interface ResolvedImport {
  providerResolutions: Map<string, ProviderConflictResolution>
  policyMap: Map<string, string>
}

export interface MergeResult {
  sequence: RuleSequence
  providers: RuleProviderConfigMap
}

export interface ScopedMergeResult {
  sequence: RuleSequence
  profileProviders: RuleProviderConfigMap
  globalProviders: RuleProviderConfigMap
}

function mergeRuleList(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing)
  const merged = [...existing]
  for (const line of incoming) {
    if (seen.has(line)) continue
    seen.add(line)
    merged.push(line)
  }
  return merged
}

/** 先映射与改名再去重，避免把映射后相同的规则重复写入。 */
function mergeSequence(
  current: RuleSequence,
  incoming: RuleSequence,
  resolved: ResolvedImport,
): RuleSequence {
  const renames = new Map<string, string>()
  for (const [name, resolution] of resolved.providerResolutions) {
    if (resolution.action === 'rename') renames.set(name, resolution.newName)
  }

  // A policy the user left unmapped has no local counterpart, so writing the
  // rule would make the kernel reject the config: drop the rule instead.
  const mapped = (line: string) => {
    const policy = extractProxyPolicy(line)
    return !policy || resolved.policyMap.has(policy)
  }

  const rewrite = (line: string) =>
    applyProviderRenameToRuleLine(
      applyPolicyToRuleLine(line, resolved.policyMap),
      renames,
    )

  return {
    prepend: mergeRuleList(
      current.prepend,
      incoming.prepend.filter(mapped).map(rewrite),
    ),
    append: mergeRuleList(
      current.append,
      incoming.append.filter(mapped).map(rewrite),
    ),
    // `delete` 匹配订阅原始规则行，不参与策略映射或规则集改名。
    delete: mergeRuleList(current.delete, incoming.delete),
  }
}

function mergeProviders(
  current: RuleProviderConfigMap,
  incoming: RuleProviderConfigMap,
  resolved: ResolvedImport,
): RuleProviderConfigMap {
  const providers: RuleProviderConfigMap = { ...current }
  for (const [name, config] of Object.entries(incoming)) {
    const resolution = resolved.providerResolutions.get(name)
    if (resolution?.action === 'skip') continue
    if (resolution?.action === 'rename') {
      providers[resolution.newName] = config
      continue
    }
    providers[name] = config
  }
  return providers
}

export function mergeBundleIntoMerge(
  current: RuleSequence,
  currentProviders: RuleProviderConfigMap,
  bundle: { sequence: RuleSequence; providers: RuleProviderConfigMap },
  resolved: ResolvedImport,
): MergeResult {
  return {
    sequence: mergeSequence(current, bundle.sequence, resolved),
    providers: mergeProviders(currentProviders, bundle.providers, resolved),
  }
}

export function mergeScopedBundle(
  current: RuleSequence,
  currentProfileProviders: RuleProviderConfigMap,
  currentGlobalProviders: RuleProviderConfigMap,
  bundle: {
    sequence: RuleSequence
    profileProviders: RuleProviderConfigMap
    globalProviders: RuleProviderConfigMap
  },
  resolved: ResolvedImport,
): ScopedMergeResult {
  return {
    sequence: mergeSequence(current, bundle.sequence, resolved),
    profileProviders: mergeProviders(
      currentProfileProviders,
      bundle.profileProviders,
      resolved,
    ),
    globalProviders: mergeProviders(
      currentGlobalProviders,
      bundle.globalProviders,
      resolved,
    ),
  }
}

import type { Rule } from 'tauri-plugin-mihomo-api'

export type RuleProviderSourceType = 'http' | 'file'
export type RuleProviderBehavior = 'domain' | 'ipcidr' | 'classical'

export interface RuleProviderConfig {
  type: RuleProviderSourceType
  behavior: RuleProviderBehavior
  url?: string
  path?: string
  interval?: number
  format?: string
}

export type RuleProviderConfigMap = Record<string, RuleProviderConfig>

/**
 * Matches a `RULE-SET,<name>` reference anywhere in a rule expression,
 * including inside a logical rule's nested payload such as
 * `((RULE-SET,foo),(DST-PORT,443))`.
 */
function buildReferencePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    `(^|[^A-Za-z0-9_.-])RULE-SET\\s*,\\s*${escaped}\\s*($|[,)])`,
    'u',
  )
}

/**
 * Live reference count comes from the running mihomo `rules` list (all
 * merge layers already applied), so it always reflects the effective
 * config even though CRUD writes below are scoped to a single merge file.
 *
 * Logical rules (`AND`/`OR`/`NOT`) keep their nested expression in
 * `payload` instead of surfacing as `RuleSet`, so those are matched
 * textually — missing them would let the delete dialog claim the provider
 * is unreferenced and leave a dangling `RULE-SET` behind.
 */
export function findRuleProviderReferences(
  rules: Rule[] | undefined,
  name: string,
): number {
  if (!rules) return 0
  const pattern = buildReferencePattern(name)
  return rules.filter((rule) => {
    if (rule.type === 'RuleSet') return rule.payload === name
    return typeof rule.payload === 'string' && pattern.test(rule.payload)
  }).length
}

/**
 * Normalizes a `rule-providers` entry read from any config layer into the
 * shape the edit form binds to. Unknown or missing fields are dropped so the
 * form falls back to its own defaults instead of showing bogus values.
 */
export function normalizeProviderConfig(
  raw: unknown,
): RuleProviderConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>

  const type: RuleProviderSourceType =
    entry.type === 'file' ? 'file' : entry.type === 'http' ? 'http' : 'http'
  const behaviorText =
    typeof entry.behavior === 'string' ? entry.behavior.toLowerCase() : ''
  const behavior: RuleProviderBehavior =
    behaviorText === 'domain'
      ? 'domain'
      : behaviorText === 'ipcidr'
        ? 'ipcidr'
        : 'classical'

  const interval = Number(entry.interval)

  return {
    type,
    behavior,
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

/**
 * Resolves a provider declaration across config layers using mihomo's own
 * precedence (global merge overrides the subscription merge, which overrides
 * the base profile), so editing a provider declared outside the current merge
 * file still prefills the values actually in effect.
 */
export function resolveDeclaredProviderConfig(
  layers: Array<RuleProviderConfigMap | Record<string, unknown> | undefined>,
  name: string,
): RuleProviderConfig | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const entry = layers[i]?.[name]
    const normalized = normalizeProviderConfig(entry)
    if (normalized) return normalized
  }
  return undefined
}

export function isDuplicateProviderName(
  providers: RuleProviderConfigMap | undefined,
  name: string,
  excludeName?: string,
): boolean {
  if (!providers) return false
  return Object.keys(providers).some(
    (key) => key === name && key !== excludeName,
  )
}

export function upsertRuleProvider(
  providers: RuleProviderConfigMap | undefined,
  name: string,
  config: RuleProviderConfig,
): RuleProviderConfigMap {
  return { ...(providers ?? {}), [name]: config }
}

export function removeRuleProvider(
  providers: RuleProviderConfigMap | undefined,
  name: string,
): RuleProviderConfigMap | undefined {
  if (!providers || !(name in providers)) return providers
  const { [name]: _removed, ...rest } = providers
  return rest
}

/** Matches `RULE-SET,<name>,<policy>[,no-resolve]` config-level rule lines. */
function isRuleSetReferenceLine(line: string, name: string): boolean {
  const parts = line.split(',').map((part) => part.trim())
  return parts[0] === 'RULE-SET' && parts[1] === name
}

export function findReferencingRuleLineIndices(
  rulesConfig: string[] | undefined,
  name: string,
): number[] {
  if (!rulesConfig) return []
  return rulesConfig.reduce<number[]>((acc, line, index) => {
    if (isRuleSetReferenceLine(line, name)) acc.push(index)
    return acc
  }, [])
}

/**
 * Lines that reference the provider but are not a plain `RULE-SET` rule —
 * typically a logical rule embedding it. Dropping such a line would also
 * drop unrelated conditions, so deletion is refused instead.
 */
export function findUnremovableReferenceLineIndices(
  rulesConfig: string[] | undefined,
  name: string,
): number[] {
  if (!rulesConfig) return []
  const pattern = buildReferencePattern(name)
  return rulesConfig.reduce<number[]>((acc, line, index) => {
    if (isRuleSetReferenceLine(line, name)) return acc
    if (pattern.test(line)) acc.push(index)
    return acc
  }, [])
}

export function clearRuleReferences(
  rulesConfig: string[] | undefined,
  name: string,
): string[] {
  if (!rulesConfig) return []
  return rulesConfig.filter((line) => !isRuleSetReferenceLine(line, name))
}

export type ProviderDeletePlan =
  /** The provider is not declared in the merge file being edited, so deleting it here would write nothing while looking like it succeeded. */
  | { action: 'reject'; reason: 'out-of-scope' }
  /** Deletion is irreversible, so it always goes through the dialog whose default action is cancel. */
  | { action: 'confirm'; liveReferenceCount: number }

export function isProviderInMergeScope(
  providers: RuleProviderConfigMap | undefined,
  name: string,
): boolean {
  return Boolean(providers) && name in providers!
}

export function planProviderDeletion(
  providers: RuleProviderConfigMap | undefined,
  name: string,
  liveReferenceCount: number,
): ProviderDeletePlan {
  if (!isProviderInMergeScope(providers, name)) {
    return { action: 'reject', reason: 'out-of-scope' }
  }
  return { action: 'confirm', liveReferenceCount }
}

export type ClearAndDeleteBlocker =
  /** Some live references sit outside this subscription's own merge file (base profile or global merge). */
  | 'out-of-scope-reference'
  /** A logical rule embeds the provider; dropping that line would also drop its unrelated conditions. */
  | 'unremovable-reference'

export interface ClearAndDeleteOutcome {
  /**
   * false when clearing this merge file alone cannot make the provider safe
   * to delete, so the caller must refuse the deletion rather than silently
   * leaving broken references behind.
   */
  canDelete: boolean
  blocker?: ClearAndDeleteBlocker
  /**
   * true when clearing the references empties the merge file's own `rules:`
   * key, which drops the whole rule override and silently falls back to the
   * subscription's original rules — the user must be told before confirming.
   */
  dropsRuleOverride: boolean
  nextRulesConfig: string[]
  nextProviders: RuleProviderConfigMap | undefined
}

export function resolveClearAndDelete(
  mergeRulesConfig: string[] | undefined,
  liveReferenceCount: number,
  providers: RuleProviderConfigMap | undefined,
  name: string,
): ClearAndDeleteOutcome {
  const unremovableCount = findUnremovableReferenceLineIndices(
    mergeRulesConfig,
    name,
  ).length
  if (unremovableCount > 0) {
    return {
      canDelete: false,
      blocker: 'unremovable-reference',
      dropsRuleOverride: false,
      nextRulesConfig: mergeRulesConfig ?? [],
      nextProviders: providers,
    }
  }

  const mergeReferenceCount = findReferencingRuleLineIndices(
    mergeRulesConfig,
    name,
  ).length

  if (mergeReferenceCount !== liveReferenceCount) {
    return {
      canDelete: false,
      blocker: 'out-of-scope-reference',
      dropsRuleOverride: false,
      nextRulesConfig: mergeRulesConfig ?? [],
      nextProviders: providers,
    }
  }

  const nextRulesConfig = clearRuleReferences(mergeRulesConfig, name)

  return {
    canDelete: true,
    dropsRuleOverride:
      (mergeRulesConfig?.length ?? 0) > 0 && nextRulesConfig.length === 0,
    nextRulesConfig,
    nextProviders: removeRuleProvider(providers, name),
  }
}

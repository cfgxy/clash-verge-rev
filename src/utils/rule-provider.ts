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
 * Live reference count comes from the running mihomo `rules` list (all
 * merge layers already applied), so it always reflects the effective
 * config even though CRUD writes below are scoped to a single merge file.
 */
export function findRuleProviderReferences(
  rules: Rule[] | undefined,
  name: string,
): number {
  if (!rules) return 0
  return rules.filter(
    (rule) => rule.type === 'RuleSet' && rule.payload === name,
  ).length
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

export interface ClearAndDeleteOutcome {
  /**
   * false when some live references live outside the current subscription's
   * own merge file (e.g. base profile or global merge) — clearing the merge
   * file alone cannot make the provider safe to delete, so the caller must
   * refuse the deletion rather than silently leaving broken references.
   */
  canDelete: boolean
  nextRulesConfig: string[]
  nextProviders: RuleProviderConfigMap | undefined
}

export function resolveClearAndDelete(
  mergeRulesConfig: string[] | undefined,
  liveReferenceCount: number,
  providers: RuleProviderConfigMap | undefined,
  name: string,
): ClearAndDeleteOutcome {
  const mergeReferenceCount = findReferencingRuleLineIndices(
    mergeRulesConfig,
    name,
  ).length

  if (mergeReferenceCount !== liveReferenceCount) {
    return {
      canDelete: false,
      nextRulesConfig: mergeRulesConfig ?? [],
      nextProviders: providers,
    }
  }

  return {
    canDelete: true,
    nextRulesConfig: clearRuleReferences(mergeRulesConfig, name),
    nextProviders: removeRuleProvider(providers, name),
  }
}

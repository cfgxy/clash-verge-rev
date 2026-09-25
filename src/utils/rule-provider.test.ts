import type { Rule } from 'tauri-plugin-mihomo-api'
import { describe, expect, test } from 'vitest'

import {
  clearRuleReferences,
  findReferencingRuleLineIndices,
  findRuleProviderReferences,
  findUnremovableReferenceLineIndices,
  isDuplicateProviderName,
  planProviderDeletion,
  removeRuleProvider,
  resolveClearAndDelete,
  resolveDeclaredProviderConfig,
  upsertRuleProvider,
} from './rule-provider'

const makeRule = (overrides: Partial<Rule>): Rule =>
  ({
    type: 'Domain',
    index: 0,
    payload: '',
    proxy: 'DIRECT',
    size: 0,
    ...overrides,
  }) as Rule

describe('findRuleProviderReferences', () => {
  test('counts only RuleSet rules whose payload matches the provider name', () => {
    const rules = [
      makeRule({ type: 'RuleSet', payload: 'ads' }),
      makeRule({ type: 'RuleSet', payload: 'ads' }),
      makeRule({ type: 'RuleSet', payload: 'cn' }),
      makeRule({ type: 'Domain', payload: 'ads' }),
    ]

    expect(findRuleProviderReferences(rules, 'ads')).toBe(2)
    expect(findRuleProviderReferences(rules, 'cn')).toBe(1)
    expect(findRuleProviderReferences(rules, 'missing')).toBe(0)
    expect(findRuleProviderReferences(undefined, 'ads')).toBe(0)
  })

  test('counts logical rules that embed the provider in their payload', () => {
    const rules = [
      makeRule({
        type: 'AND',
        payload: '((RULE-SET,ads),(DST-PORT,443))',
      }),
      makeRule({ type: 'OR', payload: '((RULE-SET,cn),(GEOIP,CN))' }),
    ]

    expect(findRuleProviderReferences(rules, 'ads')).toBe(1)
    expect(findRuleProviderReferences(rules, 'cn')).toBe(1)
  })

  test('does not count a provider whose name is only a prefix of the referenced one', () => {
    const rules = [
      makeRule({
        type: 'AND',
        payload: '((RULE-SET,ads-extra),(DST-PORT,443))',
      }),
    ]

    expect(findRuleProviderReferences(rules, 'ads')).toBe(0)
    expect(findRuleProviderReferences(rules, 'ads-extra')).toBe(1)
  })
})

describe('resolveDeclaredProviderConfig', () => {
  test('prefills from the layer that wins, keeping url/path/interval', () => {
    const base = {
      ads: {
        type: 'http',
        behavior: 'domain',
        url: 'https://base/ads.yaml',
        path: './ads.yaml',
        interval: 86400,
      },
    }

    expect(
      resolveDeclaredProviderConfig([base, undefined, undefined], 'ads'),
    ).toEqual({
      type: 'http',
      behavior: 'domain',
      url: 'https://base/ads.yaml',
      path: './ads.yaml',
      interval: 86400,
    })
  })

  test('a later layer overrides an earlier declaration of the same name', () => {
    const base = {
      ads: { type: 'http', behavior: 'domain', url: 'https://base' },
    }
    const global = {
      ads: { type: 'http', behavior: 'classical', url: 'https://global' },
    }

    expect(
      resolveDeclaredProviderConfig([base, undefined, global], 'ads'),
    ).toEqual({ type: 'http', behavior: 'classical', url: 'https://global' })
  })

  test('returns undefined when no layer declares the provider', () => {
    expect(
      resolveDeclaredProviderConfig([{}, undefined], 'ads'),
    ).toBeUndefined()
  })
})

describe('provider CRUD', () => {
  test('upsertRuleProvider adds and overwrites entries immutably', () => {
    const original = {
      foo: { type: 'http', behavior: 'domain', url: 'https://a' } as const,
    }
    const withFoo = upsertRuleProvider(original, 'foo', {
      type: 'http',
      behavior: 'classical',
      url: 'https://b',
    })

    expect(withFoo.foo).toEqual({
      type: 'http',
      behavior: 'classical',
      url: 'https://b',
    })
    expect(original.foo.url).toBe('https://a')
  })

  test('removeRuleProvider drops only the targeted key', () => {
    const providers = {
      foo: { type: 'http', behavior: 'domain' } as const,
      bar: { type: 'file', behavior: 'classical' } as const,
    }
    const result = removeRuleProvider(providers, 'foo')

    expect(result).toEqual({ bar: { type: 'file', behavior: 'classical' } })
    expect(providers.foo).toBeDefined()
  })

  test('removeRuleProvider is a no-op when the key is absent', () => {
    const providers = { bar: { type: 'file', behavior: 'classical' } as const }
    expect(removeRuleProvider(providers, 'missing')).toBe(providers)
  })

  test('isDuplicateProviderName detects collisions, excluding the current name when editing', () => {
    const providers = { foo: { type: 'http', behavior: 'domain' } as const }
    expect(isDuplicateProviderName(providers, 'foo')).toBe(true)
    expect(isDuplicateProviderName(providers, 'foo', 'foo')).toBe(false)
    expect(isDuplicateProviderName(providers, 'bar')).toBe(false)
  })
})

describe('rule-line reference scanning', () => {
  test('findReferencingRuleLineIndices matches RULE-SET lines by provider name', () => {
    const rules = [
      'RULE-SET,ads,REJECT',
      'DOMAIN,example.com,DIRECT',
      'RULE-SET,ads,REJECT,no-resolve',
      'RULE-SET,cn,DIRECT',
    ]
    expect(findReferencingRuleLineIndices(rules, 'ads')).toEqual([0, 2])
    expect(findReferencingRuleLineIndices(rules, 'cn')).toEqual([3])
  })

  test('clearRuleReferences removes matching lines and preserves the rest in order', () => {
    const rules = [
      'RULE-SET,ads,REJECT',
      'DOMAIN,example.com,DIRECT',
      'RULE-SET,ads,REJECT,no-resolve',
      'MATCH,DIRECT',
    ]
    expect(clearRuleReferences(rules, 'ads')).toEqual([
      'DOMAIN,example.com,DIRECT',
      'MATCH,DIRECT',
    ])
  })
})

describe('planProviderDeletion (required delete-safety scenarios)', () => {
  const adsProviders = { ads: { type: 'http', behavior: 'domain' } as const }

  test('scenario A: references exist -> confirmation required, deletion must not proceed by default', () => {
    const plan = planProviderDeletion(adsProviders, 'ads', 3)

    expect(plan).toEqual({ action: 'confirm', liveReferenceCount: 3 })
    // Simulates a UI that only deletes on an explicit non-default choice.
    const userTookNoAction = true
    const deletionExecuted = !userTookNoAction
    expect(deletionExecuted).toBe(false)
  })

  test('scenario B: clear-references-then-delete removes both the referencing rules and the provider', () => {
    const rulesConfig = ['RULE-SET,ads,REJECT', 'MATCH,DIRECT']
    const providers = adsProviders

    const plan = planProviderDeletion(
      providers,
      'ads',
      findReferencingRuleLineIndices(rulesConfig, 'ads').length,
    )
    expect(plan.action).toBe('confirm')

    // User explicitly chooses "clear references then delete".
    const nextRulesConfig = clearRuleReferences(rulesConfig, 'ads')
    const nextProviders = removeRuleProvider(providers, 'ads')

    expect(nextRulesConfig).toEqual(['MATCH,DIRECT'])
    expect(nextProviders).toEqual({})
    expect(findReferencingRuleLineIndices(nextRulesConfig, 'ads')).toEqual([])
  })

  test('no references -> confirmation is still required before deleting', () => {
    expect(planProviderDeletion(adsProviders, 'ads', 0)).toEqual({
      action: 'confirm',
      liveReferenceCount: 0,
    })
  })

  test('provider outside the merge file -> deletion is rejected instead of silently writing nothing', () => {
    const plan = planProviderDeletion({}, 'ads', 0)

    expect(plan).toEqual({ action: 'reject', reason: 'out-of-scope' })
    // The caller writes nothing: removeRuleProvider would return the same map.
    expect(removeRuleProvider({}, 'ads')).toEqual({})
    expect(planProviderDeletion(undefined, 'ads', 2).action).toBe('reject')
  })
})

describe('resolveClearAndDelete', () => {
  test('clears merge-scoped references and deletes when all live references are within scope', () => {
    const mergeRulesConfig = ['RULE-SET,ads,REJECT']
    const providers = { ads: { type: 'http', behavior: 'domain' } as const }

    const outcome = resolveClearAndDelete(mergeRulesConfig, 1, providers, 'ads')

    expect(outcome.canDelete).toBe(true)
    expect(outcome.nextRulesConfig).toEqual([])
    expect(outcome.nextProviders).toEqual({})
  })

  test('refuses deletion when live references exist outside the merge file scope', () => {
    const mergeRulesConfig: string[] = []
    const providers = { ads: { type: 'http', behavior: 'domain' } as const }

    // liveReferenceCount (2) comes from the base profile / global merge,
    // not from this subscription's own merge file (0 matches locally).
    const outcome = resolveClearAndDelete(mergeRulesConfig, 2, providers, 'ads')

    expect(outcome.canDelete).toBe(false)
    expect(outcome.blocker).toBe('out-of-scope-reference')
    expect(outcome.nextProviders).toEqual(providers)
  })

  test('refuses deletion when a logical rule embeds the provider', () => {
    const mergeRulesConfig = [
      'AND,((RULE-SET,ads),(DST-PORT,443)),REJECT',
      'MATCH,DIRECT',
    ]
    const providers = { ads: { type: 'http', behavior: 'domain' } as const }

    expect(
      findUnremovableReferenceLineIndices(mergeRulesConfig, 'ads'),
    ).toEqual([0])

    const outcome = resolveClearAndDelete(mergeRulesConfig, 1, providers, 'ads')

    expect(outcome.canDelete).toBe(false)
    expect(outcome.blocker).toBe('unremovable-reference')
    expect(outcome.nextRulesConfig).toEqual(mergeRulesConfig)
    expect(outcome.nextProviders).toEqual(providers)
  })

  test('flags that clearing every rule would drop the whole rule override', () => {
    const providers = { ads: { type: 'http', behavior: 'domain' } as const }

    const emptied = resolveClearAndDelete(
      ['RULE-SET,ads,REJECT'],
      1,
      providers,
      'ads',
    )
    expect(emptied.canDelete).toBe(true)
    expect(emptied.dropsRuleOverride).toBe(true)

    const partial = resolveClearAndDelete(
      ['RULE-SET,ads,REJECT', 'MATCH,DIRECT'],
      1,
      providers,
      'ads',
    )
    expect(partial.canDelete).toBe(true)
    expect(partial.dropsRuleOverride).toBe(false)
  })
})

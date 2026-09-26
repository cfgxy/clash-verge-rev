import { describe, expect, it } from 'vitest'

import type { RuleProviderConfigMap } from '@/utils/rule-provider'

import { type RuleSequence } from './format'
import {
  applyPolicyToRuleLine,
  applyProviderRenameToRuleLine,
  findBundleRuleSetReferences,
  isMappingComplete,
  mergeBundleIntoMerge,
  prepareImport,
  type ResolvedImport,
} from './import-plan'

const sequence: RuleSequence = {
  prepend: ['DOMAIN-SUFFIX,example.com,Source Proxy', 'RULE-SET,ads,REJECT'],
  append: ['GEOIP,CN,Domestic,no-resolve'],
  delete: ['MATCH,DIRECT'],
}

const bundleProviders: RuleProviderConfigMap = {
  ads: {
    type: 'http',
    behavior: 'domain',
    url: 'https://example.com/ads.yaml',
  },
  cn: { type: 'http', behavior: 'ipcidr', url: 'https://example.com/cn.yaml' },
}

describe('prepareImport', () => {
  it('pre-selects policies that exist locally and leaves mismatches open', () => {
    const { policyMappings } = prepareImport(
      sequence,
      {},
      ['DIRECT', 'REJECT', 'Domestic'],
      [],
    )

    expect(policyMappings).toEqual([
      { sourcePolicy: 'Domestic', targetPolicy: 'Domestic' },
      { sourcePolicy: 'REJECT', targetPolicy: 'REJECT' },
      { sourcePolicy: 'Source Proxy' },
    ])
    expect(isMappingComplete(policyMappings)).toBe(false)
  })

  it('ignores policies that only appear in delete entries', () => {
    const { policyMappings } = prepareImport(
      { prepend: [], append: [], delete: ['MATCH,Legacy Group'] },
      {},
      [],
      [],
    )

    expect(policyMappings).toEqual([])
    expect(isMappingComplete(policyMappings)).toBe(true)
  })

  it('reports same-name providers as conflicts with their referencing rules', () => {
    const { providerConflicts } = prepareImport(
      sequence,
      bundleProviders,
      [],
      ['ads'],
    )

    expect(providerConflicts).toEqual([
      { name: 'ads', referencingRules: ['RULE-SET,ads,REJECT'] },
    ])
  })
})

describe('findBundleRuleSetReferences', () => {
  it('finds references nested inside logical rules', () => {
    const withLogical: RuleSequence = {
      prepend: ['AND,((RULE-SET,ads),(DST-PORT,443)),REJECT'],
      append: ['RULE-SET,ads,REJECT'],
      delete: [],
    }

    expect(findBundleRuleSetReferences(withLogical, 'ads')).toEqual([
      'AND,((RULE-SET,ads),(DST-PORT,443)),REJECT',
      'RULE-SET,ads,REJECT',
    ])
  })

  it('does not match a provider whose name is only a prefix', () => {
    const lines: RuleSequence = {
      prepend: ['RULE-SET,ads-extra,REJECT'],
      append: [],
      delete: [],
    }

    expect(findBundleRuleSetReferences(lines, 'ads')).toEqual([])
  })
})

describe('applyPolicyToRuleLine', () => {
  const policyMap = new Map([['Source Proxy', 'Local Proxy']])

  it('rewrites the policy field', () => {
    expect(
      applyPolicyToRuleLine(
        'DOMAIN-SUFFIX,example.com,Source Proxy',
        policyMap,
      ),
    ).toBe('DOMAIN-SUFFIX,example.com,Local Proxy')
  })

  it('keeps a trailing no-resolve in place', () => {
    expect(
      applyPolicyToRuleLine('GEOIP,CN,Source Proxy,no-resolve', policyMap),
    ).toBe('GEOIP,CN,Local Proxy,no-resolve')
  })

  it('rewrites a MATCH rule whose policy is its only other field', () => {
    expect(applyPolicyToRuleLine('MATCH,Source Proxy', policyMap)).toBe(
      'MATCH,Local Proxy',
    )
  })

  it('leaves unmapped policies untouched', () => {
    expect(applyPolicyToRuleLine('DOMAIN,a.com,REJECT', policyMap)).toBe(
      'DOMAIN,a.com,REJECT',
    )
  })
})

describe('applyProviderRenameToRuleLine', () => {
  const renames = new Map([['ads', 'ads-imported']])

  it('rewrites a plain RULE-SET reference', () => {
    expect(applyProviderRenameToRuleLine('RULE-SET,ads,REJECT', renames)).toBe(
      'RULE-SET,ads-imported,REJECT',
    )
  })

  it('rewrites a reference nested in a logical rule', () => {
    expect(
      applyProviderRenameToRuleLine(
        'AND,((RULE-SET,ads),(DST-PORT,443)),REJECT',
        renames,
      ),
    ).toBe('AND,((RULE-SET,ads-imported),(DST-PORT,443)),REJECT')
  })

  it('leaves a name that merely shares a prefix untouched', () => {
    expect(
      applyProviderRenameToRuleLine('RULE-SET,ads-extra,REJECT', renames),
    ).toBe('RULE-SET,ads-extra,REJECT')
  })
})

describe('mergeBundleIntoMerge', () => {
  const resolved: ResolvedImport = {
    providerResolutions: new Map(),
    policyMap: new Map([
      ['Source Proxy', 'Local Proxy'],
      ['Domestic', 'Domestic'],
      ['REJECT', 'REJECT'],
    ]),
  }

  it('appends imported rules after the existing ones', () => {
    const result = mergeBundleIntoMerge(
      { prepend: ['DOMAIN,existing.com,DIRECT'], append: [], delete: [] },
      {},
      { sequence, providers: bundleProviders },
      resolved,
    )

    expect(result.sequence.prepend).toEqual([
      'DOMAIN,existing.com,DIRECT',
      'DOMAIN-SUFFIX,example.com,Local Proxy',
      'RULE-SET,ads,REJECT',
    ])
    expect(result.sequence.append).toEqual(['GEOIP,CN,Domestic,no-resolve'])
    expect(result.sequence.delete).toEqual(['MATCH,DIRECT'])
    expect(result.providers).toEqual(bundleProviders)
  })

  it('skips a rule that is identical after the policy mapping', () => {
    const result = mergeBundleIntoMerge(
      {
        prepend: ['DOMAIN-SUFFIX,example.com,Local Proxy'],
        append: [],
        delete: [],
      },
      {},
      { sequence, providers: {} },
      resolved,
    )

    expect(result.sequence.prepend).toEqual([
      'DOMAIN-SUFFIX,example.com,Local Proxy',
      'RULE-SET,ads,REJECT',
    ])
  })

  it('writes nothing for a rule whose policy was left unmapped', () => {
    const result = mergeBundleIntoMerge(
      { prepend: [], append: [], delete: [] },
      {},
      { sequence, providers: {} },
      {
        providerResolutions: new Map(),
        policyMap: new Map([['REJECT', 'REJECT']]),
      },
    )

    expect(result.sequence.prepend).toEqual(['RULE-SET,ads,REJECT'])
    expect(result.sequence.append).toEqual([])
  })

  it('overwrites a same-name provider when asked to', () => {
    const result = mergeBundleIntoMerge(
      { prepend: [], append: [], delete: [] },
      { ads: { type: 'file', behavior: 'classical', path: './ads.yaml' } },
      {
        sequence: { prepend: [], append: [], delete: [] },
        providers: bundleProviders,
      },
      {
        ...resolved,
        providerResolutions: new Map([['ads', { action: 'overwrite' }]]),
      },
    )

    expect(result.providers.ads).toEqual(bundleProviders.ads)
  })

  it('keeps the local provider when the bundled one is skipped', () => {
    const local: RuleProviderConfigMap = {
      ads: { type: 'file', behavior: 'classical', path: './ads.yaml' },
    }
    const result = mergeBundleIntoMerge(
      { prepend: [], append: [], delete: [] },
      local,
      { sequence, providers: bundleProviders },
      {
        ...resolved,
        providerResolutions: new Map([['ads', { action: 'skip' }]]),
      },
    )

    expect(result.providers.ads).toEqual(local.ads)
    expect(result.providers.cn).toEqual(bundleProviders.cn)
    // A skipped provider keeps its bundled name in the rules, which now point
    // at the local rule set the user chose to keep.
    expect(result.sequence.prepend).toContain('RULE-SET,ads,REJECT')
  })

  it('renames a provider and every rule referencing it', () => {
    const result = mergeBundleIntoMerge(
      { prepend: [], append: [], delete: [] },
      { ads: { type: 'file', behavior: 'classical', path: './ads.yaml' } },
      { sequence, providers: bundleProviders },
      {
        ...resolved,
        providerResolutions: new Map([
          ['ads', { action: 'rename', newName: 'ads-imported' }],
        ]),
      },
    )

    expect(Object.keys(result.providers).sort()).toEqual([
      'ads',
      'ads-imported',
      'cn',
    ])
    expect(result.sequence.prepend).toContain('RULE-SET,ads-imported,REJECT')
  })
})

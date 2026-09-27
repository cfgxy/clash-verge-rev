import { describe, expect, it } from 'vitest'

import {
  BUILTIN_PROXY_POLICIES,
  collectLocalPolicies,
  collectLocalProviderNames,
  readOwnRuleLayer,
  type ProfileTexts,
} from './profile-context'

const texts: ProfileTexts = {
  base: [
    'proxy-groups:',
    '  - name: Proxy',
    '    type: select',
    '  - name: Legacy',
    '    type: select',
    'rule-providers:',
    '  base-set:',
    '    type: http',
    '    behavior: domain',
  ].join('\n'),
  groups: [
    'prepend:',
    '  - name: Added',
    '    type: select',
    'append: []',
    'delete:',
    '  - Legacy',
  ].join('\n'),
  merge: ['rule-providers:', '  merge-set:', '    type: http'].join('\n'),
  globalMerge: ['rule-providers:', '  global-set:', '    type: http'].join(
    '\n',
  ),
}

describe('collectLocalPolicies', () => {
  it('offers the builtins plus the groups the profile ends up with', () => {
    expect(collectLocalPolicies(texts)).toEqual([
      ...BUILTIN_PROXY_POLICIES,
      'Added',
      'Proxy',
    ])
  })

  it('falls back to the builtins when no group is declared', () => {
    expect(
      collectLocalPolicies({
        base: '',
        groups: '',
        merge: '',
        globalMerge: '',
      }),
    ).toEqual(BUILTIN_PROXY_POLICIES)
  })
})

describe('collectLocalProviderNames', () => {
  it('collects the names every layer declares', () => {
    expect(collectLocalProviderNames(texts).sort()).toEqual([
      'base-set',
      'global-set',
      'merge-set',
    ])
  })
})

describe('readOwnRuleLayer', () => {
  it('exports global-only declarations without subscription-owned content', () => {
    const own = readOwnRuleLayer(
      'prepend:\n  - RULE-SET,global-set,REJECT',
      '',
      'rule-providers:\n  global-set:\n    type: http\n    behavior: domain',
    )

    expect(own.sequence.prepend).toEqual(['RULE-SET,global-set,REJECT'])
    expect(own.providers).toEqual({})
    expect(own.globalProviders).toEqual({
      'global-set': { type: 'http', behavior: 'domain' },
    })
    expect(own).not.toHaveProperty('base')
  })

  it('retains different declarations with the same name in both scopes', () => {
    const own = readOwnRuleLayer(
      '',
      'rule-providers:\n  ads:\n    url: https://example.com/profile.yaml',
      'rule-providers:\n  ads:\n    url: https://example.com/global.yaml',
    )

    expect(own.providers.ads.url).toBe('https://example.com/profile.yaml')
    expect(own.globalProviders.ads.url).toBe('https://example.com/global.yaml')
  })
})

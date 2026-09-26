import { describe, expect, it } from 'vitest'

import {
  BUILTIN_PROXY_POLICIES,
  collectLocalPolicies,
  collectLocalProviderNames,
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

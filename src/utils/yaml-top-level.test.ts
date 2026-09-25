import { describe, expect, test } from 'vitest'

import { readTopLevelValue, writeTopLevelValue } from './yaml-top-level'

describe('readTopLevelValue', () => {
  test('reads a top-level mapping key without disturbing others', () => {
    const yaml = [
      '# leading comment',
      'rule-providers:',
      '  foo:',
      '    type: http',
      '    url: https://example.com/foo.yaml',
      '',
      'rules:',
      '  - RULE-SET,foo,DIRECT',
    ].join('\n')

    expect(readTopLevelValue(yaml, 'rule-providers')).toEqual({
      foo: { type: 'http', url: 'https://example.com/foo.yaml' },
    })
  })

  test('returns undefined when the key does not exist', () => {
    const yaml = 'rules:\n  - MATCH,DIRECT\n'
    expect(readTopLevelValue(yaml, 'rule-providers')).toBeUndefined()
  })

  test('does not match keys that merely share a prefix', () => {
    const yaml = 'rule-providers-extra:\n  foo: bar\n'
    expect(readTopLevelValue(yaml, 'rule-providers')).toBeUndefined()
  })
})

describe('writeTopLevelValue', () => {
  test('preserves unrelated comments and sections when replacing an existing key', () => {
    const yaml = [
      '# comment above',
      'rule-providers:',
      '  foo:',
      '    type: http',
      '    url: https://example.com/old.yaml',
      '',
      '# comment below',
      'rules:',
      '  - RULE-SET,foo,DIRECT',
      '',
    ].join('\n')

    const result = writeTopLevelValue(yaml, 'rule-providers', {
      foo: { type: 'http', url: 'https://example.com/new.yaml' },
    })

    expect(result).toContain('# comment above')
    expect(result).toContain('# comment below')
    expect(result).toContain('rules:')
    expect(result).toContain('- RULE-SET,foo,DIRECT')
    expect(result).toContain('https://example.com/new.yaml')
    expect(result).not.toContain('https://example.com/old.yaml')

    expect(readTopLevelValue(result, 'rule-providers')).toEqual({
      foo: { type: 'http', url: 'https://example.com/new.yaml' },
    })
  })

  test('appends a new key when absent, keeping existing content intact', () => {
    const yaml = ['# header', 'rules:', '  - MATCH,DIRECT', ''].join('\n')

    const result = writeTopLevelValue(yaml, 'rule-providers', {
      foo: { type: 'http', url: 'https://example.com/foo.yaml' },
    })

    expect(result).toContain('# header')
    expect(result).toContain('- MATCH,DIRECT')
    expect(readTopLevelValue(result, 'rule-providers')).toEqual({
      foo: { type: 'http', url: 'https://example.com/foo.yaml' },
    })
  })

  test('removes the key entirely when value is undefined', () => {
    const yaml = [
      'rule-providers:',
      '  foo:',
      '    type: http',
      '',
      'rules:',
      '  - MATCH,DIRECT',
      '',
    ].join('\n')

    const result = writeTopLevelValue(yaml, 'rule-providers', undefined)

    expect(result).not.toContain('rule-providers')
    expect(result).toContain('rules:')
    expect(result).toContain('- MATCH,DIRECT')
  })

  test('round-trips a full add/edit/delete provider lifecycle', () => {
    let yaml = 'rules:\n  - MATCH,DIRECT\n'

    yaml = writeTopLevelValue(yaml, 'rule-providers', {
      foo: { type: 'http', url: 'https://example.com/foo.yaml' },
    })
    expect(readTopLevelValue(yaml, 'rule-providers')).toEqual({
      foo: { type: 'http', url: 'https://example.com/foo.yaml' },
    })

    yaml = writeTopLevelValue(yaml, 'rule-providers', {
      foo: { type: 'http', url: 'https://example.com/foo-v2.yaml' },
    })
    expect(readTopLevelValue(yaml, 'rule-providers')).toEqual({
      foo: { type: 'http', url: 'https://example.com/foo-v2.yaml' },
    })

    yaml = writeTopLevelValue(yaml, 'rule-providers', undefined)
    expect(readTopLevelValue(yaml, 'rule-providers')).toBeUndefined()
    expect(yaml).toContain('- MATCH,DIRECT')
  })
})

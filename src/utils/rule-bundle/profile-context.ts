import { readTopLevelValue } from '@/utils/yaml-top-level'

/** Same builtin policies the rules editor offers. */
export const BUILTIN_PROXY_POLICIES = [
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
]

export interface ProfileTexts {
  /** The subscription's own profile document. */
  base: string
  /** The `option.groups` sequence file. */
  groups: string
  /** This subscription's merge file. */
  merge: string
  /** The global `Merge` file. */
  globalMerge: string
}

interface GroupEntry {
  name?: string
}

function groupNames(texts: ProfileTexts): string[] {
  const origin =
    readTopLevelValue<GroupEntry[]>(texts.base, 'proxy-groups') ?? []
  const prepend = readTopLevelValue<GroupEntry[]>(texts.groups, 'prepend') ?? []
  const append = readTopLevelValue<GroupEntry[]>(texts.groups, 'append') ?? []
  const removed = new Set(
    (
      readTopLevelValue<Array<string | GroupEntry>>(texts.groups, 'delete') ??
      []
    )
      .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
      .filter((name): name is string => Boolean(name)),
  )

  return [...prepend, ...origin, ...append]
    .map((group) => group?.name)
    .filter((name): name is string => Boolean(name))
    .filter((name) => !removed.has(name))
}

/**
 * Policies an imported rule may point at: the builtins plus the groups this
 * profile actually ends up with. A rule mapped to anything else would make the
 * kernel refuse the config.
 */
export function collectLocalPolicies(texts: ProfileTexts): string[] {
  const seen = new Set(BUILTIN_PROXY_POLICIES)
  for (const name of groupNames(texts)) seen.add(name)
  return [...seen]
}

/** Rule-set names already declared by any layer, so an import can spot collisions. */
export function collectLocalProviderNames(texts: ProfileTexts): string[] {
  const names = new Set<string>()
  for (const text of [texts.base, texts.merge, texts.globalMerge]) {
    const providers = readTopLevelValue<Record<string, unknown>>(
      text,
      'rule-providers',
    )
    for (const name of Object.keys(providers ?? {})) names.add(name)
  }
  return [...names]
}

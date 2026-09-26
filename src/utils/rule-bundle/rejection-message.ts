import type { BundleImportRejection } from '@/utils/rule-bundle/bundle'

export interface RejectionMessage {
  key: string
  params?: Record<string, string>
}

/**
 * Maps a refusal to the notice it is reported with. A provider URL may carry a
 * subscription token, so nothing here interpolates a URL; entry names are
 * reported by shape only, never echoed back.
 */
export function describeRejection(
  rejection: BundleImportRejection,
): RejectionMessage {
  const prefix = 'rules.feedback.notifications.bundle.rejected'
  switch (rejection.kind) {
    case 'not-a-zip':
      return { key: `${prefix}.notAZip` }
    case 'manifest-missing':
      return { key: `${prefix}.manifestMissing` }
    case 'manifest-invalid':
      return { key: `${prefix}.manifestInvalid` }
    case 'format-version-unsupported':
      return {
        key: `${prefix}.formatVersion`,
        params: { version: rejection.version },
      }
    case 'unsafe-entry-path':
      return { key: `${prefix}.unsafeEntryPath` }
    case 'content-missing':
      return {
        key: `${prefix}.contentMissing`,
        params: { path: rejection.path },
      }
    case 'content-corrupt':
      return {
        key: `${prefix}.contentCorrupt`,
        params: { path: rejection.path },
      }
    case 'content-invalid':
      return {
        key: `${prefix}.contentInvalid`,
        params: { path: rejection.path },
      }
  }
}

/** Host of a provider URL: the rest of the URL may be a secret. */
export function providerUrlHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

/** Distinct hosts the bundle would disclose, for the export warning. */
export function collectProviderHosts(
  providers: Record<string, { url?: string }>,
): string[] {
  const hosts = new Set<string>()
  for (const config of Object.values(providers)) {
    const host = providerUrlHost(config.url)
    if (host) hosts.add(host)
  }
  return [...hosts].sort()
}

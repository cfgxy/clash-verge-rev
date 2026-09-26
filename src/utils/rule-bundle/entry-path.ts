/**
 * A rule bundle is never written to disk entry-by-entry, but its entry names
 * still index into the bundle's own namespace, so a traversing name would let
 * an attacker-supplied archive substitute the manifest or a payload file.
 * Names are normalized and rejected here before any entry is looked up.
 */

export class UnsafeEntryPathError extends Error {
  constructor(readonly entryName: string) {
    super(`unsafe zip entry path: ${entryName}`)
  }
}

/** Windows-authored archives may use backslashes even though ZIP mandates `/`. */
function toPosix(name: string): string {
  return name.replace(/\\/gu, '/')
}

function isAbsolute(name: string): boolean {
  return name.startsWith('/') || /^[A-Za-z]:\//u.test(name)
}

/**
 * Returns the bundle-relative path, or throws when the name is absolute or
 * carries any `..` segment. A traversing segment is refused outright rather
 * than resolved away: a legitimate bundle never needs one, so resolving would
 * only serve to accept a hostile name. Callers must treat the returned value as
 * the only usable form of the name.
 */
export function normalizeEntryPath(entryName: string): string {
  const posix = toPosix(entryName)
  if (isAbsolute(posix)) throw new UnsafeEntryPathError(entryName)

  const segments: string[] = []
  for (const segment of posix.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new UnsafeEntryPathError(entryName)
    segments.push(segment)
  }

  if (segments.length === 0) throw new UnsafeEntryPathError(entryName)
  return segments.join('/')
}

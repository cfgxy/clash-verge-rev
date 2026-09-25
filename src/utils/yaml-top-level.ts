import { dump, load } from 'js-yaml'

/**
 * Finds the raw text span (start/end line indices, end exclusive) of a
 * top-level YAML mapping key, so it can be replaced without re-dumping the
 * whole document and losing unrelated comments/formatting.
 */
function findTopLevelKeySpan(
  lines: string[],
  key: string,
): { start: number; end: number } | null {
  const keyPattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`,
  )
  let start = -1

  for (let i = 0; i < lines.length; i++) {
    if (keyPattern.test(lines[i])) {
      start = i
      break
    }
  }

  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    // A new top-level key (no leading whitespace, contains ':') ends the block.
    if (/^\S/.test(line)) {
      end = i
      break
    }
  }

  return { start, end }
}

/**
 * Reads a top-level key's value from raw YAML text without parsing the
 * whole document, so unrelated keys/comments are never touched.
 */
export function readTopLevelValue<T = unknown>(
  yamlText: string,
  key: string,
): T | undefined {
  const lines = yamlText.split(/\r?\n/u)
  const span = findTopLevelKeySpan(lines, key)
  if (!span) return undefined

  const block = lines.slice(span.start, span.end).join('\n')
  const parsed = load(block) as Record<string, unknown> | undefined
  return parsed?.[key] as T | undefined
}

/**
 * Writes (inserts, replaces, or removes when `value` is undefined) a
 * top-level key in raw YAML text, preserving all other lines verbatim
 * (including comments and formatting) outside the key's own span.
 */
export function writeTopLevelValue(
  yamlText: string,
  key: string,
  value: unknown,
): string {
  const hasTrailingNewline = /\r?\n$/u.test(yamlText)
  const lines = yamlText.split(/\r?\n/u)
  // Drop a single trailing empty element produced by a trailing newline split.
  if (hasTrailingNewline && lines[lines.length - 1] === '') lines.pop()

  const span = findTopLevelKeySpan(lines, key)

  const newBlockLines =
    value === undefined
      ? []
      : dump({ [key]: value }, { lineWidth: -1 })
          .replace(/\n$/u, '')
          .split('\n')

  let resultLines: string[]
  if (span) {
    resultLines = [
      ...lines.slice(0, span.start),
      ...newBlockLines,
      ...lines.slice(span.end),
    ]
  } else if (newBlockLines.length === 0) {
    resultLines = lines
  } else {
    const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1] !== ''
    resultLines = [
      ...lines,
      ...(needsLeadingBlank ? [''] : []),
      ...newBlockLines,
    ]
  }

  return (
    resultLines.join('\n') +
    (hasTrailingNewline || resultLines.length > 0 ? '\n' : '')
  )
}

# ADR 0001: Custom rule bundle format

- Status: accepted
- Date: 2026-09-26

## Context

Users who maintain their own rules on top of a subscription have no way to move
that work between machines or between this client and Clash Meta for Android.
Only the user-authored layer is portable: the subscription keeps updating its
own `rules` and `rule-providers`, so packing them would both duplicate data and
overwrite the provider's updates on import.

## Decision

Export and import a single ZIP archive that carries the user-authored layer
only: the rule overrides (`prepend` / `append` / `delete`) and the
user-declared `rule-providers`. Rule sets travel as declarations (name, url,
behavior, interval), never as downloaded content — the kernel refetches them.

The subscription's own `rules` and `rule-providers` are never read, packed, or
modified.

### Layout

```text
manifest.json
rules/sequence.yaml       # prepend / append / delete, order preserved
providers/providers.yaml  # rule-providers declarations, no content
```

`rules/sequence.yaml` holds the three arrays verbatim, in order. `delete` is
part of the format: it names subscription rule lines the user suppressed, and
dropping it would break round-tripping.

`providers/providers.yaml` holds a single `rule-providers` mapping.

### manifest.json

| field | meaning |
| --- | --- |
| `formatVersion` | `major.minor`, currently `1.0` |
| `generator` | `{ app, version }`; `app` is `clash-verge-rev` or `clash-meta-for-android` |
| `createdAt` | RFC 3339 timestamp |
| `proxyPolicies` | distinct policies the bundled `prepend`/`append` rules reference |
| `contents` | per file: `path`, `sha256`, `entryCount` |

`proxyPolicies` lets the importer build its mapping UI without parsing rules
first; `contents` lets it detect a truncated or edited archive.

### Version compatibility

A differing major version rejects the whole bundle and writes nothing. A higher
minor version is accepted: unrecognized fields are ignored and the user is told
explicitly that the bundle came from a newer version. Fields are never dropped
silently.

### Import semantics

Import is atomic: the archive is fully parsed and validated, and every user
decision is resolved, before the first file write.

- Byte-identical rule lines are skipped; imported lines are appended after the
  existing ones.
- A bundled policy name is written only once mapped to a local policy —
  builtin (`DIRECT`, `REJECT`, `REJECT-DROP`, `PASS`) or a group the profile
  actually ends up with. Same names are preselected. A rule whose policy is
  left unmapped is not written, because the kernel would refuse the config.
- A rule set whose name already exists is resolved by the user as overwrite,
  skip, or rename. Skipping reports which bundled rules reference it, including
  references nested inside `AND` / `OR` / `NOT`. A rename rewrites the
  `RULE-SET,<name>` references.

### Security

Every entry name is normalized before any entry is looked up: an absolute path
or any `..` segment rejects the whole bundle. `src/utils/rule-bundle/entry-path.ts`
refuses a traversing segment outright instead of resolving it away.

A provider `url` may embed a subscription token, so log lines, notifications,
and error messages carry the host only, never the full URL. The export dialog
warns that the archive contains subscription addresses.

Imported content is data only: it is parsed as YAML/JSON and written to profile
files, never evaluated or interpolated into a command line.

## Consequences

- Bundles stay small and stable across subscription updates.
- Cross-client interop needs only the two YAML documents and the manifest, so
  the Android client can produce bundles this client accepts and vice versa.
- A bundle is not a backup: restoring it onto a profile without the matching
  groups requires the mapping step.
- The ZIP layer is hand-written (store on write, store + deflate on read) to
  avoid a new dependency; archives produced elsewhere may be deflated and are
  read back correctly.

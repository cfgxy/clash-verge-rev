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

### Scoped rule providers (format 1.1)

User-declared providers can be stored in either the selected profile's merge
file or the global `Merge` file. The subscription's own declarations remain
outside the bundle. Preserve both scopes: merging them permanently into the
target profile would lose the global layer's effect on other desktop profiles.

Version 1.0 bundles have only `providers/providers.yaml`, which an importing
desktop client treats as profile-scoped. Version 1.1 adds two entries:

```text
providers/providers.yaml  # effective union for older importers; global wins
providers/profile.yaml    # declarations from the selected profile merge
providers/global.yaml     # declarations from the global Merge file
```

All three entries are listed in `manifest.contents` with SHA-256 and entry
counts. The effective union must match the two scoped maps after global names
override profile names; an inconsistency rejects the bundle before any writes.
An older importer can still use the effective union in its target profile and
warn that a newer minor format may have lost scope. A desktop importer that
understands 1.1 restores both maps to their original scopes, including two
different declarations with the same name; the global layer retains precedence.
Android has no equivalent global merge file and imports the effective union
into the selected profile. Scope changes to the global file affect all desktop
profiles, so import must make that effect visible before confirmation.
Conflict actions for a bundled name apply to both scoped declarations: skip
keeps both local layers, rename changes the name in both layers and in incoming
rule references, and overwrite replaces the declaration in each original scope.

### manifest.json

| field | meaning |
| --- | --- |
| `formatVersion` | `major.minor`; desktop exports `1.1`, older bundles use `1.0` |
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

The archive is fully parsed and validated, and every user decision is resolved,
before the first file write. Writes to the rule file, profile merge file, and
global merge file are separate operations; a later write failure can leave an
earlier change in place. Imports are not transactional across files.

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
- Version 1.1 adds two YAML documents to preserve desktop scope, while the
  original union entry remains readable by version 1.0 clients.
- A bundle is not a backup: restoring it onto a profile without the matching
  groups requires the mapping step.
- The ZIP layer is hand-written (store on write, store + deflate on read) to
  avoid a new dependency; archives produced elsewhere may be deflated and are
  read back correctly.

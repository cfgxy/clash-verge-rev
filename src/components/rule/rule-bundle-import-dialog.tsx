import {
  Alert,
  Autocomplete,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { RuleBundle } from '@/utils/rule-bundle/format'
import {
  isMappingComplete,
  type PolicyMappingTarget,
  prepareImport,
  type ProviderConflictResolution,
  type ResolvedImport,
} from '@/utils/rule-bundle/import-plan'
import { collectProviderHosts } from '@/utils/rule-bundle/rejection-message'

interface Props {
  open: boolean
  bundle: RuleBundle
  producedByNewerMinor: boolean
  localPolicies: string[]
  localProviderNames: string[]
  onClose: () => void
  onConfirm: (resolved: ResolvedImport) => Promise<void>
}

type ConflictAction = ProviderConflictResolution['action']

export const RuleBundleImportDialog = ({
  open,
  bundle,
  producedByNewerMinor,
  localPolicies,
  localProviderNames,
  onClose,
  onConfirm,
}: Props) => {
  const { t } = useTranslation()

  const preparation = useMemo(
    () =>
      prepareImport(
        bundle.sequence,
        bundle.providers,
        localPolicies,
        localProviderNames,
      ),
    [bundle, localPolicies, localProviderNames],
  )

  const [mappings, setMappings] = useState<PolicyMappingTarget[]>(
    () => preparation.policyMappings,
  )
  const [actions, setActions] = useState<Record<string, ConflictAction>>(() =>
    Object.fromEntries(
      preparation.providerConflicts.map(({ name }) => [
        name,
        'skip' as ConflictAction,
      ]),
    ),
  )
  const [newNames, setNewNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      preparation.providerConflicts.map(({ name }) => [
        name,
        `${name}-imported`,
      ]),
    ),
  )

  const takenNames = useMemo(
    () => new Set(localProviderNames),
    [localProviderNames],
  )

  const invalidRenames = useMemo(
    () =>
      preparation.providerConflicts
        .filter(({ name }) => actions[name] === 'rename')
        .filter(({ name }) => {
          const next = (newNames[name] ?? '').trim()
          return !next || takenNames.has(next)
        })
        .map(({ name }) => name),
    [actions, newNames, preparation.providerConflicts, takenNames],
  )

  const handleConfirm = useLockFn(async () => {
    const policyMap = new Map<string, string>()
    for (const mapping of mappings) {
      if (mapping.targetPolicy) {
        policyMap.set(mapping.sourcePolicy, mapping.targetPolicy)
      }
    }
    const providerResolutions = new Map<string, ProviderConflictResolution>()
    for (const { name } of preparation.providerConflicts) {
      const action = actions[name] ?? 'skip'
      providerResolutions.set(
        name,
        action === 'rename'
          ? { action, newName: newNames[name].trim() }
          : { action },
      )
    }
    await onConfirm({ policyMap, providerResolutions })
  })

  const hosts = collectProviderHosts(bundle.providers)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('rules.modals.importBundle.title')}</DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {t('rules.modals.importBundle.summary', {
              generator: bundle.manifest.generator.app || '-',
              ruleCount:
                bundle.sequence.prepend.length +
                bundle.sequence.append.length +
                bundle.sequence.delete.length,
              providerCount: Object.keys(bundle.providers).length,
            })}
          </Typography>

          {producedByNewerMinor && (
            <Alert severity="info">
              {t('rules.modals.importBundle.newerMinor', {
                version: bundle.manifest.formatVersion,
              })}
            </Alert>
          )}

          {mappings.length > 0 && (
            <Stack spacing={1}>
              <Typography variant="subtitle2">
                {t('rules.modals.importBundle.policyMappingTitle')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('rules.modals.importBundle.policyMappingHint')}
              </Typography>
              {mappings.map((mapping, index) => (
                <Autocomplete
                  key={mapping.sourcePolicy}
                  size="small"
                  options={localPolicies}
                  value={mapping.targetPolicy ?? null}
                  onChange={(_, value) =>
                    setMappings((prev) =>
                      prev.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              sourcePolicy: item.sourcePolicy,
                              ...(value ? { targetPolicy: value } : {}),
                            }
                          : item,
                      ),
                    )
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={mapping.sourcePolicy}
                      error={!mapping.targetPolicy}
                      helperText={
                        mapping.targetPolicy
                          ? undefined
                          : t('rules.modals.importBundle.policyRequired')
                      }
                    />
                  )}
                />
              ))}
            </Stack>
          )}

          {preparation.providerConflicts.length > 0 && (
            <Stack spacing={1}>
              <Typography variant="subtitle2">
                {t('rules.modals.importBundle.conflictTitle')}
              </Typography>
              {preparation.providerConflicts.map((conflict) => (
                <Stack key={conflict.name} spacing={1}>
                  <TextField
                    select
                    size="small"
                    label={conflict.name}
                    value={actions[conflict.name] ?? 'skip'}
                    onChange={(e) =>
                      setActions((prev) => ({
                        ...prev,
                        [conflict.name]: e.target.value as ConflictAction,
                      }))
                    }
                  >
                    <MenuItem value="skip">
                      {t('rules.modals.importBundle.conflict.skip')}
                    </MenuItem>
                    <MenuItem value="overwrite">
                      {t('rules.modals.importBundle.conflict.overwrite')}
                    </MenuItem>
                    <MenuItem value="rename">
                      {t('rules.modals.importBundle.conflict.rename')}
                    </MenuItem>
                  </TextField>

                  {actions[conflict.name] === 'rename' && (
                    <TextField
                      size="small"
                      label={t('rules.modals.importBundle.conflict.newName')}
                      value={newNames[conflict.name] ?? ''}
                      error={invalidRenames.includes(conflict.name)}
                      helperText={
                        invalidRenames.includes(conflict.name)
                          ? t('rules.modals.importBundle.conflict.nameTaken')
                          : undefined
                      }
                      onChange={(e) =>
                        setNewNames((prev) => ({
                          ...prev,
                          [conflict.name]: e.target.value,
                        }))
                      }
                    />
                  )}

                  {actions[conflict.name] === 'skip' &&
                    conflict.referencingRules.length > 0 && (
                      <Alert severity="warning">
                        {t(
                          'rules.modals.importBundle.conflict.skipReferenced',
                          {
                            name: conflict.name,
                            count: conflict.referencingRules.length,
                            rules: conflict.referencingRules.join('; '),
                          },
                        )}
                      </Alert>
                    )}
                </Stack>
              ))}
            </Stack>
          )}

          {hosts.length > 0 && (
            <Alert severity="info">
              {t('rules.modals.importBundle.providerSourceNotice', {
                hosts: hosts.join(', '),
              })}
            </Alert>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="outlined">
          {t('shared.actions.cancel')}
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={!isMappingComplete(mappings) || invalidRenames.length > 0}
        >
          {t('rules.modals.importBundle.actions.import')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

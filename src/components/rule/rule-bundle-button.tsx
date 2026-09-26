import { FileDownloadOutlined, FileUploadOutlined } from '@mui/icons-material'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import { getVersion } from '@tauri-apps/api/app'
import { open as openFileDialog, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RuleBundleImportDialog } from '@/components/rule/rule-bundle-import-dialog'
import { useProfiles } from '@/hooks/use-profiles'
import { useAppRefreshers } from '@/providers/app-data-context'
import {
  readProfileFile,
  saveProfileFile,
  syncRuntimeProviders,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import {
  BundleImportError,
  buildRuleBundle,
  readRuleBundle,
} from '@/utils/rule-bundle/bundle'
import {
  EMPTY_SEQUENCE,
  isSequenceEmpty,
  type RuleBundle,
  type RuleSequence,
} from '@/utils/rule-bundle/format'
import {
  mergeBundleIntoMerge,
  type ResolvedImport,
} from '@/utils/rule-bundle/import-plan'
import {
  collectLocalPolicies,
  collectLocalProviderNames,
  type ProfileTexts,
} from '@/utils/rule-bundle/profile-context'
import {
  collectProviderHosts,
  describeRejection,
} from '@/utils/rule-bundle/rejection-message'
import type { RuleProviderConfigMap } from '@/utils/rule-provider'
import { readTopLevelValue, writeTopLevelValue } from '@/utils/yaml-top-level'

const BUNDLE_EXTENSION = 'zip'

interface PendingImport {
  bundle: RuleBundle
  producedByNewerMinor: boolean
}

function readSequence(text: string): RuleSequence {
  return {
    prepend: readTopLevelValue<string[]>(text, 'prepend') ?? [],
    append: readTopLevelValue<string[]>(text, 'append') ?? [],
    delete: readTopLevelValue<string[]>(text, 'delete') ?? [],
  }
}

export const RuleBundleButton = () => {
  const { t } = useTranslation()
  const { current } = useProfiles()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()

  const [exportPreview, setExportPreview] = useState<{
    sequence: RuleSequence
    providers: RuleProviderConfigMap
  } | null>(null)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [localPolicies, setLocalPolicies] = useState<string[]>([])
  const [localProviderNames, setLocalProviderNames] = useState<string[]>([])

  const rulesUid = current?.option?.rules
  const mergeUid = current?.option?.merge
  const enabled = Boolean(rulesUid && mergeUid)

  const readOrEmpty = (uid?: string) =>
    uid ? readProfileFile(uid).catch(() => '') : Promise.resolve('')

  const loadProfileTexts = async (): Promise<ProfileTexts> => {
    const [base, groups, merge, globalMerge] = await Promise.all([
      readOrEmpty(current?.uid),
      readOrEmpty(current?.option?.groups),
      readOrEmpty(mergeUid),
      readOrEmpty('Merge'),
    ])
    return { base, groups, merge, globalMerge }
  }

  /**
   * Only our own layer is packed: the sequence file plus the rule-providers this
   * subscription's merge file declares. The subscription's own rules and
   * rule-providers stay out of the bundle.
   */
  const loadOwnLayer = async () => {
    const [rulesText, mergeText] = await Promise.all([
      readOrEmpty(rulesUid),
      readOrEmpty(mergeUid),
    ])
    return {
      sequence: readSequence(rulesText),
      providers:
        readTopLevelValue<RuleProviderConfigMap>(mergeText, 'rule-providers') ??
        {},
    }
  }

  const handleExportClick = useLockFn(async () => {
    if (!enabled) return
    try {
      const own = await loadOwnLayer()
      if (
        isSequenceEmpty(own.sequence) &&
        Object.keys(own.providers).length === 0
      ) {
        showNotice.info('rules.feedback.notifications.bundle.nothingToExport')
        return
      }
      setExportPreview(own)
    } catch (err) {
      showNotice.error('rules.feedback.notifications.bundle.exportFailed', {
        message: String(err),
      })
    }
  })

  const handleExportConfirm = useLockFn(async () => {
    const own = exportPreview
    if (!own) return
    setExportPreview(null)
    try {
      const filename = `clash-verge-rules-${dayjs().format(
        'YYYYMMDD-HHmmss',
      )}.${BUNDLE_EXTENSION}`
      const target = await save({
        defaultPath: filename,
        filters: [
          {
            name: t('rules.modals.exportBundle.fileFilter'),
            extensions: [BUNDLE_EXTENSION],
          },
        ],
      })
      if (!target) return

      const bytes = await buildRuleBundle({
        sequence: own.sequence,
        providers: own.providers,
        appVersion: await getVersion(),
      })
      await writeFile(target, bytes)
      showNotice.success('rules.feedback.notifications.bundle.exportSuccess')
    } catch (err) {
      showNotice.error('rules.feedback.notifications.bundle.exportFailed', {
        message: String(err),
      })
    }
  })

  const handleImportClick = useLockFn(async () => {
    if (!enabled) return
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: t('rules.modals.exportBundle.fileFilter'),
            extensions: [BUNDLE_EXTENSION],
          },
        ],
      })
      if (!picked || Array.isArray(picked)) return

      const bytes = await readFile(picked)
      const result = await readRuleBundle(bytes)
      const texts = await loadProfileTexts()
      setLocalPolicies(collectLocalPolicies(texts))
      setLocalProviderNames(collectLocalProviderNames(texts))
      setPending(result)
    } catch (err) {
      if (err instanceof BundleImportError) {
        const message = describeRejection(err.rejection)
        showNotice.error(message.key, message.params)
        return
      }
      showNotice.error('rules.feedback.notifications.bundle.importFailed', {
        message: String(err),
      })
    }
  })

  const handleImportConfirm = async (resolved: ResolvedImport) => {
    if (!rulesUid || !mergeUid || !pending) return
    try {
      const [rulesText, mergeText] = await Promise.all([
        readOrEmpty(rulesUid),
        readOrEmpty(mergeUid),
      ])
      const currentSequence = rulesText
        ? readSequence(rulesText)
        : EMPTY_SEQUENCE
      const currentProviders =
        readTopLevelValue<RuleProviderConfigMap>(mergeText, 'rule-providers') ??
        {}

      const next = mergeBundleIntoMerge(
        currentSequence,
        currentProviders,
        pending.bundle,
        resolved,
      )

      let nextRulesText = writeTopLevelValue(
        rulesText,
        'prepend',
        next.sequence.prepend,
      )
      nextRulesText = writeTopLevelValue(
        nextRulesText,
        'append',
        next.sequence.append,
      )
      nextRulesText = writeTopLevelValue(
        nextRulesText,
        'delete',
        next.sequence.delete,
      )
      const nextMergeText = writeTopLevelValue(
        mergeText,
        'rule-providers',
        Object.keys(next.providers).length > 0 ? next.providers : undefined,
      )

      if (!(await saveProfileFile(rulesUid, nextRulesText))) {
        throw new Error('save_profile_file rejected the rule sequence')
      }
      if (!(await saveProfileFile(mergeUid, nextMergeText))) {
        throw new Error('save_profile_file rejected the merge document')
      }

      setPending(null)
      await refreshRules()
      await refreshRuleProviders()
      void syncRuntimeProviders()
      showNotice.success('rules.feedback.notifications.bundle.importSuccess')
    } catch (err) {
      showNotice.error('rules.feedback.notifications.bundle.importFailed', {
        message: String(err),
      })
    }
  }

  if (!enabled) return null

  const exportHosts = exportPreview
    ? collectProviderHosts(exportPreview.providers)
    : []

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<FileDownloadOutlined />}
        onClick={handleExportClick}
      >
        {t('rules.page.actions.exportBundle')}
      </Button>
      <Button
        variant="outlined"
        size="small"
        startIcon={<FileUploadOutlined />}
        onClick={handleImportClick}
      >
        {t('rules.page.actions.importBundle')}
      </Button>

      <Dialog
        open={exportPreview !== null}
        onClose={() => setExportPreview(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('rules.modals.exportBundle.title')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2">
              {t('rules.modals.exportBundle.summary', {
                ruleCount: exportPreview
                  ? exportPreview.sequence.prepend.length +
                    exportPreview.sequence.append.length +
                    exportPreview.sequence.delete.length
                  : 0,
                providerCount: exportPreview
                  ? Object.keys(exportPreview.providers).length
                  : 0,
              })}
            </Typography>
            {exportHosts.length > 0 && (
              <Alert severity="warning">
                {t('rules.modals.exportBundle.subscriptionAddressWarning', {
                  hosts: exportHosts.join(', '),
                })}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportPreview(null)} variant="outlined">
            {t('shared.actions.cancel')}
          </Button>
          <Button onClick={handleExportConfirm} variant="contained">
            {t('rules.modals.exportBundle.actions.export')}
          </Button>
        </DialogActions>
      </Dialog>

      {pending && (
        <RuleBundleImportDialog
          open
          bundle={pending.bundle}
          producedByNewerMinor={pending.producedByNewerMinor}
          localPolicies={localPolicies}
          localProviderNames={localProviderNames}
          onClose={() => setPending(null)}
          onConfirm={handleImportConfirm}
        />
      )}
    </>
  )
}

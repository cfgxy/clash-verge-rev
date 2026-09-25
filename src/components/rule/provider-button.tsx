import {
  AddRounded,
  DeleteOutlineRounded,
  EditOutlined,
  RefreshRounded,
  StorageOutlined,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
  alpha,
  styled,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateRuleProvider } from 'tauri-plugin-mihomo-api'

import { DeleteProviderDialog } from '@/components/rule/delete-provider-dialog'
import {
  ProviderFormDialog,
  ProviderFormValue,
} from '@/components/rule/provider-form-dialog'
import { useProfiles } from '@/hooks/use-profiles'
import { useAppRefreshers, useRulesData } from '@/providers/app-data-context'
import {
  readProfileFile,
  saveProfileFile,
  syncRuntimeProviders,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import {
  findRuleProviderReferences,
  planProviderDeletion,
  removeRuleProvider,
  resolveClearAndDelete,
  RuleProviderConfig,
  RuleProviderConfigMap,
  upsertRuleProvider,
} from '@/utils/rule-provider'
import { readTopLevelValue, writeTopLevelValue } from '@/utils/yaml-top-level'

const TypeBox = styled(Box)<{ component?: React.ElementType }>(({ theme }) => ({
  display: 'inline-block',
  border: '1px solid #ccc',
  borderColor: alpha(theme.palette.secondary.main, 0.5),
  color: alpha(theme.palette.secondary.main, 0.8),
  borderRadius: 4,
  fontSize: 10,
  marginRight: '4px',
  padding: '0 2px',
  lineHeight: 1.25,
}))

export const ProviderButton = () => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { rules, ruleProviders } = useRulesData()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()
  const { current } = useProfiles()
  const [updating, setUpdating] = useState<Record<string, boolean>>({})
  const [formTarget, setFormTarget] = useState<
    { name: string; config: RuleProviderConfig } | 'add' | null
  >(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const mergeUid = current?.option?.merge
  const canManageProviders = Boolean(mergeUid)

  const hasProviders = Object.keys(ruleProviders || {}).length > 0

  const loadMergeConfig = async () => {
    const text = mergeUid ? await readProfileFile(mergeUid) : ''
    const providers = readTopLevelValue<RuleProviderConfigMap>(
      text,
      'rule-providers',
    )
    const mergeRules = readTopLevelValue<string[]>(text, 'rules')
    return { text, providers, mergeRules }
  }

  const handleSubmitProvider = async ({ name, config }: ProviderFormValue) => {
    if (!mergeUid) return
    const isEdit = formTarget !== 'add' && formTarget !== null
    try {
      const { text, providers } = await loadMergeConfig()
      const nextProviders = upsertRuleProvider(providers, name, config)
      const nextText = writeTopLevelValue(text, 'rule-providers', nextProviders)
      const saved = await saveProfileFile(mergeUid, nextText)
      if (!saved) throw new Error('save_profile_file rejected the document')

      await refreshRules()
      await refreshRuleProviders()
      void syncRuntimeProviders()

      showNotice.success(
        isEdit
          ? 'rules.feedback.notifications.provider.editSuccess'
          : 'rules.feedback.notifications.provider.addSuccess',
        { name },
      )
      setFormTarget(null)
    } catch (err) {
      showNotice.error(
        isEdit
          ? 'rules.feedback.notifications.provider.editFailed'
          : 'rules.feedback.notifications.provider.addFailed',
        { message: String(err) },
      )
    }
  }

  const handleDeleteProvider = useLockFn(async (name: string) => {
    if (!mergeUid) return
    const liveReferenceCount = findRuleProviderReferences(rules, name)
    const plan = planProviderDeletion(liveReferenceCount)

    if (!plan.requiresConfirmation) {
      await performDelete(name)
      return
    }

    setDeleteTarget(name)
  })

  /** `nextMergeRules` is only supplied when references were just cleared; omitting it leaves the merge file's own `rules:` key untouched. */
  const performDelete = async (name: string, nextMergeRules?: string[]) => {
    if (!mergeUid) return
    try {
      const { text, providers } = await loadMergeConfig()
      let nextText = text
      if (nextMergeRules !== undefined) {
        nextText = writeTopLevelValue(
          nextText,
          'rules',
          nextMergeRules.length > 0 ? nextMergeRules : undefined,
        )
      }
      nextText = writeTopLevelValue(
        nextText,
        'rule-providers',
        removeRuleProvider(providers, name),
      )
      const saved = await saveProfileFile(mergeUid, nextText)
      if (!saved) throw new Error('save_profile_file rejected the document')

      await refreshRules()
      await refreshRuleProviders()
      void syncRuntimeProviders()

      showNotice.success(
        'rules.feedback.notifications.provider.deleteSuccess',
        {
          name,
        },
      )
    } catch (err) {
      showNotice.error('rules.feedback.notifications.provider.deleteFailed', {
        message: String(err),
      })
    }
  }

  const handleClearAndDelete = useLockFn(async () => {
    const name = deleteTarget
    if (!name) return
    setDeleteTarget(null)

    const { providers, mergeRules } = await loadMergeConfig()
    const liveReferenceCount = findRuleProviderReferences(rules, name)
    const outcome = resolveClearAndDelete(
      mergeRules,
      liveReferenceCount,
      providers,
      name,
    )

    if (!outcome.canDelete) {
      showNotice.error(
        'rules.feedback.notifications.provider.deleteBlockedByReference',
        { name, count: liveReferenceCount },
      )
      return
    }

    await performDelete(name, outcome.nextRulesConfig)
  })

  const updateProvider = useLockFn(async (name: string) => {
    try {
      setUpdating((prev) => ({ ...prev, [name]: true }))

      await updateRuleProvider(name)

      await refreshRules()
      await refreshRuleProviders()
      void syncRuntimeProviders()

      showNotice.success(
        'rules.feedback.notifications.provider.updateSuccess',
        {
          name,
        },
      )
    } catch (err) {
      showNotice.error('rules.feedback.notifications.provider.updateFailed', {
        name,
        message: String(err),
      })
    } finally {
      setUpdating((prev) => ({ ...prev, [name]: false }))
    }
  })

  const updateAllProviders = useLockFn(async () => {
    try {
      const allProviders = Object.keys(ruleProviders || {})
      if (allProviders.length === 0) {
        showNotice.info('rules.feedback.notifications.provider.none')
        return
      }

      const newUpdating = allProviders.reduce(
        (acc, key) => {
          acc[key] = true
          return acc
        },
        {} as Record<string, boolean>,
      )
      setUpdating(newUpdating)

      for (const name of allProviders) {
        try {
          await updateRuleProvider(name)
          setUpdating((prev) => ({ ...prev, [name]: false }))
        } catch (err) {
          console.error(`更新 ${name} 失败`, err)
        }
      }

      await refreshRules()
      await refreshRuleProviders()
      void syncRuntimeProviders()

      showNotice.success('rules.feedback.notifications.provider.allUpdated')
    } catch (err) {
      showNotice.error('rules.feedback.notifications.provider.genericError', {
        message: String(err),
      })
    } finally {
      setUpdating({})
    }
  })

  const handleClose = () => {
    setOpen(false)
  }

  const handleOpenEdit = async (name: string) => {
    const { providers } = await loadMergeConfig()
    const existing = providers?.[name]
    const runtime = ruleProviders?.[name]
    const config: RuleProviderConfig = existing ?? {
      type:
        typeof runtime?.vehicleType === 'string' &&
        runtime.vehicleType === 'File'
          ? 'file'
          : 'http',
      behavior:
        typeof runtime?.behavior === 'string'
          ? ((runtime.behavior.toLowerCase() === 'ipcidr'
              ? 'ipcidr'
              : runtime.behavior.toLowerCase() === 'classical'
                ? 'classical'
                : 'domain') as RuleProviderConfig['behavior'])
          : 'classical',
    }
    setFormTarget({ name, config })
  }

  if (!hasProviders && !canManageProviders) return null

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<StorageOutlined />}
        onClick={() => setOpen(true)}
      >
        {t('rules.page.provider.trigger')}
      </Button>

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 1,
            }}
          >
            <Typography variant="h6">
              {t('rules.page.provider.dialogTitle')}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              {canManageProviders && (
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddRounded />}
                  onClick={() => setFormTarget('add')}
                >
                  {t('rules.page.provider.actions.add')}
                </Button>
              )}
              <Button
                variant="contained"
                size="small"
                onClick={updateAllProviders}
              >
                {t('rules.page.provider.actions.updateAll')}
              </Button>
            </Box>
          </Box>
        </DialogTitle>

        <DialogContent>
          <List sx={{ py: 0, minHeight: 250 }}>
            {Object.entries(ruleProviders || {})
              .sort()
              .map(([key, item]) => {
                const provider = item
                const time = dayjs(provider.updatedAt)
                const isUpdating = updating[key]

                return (
                  <ListItem
                    key={key}
                    sx={[
                      {
                        p: 0,
                        mb: '8px',
                        borderRadius: 2,
                        overflow: 'hidden',
                        transition: 'all 0.2s',
                      },
                      ({ palette: { mode, primary } }) => {
                        const bgcolor = mode === 'light' ? '#ffffff' : '#24252f'
                        const hoverColor =
                          mode === 'light'
                            ? alpha(primary.main, 0.1)
                            : alpha(primary.main, 0.2)

                        return {
                          backgroundColor: bgcolor,
                          '&:hover': {
                            backgroundColor: hoverColor,
                            borderColor: alpha(primary.main, 0.3),
                          },
                        }
                      },
                    ]}
                  >
                    <ListItemText
                      sx={{ px: 2, py: 1 }}
                      primary={
                        <Box
                          sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <Typography
                            variant="subtitle1"
                            component="div"
                            noWrap
                            title={key}
                            sx={{ display: 'flex', alignItems: 'center' }}
                          >
                            <span style={{ marginRight: '8px' }}>{key}</span>
                            <TypeBox component="span">
                              {provider.ruleCount}
                            </TypeBox>
                          </Typography>

                          <Typography
                            variant="body2"
                            color="text.secondary"
                            noWrap
                          >
                            <small>{t('shared.labels.updateAt')}: </small>
                            {time.fromNow()}
                          </Typography>
                        </Box>
                      }
                      secondary={
                        <Box sx={{ display: 'flex' }}>
                          <TypeBox component="span">
                            {typeof provider.vehicleType === 'string'
                              ? provider.vehicleType
                              : provider.vehicleType.Unknown}
                          </TypeBox>
                          <TypeBox component="span">
                            {typeof provider.behavior === 'string'
                              ? provider.behavior
                              : provider.behavior.Unknown}
                          </TypeBox>
                        </Box>
                      }
                    />
                    <Divider orientation="vertical" flexItem />
                    <Box
                      sx={{
                        px: canManageProviders ? 1 : 0,
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => updateProvider(key)}
                        disabled={isUpdating}
                        aria-label={t('rules.page.provider.actions.update')}
                        sx={{
                          animation: isUpdating
                            ? 'spin 1s linear infinite'
                            : 'none',
                          '@keyframes spin': {
                            '0%': { transform: 'rotate(0deg)' },
                            '100%': { transform: 'rotate(360deg)' },
                          },
                        }}
                        title={t('rules.page.provider.actions.update')}
                      >
                        <RefreshRounded />
                      </IconButton>
                      {canManageProviders && (
                        <>
                          <IconButton
                            size="small"
                            onClick={() => handleOpenEdit(key)}
                            aria-label={t('shared.actions.edit')}
                            title={t('shared.actions.edit')}
                          >
                            <EditOutlined fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => handleDeleteProvider(key)}
                            aria-label={t('shared.actions.delete')}
                            title={t('shared.actions.delete')}
                          >
                            <DeleteOutlineRounded fontSize="small" />
                          </IconButton>
                        </>
                      )}
                    </Box>
                  </ListItem>
                )
              })}
          </List>
        </DialogContent>

        <DialogActions>
          <Button onClick={handleClose} variant="outlined">
            {t('shared.actions.close')}
          </Button>
        </DialogActions>
      </Dialog>

      {canManageProviders && (
        <ProviderFormDialog
          open={formTarget !== null}
          initialName={formTarget !== 'add' ? formTarget?.name : undefined}
          initialConfig={formTarget !== 'add' ? formTarget?.config : undefined}
          isNameTaken={(name) =>
            Object.prototype.hasOwnProperty.call(ruleProviders ?? {}, name)
          }
          onClose={() => setFormTarget(null)}
          onSubmit={handleSubmitProvider}
        />
      )}

      {deleteTarget && (
        <DeleteProviderDialog
          open={deleteTarget !== null}
          name={deleteTarget}
          referenceCount={findRuleProviderReferences(rules, deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
          onClearAndDelete={handleClearAndDelete}
        />
      )}
    </>
  )
}

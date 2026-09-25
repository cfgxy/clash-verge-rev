import {
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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  RuleProviderBehavior,
  RuleProviderConfig,
  RuleProviderSourceType,
} from '@/utils/rule-provider'

export interface ProviderFormValue {
  name: string
  config: RuleProviderConfig
}

interface ProviderFormDialogProps {
  open: boolean
  /** Present when editing an existing provider; name becomes read-only. */
  initialName?: string
  initialConfig?: RuleProviderConfig
  isNameTaken: (name: string) => boolean
  onClose: () => void
  onSubmit: (value: ProviderFormValue) => Promise<void> | void
}

const DEFAULT_CONFIG: RuleProviderConfig = {
  type: 'http',
  behavior: 'classical',
  url: '',
  path: '',
}

interface ProviderFormBodyProps {
  isEdit: boolean
  initialName?: string
  initialConfig?: RuleProviderConfig
  isNameTaken: (name: string) => boolean
  onClose: () => void
  onSubmit: (value: ProviderFormValue) => Promise<void> | void
}

/**
 * Mounted fresh (via `key`) each time the dialog opens, so form fields
 * initialize directly from props without a reset-on-open effect.
 */
const ProviderFormBody = ({
  isEdit,
  initialName,
  initialConfig,
  isNameTaken,
  onClose,
  onSubmit,
}: ProviderFormBodyProps) => {
  const { t } = useTranslation()

  const [name, setName] = useState(initialName ?? '')
  const [type, setType] = useState<RuleProviderSourceType>(
    initialConfig?.type ?? DEFAULT_CONFIG.type,
  )
  const [behavior, setBehavior] = useState<RuleProviderBehavior>(
    initialConfig?.behavior ?? DEFAULT_CONFIG.behavior,
  )
  const [url, setUrl] = useState(initialConfig?.url ?? '')
  const [path, setPath] = useState(initialConfig?.path ?? '')
  const [intervalValue, setIntervalValue] = useState(
    initialConfig?.interval ? String(initialConfig.interval) : '',
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('rules.modals.provider.form.validation.nameRequired'))
      return
    }
    if (!isEdit && isNameTaken(trimmedName)) {
      setError(t('rules.modals.provider.form.validation.nameDuplicate'))
      return
    }
    if (type === 'http' && !url.trim()) {
      setError(t('rules.modals.provider.form.validation.urlRequired'))
      return
    }
    if (type === 'file' && !path.trim()) {
      setError(t('rules.modals.provider.form.validation.pathRequired'))
      return
    }

    const config: RuleProviderConfig = {
      type,
      behavior,
      ...(type === 'http' ? { url: url.trim() } : {}),
      ...(path.trim() ? { path: path.trim() } : {}),
      ...(intervalValue.trim()
        ? { interval: Number(intervalValue.trim()) }
        : {}),
    }

    setSubmitting(true)
    try {
      await onSubmit({ name: trimmedName, config })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <DialogTitle>
        {isEdit
          ? t('rules.modals.provider.titleEdit')
          : t('rules.modals.provider.titleAdd')}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            autoFocus={!isEdit}
            label={t('rules.modals.provider.form.labels.name')}
            value={name}
            disabled={isEdit}
            onChange={(e) => setName(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            select
            label={t('rules.modals.provider.form.labels.type')}
            value={type}
            onChange={(e) => setType(e.target.value as RuleProviderSourceType)}
            size="small"
            fullWidth
          >
            <MenuItem value="http">
              {t('rules.modals.provider.form.options.type.http')}
            </MenuItem>
            <MenuItem value="file">
              {t('rules.modals.provider.form.options.type.file')}
            </MenuItem>
          </TextField>
          <TextField
            select
            label={t('rules.modals.provider.form.labels.behavior')}
            value={behavior}
            onChange={(e) =>
              setBehavior(e.target.value as RuleProviderBehavior)
            }
            size="small"
            fullWidth
          >
            <MenuItem value="domain">
              {t('rules.modals.provider.form.options.behavior.domain')}
            </MenuItem>
            <MenuItem value="ipcidr">
              {t('rules.modals.provider.form.options.behavior.ipcidr')}
            </MenuItem>
            <MenuItem value="classical">
              {t('rules.modals.provider.form.options.behavior.classical')}
            </MenuItem>
          </TextField>
          {type === 'http' && (
            <TextField
              label={t('rules.modals.provider.form.labels.url')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              size="small"
              fullWidth
            />
          )}
          <TextField
            label={t('rules.modals.provider.form.labels.path')}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            size="small"
            fullWidth
          />
          {type === 'http' && (
            <TextField
              label={t('rules.modals.provider.form.labels.interval')}
              value={intervalValue}
              onChange={(e) =>
                setIntervalValue(e.target.value.replace(/\D/gu, ''))
              }
              size="small"
              fullWidth
            />
          )}
          {error && (
            <Typography color="error" variant="body2">
              {error}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          {t('shared.actions.cancel')}
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {t('shared.actions.save')}
        </Button>
      </DialogActions>
    </>
  )
}

export const ProviderFormDialog = ({
  open,
  initialName,
  initialConfig,
  isNameTaken,
  onClose,
  onSubmit,
}: ProviderFormDialogProps) => {
  const isEdit = initialName !== undefined

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      {open && (
        <ProviderFormBody
          key={initialName ?? 'add'}
          isEdit={isEdit}
          initialName={initialName}
          initialConfig={initialConfig}
          isNameTaken={isNameTaken}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      )}
    </Dialog>
  )
}

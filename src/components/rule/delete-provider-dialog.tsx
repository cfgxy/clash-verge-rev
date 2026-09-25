import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material'
import { useTranslation } from 'react-i18next'

interface DeleteProviderDialogProps {
  open: boolean
  name: string
  referenceCount: number
  /** Clearing the references would empty the merge file's `rules:` key, reverting the whole rule override. */
  dropsRuleOverride: boolean
  onCancel: () => void
  onClearAndDelete: () => void
  onDelete: () => void
}

export const DeleteProviderDialog = ({
  open,
  name,
  referenceCount,
  dropsRuleOverride,
  onCancel,
  onClearAndDelete,
  onDelete,
}: DeleteProviderDialogProps) => {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogTitle>{t('rules.modals.deleteProvider.title')}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {referenceCount > 0
            ? t('rules.modals.deleteProvider.messageWithReference', {
                name,
                count: referenceCount,
              })
            : t('rules.modals.deleteProvider.messageNoReference', { name })}
        </DialogContentText>
        {dropsRuleOverride && (
          <DialogContentText sx={{ mt: 1 }} color="error">
            {t('rules.modals.deleteProvider.warningDropsRuleOverride')}
          </DialogContentText>
        )}
      </DialogContent>
      <DialogActions>
        {/* Cancel is the default/auto-focused action — deletion is irreversible. */}
        <Button onClick={onCancel} autoFocus variant="contained">
          {t('shared.actions.cancel')}
        </Button>
        {referenceCount > 0 ? (
          <Button onClick={onClearAndDelete} color="error">
            {t('rules.modals.deleteProvider.actions.clearAndDelete')}
          </Button>
        ) : (
          <Button onClick={onDelete} color="error">
            {t('shared.actions.delete')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

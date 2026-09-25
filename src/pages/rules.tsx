import { EditOutlined } from '@mui/icons-material'
import { Box, Button } from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  VirtualList,
  type VirtualListHandle,
} from '@/components/base'
import { ScrollTopButton } from '@/components/layout/scroll-top-button'
import { RulesEditorViewer } from '@/components/profile/rules-editor-viewer'
import { ProviderButton } from '@/components/rule/provider-button'
import RuleItem from '@/components/rule/rule-item'
import { useProfiles } from '@/hooks/use-profiles'
import { useVisibility } from '@/hooks/use-visibility'
import { useAppRefreshers, useRulesData } from '@/providers/app-data-context'

const RulesPage = () => {
  const { t } = useTranslation()
  const { rules = [] } = useRulesData()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()
  const { current } = useProfiles()
  const [match, setMatch] = useState(() => (_: string) => true)
  const virtuosoRef = useRef<VirtualListHandle>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [editRulesOpen, setEditRulesOpen] = useState(false)
  const pageVisible = useVisibility()
  const canEditRules = Boolean(current?.option?.rules)

  // 在组件挂载时和页面获得焦点时刷新规则数据
  useEffect(() => {
    refreshRules()
    refreshRuleProviders()

    if (pageVisible) {
      refreshRules()
      refreshRuleProviders()
    }
  }, [refreshRules, refreshRuleProviders, pageVisible])

  const filteredRules = useMemo(() => {
    const rulesWithLineNo = rules.map((item, index) => ({
      ...item,
      // UI-only derived data; keep app context/SWR data immutable
      lineNo: index + 1,
    }))

    return rulesWithLineNo.filter((item) => match(item.payload ?? ''))
  }, [rules, match])

  const handleScroll = useCallback((e: Event) => {
    setShowScrollTop((e.target as HTMLElement).scrollTop > 100)
  }, [])

  const scrollToTop = () => {
    virtuosoRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <BasePage
      full
      title={t('rules.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {canEditRules && (
            <Button
              variant="outlined"
              size="small"
              startIcon={<EditOutlined />}
              onClick={() => setEditRulesOpen(true)}
            >
              {t('rules.page.actions.editRules')}
            </Button>
          )}
          <ProviderButton />
        </Box>
      }
    >
      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: '10px',
          height: '36px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <BaseSearchBox onSearch={(match) => setMatch(() => match)} />
      </Box>

      {filteredRules && filteredRules.length > 0 ? (
        <>
          <VirtualList
            ref={virtuosoRef}
            count={filteredRules.length}
            estimateSize={40}
            renderItem={(i) => <RuleItem value={filteredRules[i]} />}
            style={{ flex: 1 }}
            onScroll={handleScroll}
          />
          <ScrollTopButton onClick={scrollToTop} show={showScrollTop} />
        </>
      ) : (
        <BaseEmpty />
      )}

      {current && editRulesOpen && (
        <RulesEditorViewer
          groupsUid={current.option?.groups ?? ''}
          mergeUid={current.option?.merge ?? ''}
          profileUid={current.uid}
          property={current.option?.rules ?? ''}
          open={editRulesOpen}
          onClose={() => setEditRulesOpen(false)}
          onSave={() => {
            refreshRules()
            refreshRuleProviders()
          }}
        />
      )}
    </BasePage>
  )
}

export default RulesPage

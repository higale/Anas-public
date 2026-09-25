import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodeReviewRequest } from '@shared/codeReview'
import type { GitChangeQuery } from '@shared/gitChanges'
import type { WorkspaceProject } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot } from '../DropdownMenuShell'
import { DiffView } from '../diff/DiffView'
import { AgentChangesPanel } from './AgentChangesPanel'
import { GitChangesPanel } from './GitChangesPanel'
import { PanelActionsTarget } from './PanelActions'
import { usePanelRef, usePanelState } from './PanelViewState'

type ChangesMode = GitChangeQuery['scope'] | 'recorded'

export function FileChangesPanel({ project, request, onReview }: {
  project?: WorkspaceProject
  request: { threadId?: string; runId?: string }
  onReview?(request: CodeReviewRequest): Promise<void>
}) {
  const { t } = useTranslation()
  const [mode, setMode] = usePanelState<ChangesMode>('changes.mode', request.runId || !project ? 'recorded' : 'workspace')
  const [runId, setRunId] = usePanelState('changes.run', request.runId ?? '')
  const [compareCurrent, setCompareCurrent] = usePanelState('changes.compareCurrent', false)
  const appliedRequest = usePanelRef<typeof request | undefined>('changes.appliedRequest', undefined)
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (appliedRequest.current === request) return
    appliedRequest.current = request
    if (request.runId) { setMode('recorded'); setRunId(request.runId) }
  }, [request, setMode, setRunId, appliedRequest])
  return <PanelActionsTarget.Provider value={actionsTarget}><DiffView>
    <section className="ui-detail-panel ui-diff-panel-shell">
      <div className="ui-detail-panel-controls ui-panel-toolbar">
        <DropdownMenuRoot>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="ui-tool-button ui-tool-button-label" aria-label={t('agent.changes_mode')}>
              <span>{t(`diff.scope_${mode}`)}</span><ChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenuContent className="ui-menu ui-menu-list" align="start" sideOffset={5} collisionPadding={10} restoreFocus>
              <DropdownMenu.RadioGroup value={mode} onValueChange={(next) => setMode(next as ChangesMode)}>
                {(['workspace', 'staged', 'unstaged', 'baseline'] as const).map((value) => (
                  <DropdownMenu.RadioItem className="ui-menu-item ui-menu-item-row" key={value} value={value} disabled={!project}>
                    <span>{t(`diff.scope_${value}`)}</span>
                    <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
                <DropdownMenu.Separator className="ui-menu-separator" />
                <DropdownMenu.RadioItem className="ui-menu-item ui-menu-item-row" value="recorded">
                  <span>{t('diff.scope_recorded')}</span>
                  <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </DropdownMenuContent>
          </DropdownMenu.Portal>
        </DropdownMenuRoot>
        <div ref={setActionsTarget} className="ui-row ui-row-tight ui-panel-actions" />
      </div>
      <div className="ui-diff-panel-content">
        {mode === 'recorded'
          ? request.threadId
            ? <AgentChangesPanel threadId={request.threadId} runId={runId} onRunChange={setRunId}
                compareCurrent={compareCurrent} onCompareCurrentChange={setCompareCurrent} onReview={onReview} />
            : <p className="ui-detail-panel-empty">{t('agent.changes_no_thread')}</p>
          : project ? <GitChangesPanel key={mode} project={project} scope={mode} onReview={onReview} />
            : <p className="ui-detail-panel-empty">{t('agent.git_no_folder')}</p>}
      </div>
    </section>
  </DiffView></PanelActionsTarget.Provider>
}

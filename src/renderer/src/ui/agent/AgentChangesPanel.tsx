import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileChangeRoundListResult, RoundFileChangesResult } from '@shared/fileChanges'
import type { CodeReviewRequest } from '@shared/codeReview'
import { CheckboxField } from '../CheckboxField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { DiffContentView } from '../diff/DiffContentView'
import { CodeReviewButton } from './CodeReviewButton'
import { usePanelScroll, usePanelState } from './PanelViewState'

export function AgentChangesPanel({ threadId, runId, onRunChange, compareCurrent, onCompareCurrentChange, onReview }: {
  threadId: string
  runId: string
  onRunChange(runId: string): void
  compareCurrent: boolean
  onCompareCurrentChange(value: boolean): void
  onReview?(request: CodeReviewRequest): Promise<void>
}) {
  const { t } = useTranslation()
  const [rounds, setRounds] = usePanelState<FileChangeRoundListResult['rounds']>(`round.candidates:${threadId}`, [])
  const [after, setAfter] = useState<number>()
  const [page, setPage] = useState<FileChangeRoundListResult>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const selection = useRef({ runId, onRunChange })
  selection.current = { runId, onRunChange }
  const reload = () => { setAfter(undefined); setRevision((value) => value + 1) }
  useEffect(() => {
    let active = true
    const requestId = crypto.randomUUID()
    setLoading(true); setError(undefined)
    void window.gale.agent.changes.rounds({ threadId, after, limit: 20, ...(runId ? { selectedRunId: runId } : {}) }, requestId).then((result) => {
      if (!active) return
      setRounds((current) => {
        let next = after === undefined ? result.rounds
          : [...current, ...result.rounds.filter((round) => !current.some((entry) => entry.runId === round.runId))]
        if (result.selectedRound === null) next = next.filter((round) => round.runId !== runId)
        const selected = result.selectedRound
        return selected && !next.some((round) => round.runId === selected.runId) ? [...next, selected] : next
      })
      setPage(result)
      if (selection.current.runId === runId && (!runId || result.selectedRound === null)) {
        if (after !== undefined) setAfter(undefined)
        selection.current.onRunChange(after === undefined ? result.rounds[0]?.runId ?? '' : '')
      }
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; void window.gale.agent.changes.cancelRead(requestId).catch(() => {}) }
  }, [threadId, runId, after, revision, setRounds])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; setAfter(undefined); setRevision((value) => value + 1) }, 250)
    }
    const unsubscribe = window.gale.agent.onEvent((event) => {
      const owner = 'threadId' in event ? event.threadId : 'run' in event ? event.run.threadId : undefined
      if (owner === threadId && ['file_changes', 'run_completed', 'run_cancelled', 'run_failed', 'run_settled'].includes(event.type)) invalidate()
    }, async () => { invalidate() }, invalidate)
    return () => { unsubscribe(); if (timer !== undefined) clearTimeout(timer) }
  }, [threadId])

  const options = rounds.map((round) => ({ value: round.runId,
    label: `${new Date(round.createdAt).toLocaleString()} · ${round.summary || t('agent.changes_untitled_round')}`,
    searchText: `${round.summary} ${round.createdAt} ${round.runId}` }))
  if (runId && !options.some((option) => option.value === runId)) {
    options.unshift({ value: runId, label: t('agent.changes_round_id', { id: runId.slice(0, 8) }), searchText: runId })
  }
  return <>
    <div className="ui-detail-panel-controls ui-stack ui-stack-tight">
      <SearchableOptionPicker ariaLabel={t('agent.changes_select_round')} emptyLabel={t('agent.changes_no_rounds')}
        inputPlaceholder={t(loading ? 'common.loading' : error ? 'agent.changes_select_round' : 'agent.changes_no_rounds')} value={runId} options={options}
        onChange={onRunChange} footer={page?.hasMore ? <div className="ui-page-section">
          <button type="button" className="ui-button ui-button-compact" disabled={loading}
            onClick={() => setAfter(page.nextAfter)}>{t(loading ? 'common.loading' : 'agent.changes_more_rounds')}</button>
        </div> : undefined} />
      <CheckboxField className="ui-checkbox-field-inline" checked={compareCurrent} onChange={onCompareCurrentChange}
        label={t('agent.changes_compare_current')} />
      <p className="ui-field-hint">{t(compareCurrent ? 'agent.current_changes_hint' : 'agent.recorded_changes_hint')}</p>
      {error && <p role="alert" className="ui-status-danger">{error}</p>}
    </div>
    {runId ? <RoundFiles key={`${threadId}:${runId}`} threadId={threadId} runId={runId} compareCurrent={compareCurrent}
      revision={revision} onRefresh={reload} onReview={onReview} /> : <>
      {!error && <p role="status" className="ui-detail-panel-empty">{t(loading ? 'common.loading' : 'agent.changes_no_rounds')}</p>}
      <footer className="ui-detail-panel-footer"><button className="ui-button ui-button-compact" disabled={loading} onClick={reload}>
        <RefreshCw size={14} />{t('common.refresh')}</button></footer>
    </>}
  </>
}

function RoundFiles({ threadId, runId, compareCurrent, revision, onRefresh, onReview }: {
  threadId: string; runId: string; compareCurrent: boolean; revision: number; onRefresh(): void
  onReview?(request: CodeReviewRequest): Promise<void>
}) {
  const { t } = useTranslation()
  const [filePath, setFilePath] = usePanelState(`round.file:${runId}`, '')
  const [cursors, setCursors] = useState<string[]>([''])
  const version = useRef<string | undefined>(undefined)
  const [pageRevision, setPageRevision] = useState(revision)
  const [result, setResult] = useState<{ key: string; data?: RoundFileChangesResult; error?: string }>()
  const [readyContent, setReadyContent] = useState<string>()
  const invalidated = pageRevision !== revision
  const after = invalidated ? '' : cursors[cursors.length - 1]
  const query = { threadId, runId, ...(after ? { after, version: version.current } : {}), limit: 20 }
  const key = JSON.stringify([query, revision])
  useEffect(() => {
    let active = true
    const requestId = crypto.randomUUID()
    if (invalidated) {
      setCursors(['']); version.current = undefined; setPageRevision(revision)
    }
    void window.gale.agent.changes.roundFiles(query, requestId).then((data) => {
      if (!active) return
      if (data.runId !== runId) throw new Error(t('agent.changes_scope_changed'))
      if (!after) version.current = data.version
      setResult({ key, data })
    }).catch((reason: unknown) => {
      if (active) setResult({ key, error: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { active = false; void window.gale.agent.changes.cancelRead(requestId).catch(() => {}) }
    // The request identity owns reads; selecting a file only loads that file's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const data = result?.key === key ? result.data : undefined
  const error = result?.key === key ? result.error : undefined
  const loading = result?.key !== key
  const selected = data?.files.find((file) => file.path === filePath) ?? data?.files[0]
  const target = compareCurrent ? 'current' : 'recorded'
  const contentKey = JSON.stringify([runId, selected?.path, data?.version, target, revision])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const onScroll = usePanelScroll(scrollRef, Boolean(data), true, `round.scroll:${runId}`)
  const reload = () => { setCursors(['']); version.current = undefined; onRefresh() }
  return <>
    <div className="ui-detail-panel-controls">
      {data?.issues.map((issue, index) => <p className="ui-status-danger" key={index}>{issue.reason}</p>)}
      {data?.pendingRunIds.length ? <p>{t('agent.changes_pending')}</p> : null}
    </div>
    <div className="ui-diff-browser">
      <div className="ui-diff-file-list ui-panel" ref={scrollRef} onScroll={onScroll} aria-label={t('diff.files')}>
        {loading && <p role="status">{t('common.loading')}</p>}
        {error && <p role="alert" className="ui-status-danger">{error}</p>}
        {data?.files.map((file) => <button type="button" className={`ui-list-item ui-diff-file ${file === selected ? 'ui-list-item-active' : ''}`}
          key={file.path} aria-pressed={file === selected} onClick={() => setFilePath(file.path)}>
          <span>{file.cancelledOut ? '=' : !file.beforeExists ? 'A' : !file.afterExists ? 'D' : 'M'}</span><span>{file.path}
            {file.continuity !== 'recorded' && <small> · {t(`agent.changes_${file.continuity}`)}</small>}</span>
        </button>)}
        {data?.files.length === 0 && <p>{t('agent.changes_empty')}</p>}
      </div>
      <div className="ui-diff-content">
        {data && selected && <DiffContentView key={revision} viewKey={`round:${runId}:${selected.path}:${target}`}
          onReadyChange={(ready) => setReadyContent(ready ? contentKey : undefined)}
          request={{ kind: 'recorded', input: { threadId, runId, filePath: selected.path, version: data.version, target } }} />}
      </div>
    </div>
    <footer className="ui-detail-panel-footer">
      {onReview && <CodeReviewButton onReview={onReview} disabled={loading || !selected || Boolean(selected.unavailableReason) || Boolean(data?.pendingRunIds.length) || readyContent !== contentKey}
        request={data && selected ? { kind: 'recorded', threadId, runId, filePath: selected.path, version: data.version, target } : undefined} />}
      {cursors.length > 1 && <button className="ui-button ui-button-compact" disabled={loading}
        onClick={() => setCursors((value) => value.slice(0, -1))}>{t('agent.changes_previous')}</button>}
      {data?.hasMore && <button className="ui-button ui-button-compact" disabled={loading}
        onClick={() => setCursors((value) => [...value, data.nextAfter!])}>{t('agent.changes_next')}</button>}
      <button className="ui-button ui-button-compact" disabled={loading} onClick={reload}><RefreshCw size={14} />{t('common.refresh')}</button>
    </footer>
  </>
}

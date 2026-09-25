import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceProject } from '@shared/types'
import type { GitChangeQuery, GitChangeResult, GitReadErrorCode } from '@shared/gitChanges'
import type { CodeReviewRequest } from '@shared/codeReview'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { CodeReviewButton } from './CodeReviewButton'
import { usePanelRef, usePanelScroll, usePanelState } from './PanelViewState'
import { GitBaselinePicker, type GitBaseline } from './GitBaselinePicker'
import { DiffContentView } from '../diff/DiffContentView'

export function GitChangesPanel({ project, scope, onReview }: { project: WorkspaceProject; scope: GitChangeQuery['scope']; onReview?(request: CodeReviewRequest): Promise<void> }) {
  const { t } = useTranslation()
  const [folder, setFolder] = usePanelState('folder', project.sourceFolders[0] ?? '')
  const validFolder = project.sourceFolders.includes(folder) ? folder : project.sourceFolders[0] ?? ''
  return <>
    <div className="ui-detail-panel-controls">
      {project.sourceFolders.length > 1 && <SearchableOptionPicker ariaLabel={t('project.source_folders')}
        emptyLabel={t('settings.no_options')} value={validFolder} options={project.sourceFolders.map((value) => ({ value, label: value }))} onChange={setFolder} />}
    </div>
    {validFolder ? <GitRepositoryChanges key={`${validFolder}:${scope}`} project={project} folder={validFolder} scope={scope} onReview={onReview} />
      : <p className="ui-detail-panel-empty">{t('agent.git_no_folder')}</p>}
  </>
}
function GitRepositoryChanges({ project, folder, scope, onReview }: { project: WorkspaceProject; folder: string; scope: GitChangeQuery['scope']; onReview?(request: CodeReviewRequest): Promise<void> }) {
  const { t } = useTranslation()
  const [baseline, setBaseline] = usePanelState<GitBaseline | undefined>(`baseline:${folder}`, undefined)
  const [cursors, setCursors] = usePanelState(`git.cursors:${folder}:${scope}`, [0])
  const [file, setFile] = usePanelState(`git.file:${folder}:${scope}`, '')
  const version = usePanelRef<string | undefined>(`git.version:${folder}:${scope}`, undefined)
  const head = usePanelRef<string | undefined>(`git.head:${folder}:${scope}`, undefined)
  const [ready, setReady] = useState(false), [refresh, setRefresh] = useState(0)
  const [referenceError, setReferenceError] = useState<GitReadErrorCode>()
  const [result, setResult] = useState<{ key: string; data?: GitChangeResult; error?: GitReadErrorCode }>()
  const after = cursors[cursors.length - 1]
  const query = { projectId: project.id, sourceFolder: folder, scope,
    ...(scope !== 'unstaged' && baseline?.commit ? { baseline: baseline.commit } : {}),
    ...(scope === 'baseline' && after && head.current ? { head: head.current } : {}),
    after, limit: 20, includePatch: false, ...(after ? { version: version.current } : {}) }
  const key = JSON.stringify([query, refresh, ready, referenceError])
  useEffect(() => {
    if (scope !== 'unstaged' && (!ready || referenceError)) return
    let active = true
    const requestId = crypto.randomUUID()
    void window.gale.agent.changes.git(query, requestId).then((data) => {
      if (!active) return
      if ('error' in data) { setResult({ key, error: data.error }); return }
      if (!after) { version.current = data.version; head.current = data.head ?? undefined }
      setResult({ key, data })
    }).catch(() => { if (active) setResult({ key, error: 'read_failed' }) })
    return () => { active = false; void window.gale.agent.changes.cancelRead(requestId).catch(() => {}) }
    // A serialized query prevents view-state renders from restarting the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const data = result?.key === key ? result.data : undefined
  const error = (scope !== 'unstaged' ? referenceError : undefined) ?? (result?.key === key ? result.error : undefined)
  const selected = data?.files.find((entry) => entry.path === file) ?? data?.files[0]
  const scroll = useRef<HTMLDivElement>(null), onScroll = usePanelScroll(scroll, Boolean(data), true, `git.scroll:${folder}:${scope}`)
  const reset = () => { setCursors([0]); setFile(''); version.current = undefined; head.current = undefined }
  return <>
    {error !== 'not_repository' && <div className="ui-detail-panel-controls ui-stack ui-stack-tight">
      {scope !== 'unstaged' && <div>
        <GitBaselinePicker key={refresh} projectId={project.id} sourceFolder={folder} value={baseline} onLoadError={setReferenceError} onChange={(next) => {
          if (baseline?.commit !== next.commit || baseline.repositoryRoot !== next.repositoryRoot) reset()
          setBaseline(next); setReady(true); setReferenceError(undefined)
        }} />
      </div>}
    </div>}
    {error ? <p role={error === 'not_repository' ? 'status' : 'alert'} className={`ui-detail-panel-empty${error === 'not_repository' ? '' : ' ui-status-danger'}`}>
      {t(`agent.git_${error}`)}
    </p> : !data ? <p role="status" className="ui-detail-panel-empty">{t('agent.git_loading')}</p> : null}
    {data && !error && <div className="ui-diff-browser">
    <div className="ui-diff-file-list ui-panel" ref={scroll} onScroll={onScroll} aria-label={t('diff.files')}>
      {data?.files.map((entry) => <button type="button" className={`ui-list-item ui-diff-file ${selected?.path === entry.path ? 'ui-list-item-active' : ''}`} key={entry.path}
        aria-pressed={selected?.path === entry.path} onClick={() => setFile(entry.path)}><span>{entry.status}</span><span>{entry.relativePath}</span></button>)}
      {data?.fileCount === 0 && <p>{t('agent.git_empty')}</p>}
    </div>
    <div className="ui-diff-content">
    {data && selected && <DiffContentView key={`${data.version}:${refresh}`} viewKey={`git:${folder}:${selected.path}:${scope}`}
      request={{ kind: 'git', input: { projectId: project.id, sourceFolder: folder, scope,
        filePath: selected.path, baseline: data.baseline, ...(scope === 'baseline' && data.head ? { head: data.head } : {}) } }} />}
    </div></div>}
    <footer className="ui-detail-panel-footer">
      {onReview && data && !error && <CodeReviewButton onReview={onReview} disabled={!selected} request={data && selected ? {
        kind: 'git', projectId: project.id, sourceFolder: folder, scope, filePath: selected.path, version: data.version,
        ...(data.baseline ? { baseline: data.baseline } : {}), ...(scope === 'baseline' && data.head ? { head: data.head } : {})
      } : undefined} />}
      {cursors.length > 1 && <button className="ui-button ui-button-compact" disabled={!data} onClick={() => setCursors((current) => current.slice(0, -1))}>{t('agent.changes_previous')}</button>}
      {data?.hasMore && <button className="ui-button ui-button-compact" onClick={() => setCursors((current) => [...current, data.nextAfter!])}>{t('agent.changes_next')}</button>}
      <button className="ui-button ui-button-compact" onClick={() => { reset(); setReady(false); setReferenceError(undefined); setRefresh((current) => current + 1) }}><RefreshCw size={14} />{t('common.refresh')}</button>
    </footer>
  </>
}

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitReadError, type GitReadErrorCode, type GitReference, type GitReferenceQuery } from '@shared/gitChanges'
import { SearchableOptionPicker } from '../SearchableOptionPicker'

export interface GitBaseline { value: string; label: string; commit: string | null; repositoryRoot: string }
export function GitBaselinePicker({ projectId, sourceFolder, value, onChange, onLoadError }: {
  projectId: string; sourceFolder: string; value?: GitBaseline; onChange(value: GitBaseline): void
  onLoadError?(error: GitReadErrorCode): void
}) {
  const { t } = useTranslation(), [entries, setEntries] = useState<GitReference[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<GitReadErrorCode>()
  const [history, setHistory] = useState<{ head?: string; count: number; more: boolean }>({ count: 0, more: true })
  const serial = useRef(0), request = useRef<string | undefined>(undefined), root = useRef('')
  const change = useRef(onChange), selected = useRef(value)
  const loadError = useRef(onLoadError)
  loadError.current = onLoadError
  change.current = onChange; selected.current = value
  const query = async (kind: GitReferenceQuery['kind'], ref?: string, after?: number) => {
    if (request.current) void window.gale.agent.changes.cancelRead(request.current).catch(() => {})
    const id = crypto.randomUUID(), generation = ++serial.current
    request.current = id; setBusy(true); setError(undefined)
    try {
      const result = await window.gale.agent.changes.gitReferences({ projectId, sourceFolder, kind, ref, after }, id)
      if (generation !== serial.current) return
      if ('error' in result) throw new GitReadError(result.error, result.error)
      root.current = result.repositoryRoot
      if (kind === 'refs') {
        setEntries(result.entries)
        const previous = selected.current
        if (previous?.repositoryRoot === result.repositoryRoot && previous.commit) {
          const resolved = await window.gale.agent.changes.gitReferences({ projectId, sourceFolder, kind: 'resolve', ref: previous.commit }, id)
          if (generation !== serial.current) return
          if ('error' in resolved) throw new GitReadError(resolved.error, resolved.error)
          change.current(previous)
        } else {
          const entry = result.entries.find((entry) => entry.value === 'HEAD')
          change.current({ value: entry?.value ?? 'HEAD', label: entry?.label ?? 'HEAD', commit: entry?.commit ?? null, repositoryRoot: result.repositoryRoot })
        }
      } else if (kind === 'history') {
        setEntries((current) => [...current, ...result.entries.filter((entry) => !current.some((item) => item.value === entry.value))])
        setHistory({ head: result.historyHead, count: (after ?? 0) + result.entries.length, more: result.hasMore })
      } else {
        const entry = result.entries[0]
        if (!entry) throw new GitReadError('invalid_commit', 'No resolved commit.')
        setEntries((current) => [...current.filter((item) => item.value !== entry.value), entry])
        change.current({ ...entry, repositoryRoot: result.repositoryRoot })
      }
    } catch (reason) {
      if (generation === serial.current) {
        const code = reason instanceof GitReadError ? reason.code : kind === 'resolve' ? 'invalid_commit' : 'read_failed'
        if (kind === 'refs' && loadError.current) loadError.current(code)
        else setError(code)
      }
    }
    finally { if (generation === serial.current) setBusy(false) }
  }
  useEffect(() => {
    setHistory({ count: 0, more: true }); setEntries([])
    void query('refs')
    return () => {
      // Invalidates an in-flight request, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++
      if (request.current) void window.gale.agent.changes.cancelRead(request.current).catch(() => {})
    }
    // Repository identity owns candidate loading; selection callbacks use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sourceFolder])
  const options = entries.map((entry) => ({ value: entry.value,
    label: entry.value === 'HEAD' ? t('diff.current_commit') : `${entry.group === 'history' ? `${entry.commit.slice(0, 8)} · ` : ''}${entry.label}${entry.current ? ` · ${t('diff.current_branch')}` : ''}`,
    group: t(`diff.group_${entry.group}`), searchText: `${entry.label} ${entry.value} ${entry.commit}` }))
  if (value && !options.some((entry) => entry.value === value.value)) options.unshift({ value: value.value,
    label: value.value === 'HEAD' ? t('diff.current_commit') : value.label, group: t('diff.group_head'), searchText: value.label })
  return <div className="ui-stack ui-stack-tight">
    <SearchableOptionPicker ariaLabel={t('diff.baseline')} emptyLabel={t('diff.no_refs')}
      onOpenChange={(open) => { if (open) { setHistory({ count: 0, more: true }); void query('refs') } }}
      value={value?.value ?? 'HEAD'} options={options} enterCommitsSearch commitSearchLabel={t('diff.verify_hash')}
      searchPlaceholder={t('diff.search_refs')} onChange={(next) => {
        const entry = entries.find((item) => item.value === next)
        if (entry) change.current({ ...entry, repositoryRoot: root.current })
        else void query('resolve', next)
      }} footer={<div className="ui-page-section"><button type="button" className="ui-button ui-button-compact"
        disabled={busy || !history.more || !entries.length} onClick={() => void query('history', history.head ?? entries.find((entry) => entry.value === 'HEAD')?.commit, history.count)}>
        {t(busy ? 'common.loading' : history.count ? 'diff.more_commits' : 'diff.load_commits')}</button></div>} />
    {error && <p role="alert" className="ui-status-danger">{t(`agent.git_${error}`)}</p>}
  </div>
}

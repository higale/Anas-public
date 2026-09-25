import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitContentInput } from '@shared/gitChanges'
import type { RoundFileContentInput } from '@shared/fileChanges'
import type { DiffContents } from '@shared/diffContents'
import { ReadonlyDiff } from './ReadonlyDiff'

export function DiffContentView({ request, viewKey, onReadyChange }: {
  request: { kind: 'git'; input: GitContentInput } | { kind: 'recorded'; input: RoundFileContentInput }
  viewKey: string
  onReadyChange?(ready: boolean): void
}) {
  const { t } = useTranslation()
  const identity = JSON.stringify(request)
  const [result, setResult] = useState<{ identity: string; data?: DiffContents; error?: string }>()
  const readyChange = useRef(onReadyChange)
  readyChange.current = onReadyChange
  useEffect(() => {
    let active = true
    const requestId = crypto.randomUUID()
    const current = JSON.parse(identity) as typeof request
    readyChange.current?.(false)
    const read = current.kind === 'git' ? window.gale.agent.changes.gitContents(current.input, requestId)
      : window.gale.agent.changes.roundContents(current.input, requestId)
    void read.then((data) => {
      if (active) { setResult({ identity, data }); readyChange.current?.(data.status === 'ready') }
    })
      .catch((error: unknown) => { if (active) setResult({ identity, error: error instanceof Error ? error.message : String(error) }) })
    return () => { active = false; void window.gale.agent.changes.cancelRead(requestId).catch(() => {}) }
  }, [identity])
  if (result?.identity !== identity) return <p role="status">{t('common.loading')}</p>
  if (result.error) return <p role="alert" className="ui-status-danger">{result.error}</p>
  return result.data ? <ReadonlyDiff key={identity} data={result.data} viewKey={viewKey} /> : null
}

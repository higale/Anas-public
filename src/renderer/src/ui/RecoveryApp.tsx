import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorDetail, type RecoveryFile, type RecoveryFileStatus, type RecoverySnapshot } from '@shared/recovery'
import { ConfirmDialog } from './dialogs/ConfirmDialog'
import type { ConfirmDialogRequest } from './dialogs/dialogTypes'

export function RecoveryApp() {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<RecoverySnapshot>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [confirmation, setConfirmation] = useState<ConfirmDialogRequest>()
  const [completed, setCompleted] = useState<Partial<Record<RecoveryFile, string>>>({})
  const [reports, setReports] = useState<Partial<Record<RecoveryFile, string>>>({})

  useEffect(() => {
    let current = true
    void window.gale.recovery.inspect().then(
      (value) => { if (current) setSnapshot(value) },
      (reason) => { if (current) setError(errorDetail(reason)) }
    )
    return () => { current = false }
  }, [])

  async function perform(action: () => Promise<unknown>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await action() } catch (reason) { setError(errorDetail(reason)) } finally {
      try { setSnapshot(await window.gale.recovery.inspect()) } catch (reason) { setError(errorDetail(reason)) }
      pending.current = false
      setBusy(false)
    }
  }

  function confirmReset(file: RecoveryFileStatus): void {
    if (!snapshot) return
    const project = file.name === 'projects.json'
    setConfirmation({
      title: t('recovery.reset_file', { file: file.name }), variant: 'danger',
      confirmText: t(project ? 'recovery.reset_projects_confirm_button' : 'recovery.reset'),
      description: project ? t('recovery.reset_projects_confirm', {
        path: file.path, catalog: snapshot.catalogPath, conversations: snapshot.conversationsPath,
        parent: snapshot.preservationParent
      }) : t('recovery.reset_confirm', {
        path: file.path, parent: snapshot.preservationParent, impact: t(`recovery.impact_${file.name.replace('.json', '')}`)
      }),
      onConfirm: () => perform(async () => {
        if (file.name === 'projects.json') await window.gale.recovery.resetProjects()
        else await window.gale.recovery.reset(file.name)
        setCompleted((current) => ({ ...current, [file.name]: t('recovery.file_reset') }))
        setReports((current) => ({ ...current, [file.name]: t('recovery.file_reset') }))
        setNotice(t('recovery.restart_hint'))
      })
    })
  }

  function confirmRepair(file: RecoveryFileStatus): void {
    setConfirmation({
      title: t('recovery.repair_file', { file: file.name }), confirmText: t('recovery.repair'),
      description: t('recovery.repair_confirm', { path: file.path, count: file.repairableFields.length }),
      onConfirm: () => perform(async () => {
        const result = await window.gale.recovery.repair(file.name)
        setReports((current) => ({ ...current, [file.name]: [
          t('recovery.repaired_fields'), ...result.repaired,
          t('recovery.unresolved_fields'), ...result.unresolved
        ].join('\n') }))
        if (result.unresolved.length) setError(result.unresolved.join('\n'))
        else {
          setCompleted((current) => ({ ...current, [file.name]: t('recovery.file_repaired') }))
          setNotice(t('recovery.restart_hint'))
        }
      })
    })
  }

  const files = snapshot?.files.filter((file) => file.error || file.repairableFields.length || completed[file.name]) ?? []
  const diagnostics = snapshot ? [
    snapshot.startupError, snapshot.stopError, snapshot.dataDir, snapshot.catalogPath, snapshot.conversationsPath,
    ...snapshot.files.map((file) => [file.path, file.error, ...file.repairableFields].filter(Boolean).join('\n')),
    ...Object.entries(reports).map(([file, report]) => `${file}\n${report}`)
  ].filter(Boolean).join('\n\n') : error

  return <div className="app-shell sidebar-collapsed workspace ui-window ui-fill">
    <header className="topbar"><strong>{t('recovery.title')}</strong></header>
    <main className="initial-app-gate initial-app-gate-below-titlebar">
      <section className="initial-app-status initial-app-status-error" aria-busy={busy}>
        <strong>{t('recovery.title')}</strong>
        <p>{t('recovery.description')}</p>
        {snapshot && <>
          {!snapshot.canModify && <div role="alert" className="ui-status-danger">
            <p>{t('recovery.stop_failed')}</p>
            <button className="ui-button" disabled={busy} onClick={() => void perform(() => window.gale.recovery.enter(snapshot.startupError))}>{t('recovery.retry_stop')}</button>
          </div>}
          <div className="initial-app-failure-list">
            {files.map((file) => {
              // Project reset removes metadata until restart; don't offer it twice.
              const done = file.name === 'projects.json' && completed[file.name] === t('recovery.file_reset')
                ? completed[file.name] : !file.error && !file.repairableFields.length ? completed[file.name] : undefined
              return <div className="initial-app-failure" key={file.name} role="group" aria-label={file.name}>
                <span>
                  <b>{file.name}</b>
                  {file.name === 'projects.json' && <>
                    <small>{snapshot.catalogPath}</small>
                    <small>{snapshot.conversationsPath}</small>
                  </>}
                  <small>{done || (file.repairableFields.length
                    ? t('recovery.file_repairable', { count: file.repairableFields.length }) : t('recovery.file_unrepairable'))}</small>
                </span>
                {!done && <div className="ui-row">
                  {file.repairableFields.length > 0 && <button className="ui-button ui-button-primary" disabled={busy || !snapshot.canModify} onClick={() => confirmRepair(file)}>{t('recovery.repair')}</button>}
                  <button className="ui-button ui-button-danger" disabled={busy || !snapshot.canModify} onClick={() => confirmReset(file)}>{t('recovery.reset')}</button>
                </div>}
              </div>
            })}
          </div>
          {!files.length && <p>{t('recovery.no_file_errors')}</p>}
        </>}
        {busy && <p role="status">{t('recovery.working')}</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p className="ui-status-danger" role="alert">{error}</p>}
        <button className="ui-button" disabled={busy} onClick={() => void perform(() => window.gale.recovery.restart())}>{t('recovery.restart')}</button>
        <details className="ui-disclosure ui-surface-flat">
          <summary>{t('recovery.details')}</summary>
          <div className="ui-page-section">
            <textarea className="ui-textarea ui-textarea-wrap" rows={4} readOnly value={diagnostics} aria-label={t('recovery.details')} />
            <div className="ui-toolbar">
              <button className="ui-button" disabled={busy} onClick={() => void perform(async () => {
                await navigator.clipboard.writeText(diagnostics)
                setNotice(t('recovery.copied'))
              })}>{t('recovery.copy')}</button>
              <button className="ui-button" disabled={busy} onClick={() => void perform(() => window.gale.recovery.openDirectory('data'))}>{t('recovery.open_data')}</button>
              <button className="ui-button" disabled={busy} onClick={() => void perform(() => window.gale.recovery.openDirectory('log'))}>{t('recovery.open_log')}</button>
            </div>
            {snapshot?.lastPreservationPath && <>
              <p className="ui-field-hint">{t('recovery.saved_at', { path: snapshot.lastPreservationPath })}</p>
              <button className="ui-button" disabled={busy} onClick={() => void perform(() => window.gale.recovery.openDirectory('preservation'))}>{t('recovery.open_preservation')}</button>
            </>}
          </div>
        </details>
      </section>
    </main>
    <ConfirmDialog request={confirmation} onClose={() => setConfirmation(undefined)} />
  </div>
}

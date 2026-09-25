import { LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorDetail } from '@shared/recovery'
import {
  criticalInitialAppResources,
  failedInitialAppResources,
  initialAppCriticalPhase,
  optionalInitialAppResources,
  type InitialAppLoadSnapshot,
  type InitialAppResource
} from './initialAppLoad'

interface InitialAppGateProps {
  snapshot: InitialAppLoadSnapshot
}

const resourceLabels: Record<InitialAppResource, string> = {
  projects: 'startup.resource_projects',
  config: 'startup.resource_config',
  inputHistory: 'startup.resource_input_history',
  buildInfo: 'startup.resource_build_info',
  icon: 'startup.resource_icon'
}

export function InitialAppGate({ snapshot }: InitialAppGateProps) {
  const { t } = useTranslation()
  const [actionError, setActionError] = useState('')
  const entering = useRef(false)
  const phase = initialAppCriticalPhase(snapshot)
  const settled = criticalInitialAppResources.every((resource) => ['ready', 'error'].includes(snapshot[resource].phase))
  const failures = failedInitialAppResources(snapshot, criticalInitialAppResources)
  const details = failures.map((resource) => `${t(resourceLabels[resource])}: ${snapshot[resource].error}`).join('\n').slice(0, 32_000)

  const enterRecovery = useCallback(async (): Promise<void> => {
    if (entering.current) return
    entering.current = true
    setActionError('')
    try {
      await window.gale.recovery.enter(details)
    } catch (reason) {
      entering.current = false
      setActionError(errorDetail(reason))
    }
  }, [details])

  useEffect(() => {
    // Collect both critical results before stopping services. The ref also
    // prevents duplicate navigation during StrictMode effect replay.
    if (phase === 'error' && settled) void enterRecovery()
  }, [phase, settled, enterRecovery])

  if (phase === 'ready') return null
  return <main className="initial-app-gate ui-main">
    {actionError ? <section className="initial-app-status initial-app-status-error" role="alert">
      <strong>{t('startup.failed_title')}</strong>
      <p>{actionError}</p>
      <button className="ui-button" onClick={() => void enterRecovery()}>{t('common.reload')}</button>
      <button className="ui-button" onClick={() => void window.gale.recovery.openDirectory('log').catch((reason) => setActionError(errorDetail(reason)))}>{t('recovery.open_log')}</button>
    </section> : <div className="initial-app-status" role="status" aria-live="polite">
      <LoaderCircle className="agent-spin" size={22} />
      <strong>{t(phase === 'error' && settled ? 'recovery.checking' : 'startup.loading')}</strong>
    </div>}
  </main>
}

interface AppIssueTrayProps {
  appError?: string
  snapshot: InitialAppLoadSnapshot
  onDismissAppError(): void
  onRetry(resource: InitialAppResource): void
}

export function AppIssueTray({ appError, snapshot, onDismissAppError, onRetry }: AppIssueTrayProps) {
  const { t } = useTranslation()
  const failures = failedInitialAppResources(snapshot, optionalInitialAppResources)
  if (!appError && failures.length === 0) return null

  return (
    <aside className="app-issue-tray" aria-label={t('startup.app_issues')}>
      {appError && (
        <div className="app-issue" role="alert">
          <span>{appError}</span>
          <button
            className="ui-tool-button ui-tool-button-small"
            type="button"
            aria-label={t('common.close')}
            onClick={onDismissAppError}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {failures.map((resource) => (
        <div className="app-issue" role="status" key={resource}>
          <span>
            <b>{t(resourceLabels[resource])}</b>
            <small>{snapshot[resource].error}</small>
          </span>
          <button className="ui-button ui-button-compact" type="button" onClick={() => onRetry(resource)}>
            <RotateCcw size={12} />
            {t('common.reload')}
          </button>
        </div>
      ))}
    </aside>
  )
}

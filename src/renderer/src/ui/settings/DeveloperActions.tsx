import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentActionError } from '../agent/agentErrorMessage'
import { notice } from '../notice'

export function DeveloperActions() {
  const { t } = useTranslation()
  const [restarting, setRestarting] = useState(false)

  async function toggleDevTools(): Promise<void> {
    try {
      await window.gale.app.toggleDevTools()
    } catch (error) {
      notice.error(agentActionError(t('chat.failed_load_app'), error))
    }
  }

  async function restartInConsole(): Promise<void> {
    if (restarting) return
    setRestarting(true)
    try {
      await window.gale.app.restartInConsole()
    } catch (error) {
      setRestarting(false)
      notice.error(agentActionError(t('settings.failed_restart_in_console'), error))
    }
  }

  return (
    <div className="ui-toolbar">
      <button className="ui-button ui-button-compact" type="button" onClick={() => void toggleDevTools()}>
        {t('menu.toggle_dev_tools')}
      </button>
      <button
        className="ui-button ui-button-compact"
        data-tooltip={t('settings.start_in_console_hint')}
        disabled={restarting}
        type="button"
        onClick={() => void restartInConsole()}
      >
        {t('settings.start_in_console')}
      </button>
    </div>
  )
}

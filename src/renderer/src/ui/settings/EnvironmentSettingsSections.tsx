import { Fragment, type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppSettings, EnvironmentContextSettings } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { CommitTextarea } from '../CommitTextField'
import { notice } from '../notice'
import { UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { EnvSettings } from './EnvSettings'
import { SettingsGroup } from './SettingsGroup'
import type { SettingsTab } from './settingsTabs'

interface EnvironmentSettingsSectionsProps {
  envDraft: string
  envPath?: string
  settings: AppSettings | undefined
  sectionClass: (tab: SettingsTab, extra?: string) => string
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onOpenEnvFile: () => void | Promise<void>
  onSaveSettings: (settings: Partial<AppSettings>) => void | Promise<void>
  onUpdateEnvDraft: (value: string) => void
}

const defaultEnvironmentContext = Object.freeze<EnvironmentContextSettings>({
  operatingSystem: true,
  powerShell: true,
  bundledCommands: true,
  currentDate: true,
  applicationDataDirectory: true,
  userHomeDirectory: true,
  customInformationEnabled: true,
  customInformation: ''
})

const environmentContextCheckboxKeys = Object.freeze([
  'operatingSystem',
  'currentDate',
  'applicationDataDirectory',
  'userHomeDirectory',
  'bundledCommands'
] satisfies Array<keyof EnvironmentContextSettings>)

export function EnvironmentSettingsSections({
  envDraft,
  envPath,
  settings,
  sectionClass,
  onAutosizeInput,
  onOpenEnvFile,
  onSaveSettings,
  onUpdateEnvDraft
}: EnvironmentSettingsSectionsProps) {
  const { t } = useTranslation()
  const environmentContext = settings?.environmentContext ?? defaultEnvironmentContext
  const environmentContextRef = useRef(environmentContext)
  const customInformationDraftRef = useRef(environmentContext.customInformation)
  const savedCustomInformationRef = useRef(environmentContext.customInformation)
  const [detectingEnvironment, setDetectingEnvironment] = useState(false)
  const windows = document.documentElement.dataset.platform === 'win32'
  environmentContextRef.current = environmentContext

  useEffect(() => {
    if (customInformationDraftRef.current === savedCustomInformationRef.current) {
      customInformationDraftRef.current = environmentContext.customInformation
    }
    savedCustomInformationRef.current = environmentContext.customInformation
  }, [environmentContext.customInformation])

  function updateCustomInformationDraft(value: string): void {
    customInformationDraftRef.current = value
  }

  async function detectEnvironment(): Promise<void> {
    if (detectingEnvironment) return
    setDetectingEnvironment(true)
    try {
      const detection = await window.gale.app.detectSystemEnvironment()
      if (!detection.content) {
        notice.info(t('settings.environment_detection_empty'))
        return
      }
      const current = customInformationDraftRef.current.trimEnd()
      const customInformation = current
        ? `${current}\n\n${detection.content}`
        : detection.content
      customInformationDraftRef.current = customInformation
      await onSaveSettings({
        environmentContext: {
          ...environmentContextRef.current,
          customInformation
        }
      })
    } catch {
      notice.error(t('settings.environment_detection_failed'))
    } finally {
      setDetectingEnvironment(false)
    }
  }

  function updateEnvironmentContext(
    feature: keyof EnvironmentContextSettings,
    enabled: boolean
  ): void {
    void onSaveSettings({
      environmentContext: {
        ...environmentContext,
        [feature]: enabled
      }
    })
  }

  return (
    <>
      <section className={sectionClass('environment')}>
        <SettingsGroup
          title={t('settings.environment_context')}
        >
          <div className="settings-agent-feature-list">
            {environmentContextCheckboxKeys.map((feature) => (
              <Fragment key={feature}>
                <CheckboxField
                  checked={environmentContext[feature]}
                  className="ui-checkbox-field-inline"
                  label={t(`settings.capability_${feature}`)}
                  tooltip={t(`settings.capability_${feature}_hint`)}
                  onChange={(enabled) => updateEnvironmentContext(feature, enabled)}
                />
                {feature === 'operatingSystem' && windows && (
                  <CheckboxField
                    checked={environmentContext.powerShell}
                    className="ui-checkbox-field-inline"
                    label={t('settings.capability_powerShell')}
                    tooltip={t('settings.capability_powerShell_hint')}
                    onChange={(enabled) => updateEnvironmentContext('powerShell', enabled)}
                  />
                )}
              </Fragment>
            ))}
          </div>
          <div className="ui-field-stack">
            <div className="ui-row-between">
              <CheckboxField
                checked={environmentContext.customInformationEnabled}
                className="ui-checkbox-field-inline"
                label={t('settings.custom_environment_information')}
                onChange={(customInformationEnabled) => void onSaveSettings({
                  environmentContext: { ...environmentContext, customInformationEnabled }
                })}
              />
              <button
                className="ui-button ui-button-compact"
                type="button"
                disabled={detectingEnvironment}
                onClick={() => void detectEnvironment()}
              >
                {t(detectingEnvironment
                  ? 'settings.detecting_system_environment'
                  : 'settings.detect_system_environment')}
              </button>
            </div>
            <CommitTextarea
              preserveDirtyDraft
              id="custom-environment-information-input"
              aria-label={t('settings.custom_environment_information')}
              className="ui-autosize-textarea ui-textarea-wrap ui-code-textarea"
              data-max-height="240"
              rows={UI_TEXTAREA_ROWS_COMPACT}
              value={environmentContext.customInformation}
              onInput={onAutosizeInput}
              onDraftChange={updateCustomInformationDraft}
              onCommit={(customInformation) => void onSaveSettings({
                environmentContext: { ...environmentContextRef.current, customInformation }
              })}
            />
          </div>
        </SettingsGroup>
      </section>
      <section className={sectionClass('environment')}>
        <EnvSettings
          envDraft={envDraft}
          envPath={envPath}
          onAutosizeInput={onAutosizeInput}
          onChange={onUpdateEnvDraft}
          onOpenEnvFile={onOpenEnvFile}
        />
      </section>
    </>
  )
}

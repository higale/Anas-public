import * as Dialog from '@radix-ui/react-dialog'
import { ClipboardCopy, FileJson, FileText, Save, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentModelRequestPreview, AgentSystemContextPreview } from '@shared/agentTypes'
import { summaryPromptForLanguage } from '@shared/summaryPrompt'
import type { AppSettings, ProjectCreateRequest } from '@shared/types'
import { getLanguageOptions, resolveLanguagePreference } from '../../i18n'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'

type PromptPreviewKind = 'system' | 'compression' | 'modelRequest'

interface ProjectPromptPreviewsProps {
  project: ProjectCreateRequest
  disabled?: boolean
  settings: AppSettings | undefined
  projectId?: string
}

export function ProjectPromptPreviews({
  project,
  disabled,
  settings,
  projectId
}: ProjectPromptPreviewsProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<PromptPreviewKind>()
  const [modelRequestPreview, setModelRequestPreview] = useState<AgentModelRequestPreview>()
  const [systemPreview, setSystemPreview] = useState<AgentSystemContextPreview>()
  const [previewFailed, setPreviewFailed] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const codingMode = project.kind === 'workspace' && project.codingMode
  const outputLanguageCode = resolveLanguagePreference(settings?.language)
  const outputLanguage = getLanguageOptions().find((language) => language.code === outputLanguageCode)
  const compressionPrompt = useMemo(() => summaryPromptForLanguage({
    code: outputLanguageCode,
    name: outputLanguage?.name ?? outputLanguageCode
  }, codingMode), [codingMode, outputLanguage?.name, outputLanguageCode])

  useEffect(() => {
    if ((kind !== 'system' && kind !== 'modelRequest') || !settings) return
    let cancelled = false
    setModelRequestPreview(undefined)
    setSystemPreview(undefined)
    setPreviewFailed(false)
    setPreviewLoading(true)
    void (async () => {
      try {
        const input = {
          projectId,
          project,
          settings
        }
        if (kind === 'system') {
          const preview = await window.gale.agent.context.preview(input)
          if (!cancelled) setSystemPreview(preview)
        } else {
          const preview = await window.gale.agent.context.previewModelRequest(input)
          if (!cancelled) setModelRequestPreview(preview)
        }
      } catch {
        if (!cancelled) setPreviewFailed(true)
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [kind, project, projectId, settings])

  const previewText = kind === 'compression'
    ? compressionPrompt
    : kind === 'modelRequest'
      ? modelRequestPreview?.content ?? ''
      : systemPreview?.content ?? ''
  const dynamicPreview = kind === 'system' || kind === 'modelRequest'
  const currentPreviewLoading = dynamicPreview && previewLoading
  const currentPreviewFailed = dynamicPreview && previewFailed
  const title = kind === 'compression'
    ? t('settings.context_compression_prompt')
    : kind === 'modelRequest'
      ? t('settings.model_request_preview')
      : t('settings.effective_system_context')
  const description = kind === 'compression'
    ? t('settings.context_compression_prompt_hint')
    : kind === 'modelRequest'
      ? t('settings.model_request_preview_hint')
      : t('settings.effective_system_context_hint')

  async function copyPreview(): Promise<void> {
    try {
      await navigator.clipboard.writeText(previewText)
      notice.success(t('chat.message_copied'))
    } catch {
      notice.error(t('chat.failed_copy_message'))
    }
  }

  async function saveModelRequest(): Promise<void> {
    try {
      const path = await window.gale.agent.context.saveModelRequest(previewText)
      if (path) notice.success(t('settings.model_request_saved', { path }))
    } catch {
      notice.error(t('settings.model_request_save_failed'))
    }
  }

  return (
    <>
      <div className="ui-row project-prompt-preview-actions">
        <button
          className="ui-button ui-button-compact"
          type="button"
          disabled={disabled || !settings || (project.kind === 'workspace' && !project.sourceFolders.length)}
          onClick={() => setKind('system')}
        >
          <FileText size={UI_ICON_SIZE_SMALL} />
          <span>{t('settings.view_effective_system_context')}</span>
        </button>
        <button
          className="ui-button ui-button-compact"
          type="button"
          disabled={disabled}
          onClick={() => setKind('compression')}
        >
          <FileText size={UI_ICON_SIZE_SMALL} />
          <span>{t('settings.view_context_compression_prompt')}</span>
        </button>
        <button
          className="ui-button ui-button-compact"
          type="button"
          disabled={disabled || !settings || (project.kind === 'workspace' && !project.sourceFolders.length)}
          onClick={() => setKind('modelRequest')}
        >
          <FileJson size={UI_ICON_SIZE_SMALL} />
          <span>{t('settings.view_model_request')}</span>
        </button>
      </div>

      <Dialog.Root open={kind !== undefined} onOpenChange={(open) => { if (!open) setKind(undefined) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="ui-backdrop" />
          <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-centered ui-popover settings-code-preview-dialog">
            <header className="ui-dialog-header">
              <div className="ui-dialog-icon">
                <FileText size={18} />
              </div>
              <div>
                <Dialog.Title asChild>
                  <h2 className="ui-dialog-title">{title}</h2>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <p className="ui-dialog-description">{description}</p>
                </Dialog.Description>
              </div>
            </header>

            <div className="settings-code-preview-content">
              {currentPreviewLoading
                ? <div className="ui-field-hint">{t('common.loading')}</div>
                : currentPreviewFailed
                  ? <div className="ui-status-danger">{t(kind === 'modelRequest' ? 'settings.model_request_failed' : 'settings.effective_system_context_failed')}</div>
                  : previewText
                    ? <pre className="ui-code-block settings-code-preview-code">{previewText}</pre>
                    : <div className="ui-field-hint">{t(kind === 'modelRequest' ? 'settings.model_request_empty' : 'settings.effective_system_context_empty')}</div>}
            </div>

            <footer className="ui-dialog-footer">
              {kind === 'modelRequest' && (
                <button
                  className="ui-button ui-button-compact"
                  type="button"
                  disabled={!previewText || currentPreviewLoading}
                  onClick={() => void saveModelRequest()}
                >
                  <Save size={UI_ICON_SIZE_SMALL} />
                  <span>{t('common.save')}</span>
                </button>
              )}
              <button
                className="ui-button ui-button-compact"
                type="button"
                disabled={!previewText || currentPreviewLoading}
                onClick={() => void copyPreview()}
              >
                <ClipboardCopy size={UI_ICON_SIZE_SMALL} />
                <span>{t('common.copy')}</span>
              </button>
              <Dialog.Close asChild>
                <button className="ui-button ui-button-compact" type="button">
                  <X size={UI_ICON_SIZE_SMALL} />
                  <span>{t('common.close')}</span>
                </button>
              </Dialog.Close>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

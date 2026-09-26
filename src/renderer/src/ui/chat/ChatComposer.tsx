import { useId, useState, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { MessageCircle, Plus, Send, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isSelectableModelConfig } from '@shared/modelConfig'
import type { AgentAccessMode, AgentContextStatus, AgentRunActivity, AgentTodo } from '@shared/agentTypes'
import type { AgentContextBudget } from '@shared/contextWindow'
import type { AppConfigSnapshot, Project, SelectedAttachment } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { ComposerAttachments } from './ComposerAttachments'
import { ComposerAccessPicker } from './ComposerAccessPicker'
import { ComposerContextMeter } from './ComposerContextMeter'
import { ModelPicker } from '../model/ModelPicker'
import { ModelParameterPresetPicker } from '../model/ModelParameterPresetPicker'
import { ComposerQueuedMessages } from './ComposerQueuedMessages'
import { ComposerSpeechReplyToggle } from './ComposerSpeechReplyToggle'
import { ComposerSpeechInputButton } from './ComposerSpeechInputButton'
import { ComposerSuggestions } from './ComposerSuggestions'
import type { ComposerSuggestion } from './composerTypes'
import { ProjectPicker } from '../projects/ProjectPicker'
import type { ProjectCreationKind } from '../projects/ProjectDialog'
import { AgentTaskPlan } from '../agent/AgentTaskPlan'
import {
  activeSubagentsForRun,
  AgentSubagentActivityDock
} from '../agent/AgentSubagentActivityDock'
import type { QueuedAgentMessage } from '../agent/useQueuedAgentMessages'

interface ChatComposerProps {
  attachments: SelectedAttachment[]
  config: AppConfigSnapshot | undefined
  defaultModelId?: string
  selectedModelParameterPresetId?: string
  contextCompressionBusy: boolean
  contextCompressionDisabled: boolean
  contextStatus?: AgentContextStatus
  contextBudget?: AgentContextBudget
  generationBusy: boolean
  locked: boolean
  dragActive: boolean
  accessMode: AgentAccessMode
  formRef: RefObject<HTMLFormElement | null>
  input: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  assistantName: string
  projects: Project[]
  queuedMessages: QueuedAgentMessage[]
  simpleChatEnabled: boolean
  submissionBusy: boolean
  run?: AgentRunActivity
  selectedProjectId: string
  projectSelectionDisabled: boolean
  showProjectPicker: boolean
  showSuggestions: boolean
  suggestions: ComposerSuggestion[]
  todos: AgentTodo[]
  onApplySuggestion: (suggestion: ComposerSuggestion) => void
  onAttachFiles: () => void | Promise<void>
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onCancelGeneration: () => void | Promise<void>
  onChangeAccessMode: (accessMode: AgentAccessMode) => void
  onChangeInput: (value: string) => void
  onChangeSpeechReplyEnabled: (enabled: boolean) => void | Promise<void>
  onCompressContext: () => void | Promise<void>
  onDragEnter: (event: DragEvent<HTMLFormElement>) => void
  onDragLeave: (event: DragEvent<HTMLFormElement>) => void
  onDragOver: (event: DragEvent<HTMLFormElement>) => void
  onDrop: (event: DragEvent<HTMLFormElement>) => void | Promise<void>
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onCreateProject: (kind: ProjectCreationKind) => void
  onOpenModelSettings: () => void | Promise<void>
  onOpenSubagent: (runId: string, subagentId: string) => void
  onRemoveAttachment: (path: string) => void
  onRemoveQueuedMessage: (message: QueuedAgentMessage) => void | Promise<unknown>
  onRetryQueuedMessage: (message: QueuedAgentMessage) => void | Promise<unknown>
  onToggleAttachmentContextPolicy: (path: string) => void
  onRemoveSuggestion: (text: string) => void | Promise<void>
  onSelectProject: (projectId: string) => void
  onSelectMainModel: (modelConfigId: string) => void | Promise<void>
  onSelectModelParameterPreset: (modelParameterPresetId: string | null) => void | Promise<void>
  onSetDefaultModel: (modelConfigId: string | null) => void | Promise<void>
  onSteerQueuedMessage: (message: QueuedAgentMessage, runId: string) => void | Promise<unknown>
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>
  onToggleSuggestionPinned: (text: string, pinned: boolean) => void | Promise<void>
}

export function ChatComposer({
  attachments,
  config,
  defaultModelId,
  selectedModelParameterPresetId,
  contextCompressionBusy,
  contextCompressionDisabled,
  contextStatus,
  contextBudget,
  generationBusy,
  locked,
  dragActive,
  accessMode,
  formRef,
  input,
  inputRef,
  assistantName,
  projects,
  queuedMessages,
  simpleChatEnabled,
  submissionBusy,
  run,
  selectedProjectId,
  projectSelectionDisabled,
  showProjectPicker,
  showSuggestions,
  suggestions,
  todos,
  onApplySuggestion,
  onAttachFiles,
  onAutosizeInput,
  onCancelGeneration,
  onChangeAccessMode,
  onChangeInput,
  onChangeSpeechReplyEnabled,
  onCompressContext,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  onKeyDown,
  onCreateProject,
  onOpenModelSettings,
  onOpenSubagent,
  onRemoveAttachment,
  onRemoveQueuedMessage,
  onRetryQueuedMessage,
  onToggleAttachmentContextPolicy,
  onRemoveSuggestion,
  onSelectProject,
  onSelectMainModel,
  onSelectModelParameterPreset,
  onSetDefaultModel,
  onSteerQueuedMessage,
  onSubmit,
  onToggleSuggestionPinned
}: ChatComposerProps) {
  const { t } = useTranslation()
  const suggestionsId = useId()
  const [suggestionSelection, setSuggestionSelection] = useState<{ id: string; input: string }>()
  const mainModelSelectable = Boolean(config?.defaultModel && isSelectableModelConfig(config.defaultModel))
  const visionBlocked = Boolean(
    attachments.some((attachment) => attachment.kind === 'image')
      && !config?.defaultModel?.capabilities.vision
  )
  const toolsEnabled = Boolean(
    !simpleChatEnabled && config?.defaultModel?.capabilities.toolUse
  )
  const messageDraftLocked = submissionBusy || (
    locked && !(run?.operation === 'agent' && run.status === 'running')
  )
  const modelSelectionLocked = submissionBusy
  const activeSuggestionIndex = showSuggestions && !messageDraftLocked && suggestionSelection?.input === input
    ? suggestions.findIndex((suggestion) => suggestion.id === suggestionSelection.id)
    : -1
  const applySuggestion = (suggestion: ComposerSuggestion): void => {
    setSuggestionSelection(undefined)
    inputRef.current?.focus()
    onApplySuggestion(suggestion)
  }
  const sendLabel = generationBusy
    ? t('chat.stop')
    : visionBlocked
      ? t('chat.vision_unsupported_attachment')
      : mainModelSelectable
      ? t('chat.send')
      : t('chat.select_model_before_send')

  return (
    <div className="composer-area">
      {showProjectPicker && (
        <ProjectPicker
          disabled={projectSelectionDisabled}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onCreateProject={onCreateProject}
          onSelectProject={onSelectProject}
        />
      )}
      {(todos.length > 0 || activeSubagentsForRun(run).length > 0) && (
        <div className="composer-activity-row">
          <AgentTaskPlan active={generationBusy} todos={todos} />
          <AgentSubagentActivityDock run={run} onOpenSubagent={onOpenSubagent} />
        </div>
      )}
      <div className="composer-input-stack">
        <ComposerQueuedMessages
          messages={queuedMessages}
          run={run}
          onRemove={onRemoveQueuedMessage}
          onRetry={onRetryQueuedMessage}
          onSteer={onSteerQueuedMessage}
        />
        <Popover.Root open={showSuggestions}>
          <Popover.Anchor asChild>
            <form
            ref={formRef}
            className={dragActive ? 'composer ui-surface drag-active' : 'composer ui-surface'}
            onSubmit={(event) => void onSubmit(event)}
            onDragEnter={(event) => {
              if (messageDraftLocked) {
                event.preventDefault()
                return
              }
              onDragEnter(event)
            }}
            onDragOver={(event) => {
              if (messageDraftLocked) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'none'
                return
              }
              onDragOver(event)
            }}
            onDragLeave={(event) => {
              if (messageDraftLocked) {
                event.preventDefault()
                return
              }
              onDragLeave(event)
            }}
            onDrop={(event) => {
              if (messageDraftLocked) {
                event.preventDefault()
                return
              }
              void onDrop(event)
            }}
          >
            <ComposerAttachments
              attachments={attachments}
              disabled={messageDraftLocked}
              onRemoveAttachment={onRemoveAttachment}
              onToggleAttachmentContextPolicy={onToggleAttachmentContextPolicy}
            />
            <textarea
              ref={inputRef}
              autoFocus
              className="ui-autosize-textarea composer-input"
              data-agent-composer-input
              data-max-height="150"
              data-min-rows="1"
              readOnly={messageDraftLocked}
              aria-controls={showSuggestions ? suggestionsId : undefined}
              aria-activedescendant={activeSuggestionIndex >= 0 ? `${suggestionsId}-${activeSuggestionIndex}` : undefined}
              aria-autocomplete="list"
              value={input}
              onInput={onAutosizeInput}
              onChange={(event) => {
                setSuggestionSelection(undefined)
                onChangeInput(event.target.value)
              }}
              onClick={() => setSuggestionSelection(undefined)}
              onBlur={() => setSuggestionSelection(undefined)}
              onCompositionStart={() => setSuggestionSelection(undefined)}
              onKeyDown={(event) => {
                if (messageDraftLocked) return
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
                if (showSuggestions && suggestions.length > 0 && unmodified) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const nextIndex = activeSuggestionIndex < 0
                      ? (event.key === 'ArrowDown' ? 0 : suggestions.length - 1)
                      : (activeSuggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length
                    setSuggestionSelection({ id: suggestions[nextIndex].id, input })
                    return
                  }
                  if (activeSuggestionIndex >= 0 && (event.key === 'Enter' || event.key === 'Escape')) {
                    event.preventDefault()
                    if (event.key === 'Enter') applySuggestion(suggestions[activeSuggestionIndex])
                    else setSuggestionSelection(undefined)
                    return
                  }
                }
                if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) setSuggestionSelection(undefined)
                onKeyDown(event)
              }}
              placeholder={simpleChatEnabled
                ? t('chat.simple_message_placeholder')
                : t('chat.message_placeholder', { name: assistantName })}
              rows={1}
            />
            <div className="composer-toolbar">
              <NoFocusButton
                className="composer-attachment-button ui-tool-button"
                type="button"
                aria-label={t('chat.attach_file')}
                data-tooltip={t('chat.attach_file')}
                disabled={messageDraftLocked}
                onClick={() => void onAttachFiles()}
              >
                <Plus size={16} />
              </NoFocusButton>
              {simpleChatEnabled
                ? (
                    <span className="composer-simple-mode">
                      <MessageCircle size={14} />
                      <span>{t('chat.simple_chat_mode')}</span>
                    </span>
                  )
                : (
                    <ComposerAccessPicker
                      disabled={locked || !toolsEnabled}
                      accessMode={accessMode}
                      onChange={onChangeAccessMode}
                    />
                  )}
              <span className="composer-toolbar-spacer" />
              <ComposerSpeechReplyToggle
                disabled={!config}
                enabled={config?.settings.speechReply.enabled ?? false}
                onChange={onChangeSpeechReplyEnabled}
              />
              <ComposerContextMeter
                compressionBusy={contextCompressionBusy}
                disabled={contextCompressionDisabled}
                status={contextStatus}
                budget={contextBudget}
                onCompress={onCompressContext}
              />
              <div className="composer-model-selection-group">
                <ModelPicker
                  providers={config?.providers}
                  selectedId={config?.defaultModelId ?? config?.defaultModel?.id}
                  defaultModelId={defaultModelId}
                  disabled={modelSelectionLocked}
                  focusRef={inputRef}
                  onOpenModelSettings={onOpenModelSettings}
                  onSelect={onSelectMainModel}
                  onSetDefault={onSetDefaultModel}
                />
                <ModelParameterPresetPicker
                  disabled={modelSelectionLocked}
                  focusRef={inputRef}
                  model={config?.defaultModel}
                  selectedId={selectedModelParameterPresetId}
                  onSelect={onSelectModelParameterPreset}
                />
              </div>
              <ComposerSpeechInputButton
                inputRef={inputRef}
                disabled={messageDraftLocked}
              />
              <NoFocusButton
                className="composer-send-button ui-tool-button ui-tool-button-round ui-button-primary"
                type={generationBusy ? 'button' : 'submit'}
                disabled={!generationBusy && (
                  locked
                  || !mainModelSelectable
                  || visionBlocked
                  || (!input.trim() && attachments.length === 0)
                )}
                aria-label={sendLabel}
                data-tooltip={sendLabel}
                onClick={generationBusy ? () => void onCancelGeneration() : undefined}
              >
                {generationBusy ? <Square size={14} /> : <Send size={15} />}
              </NoFocusButton>
            </div>
            </form>
          </Popover.Anchor>
          <ComposerSuggestions
            formRef={formRef}
            id={suggestionsId}
            activeIndex={activeSuggestionIndex}
            showSuggestions={showSuggestions}
            suggestions={suggestions}
            onApplySuggestion={applySuggestion}
            onRemoveSuggestion={onRemoveSuggestion}
            onToggleSuggestionPinned={onToggleSuggestionPinned}
          />
        </Popover.Root>
      </div>
    </div>
  )
}

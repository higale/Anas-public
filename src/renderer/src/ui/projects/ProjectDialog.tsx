import { defaultSubagentSelection } from '@shared/subagentSelection'
import * as Dialog from '@radix-ui/react-dialog'
import { Folder, FolderPlus, Plus, Save, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isDefaultWorkspaceProject,
  type AppConfigSnapshot,
  type Project,
  type ProjectCreateRequest,
  type ProjectIconColor,
  type ProjectIconName,
  type ProjectKind
} from '@shared/types'
import { findProviderModelConfig } from '@shared/modelConfig'
import { unwrapProjectResult } from '@shared/projectOperation'
import { projectErrorDescription } from './projectErrorDescription'
import { defaultCapabilitySettings, defaultCapabilities, defaultProjectSettings, defaultRestrictSubagents, removeEmptyMissingMcpSelections } from '@shared/agentCapabilities'
import type { SkillSnapshot, McpToolStatus, RuntimeToolStatus } from '@shared/types'
import { CapabilityEditor } from '../CapabilityEditor'
import { notice } from '../notice'
import { CheckboxField } from '../CheckboxField'
import { ModelPicker } from '../model/ModelPicker'
import { ModelParameterPresetPicker } from '../model/ModelParameterPresetPicker'
import { projectDraftModelSelection } from '@shared/draftModelSelection'
import { dataTransferHasFiles } from '../dragDrop'
import { ProjectAppearancePicker } from './ProjectAppearancePicker'
import { getSourceFolderName } from './projectName'
import { ProjectPromptPreviews } from './ProjectPromptPreviews'
import { defaultProjectIcon } from '@shared/projectAppearance'
import { CommitTextarea } from '../CommitTextField'
import { UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'

export type ProjectCreationKind = ProjectKind | 'coding'

interface ProjectDialogProps {
  open: boolean
  kind: ProjectCreationKind
  project?: Project
  config?: AppConfigSnapshot
  onClose: () => void
  onSave: (request: ProjectCreateRequest) => Promise<Project>
}

export function ProjectDialog({ open, kind, project, config, onClose, onSave }: ProjectDialogProps) {
  const { t } = useTranslation()
  const nameInputId = useId()
  const promptInputId = useId()
  const defaultsRef = useRef(config?.defaultCapabilities ?? defaultCapabilitySettings)
  defaultsRef.current = config?.defaultCapabilities ?? defaultCapabilitySettings
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<ProjectIconName>()
  const [iconColor, setIconColor] = useState<ProjectIconColor>()
  const [projectTools, setProjectTools] = useState<import('@shared/toolPackages').ToolPackage[]>([])
  const [sourceFolders, setSourceFolders] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [advancedSettings, setAdvancedSettings] = useState(defaultProjectSettings.advancedSettings)
  const [codingMode, setCodingMode] = useState(defaultProjectSettings.codingMode)
  const [capabilities, setCapabilities] = useState(() => structuredClone(defaultCapabilities))
  const [subagentSelection, setSubagentSelection] = useState(() => structuredClone(defaultSubagentSelection))
  const [restrictSubagents, setRestrictSubagents] = useState(defaultRestrictSubagents)
  const [skills, setSkills] = useState<SkillSnapshot>()
  const [mcpStatus, setMcpStatus] = useState<McpToolStatus>()
  const [runtimeToolStatus, setRuntimeToolStatus] = useState<RuntimeToolStatus>()
  const [modelConfigId, setModelConfigId] = useState<string>()
  const [modelParameterPresetId, setModelParameterPresetId] = useState<string | null>()
  const [busy, setBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const editing = Boolean(project)
  const defaultWorkspace = project ? isDefaultWorkspaceProject(project) : false
  const projectKind = project?.kind ?? (kind === 'coding' ? 'workspace' : kind)
  const simpleChat = projectKind === 'simple_chat'
  const selection = projectDraftModelSelection(config?.providers, { modelConfigId, modelParameterPresetId })
  const selectedModel = findProviderModelConfig(config?.providers ?? [], selection?.modelConfigId)
  const draft = useMemo<ProjectCreateRequest>(() => {
    const preferences = {
      name: name.trim() || t('project.untitled_name'),
      ...(icon ? { icon } : {}),
      ...(iconColor ? { iconColor } : {}),
      ...(modelConfigId ? { modelConfigId, modelParameterPresetId } : {})
    }
    return simpleChat
      ? { ...preferences, kind: 'simple_chat', prompt }
      : { ...preferences, kind: 'workspace', sourceFolders,
        ...(subagentSelection.mode === 'custom' || subagentSelection.names.length ? { subagentSelection } : {}),
        capabilities: config ? removeEmptyMissingMcpSelections(capabilities, new Set(config.mcpServers.map((server) => server.id))) : capabilities,
        restrictSubagents, prompt, advancedSettings, codingMode }
  }, [advancedSettings, capabilities, codingMode, config, icon, iconColor, modelConfigId,
    modelParameterPresetId, name, prompt, restrictSubagents, simpleChat, sourceFolders, subagentSelection, t])

  useEffect(() => {
    if (!open) return
    const initialCodingMode = project?.kind === 'workspace' ? project.codingMode : kind === 'coding' || defaultProjectSettings.codingMode
    setName(project?.name ?? '')
    setIcon(project ? project.icon : initialCodingMode ? defaultProjectIcon(projectKind, initialCodingMode) : undefined)
    setIconColor(project?.iconColor)
    setSourceFolders(project?.kind === 'workspace' ? project.sourceFolders : [])
    setPrompt(project?.prompt ?? defaultProjectSettings.prompt)
    setAdvancedSettings(project?.kind === 'workspace' ? project.advancedSettings : defaultProjectSettings.advancedSettings)
    setCodingMode(initialCodingMode)
    const defaults = defaultsRef.current
    setCapabilities(structuredClone(project?.kind === 'workspace' ? project.capabilities : defaults.capabilities))
    setSubagentSelection(structuredClone(project?.kind === 'workspace' ? project.subagentSelection ?? defaultSubagentSelection : defaults.subagentSelection))
    setRestrictSubagents(project?.kind === 'workspace' ? project.restrictSubagents : defaults.restrictSubagents)
    setModelConfigId(project?.modelConfigId)
    setModelParameterPresetId(project?.modelParameterPresetId)
    setBusy(false)
    dragDepthRef.current = 0
    setDragActive(false)
  }, [open, project, kind, projectKind])

  function updateCodingMode(next: boolean): void {
    if ((icon ?? defaultProjectIcon(projectKind)) === defaultProjectIcon(projectKind, codingMode)) {
      setIcon(defaultProjectIcon(projectKind, next))
    }
    setCodingMode(next)
  }

  useEffect(() => {
    if (!open || simpleChat) return
    let disposed = false
    let receivedMcpStatus = false
    setMcpStatus(undefined)
    setRuntimeToolStatus(undefined)
    const unsubscribe = window.gale.mcp.onStatus((status) => {
      receivedMcpStatus = true
      if (!disposed) setMcpStatus(status)
    })
    void Promise.all([window.gale.mcp.status(), window.gale.app.getRuntimeTools()])
      .then(([mcp, tools]) => {
        if (disposed) return
        if (!receivedMcpStatus) setMcpStatus(mcp ?? undefined)
        setRuntimeToolStatus(tools)
      }).catch((reason) => { if (!disposed) notice.error(t('chat.failed_load_app'), { description: projectErrorDescription(reason, t) }) })
    return () => { disposed = true; unsubscribe() }
  }, [open, simpleChat, project?.id, t])

  useEffect(() => {
    if (!open || simpleChat) return
    let disposed = false
    setSkills(undefined)
    void window.gale.skills.get(project?.id, sourceFolders)
      .then((snapshot) => { if (!disposed) setSkills(snapshot) })
      .catch((reason) => { if (!disposed) notice.error(t('chat.failed_load_app'), { description: projectErrorDescription(reason, t) }) })
    return () => { disposed = true }
  }, [open, simpleChat, project?.id, sourceFolders, t])
  useEffect(() => {
    let cancelled = false
    setProjectTools([])
    if (open && !simpleChat) void window.gale.tools.get(project?.id, sourceFolders).then(snapshot => {
      if (!cancelled) setProjectTools(snapshot.tools)
    }).catch(error => { if (!cancelled) notice.error(t('custom_tools.update_failed'), { description: String(error) }) })
    return () => { cancelled = true }
  }, [open, simpleChat, project?.id, sourceFolders, config?.customTools, t])


  function appendSourceFolders(folders: string[]): void {
    if (!editing && sourceFolders.length === 0 && folders.length > 0) {
      setName((current) => current.trim() ? current : getSourceFolderName(folders[0]))
    }
    setSourceFolders((current) => Array.from(new Set([...current, ...folders])))
  }

  function setPrimarySourceFolder(folder: string): void {
    setSourceFolders((current) => [folder, ...current.filter((item) => item !== folder)])
  }

  async function chooseSourceFolders(): Promise<void> {
    try {
      const selected = unwrapProjectResult(await window.gale.projects.chooseSourceFolders())
      if (selected.length === 0) return
      appendSourceFolders(selected)
    } catch (reason) {
      notice.error(t('project.failed_choose_folders'), { description: projectErrorDescription(reason, t) })
    }
  }

  function handleDragEnter(event: DragEvent<HTMLButtonElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  async function handleDrop(event: DragEvent<HTMLButtonElement>): Promise<void> {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) return
    try {
      const selected = unwrapProjectResult(await window.gale.projects.fromDroppedFiles(droppedFiles))
      appendSourceFolders(selected)
    } catch (reason) {
      notice.error(t('project.failed_drop_folders'), { description: projectErrorDescription(reason, t) })
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if ((!simpleChat && sourceFolders.length === 0) || busy) return
    setBusy(true)
    try {
      await onSave(draft)
      onClose()
    } catch (reason) {
      notice.error(t(editing ? 'project.failed_update' : 'project.failed_create'), { description: projectErrorDescription(reason, t) })
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          asChild
          className={`ui-dialog ui-dialog-medium ui-dialog-font-scaled ui-dialog-centered ui-dialog-fixed-footer ui-popover project-dialog${!simpleChat && advancedSettings ? ' ui-dialog-split' : ''}`}
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            nameInputRef.current?.focus({ preventScroll: true })
          }}
        >
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="ui-dialog-body ui-dialog-panes">
              <div className="ui-dialog-pane ui-dialog-pane-with-footer">
                <div className="ui-form-section ui-form-section-fill">
                  <header className="ui-dialog-header">
                    <ProjectAppearancePicker
                      color={iconColor}
                      icon={icon}
                      kind={projectKind}
                      onChangeColor={setIconColor}
                      onChangeIcon={setIcon}
                    />
                    <div>
                      <div className="project-dialog-title-row">
                        <Dialog.Title asChild>
                          <h2 className="ui-dialog-title">{t(simpleChat
                            ? editing ? 'project.edit_simple_chat_title' : 'project.create_simple_chat_title'
                            : editing ? 'project.edit_title' : kind === 'coding' ? 'project.create_coding_title' : 'project.create_title')}</h2>
                        </Dialog.Title>
                        {defaultWorkspace && <span className="project-default-badge">{t('common.default')}</span>}
                      </div>
                      <Dialog.Description asChild>
                        <p className="ui-dialog-description">
                          {t(simpleChat
                            ? editing ? 'project.edit_simple_chat_description' : 'project.create_simple_chat_description'
                            : editing ? 'project.edit_description' : 'project.create_description')}
                        </p>
                      </Dialog.Description>
                    </div>
                  </header>

                  <div className="ui-field-stack">
                    <label htmlFor={nameInputId}>{t('project.name')}</label>
                    <input
                      className="ui-input"
                      id={nameInputId}
                      ref={nameInputRef}
                      value={name}
                      maxLength={80}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t('project.name_placeholder')}
                    />
                  </div>

                  {!simpleChat && advancedSettings && <label className="ui-field-stack ui-field-stack-fill">
                    <span>{t('project.prompt')}</span>
                    <textarea className="ui-textarea ui-textarea-fixed ui-code-textarea ui-textarea-wrap" value={prompt}
                      maxLength={50_000} rows={2} disabled={busy} onChange={(event) => setPrompt(event.target.value)} />
                  </label>}

                  <section className="ui-field-stack">
                    <div className="ui-row-between">
                      {simpleChat ? (
                        <label className="ui-field-label" htmlFor={promptInputId}>{t('project.simple_chat_prompt')}</label>
                      ) : (
                        <span className="ui-field-label">{t('project.source_folders')}</span>
                      )}
                      <div className="composer-model-selection-group">
                        <ModelPicker
                          modal
                          providers={config?.providers}
                          selectedId={selection?.modelConfigId}
                          defaultModelId={config?.defaultModelId}
                          disabled={busy || !config}
                          onClear={() => {
                            setModelConfigId(undefined)
                            setModelParameterPresetId(undefined)
                          }}
                          onSelect={(id) => {
                            setModelConfigId(id)
                            setModelParameterPresetId(findProviderModelConfig(config?.providers ?? [], id)?.defaultParameterPresetId ?? null)
                          }}
                        />
                        <ModelParameterPresetPicker
                          modal
                          disabled={busy}
                          model={selectedModel}
                          selectedId={selection?.modelParameterPresetId ?? undefined}
                          onSelect={setModelParameterPresetId}
                        />
                      </div>
                    </div>

                    {simpleChat ? (
                      <CommitTextarea
                        id={promptInputId}
                        className="ui-autosize-textarea ui-code-textarea ui-textarea-wrap project-prompt-input"
                        value={prompt}
                        maxLength={50_000}
                        rows={UI_TEXTAREA_ROWS_COMPACT}
                        disabled={busy}
                        onDraftChange={setPrompt}
                        onCommit={setPrompt}
                        placeholder={t('project.simple_chat_prompt_placeholder')}
                      />
                    ) : <>
                      <button
                        className={dragActive ? 'project-folder-add drag-active' : 'project-folder-add'}
                        type="button"
                        onClick={() => void chooseSourceFolders()}
                        onDragEnter={handleDragEnter}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={(event) => void handleDrop(event)}
                        disabled={busy}
                      >
                        <FolderPlus size={18} />
                        <span>{t(dragActive ? 'project.drop_folders' : 'project.add_folders')}</span>
                      </button>
                      {sourceFolders.length > 0 && (
                        <div className="project-folder-list">
                          {sourceFolders.map((folder, index) => (
                            <div
                              className="project-folder-item"
                              data-multiple={sourceFolders.length > 1 ? true : undefined}
                              key={folder}
                            >
                              <Folder size={15} />
                              <span className="ui-truncate">{folder}</span>
                              {sourceFolders.length > 1 && (index === 0 ? (
                                <span className="project-folder-primary-badge">{t('project.primary_folder')}</span>
                              ) : (
                                <button
                                  className="project-folder-set-primary"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setPrimarySourceFolder(folder)}
                                >
                                  {t('project.set_primary_folder')}
                                </button>
                              ))}
                              <button
                                className="ui-icon-button"
                                type="button"
                                disabled={busy}
                                aria-label={t('project.remove_folder', { folder })}
                                onClick={() => setSourceFolders((folders) => folders.filter((item) => item !== folder))}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>}
                  </section>
                </div>
                {open && <ProjectPromptPreviews project={draft} projectId={project?.id} settings={config?.settings} disabled={busy} />}
              </div>
              {!simpleChat && advancedSettings && <section className="ui-dialog-pane ui-form-section" aria-label={t('settings.capabilities')}>
                <h3 className="ui-dialog-title">{t('settings.capabilities')}</h3>
                <CapabilityEditor customTools={projectTools} value={capabilities} skills={skills} mcpStatus={mcpStatus} mcpServers={config?.mcpServers} runtimeToolStatus={runtimeToolStatus} disabled={busy}
                  subagentSelection={{ value: subagentSelection, definitions: config?.subagents ?? [], onChange: setSubagentSelection }}
                  onChange={setCapabilities} onEnableAll={(enabled) => { setCapabilities(enabled); setRestrictSubagents(false); setSubagentSelection((current) => ({ ...current, mode: 'default' })) }}
                  toolbarEnd={<CheckboxField className="ui-checkbox-field-inline" checked={restrictSubagents} disabled={busy} label={t('capabilities.restrict_subagents')}
                    tooltip={t('capabilities.restrict_subagents_hint')} onChange={setRestrictSubagents} />} />
              </section>}
            </div>

            <footer className="ui-dialog-footer">
              {!simpleChat && <div className="ui-row ui-row-lg ui-dialog-footer-start">
                <CheckboxField className="ui-checkbox-field-inline" checked={codingMode} disabled={busy}
                  label={t('project.coding_mode')} onChange={updateCodingMode} />
                <CheckboxField className="ui-checkbox-field-inline" checked={advancedSettings}
                  disabled={busy} label={t('project.advanced_settings')} onChange={setAdvancedSettings} />
              </div>}
              <Dialog.Close asChild>
                <button className="ui-button ui-button-compact" type="button" disabled={busy}>
                  <X size={14} />
                  <span>{t('common.cancel')}</span>
                </button>
              </Dialog.Close>
              <button
                className="ui-button ui-button-compact ui-button-primary"
                type="submit"
                disabled={busy || (!simpleChat && sourceFolders.length === 0)}
              >
                {editing ? <Save size={14} /> : <Plus size={14} />}
                <span>{t(editing ? 'common.save' : simpleChat ? 'project.create_simple_chat' : 'project.create')}</span>
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

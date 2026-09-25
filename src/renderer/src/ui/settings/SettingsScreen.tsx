import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { CapabilitySettings } from './CapabilitySettings'
import type { DragEvent, FormEvent, RefObject } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AppAvatarImage,
  AppConfigSnapshot,
  AppProfileUpdate,
  AppSettings,
  LanguagePackSummary,
  McpToolStatus,
  ModelProviderConfigDetail,
  Project,
  RuntimeToolStatus,
  SkillAvailabilityUpdate,
  SkillRootSummary,
  SkillRootUpdate,
  SkillSnapshot,
  SpeechReplyConfig,
  StorageUsageValue
} from '@shared/types'
import type { ModelDraft } from '../model/modelDraft'
import { ModelSettings } from '../model/ModelSettings'
import type { McpDraft } from '../mcp/mcpDraft'
import { McpSettings } from '../mcp/McpSettings'
import { ChatModeSettings } from './ChatModeSettings'
import { EnvironmentSettingsSections } from './EnvironmentSettingsSections'
import { DeveloperHttpTraceSettings } from './DeveloperHttpTraceSettings'
import { DeveloperActions } from './DeveloperActions'
import { GeneralSettingsSections } from './GeneralSettingsSections'
import { LogSettings } from './LogSettings'
import { MemorySettings } from './MemorySettings'
import { CheckboxField } from '../CheckboxField'
import { formatDateTime } from '../formatDateTime'
import { SkillsSettings } from './SkillsSettings'
import type { SubagentDraft } from '../subagent/subagentDraft'
import { SubagentSettings } from '../subagent/SubagentSettings'
import { settingsTabs, type SettingsTab } from './settingsTabs'
import { ToolsSettings } from './ToolsSettings'
import type { MemorySettingsState } from './useMemorySettingsState'

interface SettingsScreenProps {
  onConfigChange(config: AppConfigSnapshot): void
  pendingDefaultCapabilities?: DefaultCapabilitySettings
  activeTab: SettingsTab
  avatar: AppAvatarImage | null
  avatarDragActive: boolean
  backupDir?: string
  config: AppConfigSnapshot | undefined
  dataDirectoryUsage?: StorageUsageValue
  developerHttpTraceEnabled: boolean
  developerHttpTraceUsage?: StorageUsageValue
  developerHttpTraceUsageLoading: boolean
  editingMcpIndex?: number
  editingModelIndex?: number
  editingProvider?: ModelProviderConfigDetail
  editingProviderModelIndex?: number
  envDraft: string
  envPath?: string
  error?: string
  languageOptions: LanguagePackSummary[]
  mcpDraft: McpDraft
  mcpListRef: RefObject<HTMLDivElement | null>
  mcpReloadingFailed: boolean
  mcpRuntimeEnabled: boolean
  mcpStatus: McpToolStatus | undefined
  runtimeToolStatus: RuntimeToolStatus | undefined
  subagentDraft: SubagentDraft
  subagentListRef: RefObject<HTMLDivElement | null>
  editingSubagentIndex?: number
  memory: MemorySettingsState
  modelCandidates: string[]
  modelDraft: ModelDraft
  modelListLoading: boolean
  modelListRef: RefObject<HTMLDivElement | null>
  projects: Project[]
  settingsContentRef: RefObject<HTMLDivElement | null>
  sidebarVisible: boolean
  skills: SkillSnapshot | undefined
  systemLanguage: string
  storageUsageLoading: boolean
  onAddMcpServer: () => void | Promise<void>
  onAddSubagent: () => void | Promise<void>
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onAvatarDragEnter: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDragLeave: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDragOver: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDrop: (event: DragEvent<HTMLButtonElement>) => void | Promise<void>
  onBackupDataDirectory: () => void | Promise<void>
  onEditAvatar: () => void | Promise<void>
  onClearAvatar: () => void | Promise<void>
  onCreateModel: (templateId?: string) => void | Promise<void>
  onAddProviderModel: () => boolean | void | Promise<boolean | void>
  onAddProviderModels: (models: string[]) => boolean | void | Promise<boolean | void>
  onDeleteMcpServer: () => void | Promise<void>
  onDeleteSubagent: () => void | Promise<void>
  onDeleteModel: () => void | Promise<void>
  onDeleteProviderModel: () => boolean | void | Promise<boolean | void>
  onAddSkillDirectory: () => void | Promise<void>
  onImportSkills: () => void | Promise<void>
  onEditMcpServer: (index: number) => void | Promise<void>
  onEditSubagent: (index: number) => void
  onEditModel: (index: number) => void | Promise<void>
  onMoveMcpServer: (direction: -1 | 1) => void | Promise<void>
  onMoveSubagent: (direction: -1 | 1) => void | Promise<void>
  onMoveModel: (direction: -1 | 1) => void | Promise<void>
  onMoveProviderModel: (direction: -1 | 1) => void | Promise<void>
  onSelectProviderModel: (index: number) => boolean | void | Promise<boolean | void>
  onOpenEnvFile: () => void | Promise<void>
  onOpenDataCleanup: () => void
  onOpenDataDirectory: () => void | Promise<void>
  onOpenDeveloperHttpTraceDirectory: () => void | Promise<void>
  onOpenLogDirectory: () => void | Promise<void>
  onOpenRuntimeLogViewer: () => void | Promise<void>
  onRefreshModelCandidates: () => void | Promise<void>
  onReloadFailedMcpServers: () => void | Promise<void>
  onRestoreDataDirectory: () => void | Promise<void>
  onRestoreSubagent: () => void
  onSaveLanguage: (language: string) => void | Promise<void>
  onSaveProfile: (profile: AppProfileUpdate) => void | Promise<void>
  onSaveDefaultCapabilities: (value: DefaultCapabilitySettings) => void | Promise<void>
  onSaveSettings: (settings: Partial<AppSettings>) => void | Promise<void>
  onDeveloperHttpTraceEnabledChange: (enabled: boolean) => void | Promise<void>
  onSaveSpeechReply: (settings: Partial<SpeechReplyConfig>) => void | Promise<void>
  onMoveSkillDirectory: (rootId: string, direction: -1 | 1) => void | Promise<void>
  onRefreshSkills: () => void | Promise<void>
  onUpdateSkillDirectory: (rootId: string, update: SkillRootUpdate) => void | Promise<void>
  onRemoveSkillDirectory: (root: SkillRootSummary) => void
  onToggleSidebar: () => void | Promise<void>
  onUpdateEnvDraft: (value: string) => void
  onUpdateMcpDraft: (update: Partial<McpDraft>) => void
  onUpdateSubagentDraft: (update: Partial<SubagentDraft>) => void
  onUpdateModelDraft: (update: Partial<ModelDraft>) => void
  onUpdateModelParameters: (parametersJson: string) => void
  onUpdateSkillScriptApproval: (skillId: string | undefined, enabled: boolean) => void | Promise<void>
  onUpdateSkillAvailability: (skillId: string, update: SkillAvailabilityUpdate) => void | Promise<void>
}

function settingsSectionClass(activeTab: SettingsTab, tab: SettingsTab, extra = ''): string {
  return ['settings-section', 'ui-page-section', 'ui-surface', extra, activeTab === tab ? '' : 'settings-section-hidden'].filter(Boolean).join(' ')
}

export function SettingsScreen({
  onConfigChange,
  activeTab,
  pendingDefaultCapabilities,
  avatar,
  avatarDragActive,
  backupDir,
  config,
  dataDirectoryUsage,
  developerHttpTraceEnabled,
  developerHttpTraceUsage,
  developerHttpTraceUsageLoading,
  editingMcpIndex,
  editingModelIndex,
  editingProvider,
  editingProviderModelIndex,
  envDraft,
  envPath,
  error,
  languageOptions,
  mcpDraft,
  mcpListRef,
  mcpReloadingFailed,
  mcpRuntimeEnabled,
  mcpStatus,
  runtimeToolStatus,
  subagentDraft,
  subagentListRef,
  editingSubagentIndex,
  memory,
  modelCandidates,
  modelDraft,
  modelListLoading,
  modelListRef,
  projects,
  settingsContentRef,
  sidebarVisible,
  skills,
  systemLanguage,
  storageUsageLoading,
  onAddMcpServer,
  onAddSubagent,
  onAutosizeInput,
  onAvatarDragEnter,
  onAvatarDragLeave,
  onAvatarDragOver,
  onAvatarDrop,
  onBackupDataDirectory,
  onEditAvatar,
  onClearAvatar,
  onCreateModel,
  onAddProviderModel,
  onAddProviderModels,
  onDeleteMcpServer,
  onDeleteSubagent,
  onDeleteModel,
  onDeleteProviderModel,
  onAddSkillDirectory,
  onImportSkills,
  onEditMcpServer,
  onEditSubagent,
  onEditModel,
  onMoveMcpServer,
  onMoveSubagent,
  onMoveModel,
  onMoveProviderModel,
  onSelectProviderModel,
  onOpenEnvFile,
  onOpenDataCleanup,
  onOpenDataDirectory,
  onOpenDeveloperHttpTraceDirectory,
  onOpenLogDirectory,
  onOpenRuntimeLogViewer,
  onRefreshModelCandidates,
  onReloadFailedMcpServers,
  onRestoreDataDirectory,
  onRestoreSubagent,
  onSaveLanguage,
  onSaveProfile,
  onSaveSettings,
  onSaveDefaultCapabilities,
  onDeveloperHttpTraceEnabledChange,
  onSaveSpeechReply,
  onMoveSkillDirectory,
  onRefreshSkills,
  onUpdateSkillDirectory,
  onRemoveSkillDirectory,
  onToggleSidebar,
  onUpdateEnvDraft,
  onUpdateMcpDraft,
  onUpdateSubagentDraft,
  onUpdateModelDraft,
  onUpdateModelParameters,
  onUpdateSkillScriptApproval,
  onUpdateSkillAvailability
}: SettingsScreenProps) {
  const { t } = useTranslation()
  const sectionClass = (tab: SettingsTab, extra = ''): string => settingsSectionClass(activeTab, tab, extra)
  const sidebarLabel = t('chat.show_sidebar')
  const activeTabDefinition = settingsTabs.find((tab) => tab.id === activeTab)
  const pageDescription = activeTab === 'capabilities' && config
    ? t('settings.default_capabilities_hint')
    : activeTab === 'mcp' && mcpStatus
      ? t('settings.mcp_status_summary', { servers: mcpStatus.servers.length, tools: mcpStatus.toolNames.length, checkedAt: formatDateTime(mcpStatus.checkedAt) })
      : undefined

  return (
    <main className="workspace workspace-workbench settings-workspace ui-main" aria-label={t('settings.title')}>
      <header className="topbar settings-topbar ui-main">
        {!sidebarVisible && (
          <button
            className="topbar-sidebar-toggle ui-tool-button ui-tool-button-square"
            type="button"
            aria-label={sidebarLabel}
            data-tooltip={sidebarLabel}
            onClick={() => void onToggleSidebar()}
          >
            <PanelLeftOpen size={18} />
          </button>
        )}
      </header>
      <div className="settings-content workspace-content-scroll ui-content ui-content-scroll ui-layer-content" ref={settingsContentRef}>
          <header className="settings-page-header">
            <div className="ui-copy-stack">
              <h1 className="settings-page-title">{activeTabDefinition ? t(activeTabDefinition.labelKey) : ''}</h1>
              {pageDescription && <div className="ui-field-hint">{pageDescription}</div>}
            </div>
            {activeTab === 'skills' && <CheckboxField checked={skills?.scriptAutoApprove ?? false}
              disabled={!skills} label={t('settings.skill_scripts_auto_approve_all')}
              onChange={enabled => void onUpdateSkillScriptApproval(undefined, enabled)} />}
          </header>
          {error && <div className="settings-error" role="alert">{error}</div>}
          {activeTab === 'general' && (
            <GeneralSettingsSections
              className={sectionClass('general')}
              profile={{
                avatarDataUri: avatar?.dataUri,
                avatarDragActive,
                customAvatar: avatar?.source === 'custom',
                profile: config?.settings.profile,
                onAvatarDragEnter, onAvatarDragLeave, onAvatarDragOver, onAvatarDrop,
                onEditAvatar, onClearAvatar, onProfileChange: onSaveProfile
              }}
              appearance={{
                languageOptions,
                languageValue: config?.settings.language ?? systemLanguage,
                systemLanguage,
                themeValue: config?.settings.theme,
                fontSizeValue: config?.settings.fontSize,
                chatContentWidthValue: config?.settings.chatContentWidth,
                onSaveLanguage,
                onSaveTheme: (theme) => onSaveSettings({ theme }),
                onSaveFontSize: (fontSize) => onSaveSettings({ fontSize }),
                onSaveChatContentWidth: (chatContentWidth) => onSaveSettings({ chatContentWidth })
              }}
              data={{
                backupDir, dataDirectoryUsage, storageUsageLoading,
                onBackupDataDirectory, onOpenDataCleanup, onOpenDataDirectory, onRestoreDataDirectory
              }}
            />
          )}
          {activeTab === 'chatMode' && (
            <section className={sectionClass('chatMode')}>
              <ChatModeSettings
                settings={config?.settings}
                speechReply={config?.settings.speechReply}
                onChange={onSaveSettings}
                onSpeechReplyChange={onSaveSpeechReply}
              />
            </section>
          )}
          {activeTab === 'capabilities' && config && (
            <section className={sectionClass('capabilities')}>
              <CapabilitySettings config={config} pending={pendingDefaultCapabilities} skills={skills} mcpStatus={mcpStatus}
                runtimeToolStatus={runtimeToolStatus} onSave={onSaveDefaultCapabilities} />
            </section>
          )}
          {activeTab === 'environment' && (
            <EnvironmentSettingsSections
              envDraft={envDraft}
              envPath={envPath}
              settings={config?.settings}
              sectionClass={sectionClass}
              onAutosizeInput={onAutosizeInput}
              onOpenEnvFile={onOpenEnvFile}
              onSaveSettings={onSaveSettings}
              onUpdateEnvDraft={onUpdateEnvDraft}
            />
          )}
          {activeTab === 'subagents' && (
            <SubagentSettings
              config={config}
              draft={subagentDraft}
              editingIndex={editingSubagentIndex}
              listRef={subagentListRef}
              mcpStatus={mcpStatus}
              runtimeToolStatus={runtimeToolStatus}
              sectionClass={sectionClass('subagents', 'settings-workbench ui-workbench ui-grid-sidebar')}
              skills={skills}
              onAdd={onAddSubagent}
              onAutosizeInput={onAutosizeInput}
              onDelete={onDeleteSubagent}
              onEdit={onEditSubagent}
              onMove={onMoveSubagent}
              onRestore={onRestoreSubagent}
              onUpdate={onUpdateSubagentDraft}
            />
          )}
          {activeTab === 'memory' && (
            <MemorySettings
              draft={memory.draft}
              items={memory.result.items}
              kind={memory.kind}
              listRef={memory.memoryListRef}
              projects={projects.filter((project) => project.kind === 'workspace')}
              query={memory.query}
              saving={memory.saving}
              scope={memory.scope}
              sectionClass={sectionClass('memory', 'settings-workbench ui-workbench ui-grid-sidebar')}
              selectedId={memory.selectedId}
              total={memory.result.total}
              onAutosizeInput={onAutosizeInput}
              onDelete={memory.deleteMemory}
              onKindChange={memory.setKind}
              onNew={memory.startNewMemory}
              onQueryChange={memory.setQuery}
              onSave={memory.saveMemory}
              onScopeChange={memory.setScope}
              onSelect={memory.selectMemory}
              onUpdateDraft={memory.updateMemoryDraft}
            />
          )}

          {activeTab === 'dev' && (
            <>
              <section className={sectionClass('dev')}>
                <DeveloperActions />
              </section>
              <section className={sectionClass('dev')}>
                <DeveloperHttpTraceSettings
                  enabled={developerHttpTraceEnabled}
                  storageUsageLoading={developerHttpTraceUsageLoading}
                  usage={developerHttpTraceUsage}
                  onChange={onDeveloperHttpTraceEnabledChange}
                  onOpenDirectory={onOpenDeveloperHttpTraceDirectory}
                />
              </section>
              <section className={sectionClass('dev')}>
                <LogSettings
                  settings={config?.settings}
                  onChange={onSaveSettings}
                  onOpenLogDirectory={onOpenLogDirectory}
                  onOpenRuntimeLogViewer={onOpenRuntimeLogViewer}
                />
              </section>
            </>
          )}

          {activeTab === 'model' && (
            <ModelSettings
              candidates={modelCandidates}
              config={config}
              editingModelIndex={editingModelIndex}
              editingProvider={editingProvider}
              editingProviderModelIndex={editingProviderModelIndex}
              listLoading={modelListLoading}
              listRef={modelListRef}
              modelDraft={modelDraft}
              sectionClass={sectionClass('model', 'settings-workbench ui-workbench ui-grid-sidebar')}
              onCreateModel={onCreateModel}
              onAddProviderModel={onAddProviderModel}
              onAddProviderModels={onAddProviderModels}
              onDeleteModel={onDeleteModel}
              onDeleteProviderModel={onDeleteProviderModel}
              onEditModel={onEditModel}
              onMoveModel={onMoveModel}
              onMoveProviderModel={onMoveProviderModel}
              onSelectProviderModel={onSelectProviderModel}
              onRefreshCandidates={onRefreshModelCandidates}
              onUpdateDraft={onUpdateModelDraft}
              onUpdateParameters={onUpdateModelParameters}
            />
          )}

          {activeTab === 'mcp' && (
            <McpSettings
              config={config}
              editingIndex={editingMcpIndex}
              listRef={mcpListRef}
              mcpDraft={mcpDraft}
              reloadingFailed={mcpReloadingFailed}
              runtimeEnabled={mcpRuntimeEnabled}
              sectionClass={sectionClass('mcp', 'settings-workbench ui-workbench ui-grid-sidebar')}
              status={mcpStatus}
              onAddServer={onAddMcpServer}
              onAutosizeInput={onAutosizeInput}
              onDeleteServer={onDeleteMcpServer}
              onEditServer={onEditMcpServer}
              onMoveServer={onMoveMcpServer}
              onReloadFailedServers={onReloadFailedMcpServers}
              onUpdateDraft={onUpdateMcpDraft}
            />
          )}

          {activeTab === 'tools' && (
            <section className={sectionClass('tools', 'settings-workbench ui-workbench ui-grid-sidebar')}>
              <ToolsSettings
                customTools={config?.customTools ?? []}
                onConfigChange={onConfigChange}
                mcpServers={config?.mcpServers ?? []}
                mcpStatus={mcpStatus}
                runtimeToolStatus={runtimeToolStatus}
              />
            </section>
          )}

          {activeTab === 'skills' && (
            <SkillsSettings
              sectionClass={sectionClass('skills', 'settings-workbench ui-workbench ui-grid-sidebar')}
              skills={skills}
              onAddDirectory={onAddSkillDirectory}
              onImportDirectories={onImportSkills}
              onMoveDirectory={onMoveSkillDirectory}
              onRefresh={onRefreshSkills}
              onUpdateDirectory={onUpdateSkillDirectory}
              onRemoveDirectory={onRemoveSkillDirectory}
              onUpdateScriptApproval={onUpdateSkillScriptApproval}
              onUpdateAvailability={onUpdateSkillAvailability}
            />
          )}
      </div>
    </main>
  )
}

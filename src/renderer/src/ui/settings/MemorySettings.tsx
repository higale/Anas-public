import type { FormEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryItem, MemoryKind, MemoryScope, WorkspaceProject } from '@shared/types'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SettingsListActions } from './SettingsListActions'
import type { MemoryDraft } from './useMemorySettingsState'
import { formatDateTime } from '../formatDateTime'

interface MemorySettingsProps {
  draft?: MemoryDraft
  items: MemoryItem[]
  kind: 'all' | MemoryKind
  listRef: RefObject<HTMLDivElement | null>
  projects: WorkspaceProject[]
  query: string
  saving: boolean
  scope: 'all' | MemoryScope
  sectionClass: string
  selectedId?: string
  total: number
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onDelete: () => void | Promise<void>
  onKindChange: (kind: 'all' | MemoryKind) => void
  onNew: () => void | Promise<void>
  onQueryChange: (query: string) => void
  onSave: () => void | Promise<void>
  onScopeChange: (scope: 'all' | MemoryScope) => void
  onSelect: (id: string) => void
  onUpdateDraft: (patch: Partial<MemoryDraft>) => void
}

const kindKeys: Record<MemoryKind, string> = {
  preference: 'settings.memory_kind_preference',
  fact: 'settings.memory_kind_fact',
  experience: 'settings.memory_kind_experience'
}

const scopeKeys: Record<MemoryScope, string> = {
  global: 'settings.memory_scope_global',
  project: 'settings.memory_scope_project'
}

function MemoryListPane(props: Pick<MemorySettingsProps,
  | 'items' | 'kind' | 'listRef' | 'query' | 'scope' | 'selectedId' | 'total'
  | 'onDelete' | 'onKindChange' | 'onNew' | 'onQueryChange' | 'onScopeChange' | 'onSelect'
>) {
  const { t } = useTranslation()
  const scopeOptions = [
    { value: 'all', label: t('settings.memory_filter_all_scopes') },
    ...Object.entries(scopeKeys).map(([value, key]) => ({ value, label: t(key) }))
  ]
  const kindOptions = [
    { value: 'all', label: t('settings.memory_filter_all_kinds') },
    ...Object.entries(kindKeys).map(([value, key]) => ({ value, label: t(key) }))
  ]
  return (
    <div className="ui-list-pane">
      <div className="ui-list-pane-header">
        <SettingsListActions
          addLabel={t('settings.new_memory')}
          canDelete={Boolean(props.selectedId)}
          canMoveDown={false}
          canMoveUp={false}
          deleteLabel={t('settings.delete_memory')}
          leading={<small className="ui-field-hint">{t('settings.memory_result_count', { count: props.total })}</small>}
          onAdd={props.onNew}
          onDelete={props.onDelete}
        />
        <div className="settings-memory-filters">
          <input
            aria-label={t('settings.search_memory')}
            className="ui-input"
            maxLength={2_000}
            placeholder={t('settings.search_memory')}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
          <div className="ui-grid-2">
            <SearchableOptionPicker
              ariaLabel={t('settings.memory_scope')}
              emptyLabel={t('settings.no_options')}
              options={scopeOptions}
              searchable={false}
              value={props.scope}
              onChange={(scope) => props.onScopeChange(scope as 'all' | MemoryScope)}
            />
            <SearchableOptionPicker
              ariaLabel={t('settings.memory_kind')}
              emptyLabel={t('settings.no_options')}
              options={kindOptions}
              searchable={false}
              value={props.kind}
              onChange={(kind) => props.onKindChange(kind as 'all' | MemoryKind)}
            />
          </div>
        </div>
      </div>
      <div className="ui-scroll-list ui-list" ref={props.listRef}>
        {props.items.length === 0 && (
          <div className="ui-empty-state ui-empty-state-compact">{t('settings.memory_empty')}</div>
        )}
        {props.items.map((memory) => (
          <button
            className={memory.id === props.selectedId
              ? 'ui-list-item-split ui-list-item ui-list-item-active active'
              : 'ui-list-item-split ui-list-item'}
            key={memory.id}
            type="button"
            onClick={() => props.onSelect(memory.id)}
          >
            <span>
              <strong>{memory.content}</strong>
              <small>{t(scopeKeys[memory.scope])} · {t(kindKeys[memory.kind])}</small>
            </span>
            <em>{memory.importance}</em>
          </button>
        ))}
      </div>
    </div>
  )
}

function MemoryEditor(props: Pick<MemorySettingsProps,
  | 'draft' | 'items' | 'projects' | 'saving' | 'onAutosizeInput' | 'onSave' | 'onUpdateDraft'
>) {
  const { t } = useTranslation()
  const memory = props.draft?.id
    ? props.items.find((item) => item.id === props.draft?.id)
    : undefined
  if (!props.draft) {
    return <div className="ui-editor ui-editor-empty">{t('settings.memory_select_hint')}</div>
  }
  const valid = Boolean(
    props.draft.content.trim()
    && (props.draft.scope === 'global' || props.draft.projectId)
  )
  const scopeOptions = Object.entries(scopeKeys).map(([value, key]) => ({ value, label: t(key) }))
  const kindOptions = Object.entries(kindKeys).map(([value, key]) => ({ value, label: t(key) }))
  const projectOptions = props.projects.map((project) => ({ value: project.id, label: project.name }))
  const importanceOptions = [1, 2, 3, 4, 5].map((importance) => ({
    value: String(importance),
    label: String(importance)
  }))
  return (
    <div className="ui-editor settings-memory-editor">
      <div className="ui-form-section-heading">
        <strong>{props.draft.id ? t('settings.edit_memory') : t('settings.new_memory')}</strong>
        <button
          className="ui-button ui-button-primary ui-button-compact"
          type="button"
          disabled={!valid || props.saving}
          onClick={() => void props.onSave()}
        >
          {t('common.save')}
        </button>
      </div>
      <div className="ui-grid-2">
        <div className="ui-field-stack">
          <span>{t('settings.memory_scope')}</span>
          <SearchableOptionPicker
            ariaLabel={t('settings.memory_scope')}
            disabled={props.saving}
            emptyLabel={t('settings.no_options')}
            options={scopeOptions}
            searchable={false}
            value={props.draft.scope}
            onChange={(scope) => props.onUpdateDraft({ scope: scope as MemoryScope })}
          />
        </div>
        <div className="ui-field-stack">
          <span>{t('settings.memory_kind')}</span>
          <SearchableOptionPicker
            ariaLabel={t('settings.memory_kind')}
            disabled={props.saving}
            emptyLabel={t('settings.no_options')}
            options={kindOptions}
            searchable={false}
            value={props.draft.kind}
            onChange={(kind) => props.onUpdateDraft({ kind: kind as MemoryKind })}
          />
        </div>
      </div>
      {props.draft.scope === 'project' && (
        <div className="ui-field-stack">
          <span>{t('settings.memory_project')}</span>
          <SearchableOptionPicker
            ariaLabel={t('settings.memory_project')}
            disabled={props.saving}
            emptyLabel={t('settings.no_options')}
            options={projectOptions}
            searchable={false}
            value={props.draft.projectId ?? ''}
            onChange={(projectId) => props.onUpdateDraft({ projectId })}
          />
        </div>
      )}
      <label className="ui-field-stack">
        <span>{t('settings.memory_content')}</span>
        <textarea
          className="ui-autosize-textarea ui-code-textarea"
          data-max-height="none"
          disabled={props.saving}
          rows={6}
          value={props.draft.content}
          onInput={props.onAutosizeInput}
          onChange={(event) => props.onUpdateDraft({ content: event.target.value })}
        />
      </label>
      <div className="ui-grid-main-aside">
        <label className="ui-field-stack">
          <span>{t('settings.memory_keywords')}</span>
          <input
            disabled={props.saving}
            value={props.draft.keywordsText}
            onChange={(event) => props.onUpdateDraft({ keywordsText: event.target.value })}
          />
        </label>
        <div className="ui-field-stack">
          <span>{t('settings.memory_importance')}</span>
          <SearchableOptionPicker
            ariaLabel={t('settings.memory_importance')}
            disabled={props.saving}
            emptyLabel={t('settings.no_options')}
            options={importanceOptions}
            searchable={false}
            value={String(props.draft.importance)}
            onChange={(importance) => props.onUpdateDraft({ importance: Number(importance) })}
          />
        </div>
      </div>
      {memory && (
        <div className="ui-note settings-memory-metadata">
          <span>{t('settings.memory_origin')}: {t(`settings.memory_origin_${memory.origin}`)}</span>
          <span>{t('settings.memory_created')}: {formatDateTime(memory.createdAt)}</span>
          <span>{t('settings.memory_updated')}: {formatDateTime(memory.updatedAt)}</span>
          {memory.sourceThreadId && <span>{t('settings.memory_source_thread')}: {memory.sourceThreadId}</span>}
          {memory.sourceRunId && <span>{t('settings.memory_source_run')}: {memory.sourceRunId}</span>}
        </div>
      )}
    </div>
  )
}

export function MemorySettings(props: MemorySettingsProps) {
  return (
    <section className={props.sectionClass}>
      <MemoryListPane {...props} />
      <MemoryEditor {...props} />
    </section>
  )
}

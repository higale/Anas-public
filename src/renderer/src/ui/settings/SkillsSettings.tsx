import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderDown, FolderInput, FolderOpen, Link2, ListTree, RefreshCw, SquareChevronDown, SquareChevronRight, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_PATTERN } from '@shared/types'
import type { SkillAvailabilityUpdate, SkillFileNode, SkillFilePreview, SkillRootSummary, SkillRootUpdate, SkillSnapshot, SkillSummary } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'

interface Props {
  sectionClass: string
  skills?: SkillSnapshot
  onAddDirectory: () => void | Promise<void>
  onImportDirectories: () => void | Promise<void>
  onMoveDirectory: (rootId: string, direction: -1 | 1) => void | Promise<void>
  onRefresh: () => void | Promise<void>
  onUpdateDirectory: (rootId: string, update: SkillRootUpdate) => void | Promise<void>
  onRemoveDirectory: (root: SkillRootSummary) => void
  onUpdateScriptApproval: (skillId: string | undefined, enabled: boolean) => void | Promise<void>
  onUpdateAvailability: (skillId: string, update: SkillAvailabilityUpdate) => void | Promise<void>
}

type Selection =
  | { kind: 'all' }
  | { kind: 'root'; rootId: string }
  | { kind: 'skill'; skillId: string }
  | { kind: 'file'; skillId: string; relativePath: string }

function nodeKey(skillId: string, path = ''): string {
  return `${skillId}\0${path}`
}

export function SkillsSettings({
  sectionClass,
  skills,
  onAddDirectory,
  onImportDirectories,
  onMoveDirectory,
  onRefresh,
  onUpdateDirectory,
  onRemoveDirectory,
  onUpdateScriptApproval,
  onUpdateAvailability
}: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState<Record<string, SkillFileNode[]>>({})
  const [rootDrafts, setRootDrafts] = useState<Record<string, SkillRootUpdate>>({})
  const [selection, setSelection] = useState<Selection>()
  const [preview, setPreview] = useState<SkillFilePreview>()
  const previewRequestRef = useRef(0)
  const roots = useMemo(() => skills?.roots ?? [], [skills?.roots])
  const allSkills = useMemo(() => skills?.skills ?? [], [skills?.skills])
  const sortedSkills = useMemo(() => {
    const rootOrder = new Map(roots.map((root, index) => [root.id, index]))
    return [...allSkills].sort((left, right) => (
      (rootOrder.get(left.rootId) ?? Number.MAX_SAFE_INTEGER) - (rootOrder.get(right.rootId) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name)
    ))
  }, [allSkills, roots])
  const rootById = useMemo(() => new Map(roots.map((root) => [root.id, root])), [roots])
  const skillById = useMemo(() => new Map(allSkills.map((skill) => [skill.id, skill])), [allSkills])
  const selectedRoot = selection?.kind === 'root' ? rootById.get(selection.rootId) : undefined
  const selectedRootDraft = selectedRoot
    ? rootDrafts[selectedRoot.id] ?? { name: selectedRoot.name, shortcutAlias: selectedRoot.shortcutAlias }
    : undefined
  const selectedRootDraftValid = Boolean(
    selectedRootDraft?.name.trim()
    && selectedRootDraft.name.trim().length <= SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH
    && selectedRootDraft.shortcutAlias.trim().length <= SKILL_SHORTCUT_ALIAS_MAX_LENGTH
    && SKILL_SHORTCUT_ALIAS_PATTERN.test(selectedRootDraft.shortcutAlias.trim())
  )
  const selectedRootDraftDirty = Boolean(
    selectedRoot
    && selectedRootDraft
    && (selectedRootDraft.name.trim() !== selectedRoot.name || selectedRootDraft.shortcutAlias.trim() !== selectedRoot.shortcutAlias)
  )
  const selectedSkill = selection?.kind === 'skill' || selection?.kind === 'file' ? skillById.get(selection.skillId) : undefined
  const showImport = selectedRoot?.kind === 'user' || selectedSkill?.source === 'user'
  const selectedSkillIssue = selectedSkill?.loadError
  const selectedSkillIssueText = selectedSkillIssue
    ? t(`settings.skill_issue_${selectedSkillIssue.code}`, {
        name: selectedSkillIssue.name ?? '',
        expected: selectedSkillIssue.expected ?? ''
      })
    : undefined
  const selectedFile = selection?.kind === 'file'
    ? Object.entries(children)
        .filter(([key]) => key.startsWith(`${selection.skillId}\0`))
        .flatMap(([, files]) => files)
        .find((file) => file.relativePath === selection.relativePath)
    : undefined
  const externalRoots = roots.filter((root) => root.kind === 'external')

  useEffect(() => {
    previewRequestRef.current += 1
    setChildren({})
    setPreview(undefined)
    setSelection((current) => {
      if (!current) return undefined
      if (current.kind === 'all') return current
      if (current.kind === 'root') return rootById.has(current.rootId) ? current : undefined
      return skillById.has(current.skillId) ? current : undefined
    })
  }, [skills, rootById, skillById])

  function toggle(key: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function clearPreview(): void {
    previewRequestRef.current += 1
    setPreview(undefined)
  }

  async function updateRoot(event: FormEvent<HTMLFormElement>, root: SkillRootSummary): Promise<void> {
    event.preventDefault()
    if (!root.removable || !selectedRootDraftValid) return
    const update = rootDrafts[root.id] ?? { name: root.name, shortcutAlias: root.shortcutAlias }
    const normalized = { name: update.name.trim(), shortcutAlias: update.shortcutAlias.trim() }
    if (normalized.name === root.name && normalized.shortcutAlias === root.shortcutAlias) return
    setRootDrafts((current) => ({ ...current, [root.id]: normalized }))
    await onUpdateDirectory(root.id, normalized)
  }

  async function showItemInFolder(path: string): Promise<void> {
    try {
      await window.gale.files.showItemInFolder(path)
    } catch {
      notice.error(t('settings.failed_open_skill_path'), { id: 'settings-skill-file-status' })
    }
  }

  function openButton(path: string, disabled = false): ReactNode {
    return (
      <button className="ui-button ui-button-compact" disabled={disabled} type="button" onClick={() => void showItemInFolder(path)}>
        <FolderOpen size={UI_ICON_SIZE_SMALL} />
        <span>{t('common.open')}</span>
      </button>
    )
  }

  async function expandFiles(skillId: string, relativePath?: string): Promise<void> {
    try {
      const key = nodeKey(skillId, relativePath)
      if (!children[key]) {
        const items = await window.gale.skills.listFiles(undefined, skillId, relativePath)
        setChildren((current) => ({ ...current, [key]: items }))
      }
      toggle(`files:${key}`)
    } catch {
      notice.error(t('settings.failed_read_skill_file'), { id: 'settings-skill-file-status' })
    }
  }

  async function selectFile(skillId: string, file: SkillFileNode): Promise<void> {
    const previewRequest = ++previewRequestRef.current
    if (file.kind === 'directory' || file.linkDirectory) {
      setSelection({ kind: 'file', skillId, relativePath: file.relativePath })
      setPreview(undefined)
      await expandFiles(skillId, file.relativePath)
      return
    }
    setSelection({ kind: 'file', skillId, relativePath: file.relativePath })
    try {
      const nextPreview = await window.gale.skills.readFile(undefined, skillId, file.relativePath)
      if (previewRequestRef.current === previewRequest) setPreview(nextPreview)
    } catch {
      if (previewRequestRef.current === previewRequest) {
        setPreview(undefined)
        notice.error(t('settings.failed_read_skill_file'), { id: 'settings-skill-file-status' })
      }
    }
  }

  function renderFileNodes(skillId: string, parentPath?: string, depth = 0): ReactNode {
    const key = nodeKey(skillId, parentPath)
    return (children[key] ?? []).map((file) => {
      const expandable = file.kind === 'directory' || file.linkDirectory
      const expandedKey = `files:${nodeKey(skillId, file.relativePath)}`
      const isExpanded = expanded.has(expandedKey)
      const selected = selection?.kind === 'file' && selection.skillId === skillId && selection.relativePath === file.relativePath
      const Icon = file.kind === 'symlink' ? Link2 : expandable ? Folder : file.kind === 'text' ? FileCode2 : File
      return (
        <div key={file.relativePath}>
          <button
            className={selected ? 'settings-skill-tree-row active' : 'settings-skill-tree-row'}
            style={{ paddingLeft: 10 + depth * 16 }}
            type="button"
            onClick={() => void selectFile(skillId, file)}
          >
            {expandable ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="settings-skill-tree-spacer" />}
            <Icon size={14} />
            <span className="settings-skill-tree-label">{file.name}</span>
          </button>
          {expandable && isExpanded && renderFileNodes(skillId, file.relativePath, depth + 1)}
        </div>
      )
    })
  }

  function renderSkill(skill: SkillSummary, depth: number, showSource = false): ReactNode {
    const isExpanded = expanded.has(`files:${nodeKey(skill.id)}`)
    const selected = selection?.kind === 'skill' && selection.skillId === skill.id
    const fullyUnavailable = !skill.modelAvailable && !skill.userAvailable
    const className = [
      'settings-skill-tree-row',
      selected && 'active',
      fullyUnavailable && 'settings-skill-tree-row-fully-unavailable'
    ].filter(Boolean).join(' ')
    const badge = [
      showSource ? `@${skill.shortcutAlias}` : '',
      skill.loadError ? t('settings.skill_load_error_badge') : ''
    ].filter(Boolean).join(' · ')
    return (
      <div key={skill.id}>
        <div
          className={`${className} settings-skill-tree-split`}
          style={{ paddingLeft: 10 + depth * 16 }}
        >
          <button
            aria-expanded={isExpanded}
            aria-label={t(isExpanded ? 'settings.skill_collapse' : 'settings.skill_expand', { name: skill.name })}
            className="settings-skill-tree-toggle"
            type="button"
            onClick={() => void expandFiles(skill.id)}
          >
            {isExpanded ? <SquareChevronDown size={14} /> : <SquareChevronRight size={14} />}
          </button>
          <button
            className="settings-skill-tree-select"
            aria-label={skill.scriptAutoApprove ? [skill.name, badge, t('settings.skill_scripts_auto_approve')].filter(Boolean).join(' · ') : undefined}
            data-tooltip={skill.scriptAutoApprove ? t('settings.skill_scripts_auto_approve') : undefined}
            type="button"
            onClick={() => {
              setSelection({ kind: 'skill', skillId: skill.id })
              clearPreview()
            }}
          >
            {skill.linked ? <Link2 size={14} /> : <Folder size={14} />}
            <span className={`settings-skill-tree-label${skill.scriptAutoApprove ? ' ui-text-success' : ''}`}>{skill.name}</span>
            {badge && <em>{badge}</em>}
          </button>
        </div>
        {isExpanded && renderFileNodes(skill.id, undefined, depth + 1)}
      </div>
    )
  }

  function rootLabel(root: SkillRootSummary): string {
    return root.kind === 'system' || root.kind === 'user'
      ? t(`settings.skill_group_${root.kind}`)
      : root.name
  }

  function renderRoot(root: SkillRootSummary, depth = 0): ReactNode {
    const key = `root:${root.id}`
    const isExpanded = expanded.has(key)
    const selected = selection?.kind === 'root' && selection.rootId === root.id
    const rootSkills = allSkills.filter((skill) => skill.rootId === root.id)
    const label = rootLabel(root)
    return (
      <div key={root.id}>
        <button
          className={selected ? 'settings-skill-tree-row settings-skill-tree-root active' : 'settings-skill-tree-row settings-skill-tree-root'}
          style={{ paddingLeft: 8 + depth * 16 }}
          type="button"
          onClick={() => {
            setSelection({ kind: 'root', rootId: root.id })
            clearPreview()
            toggle(key)
          }}
        >
          <span>
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <Folder size={15} />
          <span className="settings-skill-tree-label">{label}</span>
          <em>{rootSkills.length}</em>
        </button>
        {isExpanded && rootSkills.map((skill) => renderSkill(skill, depth + 1))}
      </div>
    )
  }

  const selectedExternalIndex = selectedRoot ? externalRoots.findIndex((root) => root.id === selectedRoot.id) : -1
  const rootIssue = selectedRoot?.issue === 'not_found'
    ? t('settings.skill_root_not_found')
    : selectedRoot?.issue === 'not_directory'
      ? t('settings.skill_root_not_directory')
      : t('settings.skill_root_unreadable')

  return (
    <section className={sectionClass}>
      <div className="ui-list-pane">
        <div className="ui-list-pane-header">
          <div className="ui-toolbar ui-toolbar-between">
            <div className="ui-toolbar">
              <button className="ui-button ui-button-compact" type="button" onClick={() => void onAddDirectory()}>
                <FolderInput size={UI_ICON_SIZE_SMALL} /><span>{t('settings.add_skill_directory')}</span>
              </button>
              {showImport && (
                <button className="ui-button ui-button-compact" type="button" onClick={() => void onImportDirectories()}>
                  <FolderDown size={UI_ICON_SIZE_SMALL} /><span>{t('settings.import_skill')}</span>
                </button>
              )}
            </div>
            <button className="ui-tool-button ui-tool-button-small" type="button" aria-label={t('common.refresh')} data-tooltip={t('common.refresh')} onClick={() => void onRefresh()}>
              <RefreshCw size={UI_ICON_SIZE_SMALL} />
            </button>
          </div>
        </div>
        <div className="ui-scroll-list settings-skill-tree">
          <div>
            <button
              className={selection?.kind === 'all' ? 'settings-skill-tree-row settings-skill-tree-root active' : 'settings-skill-tree-row settings-skill-tree-root'}
              type="button"
              onClick={() => {
                setSelection({ kind: 'all' })
                clearPreview()
                toggle('group:all')
              }}
            >
              {expanded.has('group:all') ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <ListTree size={15} /><span className="settings-skill-tree-label">{t('settings.skill_group_all')}</span>
              <em>{allSkills.length}</em>
            </button>
            {expanded.has('group:all') && sortedSkills.map((skill) => renderSkill(skill, 1, true))}
          </div>
          {roots.map((root) => renderRoot(root))}
        </div>
      </div>

      <div className="ui-editor settings-skill-viewer">
        {selection?.kind === 'all' && (
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><strong>{t('settings.skill_group_all')}</strong><small>{t('settings.skill_total', { count: allSkills.length })}</small></div>
          </div>
        )}

        {selectedRoot && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><strong>{rootLabel(selectedRoot)}</strong><small>{selectedRoot.path}</small></div>
            <div className="ui-toolbar">
              {openButton(selectedRoot.path, !selectedRoot.available)}
              {selectedRoot.removable && <>
                <button className="ui-button ui-button-compact" disabled={selectedExternalIndex <= 0} type="button" onClick={() => void onMoveDirectory(selectedRoot.id, -1)}>↑</button>
                <button className="ui-button ui-button-compact" disabled={selectedExternalIndex < 0 || selectedExternalIndex >= externalRoots.length - 1} type="button" onClick={() => void onMoveDirectory(selectedRoot.id, 1)}>↓</button>
                <button className="ui-button ui-button-compact ui-button-danger" type="button" onClick={() => onRemoveDirectory(selectedRoot)}>
                  <Trash2 size={UI_ICON_SIZE_SMALL} /> {t('settings.remove_skill_directory')}
                </button>
              </>}
            </div>
          </div>
          {!selectedRoot.available && <div className="ui-note ui-note-danger">{rootIssue}</div>}
          {selectedRoot.removable && selectedRootDraft && (
            <form className="settings-skill-root-editor" onSubmit={(event) => void updateRoot(event, selectedRoot)}>
              <label className="ui-form-row ui-form-row-wide">
                <span>{t('settings.skill_directory_display_name')}</span>
                <input
                  className="ui-input"
                  maxLength={SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH}
                  value={selectedRootDraft.name}
                  onChange={(event) => setRootDrafts((current) => ({
                    ...current,
                    [selectedRoot.id]: { ...selectedRootDraft, name: event.target.value }
                  }))}
                />
              </label>
              <label className="ui-form-row ui-form-row-wide">
                <span>
                  {t('settings.skill_shortcut_alias')}
                  <small>{t('settings.skill_shortcut_alias_hint')}</small>
                </span>
                <input
                  className="ui-input"
                  maxLength={SKILL_SHORTCUT_ALIAS_MAX_LENGTH}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  value={selectedRootDraft.shortcutAlias}
                  onChange={(event) => setRootDrafts((current) => ({
                    ...current,
                    [selectedRoot.id]: { ...selectedRootDraft, shortcutAlias: event.target.value }
                  }))}
                />
              </label>
              <div className="settings-skill-root-editor-actions">
                <button className="ui-button ui-button-compact" disabled={!selectedRootDraftValid || !selectedRootDraftDirty} type="submit">
                  {t('common.save')}
                </button>
              </div>
            </form>
          )}
          <dl className="settings-skill-metadata">
            <dt>{t('settings.skill_source')}</dt><dd>{selectedRoot.kind}</dd>
            {!selectedRoot.removable && <><dt>{t('settings.skill_shortcut_alias')}</dt><dd>@{selectedRoot.shortcutAlias}</dd></>}
          </dl>
        </>}

        {selectedSkill && !preview && selection?.kind === 'skill' && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><strong>{selectedSkill.name}</strong></div>
            <div className="ui-toolbar">
              <CheckboxField checked={selectedSkill.modelAvailable} label={t('settings.skill_model_available')} onChange={(modelAvailable) => void onUpdateAvailability(selectedSkill.id, { modelAvailable })} />
              <CheckboxField checked={selectedSkill.userAvailable} label={t('settings.skill_user_available')} onChange={(userAvailable) => void onUpdateAvailability(selectedSkill.id, { userAvailable })} />
              <CheckboxField checked={selectedSkill.scriptAutoApprove} label={t('settings.skill_scripts_auto_approve')}
                onChange={enabled => void onUpdateScriptApproval(selectedSkill.id, enabled)} />
            </div>
          </div>
          {skills?.scriptAutoApprove && <small className="ui-field-hint">{t('settings.skill_scripts_auto_approve_global_active')}</small>}
          {selectedSkillIssue && <div className="ui-note ui-note-danger">{selectedSkillIssueText}{selectedSkillIssue.detail ? ` ${selectedSkillIssue.detail}` : ''}</div>}
          <p>{selectedSkill.description}</p>
          {selectedSkill.compatibility && <p><strong>{t('settings.skill_compatibility')}：</strong>{selectedSkill.compatibility}</p>}
          <dl className="settings-skill-metadata">
            <dt>{t('settings.skill_path')}</dt><dd><button className="ui-link-button" type="button"
              disabled={selectedSkill.linked && !selectedSkill.resolvedDirPath}
              onClick={() => void showItemInFolder(selectedSkill.dirPath)}>{selectedSkill.dirPath}</button></dd>
            <dt>{t('settings.skill_shortcut')}</dt><dd>{selectedSkill.shortcut ?? t('settings.skill_shortcut_unavailable')}</dd>
            {selectedSkill.linked && <><dt>{t('settings.skill_link_target')}</dt><dd>{selectedSkill.linkTarget}</dd><dt>{t('settings.skill_resolved_path')}</dt><dd>{selectedSkill.resolvedDirPath ?? t('settings.skill_link_unavailable')}</dd></>}
            {selectedSkill.modelShadowedBy && <><dt>{t('settings.skill_model_shadowed')}</dt><dd>{selectedSkill.modelShadowedBy}</dd></>}
            {selectedSkill.userShadowedBy && <><dt>{t('settings.skill_user_shadowed')}</dt><dd>{selectedSkill.userShadowedBy}</dd></>}
          </dl>
        </>}

        {preview && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><strong>{preview.name}</strong><small>{preview.relativePath}</small></div><div className="ui-row"><small>{preview.size} B</small>{openButton(preview.path)}</div></div>
          {preview.linkTarget && <div className="ui-note"><Link2 size={14} /> {preview.linkTarget} → {preview.resolvedPath}</div>}
          {preview.kind === 'text' ? <pre className="settings-skill-file-content">{preview.content}</pre> : <div className="ui-empty-state">{t('settings.skill_binary_preview_unavailable')}</div>}
        </>}

        {selection?.kind === 'file' && !preview && selectedFile && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><strong>{selectedFile.name}</strong><small>{selectedFile.relativePath}</small></div>{openButton(selectedFile.path, selectedFile.kind === 'symlink' && !selectedFile.resolvedPath)}</div>
          {selectedFile.linkTarget && <div className="ui-note"><Link2 size={14} /> {selectedFile.linkTarget} → {selectedFile.resolvedPath ?? t('settings.skill_link_unavailable')}</div>}
          <div className="ui-empty-state">{selectedFile.kind === 'directory' || selectedFile.linkDirectory
            ? t('settings.skill_directory_preview')
            : t('settings.skill_file_preview_unavailable')}</div>
        </>}

        {!selection && <div className="ui-empty-state">{t('settings.select_skill_tree_item')}</div>}
      </div>
    </section>
  )
}

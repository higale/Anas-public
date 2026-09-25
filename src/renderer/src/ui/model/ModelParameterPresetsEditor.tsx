import { RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { modelParameterPresetTemplateGroups } from '@shared/modelParameterPresetTemplates'
import type { ModelParameterPresetTemplate } from '@shared/modelParameterPresetTemplates'
import type { ModelParameterPresetMode } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { ConfirmDialog } from '../dialogs/AppDialogs'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SettingsListActions } from '../settings/SettingsListActions'
import { UI_ICON_SIZE_LARGE, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import type { ModelDraft, ModelParameterPresetDraft } from './modelDraft'

interface ModelParameterPresetsEditorProps {
  draft: ModelDraft
  portalContainer?: HTMLElement | null
  onUpdate(update: Partial<ModelDraft>): void
}

function nextPresetName(existing: ModelParameterPresetDraft[], base: string): string {
  const names = new Set(existing.map((preset) => preset.name))
  if (!names.has(base)) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}

export function ModelParameterPresetsEditor({
  draft,
  portalContainer,
  onUpdate
}: ModelParameterPresetsEditorProps) {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [editingNameId, setEditingNameId] = useState<string | undefined>()
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogRequest | undefined>()
  const modelConfigIdRef = useRef(draft.modelConfigId)
  const pendingAddedIdRef = useRef<string | undefined>(undefined)
  const parameterTemplateGroup = modelParameterPresetTemplateGroups.find(
    (group) => group.id === draft.protocol
  )
  const protocolPresets = useMemo<ModelParameterPresetDraft[]>(() => (
    parameterTemplateGroup?.templates.map((template) => ({
      id: template.id,
      name: template.label,
      parametersJson: JSON.stringify(template.parameters, null, 2)
    })) ?? []
  ), [parameterTemplateGroup])
  const isCustom = draft.parameterPresetMode === 'custom'
  const visiblePresets = useMemo(() => (
    draft.parameterPresetMode === 'protocol_default'
      ? protocolPresets
      : draft.parameterPresetMode === 'custom'
        ? draft.parameterPresets
        : []
  ), [draft.parameterPresetMode, draft.parameterPresets, protocolPresets])
  const resolvedSelectedId = visiblePresets.some((preset) => preset.id === selectedId)
    ? selectedId
    : draft.parameterPresetMode === 'protocol_default'
      ? visiblePresets[0]?.id
      : undefined
  const selectedIndex = visiblePresets.findIndex((preset) => preset.id === resolvedSelectedId)
  const selected = selectedIndex >= 0 ? visiblePresets[selectedIndex] : undefined

  useEffect(() => {
    if (modelConfigIdRef.current !== draft.modelConfigId) {
      modelConfigIdRef.current = draft.modelConfigId
      pendingAddedIdRef.current = undefined
      setSelectedId(undefined)
      setEditingNameId(undefined)
      return
    }
    if (!selectedId) return
    if (pendingAddedIdRef.current === selectedId) {
      if (visiblePresets.some((preset) => preset.id === selectedId)) {
        pendingAddedIdRef.current = undefined
      }
      return
    }
    if (visiblePresets.some((preset) => preset.id === selectedId)) return
    setSelectedId(undefined)
    setEditingNameId(undefined)
  }, [draft.modelConfigId, selectedId, visiblePresets])

  function addPresets(templates: ModelParameterPresetTemplate[] = []): void {
    const sources: Array<ModelParameterPresetTemplate | undefined> = templates.length > 0
      ? templates
      : [undefined]
    const parameterPresets = [...draft.parameterPresets]
    const added = sources.map((template) => {
      const preset: ModelParameterPresetDraft = {
        id: globalThis.crypto.randomUUID(),
        name: nextPresetName(
          parameterPresets,
          template?.label ?? t('settings.new_model_parameter_preset')
        ),
        parametersJson: template ? JSON.stringify(template.parameters, null, 2) : ''
      }
      parameterPresets.push(preset)
      return preset
    })
    const selectedPreset = added[0]
    pendingAddedIdRef.current = selectedPreset.id
    onUpdate({ parameterPresets })
    setSelectedId(selectedPreset.id)
    setEditingNameId(selectedPreset.id)
  }

  function importProtocolPresets(): void {
    if (!parameterTemplateGroup) return
    const parameterPresets = parameterTemplateGroup.templates.map((template) => ({
      id: globalThis.crypto.randomUUID(),
      name: template.label,
      parametersJson: JSON.stringify(template.parameters, null, 2)
    }))
    pendingAddedIdRef.current = parameterPresets[0]?.id
    onUpdate({ parameterPresets, defaultParameterPresetId: undefined })
    setSelectedId(parameterPresets[0]?.id)
    setEditingNameId(undefined)
  }

  function requestImportProtocolPresets(): void {
    if (!parameterTemplateGroup) return
    if (draft.parameterPresets.length === 0) {
      importProtocolPresets()
      return
    }
    setConfirmDialog({
      title: t('settings.restore_model_parameter_presets_title', {
        protocol: parameterTemplateGroup.label
      }),
      description: t('settings.restore_model_parameter_presets_description'),
      confirmText: t('settings.import_protocol_defaults'),
      onConfirm: importProtocolPresets
    })
  }

  function updateSelected(update: Partial<ModelParameterPresetDraft>): void {
    if (!isCustom || selectedIndex < 0) return
    const parameterPresets = [...draft.parameterPresets]
    parameterPresets[selectedIndex] = { ...parameterPresets[selectedIndex], ...update }
    onUpdate({ parameterPresets })
  }

  function deleteSelected(): void {
    if (!isCustom || selectedIndex < 0 || !selected) return
    const parameterPresets = draft.parameterPresets.filter((preset) => preset.id !== selected.id)
    const nextSelected = parameterPresets[Math.min(selectedIndex, parameterPresets.length - 1)]
    onUpdate({
      parameterPresets,
      defaultParameterPresetId: draft.defaultParameterPresetId === selected.id
        ? undefined
        : draft.defaultParameterPresetId
    })
    setEditingNameId(undefined)
    setSelectedId(nextSelected?.id)
  }

  function moveSelected(direction: -1 | 1): void {
    if (!isCustom || selectedIndex < 0) return
    const targetIndex = selectedIndex + direction
    if (targetIndex < 0 || targetIndex >= draft.parameterPresets.length) return
    const parameterPresets = [...draft.parameterPresets]
    ;[parameterPresets[selectedIndex], parameterPresets[targetIndex]] = [
      parameterPresets[targetIndex],
      parameterPresets[selectedIndex]
    ]
    onUpdate({ parameterPresets })
  }

  function updateMode(parameterPresetMode: ModelParameterPresetMode): void {
    const availablePresets = parameterPresetMode === 'protocol_default'
      ? protocolPresets
      : parameterPresetMode === 'custom'
        ? draft.parameterPresets
        : []
    onUpdate({
      parameterPresetMode,
      defaultParameterPresetId: availablePresets.some(
        (preset) => preset.id === draft.defaultParameterPresetId
      )
        ? draft.defaultParameterPresetId
        : undefined
    })
  }

  const modeOptions: Array<{ value: ModelParameterPresetMode, label: string }> = [
    { value: 'protocol_default', label: t('settings.parameter_preset_mode_protocol_default') },
    { value: 'custom', label: t('settings.parameter_preset_mode_custom') },
    { value: 'none', label: t('settings.parameter_preset_mode_none') }
  ]

  return (
    <div className="model-parameter-presets">
      <div className="model-parameter-presets-heading ui-field-heading">
        <span>{t('settings.model_parameter_presets')}</span>
        <SearchableOptionPicker
          ariaLabel={t('settings.parameter_preset_mode')}
          className="model-parameter-preset-mode-picker"
          emptyLabel={t('settings.no_options')}
          options={modeOptions}
          popoverClassName="model-parameter-preset-mode-popover"
          portalContainer={portalContainer}
          searchable={false}
          value={draft.parameterPresetMode}
          onChange={(parameterPresetMode) => updateMode(parameterPresetMode as ModelParameterPresetMode)}
        />
      </div>

      {draft.parameterPresetMode === 'protocol_default' && (
        <p className="model-parameter-preset-mode-description ui-muted">
          {t('settings.protocol_default_reasoning_options_description', {
            protocol: parameterTemplateGroup?.label ?? draft.protocol
          })}
        </p>
      )}

      {draft.parameterPresetMode === 'none' && (
        <div className="model-parameter-presets-empty ui-muted">
          {t('settings.reasoning_options_disabled_description')}
        </div>
      )}

      {isCustom && (
        <SettingsListActions
          addLabel={t('settings.add_model_parameter_preset')}
          additionalActions={(
            <button
              aria-label={t('settings.import_protocol_defaults')}
              className="ui-icon-button"
              data-tooltip={t('settings.import_protocol_defaults')}
              disabled={!parameterTemplateGroup}
              type="button"
              onClick={requestImportProtocolPresets}
            >
              <RotateCcw size={UI_ICON_SIZE_LARGE} />
            </button>
          )}
          canDelete={Boolean(selected)}
          canMoveDown={selectedIndex >= 0 && selectedIndex < draft.parameterPresets.length - 1}
          canMoveUp={selectedIndex > 0}
          deleteLabel={t('settings.delete_model_parameter_preset')}
          onAdd={() => addPresets()}
          onDelete={deleteSelected}
          onMove={moveSelected}
        />
      )}

      {draft.parameterPresetMode !== 'none' && (
        visiblePresets.length === 0 ? (
          <div className="model-parameter-presets-empty ui-muted">
            {t('settings.no_model_parameter_presets')}
          </div>
        ) : (
          <div className="model-parameter-presets-layout">
            <div
              aria-label={t('settings.model_parameter_presets')}
              className="model-parameter-preset-list ui-list ui-list-compact ui-list-framed"
              role="listbox"
            >
              {visiblePresets.map((preset) => isCustom && preset.id === editingNameId
                ? (
                    <div
                      aria-selected={preset.id === selected?.id}
                      className="model-parameter-preset-name-editor ui-list-inline-editor ui-list-editor-compact"
                      key={preset.id}
                      role="option"
                    >
                      <CommitTextInput
                        aria-label={t('settings.name')}
                        autoFocus
                        value={preset.name}
                        onBlur={() => setEditingNameId(undefined)}
                        onCommit={(name) => updateSelected({ name })}
                      />
                      {preset.id === draft.defaultParameterPresetId && <small>{t('common.default')}</small>}
                    </div>
                  )
                : (
                    <button
                      aria-selected={preset.id === selected?.id}
                      className="model-parameter-preset-item ui-list-item ui-list-item-compact ui-list-item-split"
                      key={preset.id}
                      onClick={() => {
                        if (isCustom && preset.id === selected?.id) {
                          setEditingNameId(preset.id)
                        } else {
                          setSelectedId(preset.id)
                        }
                      }}
                      role="option"
                      type="button"
                    >
                      <strong>{preset.name || t('settings.unnamed_model_parameter_preset')}</strong>
                      {preset.id === draft.defaultParameterPresetId && <small>{t('common.default')}</small>}
                    </button>
                ))}
            </div>
            {selected && (
              <div className="model-parameter-preset-editor">
                <div className="ui-field-stack">
                  <div className="model-parameter-preset-heading ui-field-heading">
                    <span>{t('settings.model_parameter_preset_parameters')}</span>
                    <CheckboxField
                      checked={draft.defaultParameterPresetId === selected.id}
                      className="ui-checkbox-field-inline"
                      label={t('common.default')}
                      onChange={(checked) => onUpdate({
                        defaultParameterPresetId: checked ? selected.id : undefined
                      })}
                    />
                  </div>
                  <CommitTextarea
                    aria-label={t('settings.model_parameter_preset_parameters')}
                    className="ui-autosize-textarea ui-code-textarea"
                    data-max-height="none"
                    readOnly={!isCustom}
                    value={selected.parametersJson}
                    onCommit={(parametersJson) => updateSelected({ parametersJson })}
                    placeholder='{"enable_thinking":true}'
                    rows={UI_TEXTAREA_ROWS_COMPACT}
                  />
                </div>
              </div>
            )}
          </div>
        )
      )}
      <ConfirmDialog request={confirmDialog} onClose={() => setConfirmDialog(undefined)} />
    </div>
  )
}

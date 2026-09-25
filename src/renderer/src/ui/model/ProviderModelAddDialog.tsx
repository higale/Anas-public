import * as Dialog from '@radix-ui/react-dialog'
import { ListPlus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelListAuth, ModelProtocol } from '@shared/types'
import { Checkbox } from '../Checkbox'
import { CheckboxField } from '../CheckboxField'
import { RefreshButton } from '../RefreshButton'
import { ModelListUrlPopover } from './ModelListUrlPopover'
import type { ModelListSettingsUpdate } from './ModelListUrlPopover'

interface ProviderModelAddDialogProps {
  baseUrl: string
  candidates: string[]
  configuredModelIds: string[]
  listLoading: boolean
  modelListAuth: ModelListAuth
  modelListUrl: string
  open: boolean
  protocol: ModelProtocol
  onAddBlank(): boolean | void | Promise<boolean | void>
  onAddSelected(models: string[]): boolean | void | Promise<boolean | void>
  onModelListSettingsChange(update: ModelListSettingsUpdate): void
  onOpenChange(open: boolean): void
  onRefreshCandidates(): void | Promise<void>
}

export function ProviderModelAddDialog({
  baseUrl,
  candidates,
  configuredModelIds,
  listLoading,
  modelListAuth,
  modelListUrl,
  open,
  protocol,
  onAddBlank,
  onAddSelected,
  onModelListSettingsChange,
  onOpenChange,
  onRefreshCandidates
}: ProviderModelAddDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  useEffect(() => {
    if (!open) {
      setSelected([])
      setQuery('')
    }
  }, [open])
  const options = useMemo(
    () => Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))),
    [candidates]
  )
  const optionSet = useMemo(() => new Set(options), [options])
  const configuredModelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const id of configuredModelIds) {
      const model = id.trim()
      if (model) counts.set(model, (counts.get(model) ?? 0) + 1)
    }
    return counts
  }, [configuredModelIds])
  const filteredOptions = useMemo(() => options.filter((model) => model.toLowerCase().includes(normalizedQuery)), [options, normalizedQuery])
  const selectedOptions = selected.filter((model) => optionSet.has(model))
  const selectedSet = new Set(selectedOptions)
  const allSelected = filteredOptions.length > 0 && filteredOptions.every((model) => selectedSet.has(model))

  function changeOpen(nextOpen: boolean): void {
    if (busy) return
    onOpenChange(nextOpen)
  }

  function toggle(model: string, checked: boolean): void {
    setSelected((current) => checked
      ? Array.from(new Set([...current, model]))
      : current.filter((candidate) => candidate !== model))
  }

  function toggleVisible(checked: boolean): void {
    const visible = new Set(filteredOptions)
    setSelected((current) => checked
      ? Array.from(new Set([...current, ...filteredOptions]))
      : current.filter((model) => !visible.has(model)))
  }

  async function addBlank(): Promise<void> {
    setBusy(true)
    try {
      const added = await onAddBlank()
      if (added !== false) {
        onOpenChange(false)
      }
    } finally {
      setBusy(false)
    }
  }

  async function addSelected(): Promise<void> {
    if (selectedOptions.length === 0) return
    setBusy(true)
    try {
      const added = await onAddSelected(selectedOptions)
      if (added !== false) {
        onOpenChange(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          className="provider-model-add-dialog ui-dialog ui-dialog-medium ui-dialog-font-scaled ui-dialog-centered ui-popover"
          ref={setPortalContainer}
        >
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon">
              <ListPlus size={18} />
            </div>
            <div>
              <Dialog.Title asChild>
                <h2 className="ui-dialog-title">{t('settings.add_models_title')}</h2>
              </Dialog.Title>
              <Dialog.Description asChild>
                <p className="ui-dialog-description">{t('settings.add_models_description')}</p>
              </Dialog.Description>
            </div>
          </header>

          <div className="provider-model-add-toolbar">
            <input
              aria-label={t('settings.search_models')}
              autoComplete="off"
              autoFocus
              className="ui-input"
              disabled={busy}
              placeholder={t('settings.search_models')}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ModelListUrlPopover
              baseUrl={baseUrl}
              modelListAuth={modelListAuth}
              modelListUrl={modelListUrl}
              portalContainer={portalContainer}
              protocol={protocol}
              onChange={onModelListSettingsChange}
            />
            <RefreshButton
              label={t('settings.fetch_available_models')}
              loading={listLoading}
              onClick={() => void onRefreshCandidates()}
              showLabel
              variant="small"
            />
          </div>
          <div className="provider-model-add-options ui-list ui-list-framed">
            {options.length === 0 && (
              <div className="ui-empty-state ui-empty-state-compact">
                {listLoading ? t('common.loading') : t('settings.no_available_models')}
              </div>
            )}
            {options.length > 0 && filteredOptions.length === 0 && (
              <div className="ui-empty-state ui-empty-state-compact">{t('settings.no_matching_models')}</div>
            )}
            {filteredOptions.map((model) => {
              const count = configuredModelCounts.get(model) ?? 0
              return (
                <label className="provider-model-add-option ui-check-card ui-list-item" key={model}>
                  <Checkbox
                    checked={selectedSet.has(model)}
                    disabled={busy}
                    onChange={(checked) => toggle(model, checked)}
                  />
                  <span>
                    <strong className="ui-row">
                      <span>{model}</span>
                      {count > 0 && (
                        <span className="ui-badge ui-badge-info">
                          {t(count > 1 ? 'settings.model_already_added_count' : 'settings.model_already_added', { count })}
                        </span>
                      )}
                    </strong>
                  </span>
                </label>
              )
            })}
          </div>

          <footer className="provider-model-add-footer ui-dialog-footer">
            <CheckboxField
              checked={allSelected}
              className="ui-checkbox-field-inline"
              disabled={busy || filteredOptions.length === 0}
              label={t(normalizedQuery ? 'settings.select_filtered_models' : 'menu.select_all')}
              onChange={toggleVisible}
            />
            <div className="provider-model-add-actions">
              <button className="ui-button ui-button-compact" disabled={busy} onClick={() => void addBlank()} type="button">
                <Plus size={14} />
                <span>{t('settings.blank_model')}</span>
              </button>
              <Dialog.Close asChild>
                <button className="ui-button ui-button-compact" disabled={busy} type="button">
                  <X size={14} />
                  <span>{t('common.cancel')}</span>
                </button>
              </Dialog.Close>
              <button
                className="ui-button ui-button-compact"
                disabled={busy || selectedOptions.length === 0}
                onClick={() => void addSelected()}
                type="button"
              >
                <ListPlus size={14} />
                <span>{t('settings.add_selected_models', { count: selectedOptions.length })}</span>
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

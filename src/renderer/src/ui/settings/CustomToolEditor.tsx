import { errorDetail } from '@shared/recovery'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, FileCode, X } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { customToolDefaults, type CustomToolDefinition, type CustomToolSave } from '@shared/customTools'
import { maxCommandTimeoutSeconds } from '@shared/commandShell'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { CheckboxField } from '../CheckboxField'

const exampleSchema = { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false }

export function CustomToolEditor({ tool, onClose, onSave }: {
  tool?: CustomToolDefinition
  onClose(): void
  onSave(tool: CustomToolSave): Promise<void>
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<CustomToolSave>(() => tool ?? {
    ...customToolDefaults, name: '', description: '', inputSchema: exampleSchema
  })
  const [schema, setSchema] = useState(() => JSON.stringify(draft.inputSchema, null, 2))
  const [timeoutDraft, setTimeoutDraft] = useState(() => draft.timeoutSeconds === 0 ? '' : String(draft.timeoutSeconds))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const update = (value: Partial<CustomToolSave>) => setDraft((current) => ({ ...current, ...value }))
  async function save() {
    setBusy(true)
    setError('')
    try {
      await onSave({ ...draft, inputSchema: JSON.parse(schema), timeoutSeconds: Number(timeoutDraft) })
      onClose()
    } catch (reason) { setError(errorDetail(reason)) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="ui-backdrop" />
      <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-fixed-footer ui-dialog-centered ui-popover"
        onPointerDownOutside={(event) => event.preventDefault()}>
        <div className="ui-dialog-body ui-form-section">
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon"><FileCode size={18} /></div>
            <div>
              <Dialog.Title className="ui-dialog-title">{t(tool ? 'custom_tools.edit' : 'custom_tools.add')}</Dialog.Title>
              <Dialog.Description className="ui-dialog-description">{t('custom_tools.editor_hint')}</Dialog.Description>
            </div>
          </header>
          <fieldset className="ui-form-section" disabled={busy}>
            <label className="ui-field-stack"><span>{t('custom_tools.name')}</span><input className="ui-input" value={draft.name} maxLength={64} placeholder="submit_result" onChange={(event) => update({ name: event.target.value })} /></label>
            <label className="ui-field-stack"><span>{t('custom_tools.description')}</span>
              <CommitTextarea className="ui-textarea ui-autosize-textarea" rows={2} data-min-rows={2} data-max-rows={4} value={draft.description}
                onCommit={(description) => update({ description })} onDraftChange={(description) => update({ description })} />
            </label>
            <label className="ui-field-stack"><span>{t('custom_tools.schema')}</span>
              <CommitTextarea className="ui-textarea ui-code-textarea ui-autosize-textarea" rows={4} data-min-rows={4} data-max-rows={8} value={schema} onCommit={setSchema} onDraftChange={setSchema} />
            </label>
            <label className="ui-field-stack"><span>{t('custom_tools.command')}</span>
              <CommitTextarea className="ui-textarea ui-code-textarea ui-autosize-textarea" rows={2} data-min-rows={2} data-max-rows={4} value={draft.command}
                onCommit={(command) => update({ command })} onDraftChange={(command) => update({ command })} />
            </label>
            <small className="ui-field-hint">{t('custom_tools.protocol_hint', { args: '{{args}}', tool_dir: '{{tool_dir}}' })}</small>
            <div className="ui-grid-auto ui-grid-centered" style={{ '--ui-grid-min-width': '19em' } as CSSProperties}>
              <label className="ui-row" data-tooltip={t('custom_tools.timeout_hint')}><span className="ui-field-label">{t('custom_tools.timeout')}</span>
                <CommitTextInput className="ui-input ui-input-short" type="number" min={0} max={maxCommandTimeoutSeconds} step={1}
                  placeholder={t('settings.max_model_calls_unlimited')} value={timeoutDraft} normalizeDraft={(value) => value === '0' ? '' : value}
                  onCommit={setTimeoutDraft} onDraftChange={setTimeoutDraft} />
              </label>
              <CheckboxField checked={draft.interactive} onChange={(interactive) => update({ interactive })} label={t('custom_tools.interactive')}
                tooltip={t('custom_tools.interactive_hint')} />
            </div>
            {error && <div role="alert"><p className="ui-status-danger">{t('custom_tools.update_failed')}</p><pre className="ui-code-block">{error}</pre></div>}
          </fieldset>
        </div>
        <footer className="ui-dialog-footer">
          <button className="ui-button ui-button-compact" type="button" disabled={busy} onClick={onClose}><X size={14} />{t('common.cancel')}</button>
          <button className="ui-button ui-button-compact ui-button-primary" type="button" disabled={busy} onClick={() => void save()}><Check size={14} />{t('common.save')}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

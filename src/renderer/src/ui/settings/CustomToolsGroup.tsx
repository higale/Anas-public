import { errorDetail } from '@shared/recovery'
import { FolderDown, FolderOpen, Pencil, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot } from '@shared/types'
import type { ToolPackage } from '@shared/toolPackages'
import { SettingsListActions } from './SettingsListActions'
import { CustomToolEditor } from './CustomToolEditor'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { UI_ICON_SIZE_LARGE } from '../uiConstants'

export function CustomToolsGroup({ tools, onConfigChange }: {
  tools: ToolPackage[]
  onConfigChange(config: AppConfigSnapshot): void
}) {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState<ToolPackage | 'new'>()
  const [deleting, setDeleting] = useState<ToolPackage>()
  const [busy, setBusy] = useState(false)
  const selected = tools.find(tool => tool.id === selectedId)
  const index = tools.findIndex(tool => tool.id === selectedId)
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true)
    try { await action(); onConfigChange(await window.gale.tools.refresh()) }
    catch (reason) { notice.error(t('custom_tools.update_failed'), { description: errorDetail(reason) }) }
    finally { setBusy(false) }
  }
  async function importDirectories() {
    setBusy(true)
    try {
      const result = await window.gale.tools.importDirectories()
      if (result.status === 'cancelled') return
      if (result.status === 'error') {
        notice.error(t(`custom_tools.import_error_${result.error.code}`, { name: result.error.name }), { description: result.error.detail })
        return
      }
      onConfigChange(result.config)
      setSelectedId(result.ids[0])
      notice.success(t('custom_tools.imported', { count: result.ids.length }))
    } catch (reason) { notice.error(t('custom_tools.import_error_failed'), { description: errorDetail(reason) }) }
    finally { setBusy(false) }
  }
  return <div className="ui-form-section">
    <div className="ui-row-between"><strong className="ui-section-title">{t('custom_tools.title')}</strong>
      <button className="ui-icon-button" type="button" disabled={busy} aria-label={t('common.refresh')} data-tooltip={t('common.refresh')}
        onClick={() => void mutate(() => Promise.resolve())}><RefreshCw size={UI_ICON_SIZE_LARGE} /></button>
    </div>
    <SettingsListActions addLabel={t('custom_tools.add')} deleteLabel={t('custom_tools.delete')}
      canDelete={Boolean(selected)} canMoveUp={index > 0} canMoveDown={index >= 0 && index < tools.length - 1} disabled={busy}
      additionalActions={<>
        <button className="ui-icon-button" type="button" aria-label={t('custom_tools.import')} data-tooltip={t('custom_tools.import')}
          disabled={busy} onClick={() => void importDirectories()}><FolderDown size={UI_ICON_SIZE_LARGE} /></button>
        <button className="ui-icon-button" type="button" aria-label={t('custom_tools.edit')} data-tooltip={t('custom_tools.edit')}
          disabled={busy || !selected?.definition} onClick={() => setEditing(selected)}><Pencil size={UI_ICON_SIZE_LARGE} /></button>
        <button className="ui-icon-button" type="button" aria-label={t('common.open')} data-tooltip={t('common.open')}
          disabled={busy || !selected} onClick={() => void mutate(() => window.gale.files.showItemInFolder(selected!.directory))}><FolderOpen size={UI_ICON_SIZE_LARGE} /></button>
      </>}
      onAdd={() => setEditing('new')} onDelete={() => setDeleting(selected)}
      onMove={direction => selected ? mutate(() => window.gale.config.moveCustomTool(selected.id, direction)) : undefined} />
    <div className="ui-list-framed ui-form-section">
      {tools.map(tool => <button key={tool.id} className={`ui-list-item${selectedId === tool.id ? " active" : ""}`} type="button" aria-pressed={selectedId === tool.id} disabled={busy}
          onClick={() => setSelectedId(tool.id)} onDoubleClick={() => { if (tool.definition) setEditing(tool) }}>
          <span className="ui-row"><code className="ui-tool-name">{tool.name}</code>
            {tool.error && <span className="ui-badge">{t('capabilities.inactive')}</span>}
          </span>
        </button>)}
      {!tools.length && <small className="ui-field-hint">{t('custom_tools.empty')}</small>}
    </div>
    {selected && <div className="ui-form-section ui-form-section-divided">
      <p className="ui-field-hint">{selected.description}</p>
      {selected.error && <div role="alert" className="ui-status-danger">{selected.error}</div>}
    </div>}
    {editing && <CustomToolEditor key={editing === 'new' ? 'new' : editing.id} tool={editing === 'new' ? undefined : editing.definition} onClose={() => setEditing(undefined)}
      onSave={async tool => {
        const config = await window.gale.config.saveCustomTool(tool)
        onConfigChange(config)
        setSelectedId(tool.id ?? config.customTools.find(item => !tools.some(previous => previous.id === item.id))?.id)
      }} />}
    <ConfirmDialog request={deleting ? {
      title: t('custom_tools.delete'),
      description: t('custom_tools.delete_hint', { name: deleting.name }), variant: 'danger',
      onConfirm: () => mutate(async () => {
        await window.gale.config.deleteCustomTool(deleting.id)
        setSelectedId(undefined)
      })
    } : undefined} onClose={() => setDeleting(undefined)} />
  </div>
}

import { createContext, useContext, type ReactNode } from 'react'
import { Columns2, ChevronsDownUp, WrapText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppSettings } from '@shared/types'
import { PanelActions } from '../agent/PanelActions'
import { SelectableIconButton } from '../SelectableIconButton'
import { notice } from '../notice'

export type DiffViewSettings = Pick<AppSettings, 'diffViewMode' | 'diffFoldUnchanged' | 'diffWordWrap'>
export const DiffPreferences = createContext<DiffViewSettings & { onChange(update: Partial<DiffViewSettings>): Promise<void> }>({
  diffViewMode: 'inline', diffFoldUnchanged: true, diffWordWrap: false, onChange: async () => {}
})

/** A persistent panel toolbar controls global display preferences independently of file reads. */
export function DiffView({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const preferences = useContext(DiffPreferences)
  const { diffViewMode: mode, diffFoldUnchanged: fold, diffWordWrap: wordWrap } = preferences
  const save = (update: Partial<DiffViewSettings>) => {
    void preferences.onChange(update).catch(() => notice.error(t('diff.save_failed')))
  }
  return <>
    <PanelActions>
      <SelectableIconButton Icon={Columns2} iconSize={14} variant="toolbar" label={t('diff.side_by_side')} pressed={mode === 'side_by_side'}
        onClick={() => save({ diffViewMode: mode === 'side_by_side' ? 'inline' : 'side_by_side' })} />
      <SelectableIconButton Icon={ChevronsDownUp} iconSize={14} variant="toolbar" label={t('diff.fold')} pressed={fold} onClick={() => save({ diffFoldUnchanged: !fold })} />
      <SelectableIconButton Icon={WrapText} iconSize={14} variant="toolbar" label={t('diff.word_wrap')} pressed={wordWrap} onClick={() => save({ diffWordWrap: !wordWrap })} />
    </PanelActions>
    {children}
  </>
}

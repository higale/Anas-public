import settings from '../../data/config/settings.json'
import type { AppSettings } from '@shared/types'

export const diffViewSettingsFixture: Pick<AppSettings, 'diffViewMode' | 'diffFoldUnchanged' | 'diffWordWrap'> = {
  diffViewMode: settings.diff_view_mode as AppSettings['diffViewMode'],
  diffFoldUnchanged: settings.diff_fold_unchanged,
  diffWordWrap: settings.diff_word_wrap
}

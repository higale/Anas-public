import { ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { UI_ICON_SIZE_BACK, UI_ICON_SIZE_NAV } from '../uiConstants'
import { settingsTabs } from './settingsTabs'
import type { SettingsTab } from './settingsTabs'

interface SettingsSidebarContentProps {
  activeTab: SettingsTab
  onSelectTab: (tab: SettingsTab) => void | Promise<void>
}

interface SettingsSidebarFooterProps {
  onBack: () => void | Promise<void>
}

export function SettingsSidebarContent({
  activeTab,
  onSelectTab
}: SettingsSidebarContentProps) {
  const { t } = useTranslation()
  return (
    <nav className="settings-sidebar-tabs ui-scroll-list" aria-label={t('settings.title')}>
      {settingsTabs.map(({ Icon, ...tab }) => (
        <button
          className={activeTab === tab.id ? 'ui-sidebar-nav-item ui-list-item ui-list-item-active active' : 'ui-sidebar-nav-item ui-list-item'}
          data-settings-tab={tab.id}
          key={tab.id}
          type="button"
          onClick={() => void onSelectTab(tab.id)}
        >
          <Icon className="ui-sidebar-nav-icon" size={UI_ICON_SIZE_NAV} />
          <span className="ui-copy-stack">
            <span className="ui-sidebar-nav-title ui-truncate">{t(tab.labelKey)}</span>
            <span className="ui-sidebar-nav-description ui-truncate">{t(tab.descriptionKey)}</span>
          </span>
        </button>
      ))}
    </nav>
  )
}

export function SettingsSidebarFooter({ onBack }: SettingsSidebarFooterProps) {
  const { t } = useTranslation()
  return (
    <button className="ui-sidebar-action ui-list-item" type="button" onClick={() => void onBack()}>
      <ChevronLeft size={UI_ICON_SIZE_BACK} />
      <span>{t('settings.back')}</span>
    </button>
  )
}

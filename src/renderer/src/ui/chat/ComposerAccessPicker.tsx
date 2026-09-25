import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Shield, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'
import type { AgentAccessMode } from '@shared/agentTypes'

interface ComposerAccessPickerProps {
  disabled: boolean
  accessMode: AgentAccessMode
  onChange(accessMode: AgentAccessMode): void
}

export function ComposerAccessPicker({
  disabled,
  accessMode,
  onChange
}: ComposerAccessPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const platform = document.documentElement.dataset.platform
  const hintSuffix = platform === 'win32' || platform === 'darwin' ? `_${platform}` : ''
  const label = accessMode === 'full_access'
    ? t('chat.access_full')
    : accessMode === 'strict_approval'
      ? t('chat.access_strict_approval')
      : t('chat.access_read_only_allowed')

  function select(nextAccessMode: AgentAccessMode): void {
    setOpen(false)
    window.requestAnimationFrame(() => onChange(nextAccessMode))
  }

  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <NoFocusButton
          className={[
            'composer-access-trigger',
            accessMode === 'full_access' ? 'composer-access-trigger-full' : ''
          ].filter(Boolean).join(' ')}
          type="button"
          disabled={disabled}
          aria-label={t('chat.access_mode')}
        >
          {accessMode === 'full_access'
            ? <ShieldCheck size={14} />
            : accessMode === 'strict_approval'
              ? <ShieldQuestion size={14} />
              : <Shield size={14} />}
          <span>{label}</span>
          <ChevronDown size={12} />
        </NoFocusButton>
      </DropdownMenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          className="composer-access-menu ui-menu ui-menu-list"
          side="top"
          align="start"
          sideOffset={7}
          collisionPadding={10}
        >
          <DropdownMenu.Label className="composer-access-menu-label">
            {t('chat.access_mode')}
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className="composer-access-item ui-menu-item ui-menu-item-row"
            onSelect={() => select('strict_approval')}
          >
            <ShieldQuestion size={16} />
            <span className="ui-copy-stack">
              <strong>{t('chat.access_strict_approval')}</strong>
              <small>{t(`chat.access_strict_approval_hint${hintSuffix}`)}</small>
            </span>
            {accessMode === 'strict_approval' && <Check className="composer-access-check" size={15} />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="composer-access-item ui-menu-item ui-menu-item-row"
            onSelect={() => select('read_only_allowed')}
          >
            <Shield size={16} />
            <span className="ui-copy-stack">
              <strong>{t('chat.access_read_only_allowed')}</strong>
              <small>{t(`chat.access_read_only_allowed_hint${hintSuffix}`)}</small>
            </span>
            {accessMode === 'read_only_allowed' && <Check className="composer-access-check" size={15} />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="composer-access-item composer-access-item-full ui-menu-item ui-menu-item-row"
            onSelect={() => select('full_access')}
          >
            <ShieldCheck size={16} />
            <span className="ui-copy-stack">
              <strong>{t('chat.access_full')}</strong>
              <small>{t('chat.access_full_hint')}</small>
            </span>
            {accessMode === 'full_access' && <Check className="composer-access-check" size={15} />}
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}

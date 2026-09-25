import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ResolvedModelConfig } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'

interface ModelParameterPresetPickerProps {
  disabled: boolean
  focusRef?: RefObject<HTMLElement | null>
  modal?: boolean
  model?: ResolvedModelConfig
  selectedId?: string
  onSelect(parameterPresetId: string | null): void | Promise<void>
}

export function ModelParameterPresetPicker({
  disabled,
  focusRef,
  modal = false,
  model,
  selectedId,
  onSelect
}: ModelParameterPresetPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  const Trigger = focusRef ? DropdownMenuTrigger : DropdownMenu.Trigger
  const TriggerButton = focusRef ? NoFocusButton : 'button'
  const presets = model?.parameterPresets ?? []
  if (presets.length === 0 && !selectedId) return null
  const selectedPreset = presets.find((preset) => preset.id === selectedId)
  const label = selectedPreset?.name ?? t(selectedId
    ? 'chat.model_parameter_preset_unavailable'
    : 'chat.no_model_parameter_preset')

  return (
    <DropdownMenuRoot modal={modal} open={open && !disabled} onOpenChange={(nextOpen) => setOpen(nextOpen && !disabled)}>
      <Trigger asChild disabled={disabled}>
        <TriggerButton
          aria-label={t('chat.select_model_parameter_preset')}
          className="composer-model-parameter-preset-trigger composer-model-segment"
          disabled={disabled}
          type="button"
        >
          <span className="ui-truncate">{label}</span>
        </TriggerButton>
      </Trigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          restoreFocus={!focusRef}
          align="end"
          className="composer-model-parameter-preset-menu ui-menu ui-menu-list"
          collisionPadding={10}
          side="top"
          sideOffset={7}
          onCloseAutoFocus={(event) => {
            if (!focusRef) return
            event.preventDefault()
            focusRef.current?.focus()
          }}
        >
          <DropdownMenu.RadioGroup value={selectedPreset?.id}>
            {presets.map((preset) => (
              <DropdownMenu.RadioItem
                className="ui-menu-item ui-menu-item-row"
                key={preset.id}
                value={preset.id}
                onSelect={() => window.requestAnimationFrame(() => void onSelect(preset.id))}
              >
                <span className="composer-model-parameter-preset-check">
                  {selectedPreset?.id === preset.id && <Check size={13} />}
                </span>
                <span className="ui-truncate">{preset.name}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Item
            className="ui-menu-item ui-menu-item-row"
            onSelect={() => window.requestAnimationFrame(() => void onSelect(null))}
          >
            <span className="composer-model-parameter-preset-check" />
            <span>{t('chat.no_model_parameter_preset')}</span>
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}

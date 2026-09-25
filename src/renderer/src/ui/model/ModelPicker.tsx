import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight, Settings2, Star } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { findProviderModelConfig, isSelectableModelConfig, resolveProviderModelConfig } from '@shared/modelConfig'
import type { ModelProviderConfig } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'
import { ModelParameterPresetBadge } from './ModelParameterPresetBadge'
import { ProviderProtocolIcon } from './ProviderProtocolIcon'
import { providerProtocolLabel } from './providerProtocol'

interface ModelPickerProps {
  providers: ModelProviderConfig[] | undefined
  selectedId?: string
  defaultModelId?: string
  disabled: boolean
  focusRef?: RefObject<HTMLElement | null>
  modal?: boolean
  onOpenModelSettings?(): void | Promise<void>
  onClear?(): void
  onSelect(modelConfigId: string): void | Promise<void>
  onSetDefault?(modelConfigId: string | null): void | Promise<void>
}

interface ModelContextMenuState {
  left: number
  modelConfigId: string
  top: number
  trigger: HTMLElement
}

const modelContextMenuWidth = 148
const modelContextMenuHeight = 44

export function ModelPicker({
  providers: configuredProviders,
  selectedId,
  defaultModelId,
  disabled,
  focusRef,
  modal = false,
  onOpenModelSettings,
  onClear,
  onSelect,
  onSetDefault
}: ModelPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandedProviderId, setExpandedProviderId] = useState<string>()
  const [contextMenu, setContextMenu] = useState<ModelContextMenuState | undefined>()
  const contextActionRef = useRef<HTMLButtonElement>(null)
  const Trigger = focusRef ? DropdownMenuTrigger : DropdownMenu.Trigger
  const TriggerButton = focusRef ? NoFocusButton : 'button'
  const selectedModelItemRef = useRef<HTMLDivElement>(null)
  const providers = useMemo(
    () => configuredProviders?.map((provider) => ({
      provider,
      models: provider.models
        .map((model) => resolveProviderModelConfig(provider, model))
        .filter(isSelectableModelConfig)
    })).filter((group) => group.models.length > 0) ?? [],
    [configuredProviders]
  )
  const selectedModel = findProviderModelConfig(configuredProviders ?? [], selectedId)
  const selectedModelIsDefault = Boolean(selectedModel && selectedModel.id === defaultModelId)
  const label = selectedId && (!selectedModel || !isSelectableModelConfig(selectedModel))
    ? t('chat.model_unavailable')
    : selectedModel?.displayName.trim() || selectedModel?.model.trim() || t('chat.select_model')

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    setContextMenu(undefined)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      selectedModelItemRef.current?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [expandedProviderId, open, selectedModel?.id])

  function select(modelConfigId: string): void {
    setOpen(false)
    window.requestAnimationFrame(() => void onSelect(modelConfigId))
  }

  function setDefault(event: Event): void {
    event.preventDefault()
    if (!selectedModel) return
    window.requestAnimationFrame(() => void onSetDefault?.(selectedModelIsDefault ? null : selectedModel.id))
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, modelConfigId: string): void {
    event.preventDefault()
    event.stopPropagation()
    const menu = event.currentTarget.closest('.composer-model-menu')
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    setContextMenu({
      left: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width - modelContextMenuWidth)),
      modelConfigId,
      top: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height - modelContextMenuHeight)),
      trigger: event.currentTarget
    })
    window.requestAnimationFrame(() => contextActionRef.current?.focus())
  }

  function closeContextMenu(restoreFocus = false): void {
    if (restoreFocus) contextMenu?.trigger.focus()
    setContextMenu(undefined)
  }

  return (
    <DropdownMenuRoot
      modal={modal}
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        if (disabled && nextOpen) return
        setOpen(nextOpen)
        setExpandedProviderId(nextOpen
          ? providers.some(({ provider }) => provider.id === selectedModel?.providerId)
            ? selectedModel?.providerId
            : providers[0]?.provider.id
          : undefined)
        if (!nextOpen) setContextMenu(undefined)
      }}
    >
      <Trigger asChild disabled={disabled}>
        <TriggerButton
          className="composer-model-trigger composer-model-segment"
          type="button"
          disabled={disabled}
          aria-label={t('chat.select_model')}
        >
          <span className="ui-truncate">{label}</span>
        </TriggerButton>
      </Trigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          restoreFocus={!focusRef}
          className="composer-model-menu ui-menu ui-menu-list"
          side="top"
          align="end"
          sideOffset={7}
          collisionPadding={10}
          onPointerDownCapture={(event) => {
            if (contextMenu && event.target instanceof Element && !event.target.closest('.composer-model-context-menu')) {
              setContextMenu(undefined)
            }
          }}
          onKeyDownCapture={(event) => {
            if (contextMenu && event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeContextMenu(true)
            }
          }}
          onCloseAutoFocus={(event) => {
            if (!focusRef) return
            event.preventDefault()
            focusRef.current?.focus()
          }}
        >
          <DropdownMenu.RadioGroup
            className="composer-model-options"
            value={selectedModel?.id ?? ''}
          >
            {onClear && (
              <DropdownMenu.RadioItem
                className="composer-model-item ui-menu-item ui-menu-item-row"
                value=""
                onSelect={() => {
                  setOpen(false)
                  window.requestAnimationFrame(onClear)
                }}
              >
                {t('chat.clear_model_selection')}
              </DropdownMenu.RadioItem>
            )}
            {providers.length === 0
              ? (
                  <DropdownMenu.Item
                    className="composer-model-empty ui-menu-item"
                    disabled
                  >
                    {t('chat.no_available_models')}
                  </DropdownMenu.Item>
                )
              : providers.map(({ provider, models }) => {
                  const expanded = provider.id === expandedProviderId
                  return (
                    <div className="composer-model-provider-group" key={provider.id}>
                      <DropdownMenu.Item
                        className="composer-model-provider-label ui-menu-item"
                        aria-expanded={expanded}
                        aria-label={provider.name}
                        onSelect={(event) => {
                          event.preventDefault()
                          setExpandedProviderId((current) => current === provider.id ? undefined : provider.id)
                        }}
                      >
                        <span className="provider-protocol-badge">
                          <ProviderProtocolIcon
                            provider={provider.protocol}
                            brandColor
                            label={providerProtocolLabel(provider.protocol)}
                          />
                        </span>
                        <strong className="ui-truncate">{provider.name}</strong>
                        <ChevronRight className="composer-model-provider-chevron" size={13} aria-hidden="true" />
                      </DropdownMenu.Item>
                      {expanded && models.map((model) => (
                        <DropdownMenu.RadioItem
                          ref={model.id === selectedModel?.id ? selectedModelItemRef : undefined}
                          key={model.id}
                          value={model.id}
                          className="composer-model-item composer-model-child ui-menu-item ui-menu-item-row"
                          data-app-context-menu={onSetDefault ? true : undefined}
                          onContextMenu={onSetDefault ? (event) => openContextMenu(event, model.id) : undefined}
                          onSelect={() => select(model.id)}
                        >
                          <strong className="composer-model-name ui-truncate">
                            {model.displayName.trim() || model.model.trim()}
                          </strong>
                          {model.id === defaultModelId && (
                            <span
                              className="composer-model-default-marker"
                              aria-hidden="true"
                              data-tooltip={t('chat.default_model')}
                            >
                              <Star size={13} fill="currentColor" />
                            </span>
                          )}
                          <ModelParameterPresetBadge
                            mode={model.parameterPresetMode}
                            presetCount={model.parameterPresets?.length ?? 0}
                          />
                        </DropdownMenu.RadioItem>
                      ))}
                    </div>
                  )
                })}
          </DropdownMenu.RadioGroup>
          {(onOpenModelSettings || onSetDefault) && <>
            <DropdownMenu.Separator className="ui-menu-separator" />
            <div className="composer-model-footer">
              {onOpenModelSettings && <DropdownMenu.Item
                className="composer-model-settings ui-menu-item ui-menu-item-row"
                onSelect={() => void onOpenModelSettings()}
              >
                <Settings2 size={15} />
                <span>{t('chat.model_settings')}</span>
              </DropdownMenu.Item>}
              {onSetDefault && <DropdownMenu.Item
                className="composer-model-default ui-menu-item ui-menu-item-row"
                disabled={!selectedModel}
                onSelect={setDefault}
              >
                <Star size={15} fill={selectedModelIsDefault ? 'currentColor' : 'none'} />
                <span>{t(selectedModelIsDefault ? 'chat.clear_default_model' : 'chat.set_default_model')}</span>
              </DropdownMenu.Item>}
            </div>
          </>}
          {contextMenu && onSetDefault && (() => {
            const modelIsDefault = contextMenu.modelConfigId === defaultModelId
            return (
              <div
                className="composer-model-context-menu ui-menu ui-menu-list"
                role="menu"
                tabIndex={-1}
                aria-label={t(modelIsDefault ? 'chat.clear_default_model' : 'chat.set_default_model')}
                style={{ left: contextMenu.left, top: contextMenu.top }}
                onContextMenu={(event) => event.preventDefault()}
              >
                <NoFocusButton
                  ref={contextActionRef}
                  className="ui-menu-item ui-menu-item-row"
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation()
                    setContextMenu(undefined)
                    void onSetDefault(modelIsDefault ? null : contextMenu.modelConfigId)
                  }}
                >
                  <Star size={15} fill={modelIsDefault ? 'currentColor' : 'none'} />
                  <span>{t(modelIsDefault ? 'chat.clear_default_model' : 'chat.set_default_model')}</span>
                </NoFocusButton>
              </div>
            )
          })()}
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}

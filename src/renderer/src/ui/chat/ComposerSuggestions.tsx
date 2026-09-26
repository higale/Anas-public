import { PopoverContent } from '../PopoverContent'
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { History, Star, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NoFocusButton } from '../NoFocusButton'
import type { ComposerSuggestion } from './composerTypes'

function compactInputPreview(text: string, maxLength = 96): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

interface ComposerSuggestionsProps {
  formRef: RefObject<HTMLFormElement | null>
  id: string
  activeIndex: number
  showSuggestions: boolean
  suggestions: ComposerSuggestion[]
  onApplySuggestion: (suggestion: ComposerSuggestion) => void
  onRemoveSuggestion: (text: string) => void | Promise<void>
  onToggleSuggestionPinned: (text: string, pinned: boolean) => void | Promise<void>
}

export function ComposerSuggestions({
  formRef,
  id,
  activeIndex,
  showSuggestions,
  suggestions,
  onApplySuggestion,
  onRemoveSuggestion,
  onToggleSuggestionPinned
}: ComposerSuggestionsProps) {
  const { t } = useTranslation()
  const activeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (showSuggestions) activeButton.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, showSuggestions, suggestions])

  if (!showSuggestions) return null

  return (
    <Popover.Portal>
      <PopoverContent
        id={id}
        role="listbox"
        aria-label={t('settings.skill_shortcut')}
        className="composer-suggestions ui-popover ui-list"
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={8}
        style={{
          '--composer-suggestions-width': formRef.current?.offsetWidth
            ? `${Math.max(0, formRef.current.offsetWidth - 16)}px`
            : 'min(720px, calc(100vw - 32px))'
        } as CSSProperties}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        {suggestions.map((suggestion, index) => (
          <div
            className={`composer-suggestion ui-list-item${index === activeIndex ? ' ui-list-item-active' : ''}`}
            key={suggestion.id}
          >
            <NoFocusButton
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              ref={index === activeIndex ? activeButton : undefined}
              className="composer-suggestion-apply"
              type="button"
              onClick={() => onApplySuggestion(suggestion)}
            >
              <span className={`suggestion-kind ${suggestion.kind}`}>
                {suggestion.kind === 'command'
                  ? (suggestion.command?.skillName ? 'S' : '/')
                  : suggestion.kind === 'favorite'
                    ? <Star size={12} />
                    : <History size={12} />}
              </span>
              <span className={suggestion.description ? 'suggestion-main suggestion-main-with-description' : 'suggestion-main'}>
                <strong>
                  {suggestion.kind === 'command'
                    ? suggestion.text.replace(/^\//, '')
                    : compactInputPreview(suggestion.text)}
                </strong>
                {suggestion.description && <small>{suggestion.description}</small>}
              </span>
            </NoFocusButton>
            {suggestion.item && (
              <span className="suggestion-actions">
                <NoFocusButton
                  className="ui-tool-button ui-tool-button-small ui-tool-button-muted"
                  type="button"
                  aria-label={suggestion.item.pinned ? t('chat.remove_favorite') : t('chat.add_favorite')}
                  data-tooltip={suggestion.item.pinned ? t('chat.remove_favorite') : t('chat.add_favorite')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onToggleSuggestionPinned(suggestion.item!.text, !suggestion.item!.pinned)
                  }}
                >
                  <Star size={13} fill={suggestion.item.pinned ? 'currentColor' : 'none'} />
                </NoFocusButton>
                <NoFocusButton
                  className="ui-tool-button ui-tool-button-small ui-tool-button-muted"
                  type="button"
                  aria-label={t('chat.delete_from_history')}
                  data-tooltip={t('chat.delete_from_history')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onRemoveSuggestion(suggestion.item!.text)
                  }}
                >
                  <Trash2 size={13} />
                </NoFocusButton>
              </span>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover.Portal>
  )
}

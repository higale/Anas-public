import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultSpeechReplyVoice } from '@shared/speechText'
import type { SpeechVoiceInfo } from '@shared/types'
import { RefreshButton } from '../RefreshButton'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { UI_ICON_SIZE_MEDIUM } from '../uiConstants'

interface VoiceDisplay {
  label: string
  searchText: string
}

interface SpeechVoicePickerProps {
  refreshing: boolean
  value: string
  voices: SpeechVoiceInfo[]
  onChange: (voice: string) => void | Promise<void>
  onRefresh: () => void | Promise<void>
}

function shortNameLocale(shortName: string): string {
  const parts = shortName.split('-')
  const hasLocalePrefix = parts.length >= 3 && /^[a-z]{2}$/i.test(parts[0]) && /^[a-z]{2}$/i.test(parts[1])
  return hasLocalePrefix ? `${parts[0]}-${parts[1]}` : ''
}

function voiceDetailIsDuplicate(voice: SpeechVoiceInfo): boolean {
  if (!voice.detail) return false
  const shortName = voice.shortName.toLowerCase()
  const detail = voice.detail.toLowerCase()
  return detail === shortNameLocale(voice.shortName).toLowerCase() || shortName.startsWith(`${detail}-`)
}

function voiceDisplay(voice: SpeechVoiceInfo): VoiceDisplay {
  const detail = voiceDetailIsDuplicate(voice) ? '' : voice.detail
  const label = [voice.shortName, voice.gender ? `(${voice.gender})` : '', detail].filter(Boolean).join(' ')
  return {
    label: label || voice.shortName,
    searchText: [label, voice.shortName, voice.gender, voice.detail].filter(Boolean).join(' ').toLowerCase()
  }
}

export function SpeechVoicePicker({ refreshing, value, voices, onChange, onRefresh }: SpeechVoicePickerProps) {
  const { t } = useTranslation()

  const voiceOptions = useMemo(() => {
    const byName = new Map<string, SpeechVoiceInfo>()
    const currentVoice = defaultSpeechReplyVoice(value)
    for (const voice of voices) byName.set(voice.shortName.toLowerCase(), voice)
    const options = [...byName.values()].sort((left, right) =>
      (left.detail || left.shortName).localeCompare(right.detail || right.shortName) ||
      left.shortName.localeCompare(right.shortName)
    )
    if (!byName.has(currentVoice.toLowerCase())) {
      options.push({
        shortName: currentVoice,
        gender: '',
        detail: ''
      })
    }
    return options
  }, [value, voices])

  return (
    <div className="ui-control-row">
      <SearchableOptionPicker
        ariaLabel={t('speech.voice')}
        emptyLabel={t('speech.no_voices')}
        options={voiceOptions.map((voice) => {
          const display = voiceDisplay(voice)
          return {
            value: voice.shortName,
            label: display.label,
            searchText: display.searchText
          }
        })}
        searchPlaceholder={t('speech.search_voices')}
        value={value}
        onChange={onChange}
      />
      <RefreshButton
        iconSize={UI_ICON_SIZE_MEDIUM}
        label={t('speech.refresh_voices')}
        loading={refreshing}
        onClick={() => void onRefresh()}
        disabled={refreshing}
      />
    </div>
  )
}

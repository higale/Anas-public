import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_SPEECH_REPLY_SPEED, DEFAULT_SPEECH_REPLY_VOICE, MAX_SPEECH_REPLY_SPEED, MIN_SPEECH_REPLY_SPEED, clampSpeechReplySpeed } from '@shared/speechText'
import type { SpeechReplyConfig, SpeechVoiceInfo } from '@shared/types'
import { notice } from '../notice'
import { RangeField } from '../RangeField'
import { SettingsGroup } from '../settings/SettingsGroup'
import { SETTINGS_RANGE_STEP_FINE } from '../uiConstants'
import { SpeechVoicePicker } from './SpeechVoicePicker'

interface SpeechReplySettingsProps {
  value?: SpeechReplyConfig
  onChange: (settings: Partial<SpeechReplyConfig>) => void | Promise<void>
}

export function SpeechReplySettings({ value, onChange }: SpeechReplySettingsProps) {
  const { t } = useTranslation()
  const [voices, setVoices] = useState<SpeechVoiceInfo[]>([])
  const [voiceStatus, setVoiceStatus] = useState<string | undefined>()
  const [refreshingVoices, setRefreshingVoices] = useState(false)
  const voice = value?.voice ?? DEFAULT_SPEECH_REPLY_VOICE
  const speed = value?.speed ?? DEFAULT_SPEECH_REPLY_SPEED

  const loadVoices = useCallback(async (forceRefresh = false, cancelled?: () => boolean): Promise<void> => {
    if (!forceRefresh) setVoiceStatus(t('speech.loading_voices'))
    if (forceRefresh) setRefreshingVoices(true)
    try {
      const nextVoices = await window.gale.speech.listVoices(forceRefresh)
      if (cancelled?.()) return
      setVoices(nextVoices)
      setVoiceStatus(undefined)
      if (forceRefresh) notice.success(t('speech.voices_refreshed'))
    } catch {
      if (!cancelled?.()) {
        const message = t('speech.failed_load_voices')
        notice.error(message)
        setVoiceStatus(undefined)
      }
    } finally {
      if (!cancelled?.() && forceRefresh) setRefreshingVoices(false)
    }
  }, [t])

  useEffect(() => {
    let cancelled = false

    void loadVoices(false, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [loadVoices])

  const speedLabel = `${Number(speed.toFixed(2))}x`

  return (
    <SettingsGroup title={t('speech.title')} description={voiceStatus ?? t('speech.hint')}>
      <div className="ui-form-row">
        <span>
          <strong>{t('speech.voice')}</strong>
          <small>{t('speech.voice_hint')}</small>
        </span>
        <SpeechVoicePicker
          refreshing={refreshingVoices}
          value={voice}
          voices={voices}
          onChange={(voice) => void onChange({ voice })}
          onRefresh={() => void loadVoices(true)}
        />
      </div>
      <RangeField
        className="ui-form-row-standard"
        label={`${t('speech.speed')} ${speedLabel}`}
        min={MIN_SPEECH_REPLY_SPEED}
        max={MAX_SPEECH_REPLY_SPEED}
        step={SETTINGS_RANGE_STEP_FINE}
        value={speed}
        onChange={(value) => void onChange({ speed: clampSpeechReplySpeed(value) })}
      />
    </SettingsGroup>
  )
}

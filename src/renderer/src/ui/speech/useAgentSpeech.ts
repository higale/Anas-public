import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentMessage,
  AgentRuntimeEvent
} from '@shared/agentTypes'
import {
  idleAgentReplyCandidate,
  transitionAgentReplyCandidate,
  type AgentReplyCandidateState
} from '@shared/agentReplyLifecycle'
import {
  findSpeechCutPosition,
  splitSpeechText,
  type SpeechTextContext
} from '@shared/speechText'
import type {
  SpeechRendererDiagnostics,
  SpeechRendererWarningKind,
  SpeechReplyConfig
} from '@shared/types'
import { shouldHandleSpeechEvent } from './speechEventRouting'

export type AgentSpeechStatus = 'idle' | 'generating' | 'playing' | 'error'

export interface AgentSpeechState {
  messageId?: string
  status: AgentSpeechStatus
  error?: string
}

interface ReadySpeechChunk {
  sequence: number
  text: string
  mediaUrl?: string
}

function messageText(message: AgentMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function logSpeechWarning(kind: SpeechRendererWarningKind, diagnostics: SpeechRendererDiagnostics): void {
  void window.gale.speech.logWarning(kind, diagnostics).catch(() => undefined)
}

export function useAgentSpeech(
  config: SpeechReplyConfig | undefined,
  activeThreadId: string | undefined
) {
  const { t } = useTranslation()
  const [state, setState] = useState<AgentSpeechState>({ status: 'idle' })
  const configRef = useRef(config)
  const activeThreadIdRef = useRef(activeThreadId)
  const activeRunIdRef = useRef<string | undefined>(undefined)
  const activeMessageIdRef = useRef<string | undefined>(undefined)
  const stoppedRunIdRef = useRef<string | undefined>(undefined)
  const candidateStateRef = useRef<AgentReplyCandidateState>(idleAgentReplyCandidate)
  const candidateTextRef = useRef('')
  const candidateBufferRef = useRef('')
  const candidateBufferStartsLineRef = useRef(true)
  const candidateStartedAtRef = useRef(0)
  const candidateChunkSequenceRef = useRef(0)
  const tokenRef = useRef(0)
  const queuedChunkSequenceRef = useRef(0)
  const nextPlaySequenceRef = useRef(1)
  const pendingSpeechCountRef = useRef(0)
  const readyChunksRef = useRef<ReadySpeechChunk[]>([])
  const generationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const activeRequestRef = useRef<string | undefined>(undefined)
  const capacityWaitRef = useRef<(() => void) | undefined>(undefined)
  const playingRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined)
  const speechErrorRef = useRef<string | undefined>(undefined)
  const playNextRef = useRef<(token: number) => void>(() => undefined)

  const isCurrentToken = useCallback((token: number): boolean => token === tokenRef.current, [])

  const stopAudio = useCallback((): void => {
    const audio = audioRef.current
    audioRef.current = undefined
    playingRef.current = false
    if (!audio) return
    const url = audio.src
    audio.pause()
    audio.removeAttribute('src')
    URL.revokeObjectURL(url)
    audio.load()
  }, [])

  const resetSpeechWork = useCallback((): void => {
    tokenRef.current += 1
    const requestId = activeRequestRef.current
    activeRequestRef.current = undefined
    if (requestId) void window.gale.speech.cancel(requestId).catch(() => undefined)
    generationQueueRef.current = Promise.resolve()
    capacityWaitRef.current?.()
    capacityWaitRef.current = undefined
    for (const chunk of readyChunksRef.current) {
      if (chunk.mediaUrl) URL.revokeObjectURL(chunk.mediaUrl)
    }
    queuedChunkSequenceRef.current = 0
    nextPlaySequenceRef.current = 1
    pendingSpeechCountRef.current = 0
    readyChunksRef.current = []
    speechErrorRef.current = undefined
  }, [])

  const resetCandidate = useCallback((): void => {
    candidateTextRef.current = ''
    candidateBufferRef.current = ''
    candidateBufferStartsLineRef.current = true
    candidateStartedAtRef.current = 0
    candidateChunkSequenceRef.current = 0
  }, [])

  const refreshState = useCallback((): void => {
    if (playingRef.current) return
    if (pendingSpeechCountRef.current > 0 || readyChunksRef.current.length > 0) {
      setState({
        messageId: activeMessageIdRef.current,
        status: 'generating'
      })
      return
    }
    if (speechErrorRef.current) {
      setState({
        messageId: activeMessageIdRef.current,
        status: 'error',
        error: speechErrorRef.current
      })
      return
    }
    setState({ status: 'idle' })
    activeMessageIdRef.current = undefined
  }, [])

  const cancelAll = useCallback((showIdle = true): void => {
    resetSpeechWork()
    resetCandidate()
    stopAudio()
    activeRunIdRef.current = undefined
    activeMessageIdRef.current = undefined
    candidateStateRef.current = idleAgentReplyCandidate
    if (showIdle) setState({ status: 'idle' })
  }, [resetCandidate, resetSpeechWork, stopAudio])

  const stop = useCallback((): void => {
    stoppedRunIdRef.current = activeRunIdRef.current
    cancelAll()
  }, [cancelAll])

  const playChunk = useCallback((chunk: ReadySpeechChunk, token: number): void => {
    if (!isCurrentToken(token) || !chunk.mediaUrl) return
    stopAudio()

    const audio = new Audio(chunk.mediaUrl)
    audio.preload = 'auto'
    audio.volume = 1
    audioRef.current = audio
    playingRef.current = true
    speechErrorRef.current = undefined
    setState({
      messageId: activeMessageIdRef.current,
      status: 'playing'
    })

    const finish = (): void => {
      if (audioRef.current !== audio) return
      stopAudio()
      playNextRef.current(tokenRef.current)
    }

    const fail = (): void => {
      if (audioRef.current !== audio) return
      if (isCurrentToken(token)) {
        const detail = audio.error
          ? t('speech.playback_media_error', {
            code: audio.error.code
          })
          : t('speech.playback_failed')
        speechErrorRef.current = detail
        logSpeechWarning('playback_media_error', {
          token,
          sequence: chunk.sequence,
          textLength: chunk.text.length,
          code: audio.error?.code
        })
      }
      finish()
    }

    audio.addEventListener('ended', finish, { once: true })
    audio.addEventListener('error', fail, { once: true })
    audio.load()
    void audio.play().catch(() => {
      if (audioRef.current !== audio) return
      if (isCurrentToken(token)) {
        const detail = t('speech.playback_failed')
        speechErrorRef.current = detail
        logSpeechWarning('playback_start_failed', {
          token,
          sequence: chunk.sequence,
          textLength: chunk.text.length
        })
      }
      finish()
    })
  }, [isCurrentToken, stopAudio, t])

  const playNext = useCallback((token: number): void => {
    if (!isCurrentToken(token) || playingRef.current) return

    while (true) {
      const index = readyChunksRef.current.findIndex((chunk) =>
        chunk.sequence === nextPlaySequenceRef.current
      )
      if (index < 0) break
      const [chunk] = readyChunksRef.current.splice(index, 1)
      nextPlaySequenceRef.current += 1
      capacityWaitRef.current?.()
      capacityWaitRef.current = undefined
      if (!chunk.mediaUrl) continue
      playChunk(chunk, token)
      return
    }

    refreshState()
  }, [isCurrentToken, playChunk, refreshState])

  useEffect(() => {
    playNextRef.current = playNext
  }, [playNext])

  const addReadyChunk = useCallback((chunk: ReadySpeechChunk, token: number): void => {
    if (!isCurrentToken(token)) return
    readyChunksRef.current = [...readyChunksRef.current, chunk]
    playNextRef.current(token)
    refreshState()
  }, [isCurrentToken, refreshState])

  const queueSpeechChunk = useCallback((
    speechText: string,
    token: number,
    sequence: number,
    force = false
  ): Promise<void> => {
    if (!isCurrentToken(token)) return Promise.resolve()

    const currentConfig = configRef.current
    if (!currentConfig || (!currentConfig.enabled && !force)) return Promise.resolve()

    pendingSpeechCountRef.current += 1
    refreshState()
    const task = generationQueueRef.current.then(async () => {
      if (!isCurrentToken(token)) return
      // Keep at most two generated chunks ahead of playback, and one connection.
      if (readyChunksRef.current.filter((chunk) => chunk.mediaUrl).length >= 2) {
        await new Promise<void>((resolve) => { capacityWaitRef.current = resolve })
      }
      if (!isCurrentToken(token)) return
      const requestId = crypto.randomUUID()
      activeRequestRef.current = requestId
      try {
        const audio = await window.gale.speech.generate({
          requestId,
          text: speechText,
          voice: currentConfig.voice,
          speed: currentConfig.speed
        })
        if (!isCurrentToken(token)) return
        const mediaUrl = URL.createObjectURL(new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }))
        addReadyChunk({ sequence, text: speechText, mediaUrl }, token)
      } catch {
        if (!isCurrentToken(token)) return
        speechErrorRef.current = t('speech.generation_failed')
        logSpeechWarning('generation_request_failed', { token, sequence, textLength: speechText.length })
        addReadyChunk({ sequence, text: speechText }, token)
      } finally {
        if (activeRequestRef.current === requestId) activeRequestRef.current = undefined
        if (isCurrentToken(token)) {
          pendingSpeechCountRef.current = Math.max(0, pendingSpeechCountRef.current - 1)
          refreshState()
        }
      }
    })
    generationQueueRef.current = task
    return task
  }, [addReadyChunk, isCurrentToken, refreshState, t])

  const queueSpeechText = useCallback((text: string, token: number, options: SpeechTextContext & { force?: boolean } = {}): void => {
    const chunks = splitSpeechText(text, options)
    if (chunks.length === 0) {
      refreshState()
      return
    }
    for (const chunk of chunks) {
      queuedChunkSequenceRef.current += 1
      void queueSpeechChunk(chunk, token, queuedChunkSequenceRef.current, options.force)
    }
  }, [queueSpeechChunk, refreshState])

  const queueDoneText = useCallback((text: string): void => {
    resetSpeechWork()
    const token = tokenRef.current
    queueSpeechText(text, token)
    refreshState()
  }, [queueSpeechText, refreshState, resetSpeechWork])

  const queueCandidateBuffer = useCallback((final: boolean): void => {
    const token = tokenRef.current
    while (candidateBufferRef.current) {
      const cutPosition = findSpeechCutPosition(candidateBufferRef.current, {
        final,
        streamSequence: candidateChunkSequenceRef.current,
        streamStartedAt: candidateStartedAtRef.current
      })
      if (cutPosition <= 0) break
      const chunk = candidateBufferRef.current.slice(0, cutPosition)
      candidateBufferRef.current = candidateBufferRef.current.slice(cutPosition)
      candidateChunkSequenceRef.current += 1
      queueSpeechText(chunk, token, { startsAtLineBoundary: candidateBufferStartsLineRef.current })
      const lastLineBreak = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf('\r'))
      candidateBufferStartsLineRef.current = (lastLineBreak >= 0 || candidateBufferStartsLineRef.current)
        && /^[ \t]*$/.test(chunk.slice(lastLineBreak + 1))
      if (final) continue
    }
    refreshState()
  }, [queueSpeechText, refreshState])

  const appendCandidateText = useCallback((text: string): void => {
    if (!text) return
    candidateTextRef.current += text
    candidateBufferRef.current += text
    queueCandidateBuffer(false)
  }, [queueCandidateBuffer])

  const reconcileCandidateText = useCallback((completeText: string): void => {
    if (!completeText) return
    const streamedText = candidateTextRef.current
    if (completeText.startsWith(streamedText)) {
      appendCandidateText(completeText.slice(streamedText.length))
    } else if (!streamedText) {
      appendCandidateText(completeText)
    }
  }, [appendCandidateText])

  const discardCandidate = useCallback((): void => {
    const keepPlaying = playingRef.current
    resetSpeechWork()
    resetCandidate()
    if (!keepPlaying) {
      stopAudio()
      activeMessageIdRef.current = undefined
      setState({ status: 'idle' })
    }
  }, [resetCandidate, resetSpeechWork, stopAudio])

  const playText = useCallback((
    messageId: string,
    text: string,
    force = false
  ): void => {
    if (!configRef.current || (!configRef.current.enabled && !force) || !text.trim()) return
    const isActiveMessage = activeMessageIdRef.current === messageId
      && (
        playingRef.current
        || pendingSpeechCountRef.current > 0
        || readyChunksRef.current.length > 0
      )
    if (isActiveMessage) {
      cancelAll()
      return
    }

    resetSpeechWork()
    stopAudio()
    activeMessageIdRef.current = messageId
    const token = tokenRef.current
    queueSpeechText(text, token, { force: true })
    refreshState()
  }, [cancelAll, queueSpeechText, refreshState, resetSpeechWork, stopAudio])

  const handleEvent = useCallback((event: AgentRuntimeEvent): void => {
    if (!configRef.current?.enabled) return
    const threadId = 'run' in event ? event.run.threadId : event.threadId
    if (!shouldHandleSpeechEvent(activeThreadIdRef.current, threadId)) return
    const transition = transitionAgentReplyCandidate(candidateStateRef.current, event)
    candidateStateRef.current = transition.state
    for (const action of transition.actions) {
      if (action.type === 'run_started') {
        resetSpeechWork()
        resetCandidate()
        stopAudio()
        activeRunIdRef.current = action.runId
        activeMessageIdRef.current = undefined
        stoppedRunIdRef.current = undefined
        setState({ status: 'idle' })
        continue
      }
      if (stoppedRunIdRef.current === activeRunIdRef.current) continue
      if (action.type === 'candidate_started') {
        const preservePlayback = playingRef.current
        resetSpeechWork()
        resetCandidate()
        if (!preservePlayback) stopAudio()
        activeMessageIdRef.current = `${action.runId}:model:${action.model.id}`
        const parsedStartedAt = action.model.startedAt
          ? Date.parse(action.model.startedAt)
          : Number.NaN
        candidateStartedAtRef.current = Number.isFinite(parsedStartedAt)
          ? parsedStartedAt
          : Date.now()
        continue
      }
      if (action.type === 'candidate_delta') {
        appendCandidateText(action.text)
        continue
      }
      if (action.type === 'candidate_completed') {
        reconcileCandidateText(action.model.text)
        queueCandidateBuffer(true)
        continue
      }
      if (action.type === 'candidate_intermediate') {
        discardCandidate()
        continue
      }
      if (action.type === 'stopped') {
        cancelAll()
        continue
      }
      if (action.type === 'candidate_final') {
        const finalText = action.message ? messageText(action.message) : ''
        if (action.message && candidateTextRef.current) {
          reconcileCandidateText(finalText)
          queueCandidateBuffer(true)
          activeMessageIdRef.current = action.message.id
          refreshState()
        } else if (action.message) {
          activeMessageIdRef.current = action.message.id
          queueDoneText(finalText)
        }
        activeRunIdRef.current = undefined
      }
    }
  }, [
    appendCandidateText,
    cancelAll,
    discardCandidate,
    queueCandidateBuffer,
    queueDoneText,
    reconcileCandidateText,
    refreshState,
    resetCandidate,
    resetSpeechWork,
    stopAudio
  ])

  useEffect(() => {
    configRef.current = config
    if (!config?.enabled) cancelAll()
  }, [cancelAll, config])

  useLayoutEffect(() => {
    if (activeThreadIdRef.current !== activeThreadId) cancelAll()
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId, cancelAll])

  useEffect(() => () => cancelAll(false), [cancelAll])

  return { handleEvent, playText, state, stop }
}

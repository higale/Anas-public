import { useEffect, useState } from 'react'
import stableStringify from 'fast-json-stable-stringify'
import type { AgentContextStatus } from '@shared/agentTypes'
import { contextStatusForModel } from '@shared/contextWindow'
import { modelContextKey } from '@shared/modelConfig'
import type { AppConfigSnapshot, Project, ResolvedModelConfig } from '@shared/types'

interface ContextProjection {
  config: AppConfigSnapshot | undefined
  project: Project | undefined
  /** Interruptions retain run capabilities, but rebuild prompts when resumed. */
  continuationRunId: string | undefined
  continuationStatus?: 'running' | 'interrupted'
  /** Emitted by the current running instance; never reconstructed from a snapshot. */
  liveStatus?: AgentContextStatus
}

function projectionKey({ config, project, continuationRunId, continuationStatus }: ContextProjection): string {
  if (continuationStatus === 'running') return `running:${continuationRunId}`
  return stableStringify({
    continuationRunId,
    continuationStatus,
    project: project && {
      id: project.id, kind: project.kind, name: project.name, prompt: project.prompt,
      ...(project.kind === 'workspace' ? {
        advancedSettings: project.advancedSettings, codingMode: project.codingMode,
        sourceFolders: project.sourceFolders, capabilities: project.capabilities,
        restrictSubagents: project.restrictSubagents, subagentSelection: project.subagentSelection
      } : {})
    },
    defaultCapabilities: config?.defaultCapabilities,
    customTools: config?.customTools,
    subagents: config?.subagents,
    mcpServers: config?.mcpServers,
    profile: config?.settings.profile,
    environmentContext: config?.settings.environmentContext,
    language: config?.settings.language,
    attachmentTextMaxChars: config?.settings.attachmentTextMaxChars,
    attachmentTextOverflow: config?.settings.attachmentTextOverflow
  })
}

/** Only a currently running instance retains its assembled prompt context. */
export function useLiveContextStatus(
  threadId: string | undefined,
  model: ResolvedModelConfig | undefined,
  reported: AgentContextStatus | undefined,
  projection: ContextProjection
): AgentContextStatus | undefined {
  const key = model ? modelContextKey(model) : undefined
  const productKey = projectionKey(projection)
  const [preview, setPreview] = useState<{
    threadId: string
    productKey: string
    status: AgentContextStatus
    reported: AgentContextStatus | undefined
  }>()
  // Snapshot reports can predate resume even when the run id matches. Reuse
  // only a status emitted after the current instance's run_started event.
  const liveStatus = projection.liveStatus
  const reportedMatches = Boolean(key && liveStatus?.modelContextKey === key
    && projection.continuationStatus === 'running'
    && projection.continuationRunId && liveStatus.runId === projection.continuationRunId)

  useEffect(() => {
    if (!threadId || !key || reportedMatches) return
    let cancelled = false
    setPreview(undefined)
    void window.gale.agent.context.status(threadId).then((status) => {
      if (!cancelled && status?.modelContextKey === key) setPreview({ threadId, productKey, status, reported })
    }).catch(() => {
      // A removed or invalid selection has no meaningful context projection.
    })
    return () => { cancelled = true }
  }, [threadId, key, productKey, reported, reportedMatches])

  const status = reportedMatches ? liveStatus : preview && preview.threadId === threadId && preview.productKey === productKey
    && preview.reported === reported && preview.status.modelContextKey === key
    ? preview.status : undefined
  return contextStatusForModel(status, model)
}

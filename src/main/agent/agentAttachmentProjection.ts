import { readFile } from 'node:fs/promises'
import {
  type BaseMessage,
  HumanMessage
} from '@langchain/core/messages'
import type {
  AgentAttachmentArtifact
} from '@shared/agentTypes'
import type { AttachmentTextOverflowMode } from '@shared/types'
import { extractLocalAttachmentText, supportsLocalTextExtraction } from '../attachmentTextExtractor'
import { runtimeLog } from '../runtimeLogger'
import { ModelSelectionError } from './modelSelection'

type ModelContentBlock = Record<string, unknown>

interface AttachmentProjectionOptions {
  artifacts: AgentAttachmentArtifact[]
  currentRunId?: string
  textMaxChars: number
  textOverflow: AttachmentTextOverflowMode
}

export interface AgentAttachmentProjector {
  artifacts: AgentAttachmentArtifact[]
  addArtifacts(artifacts: AgentAttachmentArtifact[]): void
  project(messages: BaseMessage[], visionEnabled: boolean, includedMessageIds?: ReadonlySet<string>): Promise<BaseMessage[]>
}

function selectedForContext(
  artifact: AgentAttachmentArtifact,
  currentRunId?: string
): boolean {
  return artifact.available
    && (
      artifact.runId === currentRunId
      || artifact.contextPolicy === 'conversation'
    )
}

function textMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || [
      'application/json',
      'application/jsonl',
      'application/toml',
      'application/xml',
      'application/yaml'
    ].includes(mimeType)
}

function fileLabel(artifact: AgentAttachmentArtifact): ModelContentBlock {
  return {
    type: 'text',
    text: `[Attachment: ${artifact.name}]`
  }
}

async function textContent(
  artifact: AgentAttachmentArtifact,
  maxChars: number,
  overflow: AttachmentTextOverflowMode
): Promise<ModelContentBlock[]> {
  const text = supportsLocalTextExtraction(artifact.mimeType)
    ? (await extractLocalAttachmentText(artifact.path, artifact.mimeType)).text
    : (await readFile(artifact.path)).toString('utf8')
  if (text.length > maxChars && overflow === 'error') return []
  const content = text.length > maxChars ? text.slice(0, maxChars) : text
  return [{
    type: 'text',
    text: `<file name=${JSON.stringify(artifact.name)}>\n${content}\n</file>`
  }]
}

async function modelContent(
  artifact: AgentAttachmentArtifact,
  maxChars: number,
  overflow: AttachmentTextOverflowMode
): Promise<ModelContentBlock[]> {
  try {
    if (artifact.kind === 'image') {
      const content = await readFile(artifact.path)
      return [
        fileLabel(artifact),
        {
          type: 'image_url',
          image_url: {
            url: `data:${artifact.mimeType};base64,${content.toString('base64')}`,
            detail: 'auto'
          }
        }
      ]
    }
    if (
      artifact.kind === 'text'
      && (supportsLocalTextExtraction(artifact.mimeType) || textMimeType(artifact.mimeType))
    ) {
      return await textContent(artifact, maxChars, overflow)
    }
    return []
  } catch (reason) {
    runtimeLog('warn', 'agent', 'Archived attachment could not be projected into model context.', {
      attachmentId: artifact.id,
      file: artifact.path,
      error: reason instanceof Error ? reason.message : String(reason)
    })
    return []
  }
}

function cloneHumanMessage(
  message: BaseMessage,
  content: ModelContentBlock[]
): HumanMessage {
  const originalContent = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : [...message.content] as ModelContentBlock[]
  return new HumanMessage({
    id: message.id,
    name: message.name,
    content: [...originalContent, ...content] as never,
    additional_kwargs: {
      ...message.additional_kwargs,
      anas_attachment_projection: true,
      anas_attachment_block_count: (
        typeof message.additional_kwargs?.anas_attachment_block_count === 'number'
          ? message.additional_kwargs.anas_attachment_block_count
          : 0
      ) + content.length
    },
    response_metadata: message.response_metadata
  })
}

export function stripAgentAttachmentProjection(
  messages: BaseMessage[]
): BaseMessage[] {
  return messages.map((message) => {
    const count = message.additional_kwargs?.anas_attachment_block_count
    if (
      !HumanMessage.isInstance(message)
      || typeof count !== 'number'
      || count <= 0
      || typeof message.content === 'string'
    ) {
      return message
    }
    const {
      anas_attachment_projection: _projection,
      anas_attachment_block_count: _blockCount,
      ...additional_kwargs
    } = message.additional_kwargs
    return new HumanMessage({
      id: message.id,
      name: message.name,
      content: message.content.slice(0, Math.max(0, message.content.length - count)) as never,
      additional_kwargs,
      response_metadata: message.response_metadata
    })
  })
}

export function createAgentAttachmentProjector(
  options: AttachmentProjectionOptions
): AgentAttachmentProjector {
  const artifacts = options.artifacts.filter((artifact) =>
    selectedForContext(artifact, options.currentRunId)
  )
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const contentCache = new Map<string, Promise<ModelContentBlock[]>>()

  function addArtifacts(items: AgentAttachmentArtifact[]): void {
    for (const artifact of items) {
      if (
        artifactIds.has(artifact.id)
        || !selectedForContext(artifact, options.currentRunId)
      ) continue
      artifactIds.add(artifact.id)
      artifacts.push(artifact)
    }
  }

  async function contentFor(artifact: AgentAttachmentArtifact): Promise<ModelContentBlock[]> {
    const cached = contentCache.get(artifact.id)
    if (cached) return cached
    const pending = modelContent(
      artifact,
      options.textMaxChars,
      options.textOverflow
    )
    contentCache.set(artifact.id, pending)
    return pending
  }

  async function project(messages: BaseMessage[], visionEnabled: boolean, includedMessageIds?: ReadonlySet<string>): Promise<BaseMessage[]> {
    if (
      artifacts.length === 0
      || messages.some((message) => message.additional_kwargs?.anas_attachment_projection === true)
    ) {
      return messages
    }

    const contentByMessage = new Map<string, ModelContentBlock[]>()
    const messageIds = new Set(messages.flatMap((message) => message.id ? [message.id] : []))
    for (const artifact of artifacts) {
      if (!messageIds.has(artifact.messageId) || includedMessageIds && !includedMessageIds.has(artifact.messageId)) continue
      if (artifact.kind === 'image' && !visionEnabled) {
        throw new ModelSelectionError(`The selected model does not support the required image attachment "${artifact.name}". The run was stopped. Choose a model with vision enabled and send again.`)
      }
      const content = await contentFor(artifact)
      if (content.length === 0) continue
      contentByMessage.set(
        artifact.messageId,
        [...(contentByMessage.get(artifact.messageId) ?? []), ...content]
      )
    }

    return messages.map((message) => {
      const content = message.id ? contentByMessage.get(message.id) : undefined
      return content?.length && HumanMessage.isInstance(message)
        ? cloneHumanMessage(message, content)
        : message
    })
  }

  return { addArtifacts, artifacts, project }
}

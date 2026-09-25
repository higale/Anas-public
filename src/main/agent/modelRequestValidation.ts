import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { ContextOverflowError } from '@langchain/core/errors'
import { modelContextKey } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { ModelSelectionError } from './modelSelection'
import { currentContextWindowTokens } from './serverTokenUsage'
import { errorCauses } from './errorCauses'
import { modelInputHasImages } from './localTokenCounting'

/** Re-enter request preparation if settings changed during asynchronous work. */
export class ModelRequestChangedError extends Error {
  readonly code = 'MODEL_REQUEST_CHANGED'

  constructor() {
    super('The selected model or its parameters kept changing while preparing the request. The run was stopped before sending; select a valid model and send again.')
    this.name = 'ModelRequestChangedError'
  }
}

export function isModelRequestChangedError(error: unknown): boolean {
  return errorCauses(error).some((cause) => cause instanceof ModelRequestChangedError)
}

export function assertModelInputSupported(model: ResolvedModelConfig, messages: BaseMessage[], requiresTools: boolean): void {
  if (!model.capabilities.toolUse && (requiresTools || messages.some((message) =>
    ToolMessage.isInstance(message) || AIMessage.isInstance(message) && message.tool_calls?.length
  ))) {
    throw new ModelSelectionError(`Model "${model.displayName || model.model}" does not support the tool context required by this conversation. The run was stopped. Select a model with tool use enabled and send again.`)
  }
  if (!model.capabilities.vision && modelInputHasImages(messages, model.protocol)) {
    throw new ModelSelectionError(`Model "${model.displayName || model.model}" does not support the images required by this conversation. The run was stopped. Select a model with vision enabled and send again.`)
  }
}

export function assertModelInputFits(model: ResolvedModelConfig, messages: BaseMessage[], tools: unknown[]): void {
  const capacity = model.maxContextTokens - model.maxOutputTokens
  // The complete prepared message list already includes its system message.
  // Keep the same valid provider usage floor as context status and compression.
  const tokens = currentContextWindowTokens({
    messages,
    systemMessage: undefined,
    tools,
    modelContextKey: modelContextKey(model),
    protocol: model.protocol,
    parameters: model.parameters
  })
  if (tokens > capacity) {
    throw ContextOverflowError.fromError(new ModelSelectionError(`Model "${model.displayName || model.model}" has an input capacity of ${capacity} tokens, but the prepared conversation needs approximately ${tokens}. The run was stopped because the required context does not fit. Choose a larger context window or adjust compression and send again.`))
  }
}

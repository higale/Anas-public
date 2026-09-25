import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResolvedModelConfig } from '@shared/types'

const requestModel = new AsyncLocalStorage<ResolvedModelConfig>()

export function withModelRequest<T>(model: ResolvedModelConfig, operation: () => T): T {
  return requestModel.run(model, operation)
}

export function currentRequestModel(): ResolvedModelConfig {
  const model = requestModel.getStore()
  if (!model) throw new Error('A model request has not been prepared.')
  return model
}

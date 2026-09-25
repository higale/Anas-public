import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { AgentManagedCallRecord, AgentToolEffectKey } from './agentDatabase'
import { beginToolEffect } from './toolExecutionContext'
import type { FilePatchEditRecord } from '../filePatchRecord'

export type AgentToolEffectRecoveryMode = 'confirm' | 'idempotent'

export interface AgentToolEffectArm {
  kind: string
  target: unknown
  recoveryMode?: AgentToolEffectRecoveryMode
  idempotencyFingerprint?: string
}

export interface CurrentAgentToolEffectScope {
  readonly effectKey?: AgentToolEffectKey
  isUnarmed?(): boolean
  previousEffect?(): Pick<AgentToolEffectArm, 'kind' | 'target'> | undefined
  persistFileChange?(record: FilePatchEditRecord, observed: boolean): void
  deferManagedCallResult?(call: AgentManagedCallRecord): void
  arm(effect: AgentToolEffectArm): void
}

const currentToolEffect = new AsyncLocalStorage<CurrentAgentToolEffectScope>()

export function deferCurrentManagedCallResult(call: AgentManagedCallRecord): boolean {
  const defer = currentToolEffect.getStore()?.deferManagedCallResult
  if (!defer) return false
  defer(call)
  return true
}

export function persistCurrentFileChange(record: FilePatchEditRecord, observed = false): void {
  currentToolEffect.getStore()?.persistFileChange?.(record, observed)
}

export function runWithCurrentAgentToolEffect<T>(
  scope: CurrentAgentToolEffectScope,
  operation: () => T
): T {
  return currentToolEffect.run(scope, operation)
}

export function runWithoutCurrentAgentToolEffect<T>(operation: () => T): T {
  return currentToolEffect.exit(operation)
}

export function armCurrentAgentToolEffect(effect: AgentToolEffectArm): void {
  beginToolEffect()
  currentToolEffect.getStore()?.arm(effect)
}

export function agentToolEffectArtifactId(
  key: AgentToolEffectKey,
  purpose: string
): string {
  const digest = createHash('sha256').update(JSON.stringify([
    'anas-agent-tool-effect-artifact-v1',
    key.runId,
    key.checkpointId,
    key.checkpointNs,
    key.taskId,
    key.callKey,
    key.inputHash,
    purpose
  ])).digest()
  digest[6] = (digest[6] & 0x0f) | 0x80
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

export function currentAgentToolEffectArtifactId(purpose: string): string | undefined {
  const key = currentToolEffect.getStore()?.effectKey
  return key ? agentToolEffectArtifactId(key, purpose) : undefined
}

export function currentAgentToolEffectReference(): Pick<AgentToolEffectArm, 'kind' | 'target'> | undefined {
  return structuredClone(currentToolEffect.getStore()?.previousEffect?.())
}

export function hasCurrentAgentToolEffectScope(): boolean {
  return currentToolEffect.getStore() !== undefined
}

export function canRestartUnpublishedEffectArtifact(requestId: string, operationId: string, purpose: string): boolean {
  const scope = currentToolEffect.getStore()
  return scope?.effectKey?.runId === requestId
    && agentToolEffectArtifactId(scope.effectKey, purpose) === operationId
    && scope.isUnarmed?.() === true
}

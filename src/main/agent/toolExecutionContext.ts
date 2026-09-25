import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagedCallControl } from './managedCallService'

interface ToolExecutionContext {
  control: ManagedCallControl
  localCommit: boolean
  committing: boolean
}

const execution = new AsyncLocalStorage<ToolExecutionContext>()

export function withToolExecution<T>(control: ManagedCallControl, localCommit: boolean, invoke: () => T): T {
  return execution.run({ control, localCommit, committing: false }, invoke)
}

export function withoutToolExecution<T>(invoke: () => T): T {
  return execution.exit(invoke)
}

export function currentToolExecution(): ManagedCallControl | undefined {
  return execution.getStore()?.control
}

export function checkToolExecutionCancelled(): void {
  const context = execution.getStore()
  if (!context?.committing) context?.control.signal.throwIfAborted()
}

export function beginToolEffect(): void {
  const context = execution.getStore()
  if (!context) return
  checkToolExecutionCancelled()
  context.control.markRunning()
  // Once a local transaction starts, finish it rather than report a cancellation
  // while the filesystem/configuration mutation continues in the background.
  if (context.localCommit) {
    context.control.markLocalCommit()
    context.committing = true
  }
}

export function toolLocalCommitStarted(): boolean {
  return execution.getStore()?.committing === true
}

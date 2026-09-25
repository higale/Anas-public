type ApplicationDataLifecycleState = 'open' | 'transitioning'

const activeOperations = new Set<Promise<unknown>>()
let state: ApplicationDataLifecycleState = 'open'

export function runApplicationDataOperation<T>(
  operation: () => T | Promise<T>,
  options: { snapshot?: boolean } = {}
): Promise<T> {
  if (state !== 'open') {
    return Promise.reject(new Error('Application data is unavailable while it is being restored.'))
  }

  let result: Promise<T>
  try {
    result = options.snapshot ? Promise.resolve(operation()) : withApplicationDataMutation(operation)
  } catch (error) {
    result = Promise.reject(error)
  }
  const tracked = result.finally(() => {
    activeOperations.delete(tracked)
  })
  activeOperations.add(tracked)
  return tracked
}

export async function beginApplicationDataTransition(): Promise<void> {
  state = 'transitioning'
  while (activeOperations.size > 0) {
    await Promise.allSettled(Array.from(activeOperations))
  }
}

export function finishApplicationDataTransition(): void {
  if (activeOperations.size > 0) {
    throw new Error('Application data cannot reopen while prior operations are still active.')
  }
  state = 'open'
}
import { withApplicationDataMutation } from './applicationDataSnapshot'

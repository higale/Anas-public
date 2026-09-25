import { AsyncLocalStorage } from 'node:async_hooks'

interface LeaseScope {
  releases: Map<object, () => void>
  closed: boolean
}

const scopes = new AsyncLocalStorage<LeaseScope>()

/** Keep every database touched by an operation alive across its awaits. */
export function withConversationLeaseScope<T>(operation: () => T): T {
  const parent = scopes.getStore()
  if (parent && !parent.closed) return operation()
  const scope: LeaseScope = { releases: new Map(), closed: false }
  const release = () => {
    if (scope.closed) return
    scope.closed = true
    for (const dispose of scope.releases.values()) dispose()
    scope.releases.clear()
  }
  const complete = (value: unknown): unknown => {
    if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
      return (async function *() {
        try { yield* value as AsyncIterable<unknown> } finally { release() }
      })()
    }
    release()
    return value
  }
  return scopes.run(scope, () => {
    try {
      const result = operation()
      if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        return Promise.resolve(result).then(complete, (error) => { release(); throw error }) as T
      }
      return complete(result) as T
    } catch (error) {
      release()
      throw error
    }
  })
}

export function acquireConversationLease(resource: object, acquire: () => () => void): void {
  const scope = scopes.getStore()
  if (!scope || scope.closed || scope.releases.has(resource)) return
  scope.releases.set(resource, acquire())
}

export function ownsConversationLease(resource: object): boolean {
  return scopes.getStore()?.releases.has(resource) ?? false
}

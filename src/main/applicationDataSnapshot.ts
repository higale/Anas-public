import { AsyncLocalStorage } from 'node:async_hooks'

interface DataOperationScope { kind: 'mutation' | 'snapshot'; active: boolean; children: Set<Promise<unknown>> }
const scopes = new AsyncLocalStorage<DataOperationScope>()
const mutations = new Set<Promise<unknown>>()
let snapshotTail: Promise<void> = Promise.resolve()
let pendingSnapshots = 0

async function drainScope(scope: DataOperationScope): Promise<void> {
  scope.active = false
  while (scope.children.size > 0) await Promise.allSettled([...scope.children])
}

/** Ordinary data operations may overlap; snapshots wait for their structural changes. */
export function withApplicationDataMutation<T>(operation: () => T | Promise<T>): Promise<T> {
  const parent = scopes.getStore()
  const owner = parent?.active ? parent : undefined
  const scope: DataOperationScope = { kind: 'mutation', active: true, children: new Set() }
  const invoke = () => scopes.run(scope, operation)
  let result: Promise<T>
  try {
    result = parent?.active || pendingSnapshots === 0 ? Promise.resolve(invoke()) : snapshotTail.then(invoke)
  } catch (error) {
    result = Promise.reject(error)
  }
  const tracked = result.then(() => drainScope(scope), () => drainScope(scope)).finally(() => {
    mutations.delete(tracked)
    owner?.children.delete(tracked)
  })
  mutations.add(tracked)
  owner?.children.add(tracked)
  return result
}

/** Keep catalog membership and external attachment lifetimes stable until copying finishes. */
export function withApplicationDataSnapshot<T>(operation: () => T | Promise<T>): Promise<T> {
  const parent = scopes.getStore()
  if (parent?.active) {
    if (parent.kind === 'snapshot') return Promise.resolve().then(operation)
    return Promise.reject(new Error('A data snapshot cannot start inside a data mutation.'))
  }
  const scope: DataOperationScope = { kind: 'snapshot', active: true, children: new Set() }
  pendingSnapshots += 1
  const result = Promise.allSettled([snapshotTail, ...mutations])
    .then(() => scopes.run(scope, operation))
    .finally(async () => { await drainScope(scope); pendingSnapshots -= 1 })
  snapshotTail = result.then(() => undefined, () => undefined)
  return result
}

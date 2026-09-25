import { describe, expect, it, vi } from 'vitest'
import type { InitialAppResources } from './initialAppLoad'
import {
  createInitialAppLoadSnapshot,
  InitialAppLoader,
  initialAppCriticalPhase
} from './initialAppLoad'

function values(): InitialAppResources {
  return {
    projects: [],
    config: { settings: { language: 'en' } } as InitialAppResources['config'],
    inputHistory: { maxHistory: 100, items: [] },
    buildInfo: { version: '2.5.128' } as InitialAppResources['buildInfo'],
    icon: 'data:image/png;base64,icon'
  }
}

function deferred<Value>(): {
  promise: Promise<Value>
  resolve(value: Value): void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createLoader(overrides: Partial<{
  [Resource in keyof InitialAppResources]: () => Promise<InitialAppResources[Resource]>
}> = {}) {
  const resourceValues = values()
  const snapshots = [createInitialAppLoadSnapshot()]
  const consumers = {
    projects: vi.fn(),
    config: vi.fn(),
    inputHistory: vi.fn(),
    buildInfo: vi.fn(),
    icon: vi.fn()
  }
  const loaders = {
    projects: vi.fn(async () => resourceValues.projects),
    config: vi.fn(async () => resourceValues.config),
    inputHistory: vi.fn(async () => resourceValues.inputHistory),
    buildInfo: vi.fn(async () => resourceValues.buildInfo),
    icon: vi.fn(async () => resourceValues.icon),
    ...overrides
  }
  const loader = new InitialAppLoader({
    loaders,
    consumers,
    fallbackError: 'Failed to load app state.',
    onChange: (snapshot) => snapshots.push(snapshot)
  })
  return { consumers, loader, loaders, snapshots }
}

describe('InitialAppLoader', () => {
  it('makes critical resources ready without waiting for optional resources', async () => {
    const buildInfo = deferred<InitialAppResources['buildInfo']>()
    const icon = deferred<InitialAppResources['icon']>()
    const { loader } = createLoader({
      buildInfo: () => buildInfo.promise,
      icon: () => icon.promise
    })

    loader.start()
    await vi.waitFor(() => expect(initialAppCriticalPhase(loader.snapshot())).toBe('ready'))

    expect(loader.snapshot().buildInfo.phase).toBe('loading')
    expect(loader.snapshot().icon.phase).toBe('loading')
    buildInfo.resolve(values().buildInfo)
    icon.resolve(values().icon)
  })

  it('keeps optional failures out of critical readiness', async () => {
    const { loader } = createLoader({
      buildInfo: async () => { throw new Error('Build info unavailable') },
      icon: async () => { throw new Error('Icon unavailable') }
    })

    loader.start()
    await vi.waitFor(() => expect(loader.snapshot().icon.phase).toBe('error'))

    expect(initialAppCriticalPhase(loader.snapshot())).toBe('ready')
    expect(loader.snapshot().buildInfo.error).toBe('Build info unavailable')
  })

  it('blocks on a failed config and retries only that resource', async () => {
    const resourceValues = values()
    const config = vi.fn()
      .mockRejectedValueOnce(new Error('Config unavailable'))
      .mockResolvedValue(resourceValues.config)
    const { consumers, loader, loaders } = createLoader({ config })

    loader.start()
    await vi.waitFor(() => expect(loader.snapshot().config.phase).toBe('error'))
    expect(initialAppCriticalPhase(loader.snapshot())).toBe('error')
    const projectCalls = vi.mocked(loaders.projects).mock.calls.length

    await loader.retry('config')

    expect(initialAppCriticalPhase(loader.snapshot())).toBe('ready')
    expect(consumers.config).toHaveBeenCalledOnce()
    expect(loaders.projects).toHaveBeenCalledTimes(projectCalls)
  })
})

import type {
  AppBuildInfo,
  AppConfigSnapshot,
  InputHistorySnapshot,
  Project
} from '@shared/types'
import { errorDetail } from '@shared/recovery'

export interface InitialAppResources {
  projects: Project[]
  config: AppConfigSnapshot
  inputHistory: InputHistorySnapshot
  buildInfo: AppBuildInfo
  icon: string | undefined
}

export type InitialAppResource = keyof InitialAppResources
export type InitialAppResourcePhase = 'idle' | 'loading' | 'ready' | 'error'

export interface InitialAppResourceState {
  phase: InitialAppResourcePhase
  error?: string
}

export type InitialAppLoadSnapshot = Record<InitialAppResource, InitialAppResourceState>
export type InitialAppCriticalPhase = 'loading' | 'ready' | 'error'

export const initialAppResources: InitialAppResource[] = [
  'projects',
  'config',
  'inputHistory',
  'buildInfo',
  'icon'
]

export const criticalInitialAppResources: InitialAppResource[] = ['projects', 'config']
export const optionalInitialAppResources: InitialAppResource[] = ['inputHistory', 'buildInfo', 'icon']

export function createInitialAppLoadSnapshot(): InitialAppLoadSnapshot {
  return {
    projects: { phase: 'idle' },
    config: { phase: 'idle' },
    inputHistory: { phase: 'idle' },
    buildInfo: { phase: 'idle' },
    icon: { phase: 'idle' }
  }
}

export function initialAppCriticalPhase(snapshot: InitialAppLoadSnapshot): InitialAppCriticalPhase {
  if (criticalInitialAppResources.some((resource) => snapshot[resource].phase === 'error')) {
    return 'error'
  }
  return criticalInitialAppResources.every((resource) => snapshot[resource].phase === 'ready')
    ? 'ready'
    : 'loading'
}

export function failedInitialAppResources(
  snapshot: InitialAppLoadSnapshot,
  resources: InitialAppResource[] = initialAppResources
): InitialAppResource[] {
  return resources.filter((resource) => snapshot[resource].phase === 'error')
}

type InitialAppLoaders = {
  [Resource in InitialAppResource]: () => Promise<InitialAppResources[Resource]>
}

type InitialAppConsumers = {
  [Resource in InitialAppResource]: (value: InitialAppResources[Resource]) => void
}

interface InitialAppLoaderOptions {
  loaders: InitialAppLoaders
  consumers: InitialAppConsumers
  onChange(snapshot: InitialAppLoadSnapshot): void
  fallbackError: string
}

export class InitialAppLoader {
  private active = true
  private readonly generations: Record<InitialAppResource, number> = {
    projects: 0,
    config: 0,
    inputHistory: 0,
    buildInfo: 0,
    icon: 0
  }
  private state = createInitialAppLoadSnapshot()

  constructor(private readonly options: InitialAppLoaderOptions) {}

  start(): void {
    for (const resource of initialAppResources) void this.retry(resource)
  }

  async retry<Resource extends InitialAppResource>(resource: Resource): Promise<void> {
    if (!this.active) return
    const generation = ++this.generations[resource]
    this.update(resource, { phase: 'loading' })
    try {
      const value = await this.options.loaders[resource]()
      if (!this.isCurrent(resource, generation)) return
      this.options.consumers[resource](value)
      this.update(resource, { phase: 'ready' })
    } catch (reason) {
      if (!this.isCurrent(resource, generation)) return
      this.update(resource, {
        phase: 'error',
        error: errorDetail(reason, this.options.fallbackError)
      })
    }
  }

  dispose(): void {
    this.active = false
    for (const resource of initialAppResources) this.generations[resource] += 1
  }

  snapshot(): InitialAppLoadSnapshot {
    return this.cloneState()
  }

  private isCurrent(resource: InitialAppResource, generation: number): boolean {
    return this.active && this.generations[resource] === generation
  }

  private update(resource: InitialAppResource, state: InitialAppResourceState): void {
    this.state = { ...this.state, [resource]: state }
    this.options.onChange(this.cloneState())
  }

  private cloneState(): InitialAppLoadSnapshot {
    return {
      projects: { ...this.state.projects },
      config: { ...this.state.config },
      inputHistory: { ...this.state.inputHistory },
      buildInfo: { ...this.state.buildInfo },
      icon: { ...this.state.icon }
    }
  }
}

import type { GaleApi } from '@shared/types'

declare global {
  interface Window {
    gale: GaleApi
  }
}

export {}
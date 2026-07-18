import type { GrokApi } from '../shared/types'

declare global {
  interface Window {
    grok: GrokApi
  }
}

export {}

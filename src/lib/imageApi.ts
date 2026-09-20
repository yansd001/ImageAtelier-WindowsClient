import type { Provider } from '../types'
import { apiRequest } from './backend'

export function fetchAvailableModels(provider: Provider): Promise<string[]> {
  return apiRequest(`/models?provider=${encodeURIComponent(provider)}`)
}

import type { GenerationParams, Provider, ReferenceImage } from '../types'
import { apiRequest } from './backend'

export function fetchAvailableModels(provider: Provider): Promise<string[]> {
  return apiRequest(`/models?provider=${encodeURIComponent(provider)}`)
}

export async function generateImages(provider: Provider, model: string, prompt: string, params: GenerationParams, referenceImages: ReferenceImage[] = []): Promise<string[]> {
  const result = await apiRequest<{ images: string[] }>('/generate', {
    method: 'POST', body: JSON.stringify({ provider, model, prompt, params, referenceImages }),
  })
  return result.images
}

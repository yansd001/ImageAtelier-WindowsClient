export type Provider = 'openai' | 'gemini'
export type TaskStatus = 'running' | 'done' | 'error'

export interface ReferenceImage {
  id: string
  name: string
  dataUrl: string
}

export interface Settings {
  global: { baseUrl: string; apiKey: string }
  openai: { baseUrl: string; apiKey: string }
  gemini: { baseUrl: string; apiKey: string }
}

export interface GenerationParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  background: 'auto' | 'transparent' | 'opaque'
  outputFormat: 'png' | 'jpeg' | 'webp'
  aspectRatio: string
  imageSize: '1K' | '2K' | '4K'
  count: number
}

export interface Task {
  id: string
  prompt: string
  provider: Provider
  model: string
  params: GenerationParams
  referenceImages?: ReferenceImage[]
  images: string[]
  status: TaskStatus
  error?: string
  createdAt: number
  favorite: boolean
  workspaceId?: string
}

export interface Workspace {
  id: string
  name: string
  createdAt: number
}

export const defaultParams: GenerationParams = {
  size: 'auto', quality: 'auto', background: 'auto', outputFormat: 'png', aspectRatio: '1:1', imageSize: '1K', count: 1,
}

export const defaultSettings: Settings = {
  global: { baseUrl: 'https://code.yansd666.com', apiKey: '' },
  openai: { baseUrl: '', apiKey: '' },
  gemini: { baseUrl: '', apiKey: '' },
}

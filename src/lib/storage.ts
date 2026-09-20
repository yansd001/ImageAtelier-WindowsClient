import type { Provider, Settings, Task, Workspace } from '../types'
import { apiRequest } from './backend'
import { clearLegacyStorage, readLegacyState } from './legacyStorage'

export type ModelSelections = Record<Provider, string>
export interface GallerySnapshot {
  tasks: Task[]
  workspaces: Workspace[]
  revision: number
}
export interface BackendState {
  settings: Settings
  modelSelections: ModelSelections
  lastWorkspace: string
  gallery: { tasks: Task[]; workspaces: Workspace[] }
  galleryRevision: number
}

let initialization: Promise<BackendState> | undefined
let galleryRevision: number | undefined
let saveQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(write: () => Promise<T>): Promise<T> {
  const pending = saveQueue.catch(() => {}).then(write)
  saveQueue = pending
  return pending
}

export function initializeStorage() {
  if (!initialization) {
    initialization = (async () => {
      let state = await apiRequest<BackendState>('/state')
      const legacy = await readLegacyState()
      if (legacy) {
        state = await apiRequest<BackendState>('/migrate', { method: 'POST', body: JSON.stringify(legacy) })
        // Remove old metadata only after the server commits images and JSON.
        clearLegacyStorage()
      }
      galleryRevision = state.galleryRevision
      const params = new URLSearchParams(window.location.search)
      if (params.has('baseurl') || params.has('apikey')) {
        state.settings = {
          ...state.settings,
          global: {
            ...state.settings.global,
            ...(params.has('baseurl') ? { baseUrl: params.get('baseurl') ?? '' } : {}),
            ...(params.has('apikey') ? { apiKey: params.get('apikey') ?? '' } : {}),
          },
        }
        await saveSettings(state.settings)
      }
      return state
    })().catch((error) => { initialization = undefined; throw error })
  }
  return initialization
}

export async function loadGallery() {
  const state = await apiRequest<BackendState>('/state')
  galleryRevision = state.galleryRevision
  return state.gallery
}

export async function readGallery(): Promise<GallerySnapshot> {
  const snapshot = await apiRequest<GallerySnapshot>('/gallery')
  galleryRevision = Math.max(galleryRevision ?? -1, snapshot.revision)
  return snapshot
}

function galleryMutation(path: string, method: string, body: unknown) {
  return enqueue(async () => {
    const snapshot = await apiRequest<GallerySnapshot>(path, { method, body: JSON.stringify(body) })
    galleryRevision = Math.max(galleryRevision ?? -1, snapshot.revision)
    return snapshot
  })
}

export const submitGeneration = (task: Task) => galleryMutation('/tasks', 'POST', task)
export const retryGeneration = (id: string) => galleryMutation(`/tasks/${encodeURIComponent(id)}/retry`, 'POST', {})
export const deleteTasks = (ids: string[]) => galleryMutation('/tasks', 'DELETE', { ids })
export const editGallery = (edit: { taskIds?: string[]; favorite?: boolean; workspaceId?: string; workspace?: Workspace }) => galleryMutation('/gallery', 'PATCH', edit)

export function replaceGallery(tasks: Task[], workspaces: Workspace[], revision?: number) {
  return enqueue(async () => {
    if (galleryRevision === undefined) await loadGallery()
    const result = await apiRequest<GallerySnapshot>('/gallery', {
      method: 'PUT', body: JSON.stringify({ tasks, workspaces, revision: revision ?? galleryRevision }),
    })
    galleryRevision = Math.max(galleryRevision ?? -1, result.revision)
    return result
  })
}

export async function saveGallery(tasks: Task[], workspaces: Workspace[]) {
  return (await replaceGallery(tasks, workspaces)).tasks
}

export function saveLastWorkspace(id: string) {
  // A small preference must not wait behind image uploads. Keep the request
  // alive if the user refreshes immediately after changing the selection.
  return apiRequest('/last-workspace', { method: 'PUT', body: JSON.stringify({ id }), keepalive: true })
}

export function saveSettings(settings: Settings) {
  return enqueue(() => apiRequest<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }))
}

export function saveModelSelections(selections: ModelSelections) {
  return enqueue(() => apiRequest('/model-selections', { method: 'PUT', body: JSON.stringify(selections) }))
}

export async function hydrateImage(value: string): Promise<string> {
  if (value.startsWith('data:')) return value
  if (/^https?:\/\//i.test(value)) {
    const image = await apiRequest<{ url: string }>('/images/import', { method: 'POST', body: JSON.stringify({ source: value }) })
    return hydrateImage(image.url)
  }
  if (!/^\/api\/images\/[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/.test(value)) throw new Error('图片路径无效或旧图片尚未迁移')
  const response = await fetch(value)
  if (!response.ok) throw new Error('后端图片数据缺失，无法读取或导出该作品')
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

export async function hydrateTasks(tasks: Task[], includeReferences = true) {
  return Promise.all(tasks.map(async (task) => ({
    ...task,
    images: await Promise.all(task.images.map(hydrateImage)),
    referenceImages: includeReferences && task.referenceImages ? await Promise.all(task.referenceImages.map(async (image) => ({
      ...image, dataUrl: await hydrateImage(image.dataUrl),
    }))) : task.referenceImages,
  })))
}

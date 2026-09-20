import type { Provider, Settings, Task, Workspace } from '../types'
import { defaultSettings } from '../types'

const TASKS_KEY = 'yansd-image-tasks'
const GALLERY_KEY = 'yansd-image-gallery'
const LAST_WORKSPACE_KEY = 'yansd-image-last-workspace'
const SETTINGS_KEY = 'yansd-image-settings'
const MODEL_SELECTIONS_KEY = 'yansd-image-model-selections'
const DB_NAME = 'yansd-image-playground'
const IMAGE_STORE = 'images'
const CACHE_PREFIX = 'idb:'
let dbPromise: Promise<IDBDatabase> | null = null
let taskSaveQueue: Promise<unknown> = Promise.resolve()

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IMAGE_STORE)) request.result.createObjectStore(IMAGE_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { dbPromise = null; reject(request.error) }
  })
  return dbPromise
}

async function putImage(id: string, dataUrl: string) {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    transaction.objectStore(IMAGE_STORE).put(dataUrl, id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('图片保存已中断'))
  })
}

async function getImage(id: string) {
  const db = await openDb()
  return new Promise<string | undefined>((resolve, reject) => {
    const request = db.transaction(IMAGE_STORE, 'readonly').objectStore(IMAGE_STORE).get(id)
    request.onsuccess = () => resolve(request.result as string | undefined)
    request.onerror = () => reject(request.error)
  })
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function hydrateImage(value: string) {
  if (value.startsWith(CACHE_PREFIX)) {
    const image = await getImage(value.slice(CACHE_PREFIX.length))
    if (!image) throw new Error('本地图片数据缺失，无法读取或导出该作品')
    return image
  }
  if (!/^https?:\/\//i.test(value)) return value
  try {
    const response = await fetch(value)
    if (!response.ok) return value
    return await blobToDataUrl(await response.blob())
  } catch {
    return value
  }
}

async function clearUnusedImages(usedIds: Set<string>) {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, 'readwrite')
    const store = transaction.objectStore(IMAGE_STORE)
    const request = store.getAllKeys()
    request.onsuccess = () => request.result.forEach((key) => { if (!usedIds.has(String(key))) store.delete(key) })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export function loadTasks(): Task[] {
  return loadGallery().tasks
}

export function loadGallery(): { tasks: Task[]; workspaces: Workspace[] } {
  const value = localStorage.getItem(GALLERY_KEY)
  if (value) return JSON.parse(value)
  return { tasks: JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'), workspaces: [] }
}

export function loadLastWorkspace() { return localStorage.getItem(LAST_WORKSPACE_KEY) || '' }
export function saveLastWorkspace(id: string) { localStorage.setItem(LAST_WORKSPACE_KEY, id) }

async function persistGallery(tasks: Task[], workspaces: Workspace[]) {
  const usedIds = new Set<string>()
  const metadata = await Promise.all(tasks.map(async (task) => {
    const images = await Promise.all(task.images.map(async (image, index) => {
      if (image.startsWith(CACHE_PREFIX)) { usedIds.add(image.slice(CACHE_PREFIX.length)); return image }
      if (!image.startsWith('data:')) return image
      const id = `${task.id}:output:${index}`
      usedIds.add(id)
      await putImage(id, image)
      return `${CACHE_PREFIX}${id}`
    }))
    const referenceImages = task.referenceImages ? await Promise.all(task.referenceImages.map(async (image) => {
      if (image.dataUrl.startsWith(CACHE_PREFIX)) { usedIds.add(image.dataUrl.slice(CACHE_PREFIX.length)); return image }
      if (!image.dataUrl.startsWith('data:')) return image
      const id = `${task.id}:reference:${image.id}`
      usedIds.add(id)
      await putImage(id, image.dataUrl)
      return { ...image, dataUrl: `${CACHE_PREFIX}${id}` }
    })) : undefined
    return { ...task, images, referenceImages }
  }))
  // Commit metadata together only after all image writes have succeeded.
  localStorage.setItem(GALLERY_KEY, JSON.stringify({ tasks: metadata, workspaces }))
  localStorage.removeItem(TASKS_KEY)
  // Cleanup is best effort; a cleanup error must not report a committed import as failed.
  await clearUnusedImages(usedIds).catch((error) => console.error('清理图片缓存失败:', error))
  return metadata
}

export function saveGallery(tasks: Task[], workspaces: Workspace[]) {
  const pending = taskSaveQueue.catch(() => {}).then(() => persistGallery(tasks, workspaces))
  taskSaveQueue = pending
  return pending
}

export async function hydrateTasks(tasks: Task[], includeReferences = true) {
  return Promise.all(tasks.map(async (task) => ({
    ...task,
    images: (await Promise.all(task.images.map(hydrateImage))).filter(Boolean),
    referenceImages: includeReferences && task.referenceImages ? await Promise.all(task.referenceImages.map(async (image) => ({
      ...image,
      dataUrl: await hydrateImage(image.dataUrl),
    }))) : task.referenceImages,
  })))
}

export function loadSettings(search = typeof window === 'undefined' ? '' : window.location.search): Settings {
  let settings: Settings = defaultSettings
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as (Partial<Settings> & { baseUrl?: string; apiKey?: string }) | null
    const openaiBaseUrl = parsed?.openai?.baseUrl === 'https://api.openai.com/v1' ? '' : parsed?.openai?.baseUrl
    const geminiBaseUrl = parsed?.gemini?.baseUrl === 'https://generativelanguage.googleapis.com/v1beta' ? '' : parsed?.gemini?.baseUrl
    settings = {
      global: {
        ...defaultSettings.global,
        ...parsed?.global,
        baseUrl: parsed?.global?.baseUrl || parsed?.baseUrl || defaultSettings.global.baseUrl,
        apiKey: parsed?.global?.apiKey ?? parsed?.apiKey ?? defaultSettings.global.apiKey,
      },
      openai: { ...defaultSettings.openai, ...parsed?.openai, baseUrl: openaiBaseUrl ?? defaultSettings.openai.baseUrl },
      gemini: { ...defaultSettings.gemini, ...parsed?.gemini, baseUrl: geminiBaseUrl ?? defaultSettings.gemini.baseUrl },
    }
  } catch {}
  const params = new URLSearchParams(search)
  return {
    ...settings,
    global: {
      ...settings.global,
      ...(params.has('baseurl') ? { baseUrl: params.get('baseurl') ?? '' } : {}),
      ...(params.has('apikey') ? { apiKey: params.get('apikey') ?? '' } : {}),
    },
  }
}

export function saveSettings(settings: Settings) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) }

export type ModelSelections = Record<Provider, string>

export function loadModelSelections(): ModelSelections {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_SELECTIONS_KEY) || 'null') as Partial<ModelSelections> | null
    return {
      openai: typeof parsed?.openai === 'string' ? parsed.openai : '',
      gemini: typeof parsed?.gemini === 'string' ? parsed.gemini : '',
    }
  } catch {
    return { openai: '', gemini: '' }
  }
}

export function saveModelSelections(selections: ModelSelections) {
  localStorage.setItem(MODEL_SELECTIONS_KEY, JSON.stringify(selections))
}

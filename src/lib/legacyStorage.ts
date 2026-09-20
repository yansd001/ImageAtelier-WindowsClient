import type { Settings, Task, Workspace } from '../types'
import { defaultSettings } from '../types'

// Read-only compatibility: no new records are written to browser storage.
const keys = ['yansd-image-gallery', 'yansd-image-tasks', 'yansd-image-settings', 'yansd-image-model-selections', 'yansd-image-last-workspace']

export function normalizeLegacySettings(parsed: (Partial<Settings> & { baseUrl?: string; apiKey?: string }) | null): Settings {
  const openaiBaseUrl = parsed?.openai?.baseUrl === 'https://api.openai.com/v1' ? '' : parsed?.openai?.baseUrl
  const geminiBaseUrl = parsed?.gemini?.baseUrl === 'https://generativelanguage.googleapis.com/v1beta' ? '' : parsed?.gemini?.baseUrl
  return {
    global: {
      baseUrl: parsed?.global?.baseUrl || parsed?.baseUrl || defaultSettings.global.baseUrl,
      apiKey: parsed?.global?.apiKey ?? parsed?.apiKey ?? '',
    },
    openai: { ...defaultSettings.openai, ...parsed?.openai, baseUrl: openaiBaseUrl ?? '' },
    gemini: { ...defaultSettings.gemini, ...parsed?.gemini, baseUrl: geminiBaseUrl ?? '' },
  }
}

export async function readLegacyState() {
  let raw: (string | null)[]
  try { raw = keys.map((key) => localStorage.getItem(key)) }
  catch { return null }
  if (!raw.some((value) => value !== null)) return null
  let db: IDBDatabase | undefined
  try {
    const gallery = (raw[0] ? JSON.parse(raw[0]) : { tasks: JSON.parse(raw[1] || '[]'), workspaces: [] }) as { tasks: Task[]; workspaces: Workspace[] }
    const hasCachedImages = gallery.tasks.some((task) => task.images.some((image) => image.startsWith('idb:')) || task.referenceImages?.some((image) => image.dataUrl.startsWith('idb:')))
    if (hasCachedImages) {
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('yansd-image-playground')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    const readImage = async (source: string) => {
      if (!source.startsWith('idb:')) return source
      return new Promise<string>((resolve, reject) => {
        const request = db!.transaction('images', 'readonly').objectStore('images').get(source.slice(4))
        request.onsuccess = () => typeof request.result === 'string' ? resolve(request.result) : reject(new Error('旧版图片数据缺失'))
        request.onerror = () => reject(request.error)
      })
    }
    const tasks = await Promise.all(gallery.tasks.map(async (task) => ({
      ...task,
      images: await Promise.all(task.images.map(readImage)),
      referenceImages: task.referenceImages ? await Promise.all(task.referenceImages.map(async (image) => ({ ...image, dataUrl: await readImage(image.dataUrl) }))) : undefined,
    })))
    const selected = JSON.parse(raw[3] || 'null')
    return {
      gallery: { ...gallery, tasks },
      settings: normalizeLegacySettings(JSON.parse(raw[2] || 'null')),
      modelSelections: { openai: selected?.openai || '', gemini: selected?.gemini || '' },
      lastWorkspace: raw[4] || '',
    }
  } catch (error) { throw new Error(`旧版数据迁移失败，原数据已保留：${error instanceof Error ? error.message : String(error)}`) }
  finally { db?.close() }
}

export function clearLegacyStorage() {
  // Keep IndexedDB originals as a recovery copy. The server deduplicates
  // repeat migrations if removing metadata is blocked by the browser.
  try { keys.forEach((key) => localStorage.removeItem(key)) } catch { /* Best effort. */ }
}

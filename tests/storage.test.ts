import { beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { backendFetch, installBackendFixture } from './backendFixture'
import { readLegacyState, normalizeLegacySettings } from '../src/lib/legacyStorage'
import { defaultParams, defaultSettings } from '../src/types'

installBackendFixture()
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII='
let values: Map<string, string>

beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key), setItem: () => { throw new Error('new browser writes are forbidden') } })
  vi.stubGlobal('window', { location: { search: '' } })
})

it('initializes from the backend, persists URL overrides, and never writes browser storage', async () => {
  vi.resetModules()
  window.location.search = '?baseurl=http%3A%2F%2Fexample.test%2Fv1&apikey=query-key'
  const { initializeStorage, saveModelSelections, saveLastWorkspace } = await import('../src/lib/storage')
  const first = initializeStorage()
  expect(initializeStorage()).toBe(first)
  expect((await first).settings.global).toEqual({ baseUrl: 'http://example.test/v1', apiKey: 'query-key' })
  await saveModelSelections({ openai: 'gpt-image-test', gemini: 'gemini-image' })
  await saveLastWorkspace('')
  const state = await (await backendFetch('/api/state')).json()
  expect(state.settings.global.apiKey).toBe('query-key')
  expect(state.modelSelections.gemini).toBe('gemini-image')
  expect(state.lastWorkspace).toBe('')
})

it('saves workspace selection immediately while a gallery write is pending and keeps it alive on reload', async () => {
  vi.resetModules()
  const { saveGallery, saveLastWorkspace } = await import('../src/lib/storage')
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let keepalive = false
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === '/api/gallery') await blocked
    if (input === '/api/last-workspace') keepalive = init?.keepalive === true
    return backendFetch(input, init)
  })
  const pending = saveGallery([], [])
  try {
    await saveLastWorkspace('immediate-workspace')
    const state = await (await backendFetch('/api/state')).json()
    expect(state.lastWorkspace).toBe('immediate-workspace')
    expect(keepalive).toBe(true)
  } finally { release(); await pending }
})

it('migrates IndexedDB originals and only clears old metadata after a successful commit', async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('yansd-image-playground', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('images')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite')
    tx.objectStore('images').put(png, 'old-original')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  values.set('yansd-image-gallery', JSON.stringify({ workspaces: [], tasks: [{ id: 'legacy-idb', prompt: 'legacy', provider: 'openai', model: 'gpt-image', params: defaultParams, images: ['idb:old-original'], status: 'done', createdAt: 1, favorite: false }] }))
  expect((await readLegacyState())!.gallery.tasks[0].images).toEqual([png])
  vi.resetModules()
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => input === '/api/migrate' ? Promise.resolve(new Response(JSON.stringify({ error: 'disk full' }), { status: 500 })) : backendFetch(input, init))
  const { initializeStorage } = await import('../src/lib/storage')
  await expect(initializeStorage()).rejects.toThrow('disk full')
  expect(values.has('yansd-image-gallery')).toBe(true)
  vi.stubGlobal('fetch', backendFetch)
  const state = await initializeStorage()
  expect(state.gallery.tasks[0].images[0]).toMatch(/^\/api\/images\//)
  expect(values.has('yansd-image-gallery')).toBe(false)
})

it('reports missing legacy images without clearing data and tolerates disabled browser storage on new installs', async () => {
  values.set('yansd-image-tasks', JSON.stringify([{ images: ['idb:missing'] }]))
  await expect(readLegacyState()).rejects.toThrow('原数据已保留')
  expect(values.has('yansd-image-tasks')).toBe(true)
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('disabled') } })
  expect(await readLegacyState()).toBeNull()
  expect(normalizeLegacySettings({ baseUrl: 'http://old.test', apiKey: 'old', openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '' } })).toEqual({ ...defaultSettings, global: { baseUrl: 'http://old.test', apiKey: 'old' } })
})

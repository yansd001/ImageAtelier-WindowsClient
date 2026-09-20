import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import JSZip from 'jszip'
import { defaultParams, type Task } from '../src/types'
import { dateKey, filterTasks, mergeGallery, UNASSIGNED } from '../src/lib/gallery'
import { hydrateTasks, loadGallery, saveGallery } from '../src/lib/storage'
import { createBackup, createImageZip, readBackup } from '../src/lib/archive'
import { backendFetch, installBackendFixture } from './backendFixture'
import { readLegacyState } from '../src/lib/legacyStorage'

installBackendFixture()

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII='
const workspace = { id: 'space-1', name: '产品摄影', createdAt: 1 }
const task = (overrides: Partial<Task> = {}): Task => ({ id: 'task-1', prompt: '红色相机', provider: 'openai', model: 'gpt-image-test', params: { ...defaultParams }, images: [png], referenceImages: [{ id: 'ref', name: '参考.png', dataUrl: png }], favorite: true, status: 'done', createdAt: new Date(2026, 8, 18, 0, 15).getTime(), workspaceId: workspace.id, ...overrides })
let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
})

describe('gallery directories', () => {
  const tasks = [task(), task({ id: 'task-2', createdAt: new Date(2026, 8, 17, 23, 45).getTime(), workspaceId: undefined, favorite: false })]
  it('groups by local calendar day', () => {
    expect(dateKey(tasks[0].createdAt)).toBe('2026-09-18')
    expect(dateKey(tasks[1].createdAt)).toBe('2026-09-17')
  })
  it('applies only the active directory and supports unassigned, search, and favorites', () => {
    const filters = { tab: 'date' as const, date: '2026-09-18', workspace: UNASSIGNED, search: '', favoritesOnly: false }
    expect(filterTasks(tasks, filters).map((item) => item.id)).toEqual(['task-1'])
    expect(filterTasks(tasks, { ...filters, tab: 'workspace' }).map((item) => item.id)).toEqual(['task-2'])
    expect(filterTasks(tasks, { ...filters, tab: 'workspace', workspace: '' })).toHaveLength(2)
    expect(filterTasks(tasks, { ...filters, date: '', search: '相机', favoritesOnly: true })).toHaveLength(1)
  })
  it('merges without overwriting records and remaps colliding workspace IDs', () => {
    const incoming = { tasks: [task(), task({ id: 'task-2', status: 'running' })], workspaces: [{ ...workspace, name: '海报' }] }
    const merged = mergeGallery({ tasks: [task()], workspaces: [workspace] }, incoming)
    expect(merged.added).toBe(1)
    expect(merged.skipped).toBe(1)
    expect(merged.workspaces).toHaveLength(2)
    const imported = merged.tasks.find((item) => item.id === 'task-2')!
    expect(imported.workspaceId).not.toBe(workspace.id)
    expect(imported.status).toBe('error')
    expect(mergeGallery(merged, incoming).added).toBe(0)
  })
})

describe('persistent gallery and portable ZIP backup', () => {
  it('migrates legacy data, stores images separately and hydrates selected tasks only', async () => {
    storage.set('yansd-image-tasks', JSON.stringify([task({ workspaceId: undefined })]))
    const legacy = await readLegacyState()
    const response = await backendFetch('/api/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(legacy) })
    expect(response.ok).toBe(true)
    expect((await loadGallery()).tasks).toHaveLength(1)
    const metadata = await saveGallery([task()], [workspace])
    expect(metadata[0].images[0]).toMatch(/^\/api\/images\//)
    expect((await loadGallery()).workspaces).toEqual([workspace])
    expect((await hydrateTasks(metadata))[0]).toEqual(task())
    // An unreadable image in another directory does not break this selection.
    const other = task({ id: 'missing', images: [`/api/images/${'0'.repeat(64)}.png`] })
    const selected = filterTasks([...metadata, other], { tab: 'date', date: '', workspace: '', search: 'no-match', favoritesOnly: false })
    expect(await hydrateTasks(selected)).toEqual([])
    await expect(hydrateTasks([other])).rejects.toThrow('缺失')
  })
  it('round-trips original bytes, references, metadata, favorites, workspaces and empty workspaces', async () => {
    const gallery = { tasks: [task()], workspaces: [workspace, { id: 'empty', name: '空工作区', createdAt: 2 }] }
    const metadata = await saveGallery(gallery.tasks, gallery.workspaces)
    const backup = await createBackup({ ...gallery, tasks: metadata })
    expect(await readBackup(backup)).toEqual(gallery)
    const zip = await JSZip.loadAsync(await backup.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.tasks[0].images).toEqual(['images/1.png'])
    expect(manifest.settings).toBeUndefined()
    // Emulate importing onto a browser with no existing gallery.
    await saveGallery([], [])
    const imported = await readBackup(backup)
    await saveGallery(imported.tasks, imported.workspaces)
    expect(await hydrateTasks((await loadGallery()).tasks)).toEqual(gallery.tasks)
  })
  it('packages every selected output using its actual image type', async () => {
    const zip = await JSZip.loadAsync(await (await createImageZip([task({ images: [png, png] }), task({ id: 'other' })])).arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(['image-1-1.png', 'image-1-2.png', 'image-2-1.png'])
    expect(await zip.file('image-1-1.png')!.async('base64')).toBe(png.split(',')[1])
    await expect(createImageZip([task({ images: [] })])).rejects.toThrow('没有可下载')
  })
  it('rejects incomplete, malformed, unsupported and duplicate-ID backups before saving', async () => {
    const backup = await createBackup({ tasks: [task()], workspaces: [workspace] })
    const zip = await JSZip.loadAsync(await backup.arrayBuffer())
    zip.remove('images/1.png')
    await expect(readBackup(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow('缺少图片')
    await expect(readBackup(new Blob(['broken']))).rejects.toThrow('无法读取')
    const good = await JSZip.loadAsync(await backup.arrayBuffer())
    const manifest = JSON.parse(await good.file('manifest.json')!.async('string'))
    manifest.tasks.push(manifest.tasks[0])
    good.file('manifest.json', JSON.stringify(manifest))
    await expect(readBackup(await good.generateAsync({ type: 'blob' }))).rejects.toThrow('结构无效')
    good.file('manifest.json', JSON.stringify({ ...manifest, version: 99 }))
    await expect(readBackup(await good.generateAsync({ type: 'blob' }))).rejects.toThrow('不是受支持')
    expect((await loadGallery()).tasks).toHaveLength(0)
  })
  it('preserves committed metadata on save failure and can save again', async () => {
    await saveGallery([task()], [workspace])
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => input === '/api/gallery' && init?.method === 'PUT'
      ? Promise.resolve(new Response(JSON.stringify({ error: 'disk full' }), { status: 500 })) : backendFetch(input, init))
    await expect(saveGallery([task({ id: 'new' })], [workspace])).rejects.toThrow('disk full')
    expect((await loadGallery()).tasks[0].id).toBe('task-1')
    expect((await hydrateTasks((await loadGallery()).tasks))[0].images).toEqual([png])
    vi.stubGlobal('fetch', backendFetch)
    await saveGallery([task({ id: 'recovered' })], [workspace])
    expect((await loadGallery()).tasks[0].id).toBe('recovered')
  })
})

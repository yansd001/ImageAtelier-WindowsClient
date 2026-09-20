import { afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { startBackend } from '../scripts/backend-process.mjs'
import { defaultSettings } from '../src/types'

const nativeFetch = globalThis.fetch
let backendURL = ''

export const backendFetch: typeof fetch = (input, init) => nativeFetch(typeof input === 'string' && input.startsWith('/') ? backendURL + input : input, init)

export function installBackendFixture() {
  let backend: ReturnType<typeof startBackend>
  let directory: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'image-atelier-test-'))
    backend = startBackend(resolve(`.cache/ImageAtelier${process.platform === 'win32' ? '.exe' : ''}`), ['-listen', '127.0.0.1:0', '-api-only', '-data', directory])
    backendURL = await backend.ready
  })
  beforeEach(async () => {
    vi.stubGlobal('fetch', backendFetch)
    // Node does not expose the browser's FileReader API.
    vi.stubGlobal('FileReader', class {
      result = ''
      onload = () => {}
      onerror = () => {}
      readAsDataURL(blob: Blob) {
        blob.arrayBuffer().then((data) => { this.result = `data:${blob.type};base64,${Buffer.from(data).toString('base64')}`; this.onload() }).catch(() => this.onerror())
      }
    })
    const state = await (await backendFetch('/api/state')).json()
    const reset = await backendFetch('/api/gallery', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: [], workspaces: [], revision: state.galleryRevision }) })
    if (!reset.ok) throw new Error(await reset.text())
    await backendFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(defaultSettings) })
    const { loadGallery } = await import('../src/lib/storage')
    await loadGallery()
  })
  afterAll(async () => {
    if (backend?.child.exitCode === null) {
      const stopped = once(backend.child, 'exit')
      backend.child.stdin.end()
      await stopped
    }
    if (directory) await rm(directory, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })
}

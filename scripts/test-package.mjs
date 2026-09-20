import { chromium, expect } from '@playwright/test'
import { strict as assert } from 'node:assert'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { startBackend } from './backend-process.mjs'

if (process.platform !== 'win32') throw new Error('发布包运行测试需要 Windows')
const source = resolve('release/ImageAtelier')
assert.deepEqual((await readdir(source)).filter((name) => name !== 'data').sort(), ['ImageAtelier.exe', 'frontend'])
const temporary = await mkdtemp(join(tmpdir(), 'image-atelier-package-'))
const bundle = join(temporary, '独立程序 Image Atelier')
const workingDirectory = join(temporary, 'unrelated-working-directory')
const browserBin = join(temporary, 'browser-command')
const browserRecord = join(temporary, 'opened-browser.json')
await mkdir(bundle)
await mkdir(workingDirectory)
await mkdir(browserBin)
await cp(join(source, 'ImageAtelier.exe'), join(bundle, 'ImageAtelier.exe'))
await cp(join(source, 'frontend'), join(bundle, 'frontend'), { recursive: true })

// Replace only the test process's Windows browser command. This verifies the
// default auto-open behavior without opening or modifying the user's browser.
const recorder = join(temporary, 'browser-recorder.go')
await writeFile(recorder, `package main
import ("encoding/json"; "os")
func main() { b, _ := json.Marshal(os.Args[1:]); _ = os.WriteFile(os.Getenv("IMAGE_ATELIER_TEST_BROWSER_RECORD"), b, 0600) }
`)
const compiled = spawnSync('go', ['build', '-o', join(browserBin, 'rundll32.exe'), recorder], { stdio: 'inherit', windowsHide: true, env: { ...process.env, CGO_ENABLED: '0' } })
assert.equal(compiled.status, 0)
const env = { ...process.env, IMAGE_ATELIER_TEST_BROWSER_RECORD: browserRecord }
for (const name of ['IMAGE_ATELIER_DATA_DIR', 'IMAGE_ATELIER_WEB_DIR', 'IMAGE_ATELIER_ADDR']) delete env[name]
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
env[pathKey] = browserBin + delimiter + (env[pathKey] || '')

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII='
let backend
let browser
async function stopBackend() {
  if (backend?.child.exitCode === null) {
    const closed = once(backend.child, 'exit')
    backend.child.stdin.end()
    assert.equal((await closed)[0], 0)
  }
  backend = undefined
}

try {
  // No -web or -data arguments: exercise the same defaults as double-clicking.
  backend = startBackend(join(bundle, 'ImageAtelier.exe'), ['-listen', '127.0.0.1:0'], { cwd: workingDirectory, env })
  let url = await backend.ready
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(browserRecord, 'utf8')) }
    catch { return null }
  }).toEqual(['url.dll,FileProtocolHandler', url])
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<div id="root"><\/div>/)
  assert.doesNotMatch(html, /请先运行 npm run build/)
  for (const [, asset] of html.matchAll(/(?:src|href)="([^\"]+)"/g)) {
    if (!asset.startsWith('./')) continue
    const file = await fetch(new URL(asset, url))
    assert.equal(file.status, 200, asset)
    assert.ok((await file.arrayBuffer()).byteLength > 0, asset)
  }
  async function put(path, data) {
    const response = await fetch(`${url}/api/${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    assert.equal(response.status, 200, await response.text())
  }
  await put('settings', { global: { baseUrl: 'http://test.invalid', apiKey: 'package-test-key' }, openai: { baseUrl: '', apiKey: '' }, gemini: { baseUrl: '', apiKey: '' } })
  const state = await (await fetch(`${url}/api/state`)).json()
  await put('gallery', { revision: state.galleryRevision, workspaces: [], tasks: [{ id: 'package-test', prompt: '打包目录运行验证', provider: 'openai', model: 'gpt-image', params: { size: 'auto', quality: 'auto', background: 'auto', outputFormat: 'png', aspectRatio: '1:1', imageSize: '1K', count: 1 }, images: [png], status: 'done', createdAt: 1, favorite: false }] })
  browser = await chromium.launch()
  const page = await browser.newPage()
  await page.route('**/api/fonts/**', (route) => route.abort())
  await page.goto(url)
  await expect(page.locator('.task-card')).toContainText('打包目录运行验证')
  await expect(page.locator('.task-card img')).toBeVisible()
  await expect(page.locator('.storage-error')).toHaveCount(0)
  const stored = JSON.parse(await readFile(join(bundle, 'data/state.json'), 'utf8'))
  assert.equal(stored.settings.global.apiKey, 'package-test-key')
  assert.match(stored.gallery.tasks[0].images[0], /^\/api\/images\//)
  await assert.rejects(access(join(workingDirectory, 'data')))
  await page.close()
  await stopBackend()

  await rm(browserRecord)
  backend = startBackend(join(bundle, 'ImageAtelier.exe'), ['-listen', '127.0.0.1:0', '-open-browser=false'], { cwd: temporary, env })
  url = await backend.ready
  const restored = await (await fetch(`${url}/api/state`)).json()
  assert.equal(restored.settings.global.apiKey, 'package-test-key')
  assert.equal(restored.gallery.tasks[0].prompt, '打包目录运行验证')
  const image = await fetch(url + restored.gallery.tasks[0].images[0])
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), png.split(',')[1])
  await assert.rejects(access(browserRecord))
  await stopBackend()

  const missing = join(temporary, 'missing-frontend')
  await mkdir(missing)
  await cp(join(bundle, 'ImageAtelier.exe'), join(missing, 'ImageAtelier.exe'))
  backend = startBackend(join(missing, 'ImageAtelier.exe'), [], { cwd: workingDirectory, env })
  await assert.rejects(backend.ready, /找不到前端页面/)
  backend = undefined
  console.log('Package passed: automatic browser launch, copied folder, unrelated working directory, frontend/assets, data location and restart persistence.')
} finally {
  await browser?.close()
  await stopBackend()
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('image-atelier-package-'))
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

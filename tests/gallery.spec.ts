import { test, expect, type Page } from '@playwright/test'
import JSZip from 'jszip'
import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { defaultParams, defaultSettings } from '../src/types'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII='
const mockProviders: Server[] = []

async function mockImageProvider(page: Page, handler?: RequestListener) {
  const server = createServer(handler ?? (async (request, response) => {
    for await (const _ of request) { /* drain multipart references */ }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }))
  })).listen(0, '127.0.0.1')
  mockProviders.push(server)
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  await page.request.put('/api/settings', { data: { ...defaultSettings, global: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' } } })
}

test.afterEach(async () => {
  for (const server of mockProviders.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
const fixtures = {
  workspaces: [{ id: 'space-1', name: '产品摄影', createdAt: 1 }, { id: 'space-2', name: '海报', createdAt: 2 }],
  tasks: [
    { id: 'today-product', prompt: '今天的红色相机', workspaceId: 'space-1', favorite: true, createdAt: new Date('2026-09-18T10:00:00+08:00').getTime(), images: [png, png] },
    { id: 'yesterday-product', prompt: '昨天的绿色相机', workspaceId: 'space-1', favorite: false, createdAt: new Date('2026-09-17T10:00:00+08:00').getTime(), images: [png] },
    { id: 'today-unassigned', prompt: '今天未分配的蓝色相机', favorite: false, createdAt: new Date('2026-09-18T11:00:00+08:00').getTime(), images: [png] },
  ].map((task) => ({ ...task, provider: 'openai', model: 'gpt-image-one', status: 'done', params: { ...defaultParams, count: task.images.length }, referenceImages: [{ id: 'ref', name: '参考.png', dataUrl: png }] })),
}

async function saveGallery(page: Page, gallery: typeof fixtures) {
  const state = await (await page.request.get('/api/state')).json()
  const response = await page.request.put('/api/gallery', { data: { ...gallery, revision: state.galleryRevision } })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

test.beforeEach(async ({ page }) => {
  await saveGallery(page, { tasks: [], workspaces: [] })
  await page.request.put('/api/settings', { data: { ...defaultSettings, global: { baseUrl: 'http://test.invalid', apiKey: 'test-key' } } })
  await page.request.put('/api/model-selections', { data: { openai: 'gpt-image-one', gemini: '' } })
  await page.request.put('/api/last-workspace', { data: { id: '' } })
  await page.route('**/api/fonts/**', (route) => route.abort())
})

async function seed(page: Page) {
  await saveGallery(page, fixtures)
  await page.goto('/')
  await expect(page.locator('.task-card')).toHaveCount(3)
  await expect(page.locator('.task-card .image-tile img').first()).toBeVisible()
}

test('date and workspace tabs stay independent; selecting a directory limits cards and resets batch selection', async ({ page }) => {
  await seed(page)
  await page.getByRole('button', { name: '2026-09-17' }).click()
  await expect(page.locator('.task-card')).toHaveCount(1)
  await expect(page.locator('.task-card')).toContainText('昨天的绿色相机')
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByLabel('全选当前结果').check()
  await expect(page.locator('.batch-toolbar')).toContainText('已选 1 个作品')
  await page.getByRole('tab', { name: '工作区', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(3)
  await expect(page.locator('.batch-toolbar')).toContainText('已选 0 个作品')
  await page.locator('.directory-entry').filter({ hasText: '产品摄影' }).click()
  await expect(page.locator('.task-card')).toHaveCount(2)
  await page.getByRole('tab', { name: '日期', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(1)
  await page.getByRole('tab', { name: '工作区', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(2)
  await page.locator('.directory-entry').filter({ hasText: '未分配工作区' }).click()
  await expect(page.locator('.task-card')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/gallery-desktop.png', fullPage: true })
})

test('model dropdown reopens with every model and only filters while typing', async ({ page }) => {
  await seed(page)
  await page.route('**/api/models?provider=openai', (route) => route.fulfill({ json: ['gpt-image-one', 'gpt-image-two', 'gpt-image-three'] }))
  await page.getByRole('button', { name: '拉取模型', exact: true }).click()
  await page.getByTitle('展开模型列表').click()
  await expect(page.locator('#model-options [role="option"]')).toHaveCount(3)
  await page.getByRole('option', { name: 'gpt-image-two', exact: true }).click()
  await page.getByTitle('展开模型列表').click()
  await expect(page.locator('#model-options [role="option"]')).toHaveCount(3)
  await page.getByRole('combobox', { name: '生图模型', exact: true }).fill('three')
  await expect(page.locator('#model-options [role="option"]')).toHaveCount(1)
  await page.getByRole('option', { name: 'gpt-image-three', exact: true }).click()
  await page.getByRole('combobox', { name: '生图模型', exact: true }).focus()
  await expect(page.locator('#model-options [role="option"]')).toHaveCount(3)
})

test('create, remember, generate in, assign and clear a workspace', async ({ page }) => {
  await seed(page)
  await page.getByTitle('新建生成工作区').click()
  await page.getByLabel('工作区名称', { exact: true }).fill('新摄影项目')
  await page.getByRole('button', { name: '创建并使用', exact: true }).click()
  await expect(page.locator('#generation-workspace')).toContainText('新摄影项目')
  const workspaceId = await page.locator('#generation-workspace').inputValue()
  await page.reload()
  await expect(page.locator('#generation-workspace')).toHaveValue(workspaceId)
  await mockImageProvider(page)
  await page.locator('.bottom-prompt-input').fill('新的工作区作品')
  await page.getByTitle('生成图片', { exact: true }).click()
  await expect(page.locator('.task-card').filter({ hasText: '新的工作区作品' })).toContainText('已生成 1 张图片')
  await expect(page.locator('.task-card').filter({ hasText: '新的工作区作品' })).toContainText('新摄影项目')
  const card = page.locator('.task-card').filter({ hasText: '今天未分配的蓝色相机' })
  await card.getByTitle('设置工作区', { exact: true }).click()
  await page.getByLabel('选择工作区', { exact: true }).selectOption(workspaceId)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(card).toContainText('新摄影项目')
  await card.getByTitle('设置工作区', { exact: true }).click()
  await page.getByLabel('选择工作区', { exact: true }).selectOption('')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(card).toContainText('未分配工作区')
  await page.locator('#generation-workspace').selectOption('')
  await page.reload()
  await expect(page.locator('#generation-workspace')).toHaveValue('')
})

test('batch ZIP includes all images and deletion requires confirmation', async ({ page }) => {
  await seed(page)
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByLabel('全选当前结果').check()
  await expect(page.locator('.batch-toolbar')).toContainText('已选 3 个作品 · 4 张图片')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '打包下载', exact: true }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const zip = await JSZip.loadAsync(Buffer.concat(chunks))
  expect(Object.keys(zip.files)).toHaveLength(4)
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '删除作品' })).toContainText('3 个作品及其中的 4 张图片')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(3)
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.task-card')).toHaveCount(0)
})

test('backup imports into another browser and repeating import skips duplicates', async ({ page, browser }) => {
  await seed(page)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份', exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  await page.close()
  const context = await browser.newContext()
  const other = await context.newPage()
  await other.route('**/api/fonts/**', (route) => route.abort())
  // A new browser shares the backend. Empty it to emulate another installation.
  await saveGallery(other, { tasks: [], workspaces: [] })
  await other.goto('http://127.0.0.1:5173/')
  await other.locator('input[accept=".zip,application/zip"]').setInputFiles(path!)
  await expect(other.locator('.task-card')).toHaveCount(3)
  await expect(other.locator('.task-card img')).toHaveCount(4)
  await expect(other.locator('.task-card img').first()).toBeVisible()
  await other.locator('input[accept=".zip,application/zip"]').setInputFiles(path!)
  await expect(other.locator('.toast')).toContainText('跳过 3 个重复作品')
  await expect(other.locator('.task-card')).toHaveCount(3)
  await other.reload()
  await expect(other.locator('.task-card')).toHaveCount(3)
  await other.getByRole('tab', { name: '工作区', exact: true }).click()
  await expect(other.locator('.directory-entry').filter({ hasText: '产品摄影' })).toContainText('2')
  await other.locator('input[accept=".zip,application/zip"]').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('broken') })
  await expect(other.locator('.toast')).toContainText('无法读取')
  await expect(other.locator('.task-card')).toHaveCount(3)
  await context.close()
})

test('mobile layout fits the viewport and workspace dialog remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seed(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole('tab', { name: '工作区', exact: true }).click()
  await page.getByRole('button', { name: '新建工作区', exact: true }).click()
  await page.getByLabel('工作区名称', { exact: true }).fill('移动端项目')
  await page.getByRole('button', { name: '创建并使用', exact: true }).click()
  await expect(page.locator('.gallery-scope')).toHaveText('移动端项目')
  await page.screenshot({ path: 'test-results/gallery-mobile.png', fullPage: true })
})

test('large galleries load only displayed outputs from the backend', async ({ page }) => {
  const gallery = { ...fixtures, tasks: Array.from({ length: 60 }, (_, index) => ({ ...fixtures.tasks[index < 50 ? 0 : 1], id: `large-${index}`, images: [`data:image/png;base64,${Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from(String(index))]).toString('base64')}`], params: { ...defaultParams } })) }
  const stored = await saveGallery(page, gallery)
  let reads = new Set<string>()
  page.on('request', (request) => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/images/')) reads.add(path) })
  await page.goto('/')
  await expect(page.locator('.task-card')).toHaveCount(48)
  await expect.poll(() => reads.size).toBe(48)
  expect(reads.has(stored.tasks[0].referenceImages[0].dataUrl)).toBe(false)
  reads = new Set()
  await page.getByRole('button', { name: '2026-09-17' }).click()
  await expect(page.locator('.task-card')).toHaveCount(10)
  await expect.poll(() => reads.size).toBe(10)
  expect(reads).toEqual(new Set(stored.tasks.slice(50).map((task: { images: string[] }) => task.images[0])))
  await page.locator('.directory-entry').filter({ hasText: '全部作品' }).click()
  await expect(page.locator('.task-card')).toHaveCount(48)
  await page.getByRole('button', { name: '加载更多作品', exact: false }).click()
  await expect(page.locator('.task-card')).toHaveCount(60)
})

test('settings, model requests, reference generation and originals survive a fresh browser through Go', async ({ page, browser }) => {
  let generations = 0
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    expect(request.headers.authorization).toBe('Bearer backend-only-key')
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'gpt-image-e2e' }, { id: 'text-only' }] }))
    } else if (request.url === '/v1/images/edits') {
      generations++
      expect(request.headers['content-type']).toContain('multipart/form-data')
      expect(Buffer.concat(chunks).toString()).toContain('name="image[]"')
      response.end(JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }))
    } else { response.writeHead(404); response.end('{}') }
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address() as { port: number }
  const external: string[] = []
  page.on('request', (request) => { if (request.url().startsWith(`http://127.0.0.1:${address.port}`)) external.push(request.url()) })
  try {
    await page.goto('/')
    await page.getByTitle('配置 API').click()
    await page.getByPlaceholder('https://code.yansd666.com').fill(`http://127.0.0.1:${address.port}/v1`)
    await page.getByPlaceholder('所有提供商共用的 Key').fill('backend-only-key')
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('.settings-modal')).toHaveCount(0)
    await page.getByRole('button', { name: '拉取模型', exact: true }).click()
    await page.getByTitle('展开模型列表').click()
    await page.getByRole('option', { name: 'gpt-image-e2e', exact: true }).click()
    await page.locator('input[accept="image/*"]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') })
    await page.locator('.bottom-prompt-input').fill('完整后端生成流程')
    await page.getByTitle('生成图片', { exact: true }).click()
    await expect(page.locator('.task-card')).toContainText('已生成 1 张图片')
    await expect.poll(async () => (await (await page.request.get('/api/state')).json()).gallery.tasks[0]?.images[0]).toMatch(/^\/api\/images\//)
    expect(generations).toBe(1)
    expect(external).toEqual([])
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
    const otherContext = await browser.newContext()
    const other = await otherContext.newPage()
    try {
      await other.route('**/api/fonts/**', (route) => route.abort())
      await other.goto('http://127.0.0.1:5173/')
      await expect(other.locator('.task-card')).toContainText('完整后端生成流程')
      await expect(other.locator('.task-card img')).toBeVisible()
      await other.getByTitle('编辑后重新生成', { exact: true }).click()
      await expect(other.locator('.reference-thumb img')).toBeVisible()
      await expect(other.locator('.bottom-prompt-input')).toHaveValue('完整后端生成流程')
      await other.getByTitle('配置 API').click()
      await expect(other.getByPlaceholder('所有提供商共用的 Key')).toHaveValue('backend-only-key')
    } finally { await otherContext.close() }
    // Merely opening another window must not invalidate this one's gallery.
    await page.locator('.task-card').getByTitle('收藏', { exact: true }).click()
    await expect.poll(async () => (await (await page.request.get('/api/state')).json()).gallery.tasks[0].favorite).toBe(true)
  } finally { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())) }
})

test('failed initialization never saves empty defaults; settings failure keeps the editor open', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => { if (request.method() === 'PUT') writes.push(request.url()) })
  await page.route('**/api/state', (route) => route.fulfill({ status: 503, json: { error: '后端暂不可用' } }))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('后端暂不可用')
  await expect(page.getByTitle('配置 API')).toBeDisabled()
  expect(writes).toEqual([])
  await page.unroute('**/api/state')
  await page.reload()
  await page.getByTitle('配置 API').click()
  await page.getByPlaceholder('所有提供商共用的 Key').fill('unsaved')
  await page.route('**/api/settings', (route) => route.fulfill({ status: 500, json: { error: '磁盘空间不足' } }))
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('磁盘空间不足')
  await expect(page.locator('.settings-modal')).toBeVisible()
  expect((await (await page.request.get('/api/state')).json()).settings.global.apiKey).toBe('test-key')
})

test('refresh and closing every page leave reference generation running and backend saves the result', async ({ page, browser, request }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  await mockImageProvider(page, async (upstreamRequest, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of upstreamRequest) chunks.push(chunk)
    calls++
    expect(upstreamRequest.url).toBe('/v1/images/edits')
    expect(Buffer.concat(chunks).toString()).toContain('name="image[]"')
    await gate
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }))
  })
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/gallery')) writes.push(request.url())
  })
  try {
    await page.goto('/')
    await page.locator('input[accept="image/*"]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') })
    await page.locator('.bottom-prompt-input').fill('刷新与关闭后继续生成')
    const accepted = page.waitForResponse((response) => response.url().endsWith('/api/tasks') && response.request().method() === 'POST')
    await page.getByTitle('生成图片', { exact: true }).click()
    expect((await accepted).status()).toBe(202)
    await expect(page.locator('.task-card')).toContainText('生成中')
    await expect.poll(() => calls).toBe(1)
    await page.reload()
    await expect(page.locator('.task-card')).toContainText('生成中')
    await expect(page.locator('.task-card')).not.toContainText('已中断')
    await page.locator('.task-card').getByTitle('收藏', { exact: true }).click()
    await expect(page.locator('.task-card .is-favorite')).toHaveCount(1)
    await page.locator('.task-card').getByTitle('设置工作区', { exact: true }).click()
    await page.getByLabel('或新建工作区').fill('后台生成期间归类')
    await page.getByRole('button', { name: '创建并使用', exact: true }).click()
    await expect(page.locator('.task-card')).toContainText('后台生成期间归类')
    expect(calls).toBe(1)
    expect(writes).toEqual([])
    await page.close()
    release()
    // No page is available to write the completion. Only Go can save it.
    await expect.poll(async () => (await (await request.get('/api/state')).json()).gallery.tasks[0]?.status).toBe('done')
    const state = await (await request.get('/api/state')).json()
    expect(state.gallery.tasks[0].favorite).toBe(true)
    expect(state.gallery.tasks[0].images[0]).toMatch(/^\/api\/images\//)
    expect((await request.get(state.gallery.tasks[0].images[0])).ok()).toBe(true)
    expect(calls).toBe(1)
    const freshContext = await browser.newContext()
    try {
      const fresh = await freshContext.newPage()
      await fresh.route('**/api/fonts/**', (route) => route.abort())
      await fresh.goto('http://127.0.0.1:5173/')
      await expect(fresh.locator('.task-card')).toContainText('已生成 1 张图片')
      await expect(fresh.locator('.task-card')).toContainText('后台生成期间归类')
      await expect(fresh.locator('.task-card img')).toBeVisible()
      await expect(fresh.locator('.task-card .is-favorite')).toHaveCount(1)
    } finally { await freshContext.close() }
  } finally { release() }
})

test('retry continues across reload and polling recovers after a temporary connection failure', async ({ page }) => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await mockImageProvider(page, async (request, response) => {
    for await (const _ of request) { /* consume request */ }
    calls++
    response.setHeader('Content-Type', 'application/json')
    if (calls <= 2) { response.writeHead(502); response.end(JSON.stringify({ error: { message: '模拟生图失败' } })); return }
    await gate
    response.end(JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }))
  })
  try {
    await page.goto('/')
    await page.locator('.bottom-prompt-input').fill('重试任务刷新恢复')
    await page.getByTitle('生成图片', { exact: true }).click()
    await expect(page.locator('.task-card')).toContainText('模拟生图失败')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('.task-card')).toContainText('生成中')
    await page.reload()
    await expect(page.locator('.task-card')).toContainText('生成中')
    await expect.poll(() => calls).toBe(3)
    await page.route('**/api/gallery', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: '模拟连接中断' } })
      else await route.continue()
    })
    await expect(page.getByRole('alert')).toContainText('模拟连接中断')
    release()
    await expect.poll(async () => (await (await page.request.get('/api/state')).json()).gallery.tasks[0]?.status).toBe('done')
    await page.unroute('**/api/gallery')
    await expect(page.locator('.task-card')).toContainText('已生成 1 张图片')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.task-card img')).toBeVisible()
    expect(calls).toBe(3)
  } finally { release() }
})

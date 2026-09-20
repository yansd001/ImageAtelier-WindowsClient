import { test, expect, type Page } from '@playwright/test'
import JSZip from 'jszip'
import { defaultParams } from '../src/types'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII='
const fixtures = {
  workspaces: [{ id: 'space-1', name: '产品摄影', createdAt: 1 }, { id: 'space-2', name: '海报', createdAt: 2 }],
  tasks: [
    { id: 'today-product', prompt: '今天的红色相机', workspaceId: 'space-1', favorite: true, createdAt: new Date('2026-09-18T10:00:00+08:00').getTime(), images: [png, png] },
    { id: 'yesterday-product', prompt: '昨天的绿色相机', workspaceId: 'space-1', favorite: false, createdAt: new Date('2026-09-17T10:00:00+08:00').getTime(), images: [png] },
    { id: 'today-unassigned', prompt: '今天未分配的蓝色相机', favorite: false, createdAt: new Date('2026-09-18T11:00:00+08:00').getTime(), images: [png] },
  ].map((task) => ({ ...task, provider: 'openai', model: 'gpt-image-one', status: 'done', params: { ...defaultParams, count: task.images.length }, referenceImages: [{ id: 'ref', name: '参考.png', dataUrl: png }] })),
}

async function seed(page: Page) {
  await page.addInitScript((gallery) => {
    if (!localStorage.getItem('ui-test-seeded')) {
      localStorage.setItem('yansd-image-gallery', JSON.stringify(gallery))
      localStorage.setItem('yansd-image-settings', JSON.stringify({ global: { baseUrl: 'http://test.invalid', apiKey: 'test-key' } }))
      localStorage.setItem('yansd-image-model-selections', JSON.stringify({ openai: 'gpt-image-one', gemini: '' }))
      localStorage.setItem('ui-test-seeded', '1')
    }
  }, fixtures)
  await page.route('https://fontsapi.zeoseven.com/**', (route) => route.abort())
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
  await page.route('http://test.invalid/v1/models', (route) => route.fulfill({ json: { data: [{ id: 'gpt-image-one' }, { id: 'gpt-image-two' }, { id: 'gpt-image-three' }] } }))
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
  await page.route('http://test.invalid/v1/images/generations', (route) => route.fulfill({ json: { data: [{ b64_json: png.split(',')[1] }] } }))
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
  const context = await browser.newContext()
  const other = await context.newPage()
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

test('large galleries read only displayed output images from IndexedDB', async ({ page }) => {
  const gallery = { ...fixtures, tasks: Array.from({ length: 60 }, (_, index) => ({ ...fixtures.tasks[index < 50 ? 0 : 1], id: `large-${index}`, images: [png], params: { ...defaultParams } })) }
  await page.addInitScript((data) => {
    localStorage.setItem('yansd-image-gallery', JSON.stringify(data))
    const reads: string[] = []
    Object.assign(window, { galleryImageReads: reads })
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (key) { reads.push(String(key)); return get.call(this, key) }
  }, gallery)
  await page.goto('/')
  await expect(page.locator('.task-card')).toHaveCount(48)
  await expect.poll(() => page.evaluate(() => (window as unknown as { galleryImageReads: string[] }).galleryImageReads.filter((id) => id.includes(':output:')).length)).toBe(48)
  expect(await page.evaluate(() => (window as unknown as { galleryImageReads: string[] }).galleryImageReads.some((id) => id.includes(':reference:')))).toBe(false)
  await page.evaluate(() => { (window as unknown as { galleryImageReads: string[] }).galleryImageReads.length = 0 })
  await page.getByRole('button', { name: '2026-09-17' }).click()
  await expect(page.locator('.task-card')).toHaveCount(10)
  // React StrictMode can run mount effects twice in development; inspect the set of images read.
  await expect.poll(() => page.evaluate(() => new Set((window as unknown as { galleryImageReads: string[] }).galleryImageReads).size)).toBe(10)
  expect(await page.evaluate(() => (window as unknown as { galleryImageReads: string[] }).galleryImageReads.every((id) => /^large-5\d:output:0$/.test(id)))).toBe(true)
  await page.locator('.directory-entry').filter({ hasText: '全部作品' }).click()
  await expect(page.locator('.task-card')).toHaveCount(48)
  await page.getByRole('button', { name: '加载更多作品', exact: false }).click()
  await expect(page.locator('.task-card')).toHaveCount(60)
})

import JSZip from 'jszip'
import type { Task, Workspace } from '../types'
import { hydrateImage } from './storage'

const FORMAT = 'image-atelier'
const VERSION = 1
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
type Gallery = { tasks: Task[]; workspaces: Workspace[] }
type Asset = { path: string; mime: string }

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function imageFormat(bytes: Uint8Array) {
  const header = Array.from(bytes.slice(0, 12)).map((byte) => String.fromCharCode(byte)).join('')
  if (bytes[0] === 0x89 && header.slice(1, 4) === 'PNG') return { mime: 'image/png', extension: 'png' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' }
  if (header.startsWith('GIF8')) return { mime: 'image/gif', extension: 'gif' }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) return { mime: 'image/avif', extension: 'avif' }
  throw new Error('图片格式无效，支持 PNG、JPEG、WEBP、GIF 和 AVIF')
}

export async function readImage(value: string) {
  const source = await hydrateImage(value)
  const response = await fetch(source)
  if (!response.ok) throw new Error(`图片读取失败 (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { bytes, ...imageFormat(bytes) }
}

export async function createImageZip(tasks: Task[]) {
  const zip = new JSZip()
  let count = 0
  for (const [taskIndex, task] of tasks.entries()) {
    for (const [index, source] of task.images.entries()) {
      const image = await readImage(source)
      zip.file(`image-${taskIndex + 1}-${index + 1}.${image.extension}`, image.bytes)
      count++
    }
  }
  if (!count) throw new Error('所选作品没有可下载的图片')
  return zip.generateAsync({ type: 'blob' })
}

export async function createBackup(gallery: Gallery) {
  const zip = new JSZip()
  const tasks: Task[] = []
  const assets: Asset[] = []
  let size = 0
  const addImage = async (source: string) => {
    const image = await readImage(source)
    size += image.bytes.byteLength
    if (size > MAX_ARCHIVE_BYTES) throw new Error('备份超过 1 GB，暂时无法在浏览器中打包')
    const path = `images/${assets.length + 1}.${image.extension}`
    zip.file(path, image.bytes)
    assets.push({ path, mime: image.mime })
    return path
  }
  for (const task of gallery.tasks) {
    const images: string[] = []
    for (const image of task.images) images.push(await addImage(image))
    const referenceImages = []
    for (const image of task.referenceImages ?? []) referenceImages.push({ ...image, dataUrl: await addImage(image.dataUrl) })
    tasks.push({ ...task, images, referenceImages })
  }
  zip.file('manifest.json', JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), tasks, workspaces: gallery.workspaces, assets }, null, 2))
  return zip.generateAsync({ type: 'blob' })
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isString(value: unknown): value is string { return typeof value === 'string' }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15 }
function uniqueIds(items: { id: string }[]) { return new Set(items.map((item) => item.id)).size === items.length }

function validateManifest(value: unknown): Gallery & { assets: Asset[] } {
  const invalid = () => { throw new Error('备份文件结构无效或数据不完整') }
  if (!record(value) || value.format !== FORMAT || value.version !== VERSION) throw new Error('不是受支持的 Image Atelier 备份文件')
  if (!Array.isArray(value.tasks) || !Array.isArray(value.workspaces) || !Array.isArray(value.assets)) return invalid()
  const workspaces: Workspace[] = value.workspaces.map((item: unknown) => {
    if (!record(item) || !isString(item.id) || !item.id || !isString(item.name) || !item.name.trim() || item.name.length > 60 || !timestamp(item.createdAt)) return invalid()
    return { id: item.id, name: item.name.trim(), createdAt: item.createdAt }
  })
  if (!uniqueIds(workspaces)) return invalid()
  const assets: Asset[] = value.assets.map((item: unknown) => {
    if (!record(item) || !isString(item.path) || !/^images\/[1-9]\d*\.(png|jpg|webp|gif|avif)$/.test(item.path) || !isString(item.mime) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(item.mime)) return invalid()
    return { path: item.path, mime: item.mime }
  })
  const paths = new Set(assets.map((asset) => asset.path))
  if (paths.size !== assets.length) return invalid()
  const tasks: Task[] = value.tasks.map((item: unknown) => {
    if (!record(item) || !isString(item.id) || !item.id || !isString(item.prompt) || !isString(item.model) || !['openai', 'gemini'].includes(String(item.provider)) || !['done', 'error', 'running'].includes(String(item.status)) || !timestamp(item.createdAt) || typeof item.favorite !== 'boolean') return invalid()
    if (item.workspaceId !== undefined && (!isString(item.workspaceId) || !workspaces.some((workspace) => workspace.id === item.workspaceId))) return invalid()
    if (!Array.isArray(item.images) || !item.images.every((path: unknown) => isString(path) && paths.has(path))) return invalid()
    if (item.error !== undefined && !isString(item.error)) return invalid()
    const params = item.params
    if (!record(params) || !isString(params.size) || !isString(params.aspectRatio) || !['auto', 'low', 'medium', 'high'].includes(String(params.quality)) || !['auto', 'transparent', 'opaque'].includes(String(params.background)) || !['png', 'jpeg', 'webp'].includes(String(params.outputFormat)) || !['1K', '2K', '4K'].includes(String(params.imageSize)) || !Number.isInteger(params.count) || Number(params.count) < 1 || Number(params.count) > 4) return invalid()
    const references = item.referenceImages ?? []
    if (!Array.isArray(references) || references.length > 8) return invalid()
    const referenceImages = references.map((image: unknown) => {
      if (!record(image) || !isString(image.id) || !image.id || !isString(image.name) || !isString(image.dataUrl) || !paths.has(image.dataUrl)) return invalid()
      return { id: image.id, name: image.name, dataUrl: image.dataUrl }
    })
    if (!uniqueIds(referenceImages)) return invalid()
    return { id: item.id, prompt: item.prompt, model: item.model, provider: item.provider, status: item.status, createdAt: item.createdAt, favorite: item.favorite, workspaceId: item.workspaceId, error: item.error, images: item.images, referenceImages, params: { size: params.size, quality: params.quality, background: params.background, outputFormat: params.outputFormat, aspectRatio: params.aspectRatio, imageSize: params.imageSize, count: params.count } } as Task
  })
  if (!uniqueIds(tasks)) return invalid()
  return { tasks, workspaces, assets }
}

export async function readBackup(file: Blob): Promise<Gallery> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('备份文件不能超过 1 GB')
  let zip: JSZip
  try { zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true }) }
  catch { throw new Error('无法读取 ZIP 备份，文件可能已损坏') }
  const manifest = zip.file('manifest.json')
  if (!manifest) throw new Error('备份中缺少 manifest.json')
  let raw: unknown
  try { raw = JSON.parse(await manifest.async('string')) } catch { throw new Error('备份目录损坏') }
  const gallery = validateManifest(raw)
  const dataUrls = new Map<string, string>()
  let size = 0
  for (const asset of gallery.assets) {
    const entry = zip.file(asset.path)
    if (!entry) throw new Error(`备份缺少图片：${asset.path}`)
    const bytes = await entry.async('uint8array')
    size += bytes.byteLength
    if (size > MAX_ARCHIVE_BYTES) throw new Error('备份解压后超过 1 GB')
    if (imageFormat(bytes).mime !== asset.mime) throw new Error(`图片类型不匹配：${asset.path}`)
    const base64 = await entry.async('base64')
    dataUrls.set(asset.path, `data:${asset.mime};base64,${base64}`)
  }
  return {
    workspaces: gallery.workspaces,
    tasks: gallery.tasks.map((task) => ({ ...task, images: task.images.map((path) => dataUrls.get(path)!), referenceImages: task.referenceImages?.map((image) => ({ ...image, dataUrl: dataUrls.get(image.dataUrl)! })) })),
  }
}

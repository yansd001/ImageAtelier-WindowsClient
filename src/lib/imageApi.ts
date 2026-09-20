import type { GenerationParams, Provider, ReferenceImage, Settings } from '../types'

function endpoint(baseUrl: string, path: string) { return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}` }
function dataUrlFromBase64(value: string, mime = 'image/png') { return value.startsWith('data:') ? value : `data:${mime};base64,${value}` }
function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('远程图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

async function cacheRemoteImage(url: string) {
  if (url.startsWith('data:')) return url
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await blobToDataUrl(await response.blob())
  } catch {
    throw new Error('远程图片缓存失败，请确认图片服务器允许跨域访问')
  }
}
function dataUrlParts(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/)
  if (!match) throw new Error('参考图格式无效')
  return { mimeType: match[1] || 'image/png', base64: match[2] }
}

function base64ToBlob(base64: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: mimeType })
}
const defaultBaseUrls: Record<Provider, string> = {
  openai: 'https://code.yansd666.com',
  gemini: 'https://code.yansd666.com',
}

export async function fetchAvailableModels(provider: Provider, settings: Settings): Promise<string[]> {
  const config = settings[provider]
  const apiKey = config.apiKey.trim() || settings.global.apiKey.trim()
  const root = normalizeBaseUrl(config.baseUrl || settings.global.baseUrl) || defaultBaseUrls[provider]
  if (!apiKey) return []
  const response = await fetch(endpoint(endpoint(root, 'v1'), 'models'), { headers: { Authorization: `Bearer ${apiKey}` } })
  const json = await response.json() as { data?: Array<{ id?: string; name?: string }>; error?: { message?: string } }
  if (!response.ok) throw new Error(json.error?.message || `模型列表请求失败 (${response.status})`)
  const ids = (json.data || []).map((item) => item.id || item.name || '').filter(Boolean)
  const filtered = ids.filter((id) => {
    const normalized = id.toLowerCase()
    return normalized.includes('image') && normalized.includes(provider === 'openai' ? 'gpt' : 'gemini')
  })
  return [...new Set(filtered)]
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/(?:v1beta|v1)$/i, '')
}

function providerBaseUrl(provider: Provider, value: string) {
  const root = normalizeBaseUrl(value) || defaultBaseUrls[provider]
  return endpoint(root, provider === 'openai' ? 'v1' : 'v1beta')
}

async function generateSingleImage(provider: Provider, settings: Settings, model: string, prompt: string, params: GenerationParams, referenceImages: ReferenceImage[]): Promise<string[]> {
  const config = settings[provider]
  const apiKey = config.apiKey.trim() || settings.global.apiKey.trim()
  const baseUrl = providerBaseUrl(provider, config.baseUrl || settings.global.baseUrl)
  if (!apiKey) throw new Error(`请先在设置中配置全局或 ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API Key`)
  if (!model.trim()) throw new Error('请输入生图模型')
  if (provider === 'openai') {
    const body = { model, prompt, size: params.size, quality: params.quality, background: params.background, output_format: params.outputFormat, n: params.count }
    const request = referenceImages.length
      ? (() => {
          const form = new FormData()
          Object.entries(body).forEach(([key, value]) => form.append(key, String(value)))
          referenceImages.forEach((image) => {
            const parts = dataUrlParts(image.dataUrl)
            form.append('image[]', base64ToBlob(parts.base64, parts.mimeType), image.name)
          })
          return { headers: { Authorization: `Bearer ${apiKey}` }, body: form }
        })()
      : { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) }
    const response = await fetch(endpoint(baseUrl, referenceImages.length ? 'images/edits' : 'images/generations'), { method: 'POST', ...request })
    const json = await response.json() as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } }
    if (!response.ok) throw new Error(json.error?.message || `OpenAI 请求失败 (${response.status})`)
    const images = await Promise.all((json.data || []).map((item) => item.b64_json ? dataUrlFromBase64(item.b64_json) : item.url ? cacheRemoteImage(item.url) : ''))
    const validImages = images.filter(Boolean)
    if (!validImages.length) throw new Error('OpenAI 未返回图片数据')
    return validImages
  }

  const url = `${endpoint(baseUrl, `models/${model}:generateContent`)}?key=${encodeURIComponent(apiKey)}`
  const body = {
    contents: [{ parts: [...referenceImages.map((image) => { const parts = dataUrlParts(image.dataUrl); return { inlineData: { mimeType: parts.mimeType, data: parts.base64 } } }), { text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: params.aspectRatio, imageSize: params.imageSize } },
  }
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>; error?: { message?: string } }
  if (!response.ok) throw new Error(json.error?.message || `Gemini 请求失败 (${response.status})`)
  const images = (json.candidates || []).flatMap((candidate) => (candidate.content?.parts || []).map((part) => part.inlineData?.data ? dataUrlFromBase64(part.inlineData.data, part.inlineData.mimeType) : '').filter(Boolean))
  if (!images.length) throw new Error('Gemini 未返回图片数据，请确认模型支持图像输出')
  return images.slice(0, 1)
}

/**
 * Generate each requested image independently so a failed image does not
 * discard the successful results from the same gallery task.
 */
export async function generateImages(provider: Provider, settings: Settings, model: string, prompt: string, params: GenerationParams, referenceImages: ReferenceImage[] = []): Promise<string[]> {
  const config = settings[provider]
  const apiKey = config.apiKey.trim() || settings.global.apiKey.trim()
  if (!apiKey) throw new Error(`请先在设置中配置全局或 ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API Key`)
  if (!model.trim()) throw new Error('请输入生图模型')
  const count = Math.min(4, Math.max(1, Math.floor(Number(params.count) || 1)))
  const singleParams = { ...params, count: 1 }
  const images: string[] = []
  let lastError: unknown

  for (let index = 0; index < count; index += 1) {
    let generated = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await generateSingleImage(provider, settings, model, prompt, singleParams, referenceImages)
        const image = result[0]
        if (!image) throw new Error('未返回图片数据')
        images.push(image)
        generated = true
        break
      } catch (error) {
        lastError = error
      }
    }
    // A failed image is intentionally skipped after its one automatic retry.
    if (!generated) continue
  }

  if (!images.length) {
    const message = lastError instanceof Error ? lastError.message : '图片生成失败'
    throw new Error(`图片生成失败（已自动重试一次）：${message}`)
  }
  return images
}

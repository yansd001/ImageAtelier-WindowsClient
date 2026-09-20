export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch { throw new Error('无法连接 Go 后端，请确认服务已启动后重试') }
  let data: T & { error?: string }
  try { data = await response.json() }
  catch { throw new Error(`后端响应无效 (${response.status})，请确认 Go 服务及代理配置`) }
  if (!response.ok) throw new Error(data.error || `后端请求失败 (${response.status})`)
  return data
}

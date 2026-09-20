import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Used only by development and automated tests. The release exe runs directly.
export function startBackend(binary, args = [], options = {}) {
  const child = spawn(binary, [...args, '-parent-stdin'], { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let errors = ''
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000); process.stderr.write(chunk) })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Go 后端启动超时')) }, 15000)
    const lines = createInterface({ input: child.stdout })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); lines.close(); reject(new Error(`Go 后端已退出 (${code})：${errors}`)) })
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line)
        if (typeof value.url === 'string') { clearTimeout(timer); resolve(value.url) }
      } catch { /* Ignore other output. */ }
    })
  })
  return { child, ready }
}

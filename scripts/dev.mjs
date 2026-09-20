import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { startBackend } from './backend-process.mjs'

const built = spawnSync(process.execPath, ['scripts/build-backend.mjs'], { stdio: 'inherit', windowsHide: true })
if (built.status !== 0) process.exit(built.status || 1)
const backend = startBackend(resolve(`.cache/ImageAtelier${process.platform === 'win32' ? '.exe' : ''}`), ['-listen', '127.0.0.1:0', '-api-only', '-data', process.env.IMAGE_ATELIER_DATA_DIR || resolve('data')])
let frontend
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  frontend?.kill()
  backend.child.stdin.end()
  const timer = setTimeout(() => { backend.child.kill(); process.exit(code) }, 6000)
  timer.unref()
  process.exitCode = code
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
backend.child.once('exit', (code) => stop(code || 0))
try {
  const url = await backend.ready
  console.log(`Go 后端：${url}`)
  frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, IMAGE_ATELIER_BACKEND_URL: url },
  })
  frontend.once('error', (error) => { console.error(error); stop(1) })
  frontend.once('exit', (code) => stop(code || 0))
} catch (error) { console.error(error); stop(1) }

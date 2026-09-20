import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// UI tests must never read or overwrite a developer's real data directory.
const directory = await mkdtemp(join(tmpdir(), 'image-atelier-ui-'))
const child = spawn(process.execPath, ['scripts/dev.mjs', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env, IMAGE_ATELIER_DATA_DIR: directory },
})
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.once('exit', async (code) => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  process.exitCode = code || 0
})

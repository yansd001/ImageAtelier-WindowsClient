import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const release = process.argv.includes('--release')
const directory = release ? 'release/ImageAtelier' : '.cache'
const windows = release || process.platform === 'win32'
mkdirSync(directory, { recursive: true })
const env = { ...process.env, CGO_ENABLED: '0', ...(release ? { GOOS: 'windows', GOARCH: 'amd64' } : {}) }
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', `${directory}/ImageAtelier${windows ? '.exe' : ''}`, './backend'], { stdio: 'inherit', env, windowsHide: true })
if (result.error) console.error('Go 构建失败，请安装 Go 1.23 或更新版本。', result.error.message)
process.exit(result.status ?? 1)

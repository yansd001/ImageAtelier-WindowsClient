import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/test-server.mjs', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 120_000 },
})

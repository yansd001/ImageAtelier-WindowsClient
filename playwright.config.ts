import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
})

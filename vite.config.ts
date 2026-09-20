import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'release/ImageAtelier/frontend', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: process.env.IMAGE_ATELIER_BACKEND_URL || 'http://127.0.0.1:47831', changeOrigin: false, timeout: 0, proxyTimeout: 0 },
    },
  },
})

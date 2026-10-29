import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.CRABOT_ADMIN_WEB_PORT || '13000'}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://127.0.0.1:${process.env.CRABOT_ADMIN_WEB_PORT || '13000'}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: { input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), desktop: fileURLToPath(new URL('./desktop.html', import.meta.url)) } },
  },
})

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/live/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['www.bawerlacher.com'],
    hmr: {
        protocol: 'wss',
        host: 'www.bawerlacher.com',
        path: '/live/',
    }
  },
  optimizeDeps: {
    include: [
      'pixi-live2d-display/cubism4',
      '@pixi/utils',
      'url',
    ]
  }
})

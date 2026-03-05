import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/live/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['www.bawerlacher.com'],
    proxy: {
      '/live/ws': {
        target: 'ws://127.0.0.1:5174',
        ws: true,
        changeOrigin: true,
      },
    },
    hmr: {
        protocol: 'wss',
        host: 'www.bawerlacher.com',
        clientPort: 443,
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

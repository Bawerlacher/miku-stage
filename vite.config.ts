/**
 * Vite configuration for serving and bundling the Live2D stage frontend.
 */
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { stageOrchestratorPlugin } from './vite-plugin-stage-orchestrator.js'

export default defineConfig({
  plugins: [vue(), stageOrchestratorPlugin()],
  base: '/live/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['www.bawerlacher.com'],
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

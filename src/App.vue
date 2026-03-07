<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ensureCubismCore } from './runtime/cubism-core'
import { createLive2DStageRuntime } from './runtime/live2d-stage-runtime'
import { createStageBridgeClient } from './runtime/stage-bridge-client'
import type { RuntimeWindow } from './runtime/types'

const runtimeWindow = window as RuntimeWindow
const canvas = ref<HTMLCanvasElement | null>(null)
const stageHost = ref<HTMLDivElement | null>(null)
const status = ref('Loading Cubism runtime...')
const error = ref('')

const defaultModelUrl = `${import.meta.env.BASE_URL}live2d/miku.model3.json`
const clientName = 'miku-stage'

function resolveInitialModelUrl() {
  const searchParams = new URLSearchParams(window.location.search)

  return (
    searchParams.get('model') ||
    runtimeWindow.__mikuStageConfig__?.modelUrl ||
    defaultModelUrl
  )
}

function setError(message: string, detail?: unknown) {
  status.value = ''
  error.value = message
  console.error(message, detail)
}

function clearError() {
  error.value = ''
}

const stageRuntime = createLive2DStageRuntime({
  runtimeWindow,
  stageHost,
  canvas,
  initialModelUrl: resolveInitialModelUrl(),
})

async function loadModel(nextModelUrl = stageRuntime.getCurrentModelUrl()) {
  status.value = 'Loading Live2D model...'
  clearError()

  try {
    await stageRuntime.loadModel(nextModelUrl)
    status.value = bridgeClient.isConnected() ? 'Connected to OpenClaw' : ''
    console.info('Miku Stage loaded model', nextModelUrl)
  } catch (loadError) {
    setError(`Model loading failed for ${nextModelUrl}.`, loadError)
  }
}

const bridgeClient = createStageBridgeClient({
  runtimeWindow,
  baseUrl: import.meta.env.BASE_URL,
  clientName,
  onStatus: (nextStatus) => {
    status.value = nextStatus
  },
  onClearError: clearError,
  onLoadModel: async (modelUrl) => {
    await loadModel(modelUrl)
  },
  onModelMotion: (payload) => {
    stageRuntime.applyModelMotion(payload)
  },
  onModelFocus: (payload) => {
    stageRuntime.applyModelFocus(payload)
  },
  getModelState: () => ({
    loaded: stageRuntime.hasModel(),
    modelUrl: stageRuntime.getCurrentModelUrl(),
  }),
})

onMounted(async () => {
  try {
    await ensureCubismCore({
      runtimeWindow,
      baseUrl: import.meta.env.BASE_URL,
    })
    stageRuntime.init()
    await loadModel()
    bridgeClient.connect()

    if (!error.value) {
      status.value = 'Ready'
    }
  } catch (bootError) {
    setError('Stage boot failed.', bootError)
  }
})

onUnmounted(() => {
  bridgeClient.destroy()
  stageRuntime.destroy()
})
</script>

<template>
  <div ref="stageHost" class="miku-container">
    <canvas ref="canvas"></canvas>
    <div v-if="status || error" class="stage-overlay" :class="{ 'stage-overlay--error': !!error }">
      <p>{{ error || status }}</p>
    </div>
  </div>
</template>

<style scoped>
.miku-container {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  position: relative;
  background: #fff;
  display: flex;
  justify-content: center;
  align-items: center;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.stage-overlay {
  position: absolute;
  inset: auto 1rem 1rem 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid rgba(201, 215, 255, 0.14);
  border-radius: 0.75rem;
  background: rgba(9, 12, 18, 0.78);
  color: #dfe7ff;
  font:
    500 0.95rem/1.4 'Segoe UI',
    sans-serif;
}

.stage-overlay--error {
  border-color: rgba(255, 120, 120, 0.28);
  color: #ffd8d8;
}

.stage-overlay p {
  margin: 0;
}
</style>

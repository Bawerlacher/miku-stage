<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import * as PIXI from 'pixi.js'

type Live2DModule = typeof import('pixi-live2d-display/cubism4')
type Live2DModelInstance = Awaited<ReturnType<Live2DModule['Live2DModel']['from']>>

type RuntimeWindow = Window &
  typeof globalThis & {
    Live2DCubismCore?: unknown
    PIXI?: typeof PIXI
    __mikuCubismPromise?: Promise<void>
  }

const runtimeWindow = window as RuntimeWindow
const canvas = ref<HTMLCanvasElement | null>(null)
const stageHost = ref<HTMLDivElement | null>(null)
const status = ref('Loading Cubism runtime...')
const error = ref('')

const modelUrl =
  'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json'
const cubismCoreSources = [
  `${import.meta.env.BASE_URL}libs/live2dcubismcore.min.js`,
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  'https://cubism.live2d.com/sdk-res/js/cubismcore/live2dcubismcore.min.js',
]

let live2dModule: Live2DModule | null = null
let app: PIXI.Application | null = null
let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let currentModel: Live2DModelInstance | null = null

runtimeWindow.PIXI = PIXI

function setError(message: string, detail?: unknown) {
  status.value = ''
  error.value = message
  console.error(message, detail)
}

async function ensureCubismCore() {
  if (runtimeWindow.Live2DCubismCore) {
    return
  }

  if (!runtimeWindow.__mikuCubismPromise) {
    runtimeWindow.__mikuCubismPromise = (async () => {
      const failures: string[] = []

      for (const source of cubismCoreSources) {
        try {
          await loadCubismScript(source)
          if (runtimeWindow.Live2DCubismCore) {
            return
          }
          failures.push(`${source} loaded but did not expose Live2DCubismCore`)
        } catch (loadError) {
          const reason = loadError instanceof Error ? loadError.message : 'unknown error'
          failures.push(`${source} failed (${reason})`)
        }
      }

      throw new Error(`Unable to load Cubism runtime. ${failures.join('; ')}`)
    })()
  }

  try {
    await runtimeWindow.__mikuCubismPromise
  } catch (loadError) {
    runtimeWindow.__mikuCubismPromise = undefined
    throw loadError
  }
}

function loadCubismScript(source: string) {
  return new Promise<void>((resolve, reject) => {
    const selector = `script[data-miku-cubism-core-src="${source}"]`
    const existing = document.querySelector<HTMLScriptElement>(selector)

    const handleLoad = () => {
      if (runtimeWindow.Live2DCubismCore) {
        resolve()
        return
      }

      reject(new Error('Live2DCubismCore is unavailable after script load'))
    }

    const handleError = () => {
      reject(new Error(`Unable to load script from ${source}`))
    }

    if (existing) {
      if (existing.dataset.loaded === 'true' && runtimeWindow.Live2DCubismCore) {
        resolve()
        return
      }

      existing.addEventListener('load', handleLoad, { once: true })
      existing.addEventListener('error', handleError, { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = source
    script.async = true
    script.crossOrigin = 'anonymous'
    script.dataset.mikuCubismCoreSrc = source
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true'
        handleLoad()
      },
      { once: true },
    )
    script.addEventListener('error', handleError, { once: true })
    document.head.appendChild(script)
  })
}

async function getLive2DModule() {
  if (!live2dModule) {
    live2dModule = await import('pixi-live2d-display/cubism4')
  }

  return live2dModule
}

function layoutModel(model: Live2DModelInstance) {
  const width = stageHost.value?.clientWidth || window.innerWidth
  const height = stageHost.value?.clientHeight || window.innerHeight
  const scale = Math.min(width / model.width, height / model.height) * 0.8

  model.scale.set(scale)
  model.anchor.set(0.5, 0.5)
  model.position.set(width / 2, height / 2)
}

function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (currentModel) {
      connectToBridge(currentModel)
    }
  }, 5000)
}

function connectToBridge(model: Live2DModelInstance) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/live/ws`

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  console.log(`[MIKU-STAGE] Connecting to Bridge: ${wsUrl}`)
  socket = new WebSocket(wsUrl)

  socket.onopen = () => {
    status.value = ''
    console.log('[MIKU-STAGE] Connected to Central Station!')
  }

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)
      console.log('[MIKU-STAGE] Signal received:', message)

      if (message.type === 'agent_action' || message.type === 'MIKU_TALK') {
        const payload = message.payload
        if (payload?.motion) {
          model.motion(payload.motion)
        }
      }
    } catch (parseError) {
      console.error('[MIKU-STAGE] Failed to parse bridge message:', parseError)
    }
  }

  socket.onerror = (socketError) => {
    console.warn('[MIKU-STAGE] Bridge socket error', socketError)
  }

  socket.onclose = () => {
    socket = null
    status.value = 'Bridge disconnected. Retrying...'
    scheduleReconnect()
  }
}

async function initApp() {
  if (!canvas.value || !stageHost.value) {
    return
  }

  try {
    if (!app) {
      app = new PIXI.Application({
        view: canvas.value,
        autoStart: true,
        resizeTo: stageHost.value,
        backgroundAlpha: 1,
        backgroundColor: 0x222222,
      })
    }

    status.value = 'Loading Live2D model...'
    error.value = ''

    const { Live2DModel } = await getLive2DModule()
    const model = await Live2DModel.from(modelUrl)
    app.stage.addChild(model)
    layoutModel(model)

    currentModel = model
    ;(window as any).miku = model
    connectToBridge(model)

    window.addEventListener('resize', handleResize)

    status.value = ''
    console.info('Miku Stage is ready and connected to Bridge!')
  } catch (bootError) {
    setError('Model loading failed.', bootError)
  }
}

function handleResize() {
  if (currentModel) {
    layoutModel(currentModel)
  }
}

onMounted(async () => {
  try {
    await ensureCubismCore()
    await initApp()
  } catch (bootError) {
    setError('Stage boot failed.', bootError)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)

  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (socket) {
    socket.close()
    socket = null
  }

  if (app) {
    app.destroy(true)
    app = null
  }

  currentModel = null
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
  background: #222;
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

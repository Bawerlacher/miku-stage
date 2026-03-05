<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import * as PIXI from 'pixi.js'
import {
  STAGE_BRIDGE_PROTOCOL_VERSION,
  type StageBridgeEnvelope,
  type StageCommand,
  normalizeIncomingStageMessage,
} from './protocol/stage-bridge'

type Live2DModule = typeof import('pixi-live2d-display/cubism4')
type Live2DModelInstance = Awaited<ReturnType<Live2DModule['Live2DModel']['from']>>

type StageConfig = {
  bridgeUrl?: string
  modelUrl?: string
}

type RuntimeWindow = Window &
  typeof globalThis & {
    Live2DCubismCore?: unknown
    PIXI?: typeof PIXI
    __mikuCubismPromise?: Promise<void>
    __mikuStageConfig__?: StageConfig
  }

const runtimeWindow = window as RuntimeWindow
const canvas = ref<HTMLCanvasElement | null>(null)
const stageHost = ref<HTMLDivElement | null>(null)
const status = ref('Loading Cubism runtime...')
const error = ref('')

const cubismCoreSources = [
  `${import.meta.env.BASE_URL}libs/live2dcubismcore.min.js`,
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  'https://cubism.live2d.com/sdk-res/js/cubismcore/live2dcubismcore.min.js',
]
const defaultModelUrl =
  'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json'
const clientName = 'miku-stage'
const reconnectBaseDelayMs = 1_000
const reconnectMaxDelayMs = 15_000

let live2dModule: Live2DModule | null = null
let app: PIXI.Application | null = null
let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let reconnectAttempt = 0
let isUnmounting = false
let bridgeSessionId: string | null = null
let currentModel: Live2DModelInstance | null = null
let currentModelUrl = resolveInitialModelUrl()

runtimeWindow.PIXI = PIXI

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

async function loadModel(nextModelUrl = currentModelUrl) {
  if (!app) {
    return
  }

  status.value = 'Loading Live2D model...'
  clearError()

  try {
    const { Live2DModel } = await getLive2DModule()
    const nextModel = await Live2DModel.from(nextModelUrl)

    if (currentModel) {
      app.stage.removeChild(currentModel)
      currentModel.destroy()
    }

    currentModel = nextModel
    currentModelUrl = nextModelUrl

    app.stage.addChild(nextModel)
    layoutModel(nextModel)
    ;(window as any).miku = nextModel

    status.value = socket ? 'Connected to OpenClaw' : ''
    console.info('Miku Stage loaded model', nextModelUrl)
  } catch (loadError) {
    setError(`Model loading failed for ${nextModelUrl}.`, loadError)
  }
}

function resolveBridgeUrl() {
  const searchParams = new URLSearchParams(window.location.search)
  const configuredBridgeUrl =
    searchParams.get('bridge') ||
    searchParams.get('ws') ||
    runtimeWindow.__mikuStageConfig__?.bridgeUrl
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const defaultBaseUrl = `${wsProtocol}//${window.location.host}${import.meta.env.BASE_URL}`
  const resolved = new URL(configuredBridgeUrl || 'ws', defaultBaseUrl)

  if (resolved.protocol === 'http:') {
    resolved.protocol = 'ws:'
  } else if (resolved.protocol === 'https:') {
    resolved.protocol = 'wss:'
  }

  return resolved.toString()
}

function sendBridgeMessage(message: StageBridgeEnvelope) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false
  }

  socket.send(JSON.stringify(message))
  return true
}

function payloadAsObject(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  return payload as Record<string, unknown>
}

function applyModelFocus(payload: unknown) {
  if (!currentModel) {
    return
  }

  const focus = payloadAsObject(payload)
  const nextScale = typeof focus.scale === 'number' ? focus.scale : null
  const nextX = typeof focus.x === 'number' ? focus.x : null
  const nextY = typeof focus.y === 'number' ? focus.y : null

  if (nextScale !== null) {
    currentModel.scale.set(nextScale)
  }

  if (nextX !== null && nextY !== null) {
    currentModel.position.set(nextX, nextY)
  }
}

function applyModelMotion(payload: unknown) {
  if (!currentModel) {
    return
  }

  const motionPayload = payloadAsObject(payload)
  const motion = typeof motionPayload.motion === 'string' ? motionPayload.motion.trim() : ''

  if (!motion) {
    return
  }

  currentModel.motion(motion)
}

function dispatchStageCommand(command: StageCommand) {
  switch (command.name) {
    case 'load_model': {
      const nextModelUrl =
        typeof command.payload.modelUrl === 'string' ? command.payload.modelUrl.trim() : ''
      if (nextModelUrl) {
        void loadModel(nextModelUrl)
      }
      break
    }
    case 'model_motion':
      applyModelMotion(command.payload)
      break
    case 'model_focus':
      applyModelFocus(command.payload)
      break
  }
}

function handleBridgeMessage(rawMessage: unknown) {
  const message = normalizeIncomingStageMessage(rawMessage)
  if (!message) {
    console.debug('[MIKU-STAGE] Ignoring malformed bridge message', rawMessage)
    return
  }

  switch (message.kind) {
    case 'session_init': {
      const payload = message.payload
      const payloadSessionId =
        typeof payload.sessionId === 'string' && payload.sessionId.trim() ? payload.sessionId : null

      bridgeSessionId = message.sessionId ?? payloadSessionId ?? bridgeSessionId
      status.value = ''

      const nextModelUrl =
        typeof payload.modelUrl === 'string' && payload.modelUrl.trim()
          ? payload.modelUrl.trim()
          : ''
      if (nextModelUrl && nextModelUrl !== currentModelUrl) {
        void loadModel(nextModelUrl)
      }
      break
    }
    case 'stage_command':
      dispatchStageCommand(message.command)
      break
    case 'ping':
      sendBridgeMessage({
        v: STAGE_BRIDGE_PROTOCOL_VERSION,
        type: 'pong',
        sessionId: bridgeSessionId ?? undefined,
        payload: payloadAsObject(message.payload),
      })
      break
    case 'assistant_text':
      break
    case 'unsupported':
      console.debug('[MIKU-STAGE] Ignoring unsupported bridge message', {
        sourceType: message.sourceType,
        reason: message.reason,
      })
      break
  }
}

function scheduleReconnect() {
  if (isUnmounting || reconnectTimer !== null) {
    return
  }

  const delayMs = Math.min(
    reconnectMaxDelayMs,
    reconnectBaseDelayMs * 2 ** Math.max(0, reconnectAttempt),
  )

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connectToBridge()
  }, delayMs)

  status.value = `Connection lost. Retrying in ${Math.ceil(delayMs / 1000)}s...`
  reconnectAttempt += 1
}

function connectToBridge() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  const wsUrl = resolveBridgeUrl()
  status.value = `Connecting to OpenClaw: ${wsUrl}`

  console.log(`[MIKU-STAGE] Connecting to Bridge: ${wsUrl}`)

  const nextSocket = new WebSocket(wsUrl)
  socket = nextSocket

  nextSocket.onopen = () => {
    reconnectAttempt = 0
    clearError()
    status.value = 'Connected. Waiting for session...'

    sendBridgeMessage({
      v: STAGE_BRIDGE_PROTOCOL_VERSION,
      type: 'session_ready',
      sessionId: bridgeSessionId ?? undefined,
      payload: {
        client: clientName,
        pageUrl: window.location.href,
        modelLoaded: Boolean(currentModel),
        modelUrl: currentModelUrl,
      },
    })
  }

  nextSocket.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as unknown
      console.log('[MIKU-STAGE] Signal received:', message)
      handleBridgeMessage(message)
    } catch (parseError) {
      console.error('[MIKU-STAGE] Failed to parse bridge message:', parseError)
    }
  }

  nextSocket.onerror = (socketError) => {
    console.warn('[MIKU-STAGE] Bridge socket error', socketError)
  }

  nextSocket.onclose = () => {
    if (socket === nextSocket) {
      socket = null
    }

    bridgeSessionId = null

    if (isUnmounting) {
      return
    }

    scheduleReconnect()
  }
}

async function initApp() {
  if (!canvas.value || !stageHost.value) {
    return
  }

  if (!app) {
    app = new PIXI.Application({
      view: canvas.value,
      autoStart: true,
      resizeTo: stageHost.value,
      backgroundAlpha: 1,
      backgroundColor: 0x222222,
    })
  }

  await loadModel()
  connectToBridge()

  window.addEventListener('resize', handleResize)

  if (!error.value) {
    status.value = 'Ready'
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
  isUnmounting = true
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

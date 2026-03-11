<script setup lang="ts">
// App shell that wires stage runtime, bridge transport, and chat UI rendering.
import { onMounted, onUnmounted, ref } from 'vue'
import { ensureCubismCore } from './runtime/cubism-core'
import { useStageChat } from './runtime/stage-chat-ui'
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

/**
 * Resolves the initial model URL from query params, runtime config, or default.
 * @returns Model URL that should be loaded at startup.
 */
function resolveInitialModelUrl() {
  const searchParams = new URLSearchParams(window.location.search)

  return (
    searchParams.get('model') ||
    runtimeWindow.__mikuStageConfig__?.modelUrl ||
    defaultModelUrl
  )
}

/**
 * Sets user-visible error state and logs the detailed cause.
 * @param message Display message shown in the overlay.
 * @param detail Optional error object for diagnostics.
 * @returns Nothing.
 */
function setError(message: string, detail?: unknown) {
  status.value = ''
  error.value = message
  console.error(message, detail)
}

/**
 * Clears the current overlay error message.
 * @returns Nothing.
 */
function clearError() {
  error.value = ''
}

// Counts submitted turns that haven't received assistant_text_done yet.
// Thinking stops only when all in-flight turns have responded, so a stale
// done from an older run (when interrupt isn't honoured) doesn't kill the
// loop for a newer turn. Works for both delta-streaming and done-only paths.
let pendingThinkingTurns = 0

// Safety timeout: if the backend never responds (dead/hung), stop the
// thinking loop so Miku doesn't get stuck thinking forever.
const THINKING_TIMEOUT_MS = 60_000
let thinkingTimeoutId: ReturnType<typeof setTimeout> | null = null

function startThinkingTimeout() {
  if (thinkingTimeoutId !== null) {
    clearTimeout(thinkingTimeoutId)
  }
  thinkingTimeoutId = setTimeout(() => {
    thinkingTimeoutId = null
    pendingThinkingTurns = 0
    stageRuntime.stopThinkingMotion()
  }, THINKING_TIMEOUT_MS)
}

function clearThinkingTimeout() {
  if (thinkingTimeoutId !== null) {
    clearTimeout(thinkingTimeoutId)
    thinkingTimeoutId = null
  }
}

// Keep chat state/stream assembly isolated from stage boot/runtime concerns.
const {
  chatInput,
  chatMessages,
  setSessionId: setChatSessionId,
  bindChatLog,
  appendAssistantDelta,
  finalizeAssistantMessage,
  interruptAssistantMessage,
  submitUserText,
} = useStageChat()

const stageRuntime = createLive2DStageRuntime({
  runtimeWindow,
  stageHost,
  canvas,
  initialModelUrl: resolveInitialModelUrl(),
})

/**
 * Loads or reloads the current model and updates status text.
 * @param nextModelUrl Model URL to load; defaults to runtime current model URL.
 * @returns Promise resolved after model load path completes.
 */
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

/**
 * Sends current chat input to the bridge through the chat composable.
 * @returns Nothing.
 */
function handleChatSubmit() {
  submitUserText((text) => {
    const sent = bridgeClient.sendUserText(text)
    if (sent) {
      pendingThinkingTurns++
      stageRuntime.startThinkingMotion()
      startThinkingTimeout()
    }
    return sent
  })
}

/**
 * Starts a brand-new chat/session context and reconnects bridge routing.
 * @returns Nothing.
 */
function handleStartNewSession() {
  pendingThinkingTurns = 0
  clearThinkingTimeout()
  stageRuntime.stopThinkingMotion()
  const nextSessionId = bridgeClient.startNewSession()
  clearError()
  status.value = `Started new session: ${nextSessionId}`
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
  onAssistantTextDelta: (payload) => {
    appendAssistantDelta(payload)
  },
  onAssistantTextDone: (payload) => {
    if (pendingThinkingTurns > 0) {
      pendingThinkingTurns--
    }
    if (pendingThinkingTurns === 0) {
      clearThinkingTimeout()
      stageRuntime.stopThinkingMotion()
    }
    finalizeAssistantMessage(payload)
  },
  onInterrupt: (payload) => {
    // 'new_user_text' is a self-interrupt sent by the client before each user
    // turn to cancel any in-flight run. The server echoes it back, but it
    // should not stop the thinking motion we just started.
    if (payload.reason !== 'new_user_text') {
      pendingThinkingTurns = 0
      clearThinkingTimeout()
      stageRuntime.stopThinkingMotion()
    }
    interruptAssistantMessage({ runId: payload.runId })
  },
  onAck: (payload) => {
    console.debug('[MIKU-STAGE] Bridge ack', payload)
  },
  onError: (payload) => {
    pendingThinkingTurns = 0
    clearThinkingTimeout()
    stageRuntime.stopThinkingMotion()
    const suffix = payload.code ? ` (${payload.code})` : ''
    setError(`Bridge error${suffix}: ${payload.message}`, payload.detail)
  },
  onSessionId: (sessionId) => {
    setChatSessionId(sessionId)
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
  clearThinkingTimeout()
  bridgeClient.destroy()
  stageRuntime.destroy()
})
</script>

<template>
  <div ref="stageHost" class="miku-container">
    <canvas ref="canvas"></canvas>
    <section class="stage-chat">
      <div :ref="bindChatLog" class="stage-chat__messages">
        <p v-if="chatMessages.length === 0" class="stage-chat__placeholder">
          Chat with the stage to trigger motions and responses.
        </p>
        <article
          v-for="message in chatMessages"
          :key="message.id"
          class="stage-chat__message"
          :class="`stage-chat__message--${message.role}`"
        >
          <p class="stage-chat__text">
            {{ message.text }}
            <span v-if="message.streaming" class="stage-chat__typing">...</span>
          </p>
        </article>
      </div>
      <form class="stage-chat__composer" @submit.prevent="handleChatSubmit">
        <input
          v-model="chatInput"
          class="stage-chat__input"
          type="text"
          name="chat"
          autocomplete="off"
          placeholder="Type a message"
        />
        <button class="stage-chat__send" type="submit" :disabled="!chatInput.trim()">
          Send
        </button>
        <button class="stage-chat__new-session" type="button" @click="handleStartNewSession">
          New Session
        </button>
      </form>
    </section>
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

.stage-chat {
  position: absolute;
  right: 1rem;
  bottom: 4.5rem;
  width: min(26rem, calc(100vw - 2rem));
  max-height: min(46vh, 30rem);
  border: 1px solid rgba(148, 167, 196, 0.24);
  border-radius: 1rem;
  background: rgba(10, 14, 24, 0.74);
  backdrop-filter: blur(5px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.stage-chat__messages {
  flex: 1;
  overflow-y: auto;
  padding: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.stage-chat__placeholder {
  margin: 0;
  color: #c8d4f3;
  font:
    500 0.82rem/1.4 'Segoe UI',
    sans-serif;
}

.stage-chat__message {
  max-width: 90%;
  padding: 0.55rem 0.65rem;
  border-radius: 0.75rem;
}

.stage-chat__message--user {
  align-self: flex-end;
  background: rgba(70, 117, 240, 0.28);
}

.stage-chat__message--assistant {
  align-self: flex-start;
  background: rgba(208, 222, 255, 0.16);
}

.stage-chat__message--system {
  align-self: center;
  background: rgba(255, 176, 72, 0.2);
}

.stage-chat__text {
  margin: 0;
  color: #ecf2ff;
  white-space: pre-wrap;
  word-break: break-word;
  font:
    500 0.86rem/1.38 'Segoe UI',
    sans-serif;
}

.stage-chat__typing {
  margin-left: 0.2rem;
  letter-spacing: 0.08em;
  opacity: 0.8;
}

.stage-chat__composer {
  display: flex;
  gap: 0.55rem;
  padding: 0.75rem;
  border-top: 1px solid rgba(194, 211, 247, 0.18);
}

.stage-chat__input {
  flex: 1;
  border: 1px solid rgba(180, 199, 235, 0.3);
  border-radius: 0.65rem;
  background: rgba(8, 11, 19, 0.62);
  color: #f4f8ff;
  padding: 0.55rem 0.65rem;
  font:
    500 0.87rem/1.2 'Segoe UI',
    sans-serif;
}

.stage-chat__input::placeholder {
  color: rgba(209, 220, 247, 0.72);
}

.stage-chat__input:focus {
  outline: none;
  border-color: rgba(123, 165, 255, 0.75);
}

.stage-chat__send {
  border: 0;
  border-radius: 0.65rem;
  background: linear-gradient(180deg, #6c9dff, #4d78d8);
  color: #fff;
  font:
    600 0.85rem/1.1 'Segoe UI',
    sans-serif;
  padding: 0.55rem 0.9rem;
  cursor: pointer;
}

.stage-chat__send:disabled {
  cursor: default;
  opacity: 0.55;
}

.stage-chat__new-session {
  border: 1px solid rgba(180, 199, 235, 0.35);
  border-radius: 0.65rem;
  background: rgba(18, 24, 38, 0.9);
  color: #e8efff;
  font:
    600 0.78rem/1.1 'Segoe UI',
    sans-serif;
  padding: 0.55rem 0.7rem;
  cursor: pointer;
  white-space: nowrap;
}

.stage-chat__new-session:hover {
  border-color: rgba(123, 165, 255, 0.7);
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

@media (max-width: 768px) {
  .stage-chat {
    right: 0.65rem;
    bottom: 4.65rem;
    width: calc(100vw - 1.3rem);
    max-height: 44vh;
  }
}
</style>

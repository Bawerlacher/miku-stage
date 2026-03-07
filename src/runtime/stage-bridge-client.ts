import {
  STAGE_BRIDGE_PROTOCOL_VERSION,
  type StageBridgeEnvelope,
  type StageCommand,
  normalizeIncomingStageMessage,
} from '../protocol/stage-bridge'
import type { RuntimeWindow } from './types'

const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000

export type StageBridgeClient = {
  connect: () => void
  destroy: () => void
  isConnected: () => boolean
}

export function createStageBridgeClient(input: {
  runtimeWindow: RuntimeWindow
  baseUrl: string
  clientName: string
  onStatus: (status: string) => void
  onClearError: () => void
  onLoadModel: (modelUrl: string) => Promise<void> | void
  onModelMotion: (payload: unknown) => void
  onModelFocus: (payload: unknown) => void
  getModelState: () => {
    loaded: boolean
    modelUrl: string
  }
}): StageBridgeClient {
  const {
    runtimeWindow,
    baseUrl,
    clientName,
    onStatus,
    onClearError,
    onLoadModel,
    onModelMotion,
    onModelFocus,
    getModelState,
  } = input

  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0
  let isDestroyed = false
  let bridgeSessionId: string | null = null

  function resolveBridgeUrl() {
    const searchParams = new URLSearchParams(window.location.search)
    const configuredBridgeUrl =
      searchParams.get('bridge') ||
      searchParams.get('ws') ||
      runtimeWindow.__mikuStageConfig__?.bridgeUrl
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const defaultBaseUrl = `${wsProtocol}//${window.location.host}${baseUrl}`
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

  function dispatchStageCommand(command: StageCommand) {
    switch (command.name) {
      case 'load_model': {
        const nextModelUrl =
          typeof command.payload.modelUrl === 'string'
            ? command.payload.modelUrl.trim()
            : ''
        if (nextModelUrl) {
          void onLoadModel(nextModelUrl)
        }
        break
      }
      case 'model_motion':
        onModelMotion(command.payload)
        break
      case 'model_focus':
        onModelFocus(command.payload)
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
          typeof payload.sessionId === 'string' && payload.sessionId.trim()
            ? payload.sessionId
            : null

        bridgeSessionId = message.sessionId ?? payloadSessionId ?? bridgeSessionId
        onStatus('')

        const nextModelUrl =
          typeof payload.modelUrl === 'string' && payload.modelUrl.trim()
            ? payload.modelUrl.trim()
            : ''
        if (nextModelUrl && nextModelUrl !== getModelState().modelUrl) {
          void onLoadModel(nextModelUrl)
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
    if (isDestroyed || reconnectTimer !== null) {
      return
    }

    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempt),
    )

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delayMs)

    onStatus(`Connection lost. Retrying in ${Math.ceil(delayMs / 1000)}s...`)
    reconnectAttempt += 1
  }

  function connect() {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    const wsUrl = resolveBridgeUrl()
    onStatus(`Connecting to OpenClaw: ${wsUrl}`)

    console.log(`[MIKU-STAGE] Connecting to Bridge: ${wsUrl}`)

    const nextSocket = new WebSocket(wsUrl)
    socket = nextSocket

    nextSocket.onopen = () => {
      reconnectAttempt = 0
      onClearError()
      onStatus('Connected. Waiting for session...')

      const modelState = getModelState()
      sendBridgeMessage({
        v: STAGE_BRIDGE_PROTOCOL_VERSION,
        type: 'session_ready',
        sessionId: bridgeSessionId ?? undefined,
        payload: {
          client: clientName,
          pageUrl: window.location.href,
          modelLoaded: modelState.loaded,
          modelUrl: modelState.modelUrl,
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

      if (isDestroyed) {
        return
      }

      scheduleReconnect()
    }
  }

  function destroy() {
    isDestroyed = true

    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (socket) {
      socket.close()
      socket = null
    }

    bridgeSessionId = null
  }

  function isConnected() {
    return Boolean(socket && socket.readyState === WebSocket.OPEN)
  }

  return {
    connect,
    destroy,
    isConnected,
  }
}

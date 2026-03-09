/**
 * Websocket client that synchronizes OpenClaw bridge events with stage runtime callbacks.
 */
import {
  STAGE_BRIDGE_PROTOCOL_VERSION,
  type StageBridgeEnvelope,
  type StageCommand,
  normalizeIncomingStageMessage,
} from '../protocol/stage-bridge'
import type { RuntimeWindow } from './types'

const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000
const STAGE_SESSION_STORAGE_KEY = 'miku-stage.sessionId'

export type StageBridgeClient = {
  connect: () => void
  destroy: () => void
  isConnected: () => boolean
  getSessionId: () => string
  startNewSession: () => string
  sendUserText: (text: string) => boolean
}

/**
 * Creates a websocket client that syncs stage runtime state with OpenClaw bridge messages.
 * @param input Runtime adapters, callbacks, and config required by the bridge client.
 * @returns Client controls for connection lifecycle and user text dispatch.
 */
export function createStageBridgeClient(input: {
  runtimeWindow: RuntimeWindow
  baseUrl: string
  clientName: string
  onStatus: (status: string) => void
  onClearError: () => void
  onLoadModel: (modelUrl: string) => Promise<void> | void
  onModelMotion: (payload: unknown) => void
  onModelFocus: (payload: unknown) => void
  onAssistantTextDelta?: (payload: { text: string; runId?: string }) => void
  onAssistantTextDone?: (payload: { text: string; runId?: string }) => void
  onSessionId?: (sessionId: string) => void
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
    onAssistantTextDelta,
    onAssistantTextDone,
    onSessionId,
    getModelState,
  } = input

  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0
  let isDestroyed = false
  const reconnectSuppressedSockets = new WeakSet<WebSocket>()
  let bridgeSessionId = resolveInitialBridgeSessionId()
  onSessionId?.(bridgeSessionId)

  /**
   * Resolves the websocket endpoint from URL params, runtime config, or same-origin default.
   * @returns Absolute websocket URL string.
   */
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

    // Keep a stable session identifier attached to each websocket handshake.
    const sessionIdFromBridgeUrl = readSessionIdFromParams(resolved.searchParams)
    if (sessionIdFromBridgeUrl) {
      if (sessionIdFromBridgeUrl !== bridgeSessionId) {
        bridgeSessionId = sessionIdFromBridgeUrl
        persistSessionId(bridgeSessionId)
        onSessionId?.(bridgeSessionId)
      }
    } else {
      resolved.searchParams.set('stageSessionId', bridgeSessionId)
    }

    return resolved.toString()
  }

  /**
   * Resolves initial session identity from URL, persisted storage, or generated fallback.
   * @returns Stable stage session identifier for this browser profile.
   */
  function resolveInitialBridgeSessionId() {
    const fromPageQuery = readSessionIdFromParams(new URLSearchParams(window.location.search))
    if (fromPageQuery) {
      persistSessionId(fromPageQuery)
      return fromPageQuery
    }

    const fromStorage = readStoredSessionId()
    if (fromStorage) {
      return fromStorage
    }

    const generated = generateSessionId()
    persistSessionId(generated)
    return generated
  }

  /**
   * Reads session ID from URL-like query params.
   * @param params Query-string params object.
   * @returns Trimmed session ID when present.
   */
  function readSessionIdFromParams(params: URLSearchParams) {
    return normalizeSessionId(
      params.get('stageSessionId') ?? params.get('sessionId'),
    )
  }

  /**
   * Reads persisted session ID from browser localStorage.
   * @returns Stored session ID or null when unavailable.
   */
  function readStoredSessionId() {
    try {
      return normalizeSessionId(window.localStorage.getItem(STAGE_SESSION_STORAGE_KEY))
    } catch {
      return null
    }
  }

  /**
   * Persists session ID to browser localStorage.
   * @param sessionId Session identifier to persist.
   * @returns Nothing.
   */
  function persistSessionId(sessionId: string) {
    try {
      window.localStorage.setItem(STAGE_SESSION_STORAGE_KEY, sessionId)
    } catch {
      // Ignore storage write failures in restrictive browser modes.
    }
  }

  /**
   * Generates a best-effort unique session ID.
   * @returns Random session identifier.
   */
  function generateSessionId() {
    if (typeof window.crypto?.randomUUID === 'function') {
      return window.crypto.randomUUID()
    }
    // Defensive fallback for older embedded webviews/test environments.
    return `stage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * Normalizes unknown session values into non-empty IDs.
   * @param value Unknown session candidate.
   * @returns Trimmed session ID or null when invalid.
   */
  function normalizeSessionId(value: unknown) {
    if (typeof value !== 'string') {
      return null
    }

    const trimmed = value.trim()
    return trimmed || null
  }

  /**
   * Sends a protocol envelope when the websocket is open.
   * @param message Outbound bridge envelope.
   * @returns True when message was sent, otherwise false.
   */
  function sendBridgeMessage(message: StageBridgeEnvelope) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false
    }

    socket.send(JSON.stringify(message))
    return true
  }

  /**
   * Normalizes unknown payload values to object shape for protocol replies.
   * @param payload Arbitrary payload from incoming message.
   * @returns Object payload safe for outgoing envelope usage.
   */
  function payloadAsObject(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return {}
    }

    return payload as Record<string, unknown>
  }

  /**
   * Routes a stage command to the matching runtime callback.
   * @param command Parsed stage command from the bridge.
   * @returns Nothing.
   */
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

  /**
   * Parses and handles a single incoming bridge message.
   * @param rawMessage Raw message payload before normalization.
   * @returns Nothing.
   */
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

        const resolvedSessionId = message.sessionId ?? payloadSessionId ?? bridgeSessionId
        if (resolvedSessionId !== bridgeSessionId) {
          bridgeSessionId = resolvedSessionId
          persistSessionId(bridgeSessionId)
          onSessionId?.(bridgeSessionId)
        }
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
          sessionId: bridgeSessionId,
          payload: payloadAsObject(message.payload),
        })
        break
      case 'assistant_text':
        if (message.phase === 'done') {
          onAssistantTextDone?.({ text: message.text, runId: message.runId })
        } else {
          onAssistantTextDelta?.({ text: message.text, runId: message.runId })
        }
        break
      case 'unsupported':
        console.debug('[MIKU-STAGE] Ignoring unsupported bridge message', {
          sourceType: message.sourceType,
          reason: message.reason,
        })
        break
    }
  }

  /**
   * Schedules reconnect with exponential backoff after unexpected disconnect.
   * @returns Nothing.
   */
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

  /**
   * Opens a websocket for the current session and binds lifecycle handlers.
   * @returns Nothing.
   */
  function openSocket() {
    const wsUrl = resolveBridgeUrl()
    onStatus(`Connecting to OpenClaw: ${wsUrl}`)

    console.log(`[MIKU-STAGE] Connecting to Bridge: ${wsUrl}`)

    const nextSocket = new WebSocket(wsUrl)
    socket = nextSocket

    nextSocket.onopen = () => {
      if (socket !== nextSocket || isDestroyed) {
        // Ignore stale sockets that were replaced before handshake completion.
        nextSocket.close(1000, 'stale_socket')
        return
      }

      reconnectAttempt = 0
      onClearError()
      onStatus('Connected. Waiting for session...')

      const modelState = getModelState()
      sendBridgeMessage({
        v: STAGE_BRIDGE_PROTOCOL_VERSION,
        type: 'session_ready',
        sessionId: bridgeSessionId,
        payload: {
          client: clientName,
          pageUrl: window.location.href,
          modelLoaded: modelState.loaded,
          modelUrl: modelState.modelUrl,
        },
      })
    }

    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) {
        return
      }

      try {
        const message = JSON.parse(String(event.data)) as unknown
        console.log('[MIKU-STAGE] Signal received:', message)
        handleBridgeMessage(message)
      } catch (parseError) {
        console.error('[MIKU-STAGE] Failed to parse bridge message:', parseError)
      }
    }

    nextSocket.onerror = (socketError) => {
      if (socket !== nextSocket) {
        return
      }
      console.warn('[MIKU-STAGE] Bridge socket error', socketError)
    }

    nextSocket.onclose = () => {
      if (socket === nextSocket) {
        socket = null
      } else {
        reconnectSuppressedSockets.delete(nextSocket)
        return
      }

      if (isDestroyed) {
        return
      }

      if (reconnectSuppressedSockets.has(nextSocket)) {
        reconnectSuppressedSockets.delete(nextSocket)
        return
      }

      scheduleReconnect()
    }
  }

  /**
   * Opens websocket connection and registers lifecycle handlers.
   * @returns Nothing.
   */
  function connect() {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    openSocket()
  }

  /**
   * Stops reconnect attempts and closes current websocket connection.
   * @returns Nothing.
   */
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
  }

  /**
   * Reports whether websocket transport is currently open.
   * @returns True if bridge socket is connected.
   */
  function isConnected() {
    return Boolean(socket && socket.readyState === WebSocket.OPEN)
  }

  /**
   * Returns the currently bound stage session identifier.
   * @returns Stage session identifier used for protocol messages.
   */
  function getSessionId() {
    return bridgeSessionId
  }

  /**
   * Rotates to a newly generated stage session and reconnects the bridge transport.
   * @returns Newly generated stage session identifier.
   */
  function startNewSession() {
    bridgeSessionId = generateSessionId()
    persistSessionId(bridgeSessionId)
    onSessionId?.(bridgeSessionId)

    reconnectAttempt = 0
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (socket) {
      reconnectSuppressedSockets.add(socket)
      socket.close(1000, 'new_session')
      socket = null
    }

    openSocket()
    return bridgeSessionId
  }

  /**
   * Sends user chat text through the bridge protocol.
   * @param text User-entered message content.
   * @returns True if dispatched to an open socket.
   */
  function sendUserText(text: string) {
    const trimmed = text.trim()
    if (!trimmed) {
      return false
    }

    return sendBridgeMessage({
      v: STAGE_BRIDGE_PROTOCOL_VERSION,
      type: 'user_text',
      sessionId: bridgeSessionId,
      payload: {
        text: trimmed,
      },
    })
  }

  return {
    connect,
    destroy,
    isConnected,
    getSessionId,
    startNewSession,
    sendUserText,
  }
}

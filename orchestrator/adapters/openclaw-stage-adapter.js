/**
 * OpenClaw backend adapter that forwards stage chat to OpenClaw gateway over websocket RPC.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { WebSocket } from 'ws'
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from './openclaw-device-identity.js'
import {
  buildOpenClawDeviceAuthPayloadV2,
  buildOpenClawDeviceAuthPayloadV3,
  createOpenClawConnectParams,
  createOpenClawRequestFrame,
  DEFAULT_OPENCLAW_CLIENT_ID,
  DEFAULT_OPENCLAW_CLIENT_MODE,
  DEFAULT_OPENCLAW_CLIENT_VERSION,
  DEFAULT_OPENCLAW_GATEWAY_WS_URL,
  DEFAULT_OPENCLAW_ROLE,
  DEFAULT_OPENCLAW_SCOPES,
  OPENCLAW_PROTOCOL_VERSION,
  isOpenClawEventFrame,
  isOpenClawResponseFrame,
  normalizeOpenClawGatewayUrl,
  parseOpenClawFrame,
  readOpenClawChatEvent,
  readOpenClawConnectChallengeNonce,
} from './openclaw-protocol.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RUN_IDLE_TIMEOUT_MS = 120_000
const DEFAULT_SESSION_KEY_PREFIX = 'stage'
const DEFAULT_STAGE_MODEL3_PATH = path.resolve(process.cwd(), 'public', 'live2d', 'miku.model3.json')
const DEFAULT_DEVICE_IDENTITY_PATH = path.join(homedir(), '.openclaw', 'identity', 'device.json')
const DEFAULT_DEVICE_AUTH_PAYLOAD_VERSION = 'v2'
const OPENCLAW_ADMIN_SCOPE = 'operator.admin'
const OPENCLAW_WRITE_SCOPE = 'operator.write'
const MOTION_DIRECTIVE_PREFIX = 'MOTION'
const NO_MOTION_LABEL = 'none'
const NO_MOTION_ALIASES = new Set(['none', 'no_motion', 'no-motion', 'nomotion', 'null'])

/**
 * Creates an OpenClaw adapter implementation for Stage Orchestrator.
 * @param {{ gatewayUrl?: string, protocolVersion?: number, authToken?: string, authDeviceToken?: string, authPassword?: string, deviceAuthEnabled?: boolean, deviceIdentityPath?: string, deviceAuthPayloadVersion?: 'v2' | 'v3', sessionKeyPrefix?: string, model3Path?: string, requestTimeoutMs?: number, runIdleTimeoutMs?: number, clientId?: string, clientDisplayName?: string, clientVersion?: string, clientPlatform?: string, clientMode?: string, role?: string, scopes?: string[] }} [input] Adapter configuration options.
 * @returns {{ name: string, onUserText: (input: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>, void, void>, destroy: () => void }} Adapter interface.
 */
export function createOpenClawStageAdapter(input = {}) {
  const config = resolveOpenClawAdapterConfig(input)
  const gateway = createOpenClawGatewayClient(config)
  const motionCatalog = loadSupportedMotionCatalog(config.model3Path)
  const promptedSessionKeys = new Set()

  return {
    name: 'openclaw',

    /**
     * Sends user text to OpenClaw and returns a final assistant event.
     * @param {{ text?: string, stageSessionId?: string, sessionKey?: string }} input Stage interaction payload.
     * @returns {AsyncGenerator<Record<string, unknown>, void, void>} Stream of adapter events.
     */
    async *onUserText(input) {
      const userText = readTrimmedString(input?.text)
      if (!userText) {
        return
      }

      const stageSessionId = resolveStageSessionId(input)
      const explicitSessionKey = readTrimmedString(input?.sessionKey)
      const sessionKey = explicitSessionKey
        ? explicitSessionKey
        : resolveOpenClawSessionKey({
            stageSessionId,
            prefix: config.sessionKeyPrefix,
          })
      const shouldInjectMotionProtocol = !promptedSessionKeys.has(sessionKey)
      const outboundMessage = shouldInjectMotionProtocol
        ? buildSessionMotionProtocolPrompt(userText, motionCatalog.motionNames)
        : userText
      const clientRunId = crypto.randomUUID()
      let activeRunId = clientRunId
      const runStream = gateway.createRunStream(clientRunId)

      let bufferedText = ''

      try {
        const sendResponse = await gateway.sendRequest(
          'chat.send',
          {
            sessionKey,
            message: outboundMessage,
            idempotencyKey: clientRunId,
          },
          config.requestTimeoutMs,
        )

        if (!sendResponse.ok) {
          runStream.close()
          yield {
            type: 'error',
            code: 'openclaw_chat_send_failed',
            message: resolveResponseErrorMessage(sendResponse),
            detail: sendResponse.error,
          }
          return
        }

        if (shouldInjectMotionProtocol) {
          promptedSessionKeys.add(sessionKey)
        }

        const responsePayload = asObject(sendResponse.payload)
        const acknowledgedRunId = readTrimmedString(responsePayload?.runId)
        if (acknowledgedRunId && acknowledgedRunId !== clientRunId) {
          gateway.renameRunStream(clientRunId, acknowledgedRunId)
          activeRunId = acknowledgedRunId
        }

        for await (const event of runStream.consume(config.runIdleTimeoutMs)) {
          if (event.kind === 'delta') {
            // OpenClaw delta payloads are incremental snapshots in current runtime.
            // Keep the latest snapshot and only emit one final assistant message.
            bufferedText = event.text || bufferedText
            continue
          }

          if (event.kind === 'done') {
            const finalText = event.text || bufferedText
            const parsedAssistantResponse = parseAssistantResponseForMotion({
              text: finalText,
              motionLookup: motionCatalog.motionLookup,
            })
            if (parsedAssistantResponse.motion) {
              yield {
                type: 'stage_command',
                command: 'model_motion',
                payload: {
                  motion: parsedAssistantResponse.motion,
                },
              }
            }
            yield {
              type: 'assistant_text_done',
              runId: event.runId,
              text: parsedAssistantResponse.text,
            }
            break
          }

          if (event.kind === 'error') {
            if (bufferedText) {
              const parsedAssistantResponse = parseAssistantResponseForMotion({
                text: bufferedText,
                motionLookup: motionCatalog.motionLookup,
              })
              if (parsedAssistantResponse.motion) {
                yield {
                  type: 'stage_command',
                  command: 'model_motion',
                  payload: {
                    motion: parsedAssistantResponse.motion,
                  },
                }
              }
              yield {
                type: 'assistant_text_done',
                runId: event.runId,
                text: parsedAssistantResponse.text,
              }
            }
            yield {
              type: 'error',
              code: event.code,
              message: event.message,
            }
            break
          }
        }
      } finally {
        gateway.removeRunStream(activeRunId)
      }
    },

    /**
     * Closes gateway socket and clears all in-flight run/request state.
     * @returns {void} Nothing.
     */
    destroy() {
      gateway.destroy()
    },
  }
}

/**
 * Creates a websocket RPC client for OpenClaw gateway frames.
 * @param {{ gatewayUrl: string, protocolVersion: number, requestTimeoutMs: number, role: string, scopes: string[], authToken?: string, authDeviceToken?: string, authPassword?: string, deviceAuthEnabled: boolean, deviceIdentityPath: string, deviceAuthPayloadVersion: 'v2' | 'v3', clientId: string, clientDisplayName?: string, clientVersion: string, clientPlatform: string, clientMode: string }} config Adapter configuration.
 * @returns {{ ensureConnected: () => Promise<void>, sendRequest: (method: string, params?: unknown, timeoutMs?: number) => Promise<Record<string, unknown>>, createRunStream: (runId: string) => ReturnType<typeof createRunEventStream>, renameRunStream: (fromRunId: string, toRunId: string) => void, removeRunStream: (runId: string) => void, destroy: () => void }} Gateway client.
 */
function createOpenClawGatewayClient(config) {
  let socket = null
  let requestSeq = 0
  let connectingPromise = null
  let connected = false

  const pendingRequests = new Map()
  const runStreams = new Map()
  const connectChallengeWaiters = []
  let bufferedConnectChallengeNonce = null

  /**
   * Ensures websocket handshake to OpenClaw has completed.
   * @returns {Promise<void>} Resolves when connection is ready for RPC calls.
   */
  async function ensureConnected() {
    if (connected && socket?.readyState === WebSocket.OPEN) {
      return
    }

    if (connectingPromise) {
      return connectingPromise
    }

    connectingPromise = (async () => {
      const ws = await openSocket(config.gatewayUrl)
      socket = ws
      attachSocketHandlers(ws)

      try {
        const connectChallengeNonce = config.deviceAuthEnabled
          ? await waitForConnectChallenge(config.requestTimeoutMs)
          : null

        const device = config.deviceAuthEnabled
          ? buildOpenClawConnectDeviceParams({
              config,
              nonce: connectChallengeNonce,
            })
          : undefined

        const handshake = await sendRequestInternal('connect', createOpenClawConnectParams({
          protocolVersion: config.protocolVersion,
          clientId: config.clientId,
          clientDisplayName: config.clientDisplayName,
          clientVersion: config.clientVersion,
          clientPlatform: config.clientPlatform,
          clientMode: config.clientMode,
          role: config.role,
          scopes: config.scopes,
          authToken: config.authToken,
          authDeviceToken: config.authDeviceToken,
          authPassword: config.authPassword,
          device,
        }), config.requestTimeoutMs)

        if (!handshake.ok) {
          throw new Error(resolveResponseErrorMessage(handshake))
        }
      } catch (error) {
        connected = false
        if (socket === ws) {
          socket = null
        }
        try {
          ws.close()
        } catch {
          // Ignore close errors during handshake failure cleanup.
        }
        throw error
      }

      connected = true
    })()
      .finally(() => {
        connectingPromise = null
      })

    return connectingPromise
  }

  /**
   * Sends one RPC request and waits for its matching response frame.
   * @param {string} method OpenClaw gateway method name.
   * @param {unknown} [params] Method parameter payload.
   * @param {number} [timeoutMs] Response timeout override.
   * @returns {Promise<Record<string, unknown>>} Response frame.
   */
  async function sendRequest(method, params, timeoutMs = config.requestTimeoutMs) {
    await ensureConnected()
    return sendRequestInternal(method, params, timeoutMs)
  }

  /**
   * Creates a run stream queue for one OpenClaw `chat.send` run.
   * @param {string} runId Client run identifier.
   * @returns {ReturnType<typeof createRunEventStream>} Run event stream.
   */
  function createRunStream(runId) {
    const stream = createRunEventStream(runId)
    runStreams.set(runId, stream)
    return stream
  }

  /**
   * Rebinds run stream tracking when OpenClaw returns a different runId.
   * @param {string} fromRunId Original run ID.
   * @param {string} toRunId New run ID returned by backend.
   * @returns {void} Nothing.
   */
  function renameRunStream(fromRunId, toRunId) {
    if (fromRunId === toRunId) {
      return
    }

    const stream = runStreams.get(fromRunId)
    if (!stream) {
      return
    }

    runStreams.delete(fromRunId)
    stream.setRunId(toRunId)
    runStreams.set(toRunId, stream)
  }

  /**
   * Removes stream state for a completed/cancelled run.
   * @param {string} runId Run ID.
   * @returns {void} Nothing.
   */
  function removeRunStream(runId) {
    runStreams.delete(runId)
  }

  /**
   * Destroys websocket + in-flight requests/runs.
   * @returns {void} Nothing.
   */
  function destroy() {
    connected = false

    const activeSocket = socket
    socket = null
    if (activeSocket) {
      try {
        activeSocket.close()
      } catch {
        // Ignore close errors while tearing down.
      }
    }

    for (const request of pendingRequests.values()) {
      request.reject(new Error('OpenClaw gateway connection closed.'))
    }
    pendingRequests.clear()

    failConnectChallengeWaiters(new Error('OpenClaw gateway connection closed before connect challenge.'))

    for (const stream of runStreams.values()) {
      stream.fail('openclaw_connection_closed', 'OpenClaw gateway connection closed.')
    }
    runStreams.clear()
  }

  /**
   * Sends one RPC request assuming connection is already open.
   * @param {string} method Gateway method.
   * @param {unknown} params Method params.
   * @param {number} timeoutMs Request timeout in milliseconds.
   * @returns {Promise<Record<string, unknown>>} Response frame.
   */
  async function sendRequestInternal(method, params, timeoutMs) {
    const ws = socket
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('OpenClaw gateway socket is not connected.')
    }

    requestSeq += 1
    const requestId = `openclaw-${requestSeq}`
    const frame = createOpenClawRequestFrame({
      id: requestId,
      method,
      params,
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error(`OpenClaw request timed out for method "${method}".`))
      }, timeoutMs)

      pendingRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      try {
        ws.send(JSON.stringify(frame))
      } catch (error) {
        clearTimeout(timer)
        pendingRequests.delete(requestId)
        reject(error instanceof Error ? error : new Error('Failed to send request frame.'))
      }
    })
  }

  /**
   * Registers websocket lifecycle handlers for frame routing.
   * @param {WebSocket} ws Active websocket instance.
   * @returns {void} Nothing.
   */
  function attachSocketHandlers(ws) {
    ws.on('message', (rawData) => {
      handleSocketMessage(rawData)
    })

    ws.on('close', () => {
      connected = false
      const closeError = new Error('OpenClaw gateway websocket closed.')
      for (const request of pendingRequests.values()) {
        request.reject(closeError)
      }
      pendingRequests.clear()

      failConnectChallengeWaiters(closeError)

      for (const stream of runStreams.values()) {
        stream.fail('openclaw_connection_closed', 'OpenClaw gateway websocket closed.')
      }
      runStreams.clear()
    })

    ws.on('error', () => {
      connected = false
    })
  }

  /**
   * Routes incoming websocket frames to pending RPC requests or run streams.
   * @param {Buffer | string} rawData Raw websocket frame payload.
   * @returns {void} Nothing.
   */
  function handleSocketMessage(rawData) {
    const text = typeof rawData === 'string' ? rawData : rawData.toString()
    let parsedFrame = null
    try {
      parsedFrame = parseOpenClawFrame(JSON.parse(text))
    } catch {
      return
    }

    if (!parsedFrame) {
      return
    }

    if (isOpenClawResponseFrame(parsedFrame)) {
      const pending = pendingRequests.get(parsedFrame.id)
      if (!pending) {
        return
      }
      pendingRequests.delete(parsedFrame.id)
      pending.resolve(parsedFrame)
      return
    }

    if (!isOpenClawEventFrame(parsedFrame)) {
      return
    }

    const connectChallengeNonce = readOpenClawConnectChallengeNonce(parsedFrame)
    if (connectChallengeNonce) {
      resolveConnectChallenge(connectChallengeNonce)
      return
    }

    const chatEvent = readOpenClawChatEvent(parsedFrame)
    if (!chatEvent) {
      return
    }

    const stream = runStreams.get(chatEvent.runId)
    if (!stream) {
      return
    }

    if (chatEvent.state === 'delta') {
      if (chatEvent.text) {
        stream.pushDelta(chatEvent.text)
      }
      return
    }

    if (chatEvent.state === 'final') {
      stream.pushDone(chatEvent.text)
      return
    }

    if (chatEvent.state === 'error') {
      stream.fail('openclaw_chat_error', chatEvent.errorMessage || 'OpenClaw chat run failed.')
      return
    }

    if (chatEvent.state === 'aborted') {
      stream.fail('openclaw_chat_aborted', 'OpenClaw chat run was aborted.')
    }
  }

  /**
   * Waits for one `connect.challenge` nonce event.
   * @param {number} timeoutMs Timeout in milliseconds.
   * @returns {Promise<string>} Challenge nonce.
   */
  function waitForConnectChallenge(timeoutMs) {
    if (bufferedConnectChallengeNonce) {
      const nonce = bufferedConnectChallengeNonce
      bufferedConnectChallengeNonce = null
      return Promise.resolve(nonce)
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (nonce) => {
          clearTimeout(waiter.timer)
          resolve(nonce)
        },
        reject: (error) => {
          clearTimeout(waiter.timer)
          reject(error)
        },
        timer: setTimeout(() => {
          const index = connectChallengeWaiters.indexOf(waiter)
          if (index >= 0) {
            connectChallengeWaiters.splice(index, 1)
          }
          reject(new Error('Timed out waiting for OpenClaw connect.challenge nonce.'))
        }, timeoutMs),
      }
      connectChallengeWaiters.push(waiter)
    })
  }

  /**
   * Resolves pending challenge waiter or buffers nonce for later consumption.
   * @param {string} nonce Connect challenge nonce.
   * @returns {void} Nothing.
   */
  function resolveConnectChallenge(nonce) {
    const waiter = connectChallengeWaiters.shift()
    if (waiter) {
      waiter.resolve(nonce)
      return
    }
    bufferedConnectChallengeNonce = nonce
  }

  /**
   * Rejects and clears pending connect challenge waiters.
   * @param {Error} error Failure reason.
   * @returns {void} Nothing.
   */
  function failConnectChallengeWaiters(error) {
    bufferedConnectChallengeNonce = null
    while (connectChallengeWaiters.length > 0) {
      const waiter = connectChallengeWaiters.shift()
      waiter.reject(error)
    }
  }

  return {
    ensureConnected,
    sendRequest,
    createRunStream,
    renameRunStream,
    removeRunStream,
    destroy,
  }
}

/**
 * Opens websocket connection to the configured OpenClaw gateway URL.
 * @param {string} gatewayUrl OpenClaw gateway URL.
 * @returns {Promise<WebSocket>} Connected websocket instance.
 */
function openSocket(gatewayUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl)
    const handleError = (error) => {
      ws.removeAllListeners('open')
      reject(error instanceof Error ? error : new Error('OpenClaw websocket open failed.'))
    }

    ws.once('error', handleError)
    ws.once('open', () => {
      ws.removeListener('error', handleError)
      resolve(ws)
    })
  })
}

/**
 * Creates run-level async queue utilities for streaming events.
 * @param {string} initialRunId Initial run identifier.
 * @returns {{ setRunId: (nextRunId: string) => void, pushDelta: (text: string) => void, pushDone: (text: string) => void, fail: (code: string, message: string) => void, close: () => void, consume: (idleTimeoutMs: number) => AsyncGenerator<Record<string, unknown>, void, void> }} Run stream API.
 */
function createRunEventStream(initialRunId) {
  let runId = initialRunId
  let closed = false
  const buffered = []
  const waiters = []

  /**
   * Updates run ID metadata for events emitted by this stream.
   * @param {string} nextRunId Next run ID.
   * @returns {void} Nothing.
   */
  function setRunId(nextRunId) {
    runId = nextRunId
  }

  /**
   * Queues a delta event.
   * @param {string} text Delta text chunk.
   * @returns {void} Nothing.
   */
  function pushDelta(text) {
    push({
      kind: 'delta',
      runId,
      text,
    })
  }

  /**
   * Queues a completion event and closes the stream.
   * @param {string} text Final assistant text.
   * @returns {void} Nothing.
   */
  function pushDone(text) {
    push({
      kind: 'done',
      runId,
      text,
    })
    close()
  }

  /**
   * Queues an error event and closes the stream.
   * @param {string} code Machine-readable error code.
   * @param {string} message Human-readable error message.
   * @returns {void} Nothing.
   */
  function fail(code, message) {
    push({
      kind: 'error',
      runId,
      code,
      message,
    })
    close()
  }

  /**
   * Closes the stream and resolves pending waiters.
   * @returns {void} Nothing.
   */
  function close() {
    if (closed) {
      return
    }
    closed = true
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      waiter.resolve(null)
    }
  }

  /**
   * Async iterator over stream events with idle timeout protection.
   * @param {number} idleTimeoutMs Max idle duration before timeout error event.
   * @returns {AsyncGenerator<Record<string, unknown>, void, void>} Run stream iterator.
   */
  async function* consume(idleTimeoutMs) {
    while (true) {
      const event = await shiftNext(idleTimeoutMs)
      if (!event) {
        break
      }
      yield event
      if (event.kind === 'done' || event.kind === 'error') {
        break
      }
    }
  }

  /**
   * Pushes one event into queue or resolves active waiter.
   * @param {Record<string, unknown>} event Event payload.
   * @returns {void} Nothing.
   */
  function push(event) {
    if (closed) {
      return
    }

    const waiter = waiters.shift()
    if (waiter) {
      waiter.resolve(event)
      return
    }

    buffered.push(event)
  }

  /**
   * Reads next queued event with timeout fallback.
   * @param {number} idleTimeoutMs Idle timeout in milliseconds.
   * @returns {Promise<Record<string, unknown> | null>} Next event or null when closed.
   */
  function shiftNext(idleTimeoutMs) {
    if (buffered.length > 0) {
      return Promise.resolve(buffered.shift())
    }

    if (closed) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      const waiter = {
        resolve: (event) => {
          clearTimeout(waiter.timer)
          resolve(event)
        },
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) {
            waiters.splice(index, 1)
          }
          resolve({
            kind: 'error',
            runId,
            code: 'openclaw_chat_timeout',
            message: 'Timed out waiting for OpenClaw chat stream completion.',
          })
        }, idleTimeoutMs),
      }
      waiters.push(waiter)
    })
  }

  return {
    setRunId,
    pushDelta,
    pushDone,
    fail,
    close,
    consume,
  }
}

/**
 * Resolves adapter configuration using explicit input + environment fallback.
 * @param {Record<string, unknown>} input Explicit adapter input config.
 * @returns {{ gatewayUrl: string, protocolVersion: number, requestTimeoutMs: number, runIdleTimeoutMs: number, sessionKeyPrefix: string, model3Path: string, authToken?: string, authDeviceToken?: string, authPassword?: string, deviceAuthEnabled: boolean, deviceIdentityPath: string, deviceAuthPayloadVersion: 'v2' | 'v3', clientId: string, clientDisplayName?: string, clientVersion: string, clientPlatform: string, clientMode: string, role: string, scopes: string[] }} Resolved adapter config.
 */
function resolveOpenClawAdapterConfig(input) {
  const gatewayUrl = normalizeOpenClawGatewayUrl(
    readTrimmedString(input.gatewayUrl) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_WS_URL) ??
      DEFAULT_OPENCLAW_GATEWAY_WS_URL,
  )
  const deviceIdentityPath =
    readTrimmedString(input.deviceIdentityPath) ??
    readTrimmedString(process.env.OPENCLAW_GATEWAY_DEVICE_IDENTITY_PATH) ??
    DEFAULT_DEVICE_IDENTITY_PATH
  const authToken =
    readTrimmedString(input.authToken) ??
    readTrimmedString(process.env.OPENCLAW_GATEWAY_TOKEN) ??
    undefined
  const authDeviceToken =
    readTrimmedString(input.authDeviceToken) ??
    readTrimmedString(process.env.OPENCLAW_GATEWAY_DEVICE_TOKEN) ??
    undefined

  const role =
    readTrimmedString(input.role) ??
    readTrimmedString(process.env.OPENCLAW_GATEWAY_ROLE) ??
    DEFAULT_OPENCLAW_ROLE
  const explicitScopes =
    normalizeScopes(input.scopes) ??
    normalizeScopes(readTrimmedString(process.env.OPENCLAW_GATEWAY_SCOPES))
  const inferredDeviceTokenScopes =
    !explicitScopes && authDeviceToken
      ? readDeviceTokenScopesFromIdentityStore(deviceIdentityPath)
      : null
  const configuredScopes =
    explicitScopes ??
    inferredDeviceTokenScopes ??
    [...DEFAULT_OPENCLAW_SCOPES]
  const scopes = authDeviceToken
    ? configuredScopes
    : ensureChatSendScopes(configuredScopes)

  return {
    gatewayUrl,
    protocolVersion: normalizePositiveInteger(
      input.protocolVersion ?? process.env.OPENCLAW_GATEWAY_PROTOCOL_VERSION,
      OPENCLAW_PROTOCOL_VERSION,
    ),
    requestTimeoutMs: normalizePositiveInteger(
      input.requestTimeoutMs ?? process.env.OPENCLAW_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    runIdleTimeoutMs: normalizePositiveInteger(
      input.runIdleTimeoutMs ?? process.env.OPENCLAW_RUN_IDLE_TIMEOUT_MS,
      DEFAULT_RUN_IDLE_TIMEOUT_MS,
    ),
    sessionKeyPrefix:
      readTrimmedString(input.sessionKeyPrefix) ??
      readTrimmedString(process.env.OPENCLAW_SESSION_KEY_PREFIX) ??
      DEFAULT_SESSION_KEY_PREFIX,
    model3Path:
      readTrimmedString(input.model3Path) ??
      readTrimmedString(process.env.OPENCLAW_STAGE_MODEL3_PATH) ??
      DEFAULT_STAGE_MODEL3_PATH,
    authToken,
    authDeviceToken,
    authPassword:
      readTrimmedString(input.authPassword) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_PASSWORD) ??
      undefined,
    deviceAuthEnabled: normalizeBoolean(
      input.deviceAuthEnabled ?? process.env.OPENCLAW_GATEWAY_DEVICE_AUTH_ENABLED,
      true,
    ),
    deviceIdentityPath,
    deviceAuthPayloadVersion: normalizeDeviceAuthPayloadVersion(
      input.deviceAuthPayloadVersion ?? process.env.OPENCLAW_GATEWAY_DEVICE_AUTH_PAYLOAD_VERSION,
      DEFAULT_DEVICE_AUTH_PAYLOAD_VERSION,
    ),
    clientId:
      readTrimmedString(input.clientId) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_CLIENT_ID) ??
      DEFAULT_OPENCLAW_CLIENT_ID,
    clientDisplayName:
      readTrimmedString(input.clientDisplayName) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_CLIENT_NAME) ??
      undefined,
    clientVersion:
      readTrimmedString(input.clientVersion) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_CLIENT_VERSION) ??
      DEFAULT_OPENCLAW_CLIENT_VERSION,
    clientPlatform:
      readTrimmedString(input.clientPlatform) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_CLIENT_PLATFORM) ??
      `node-${process.platform}`,
    clientMode:
      readTrimmedString(input.clientMode) ??
      readTrimmedString(process.env.OPENCLAW_GATEWAY_CLIENT_MODE) ??
      DEFAULT_OPENCLAW_CLIENT_MODE,
    role,
    scopes,
  }
}

/**
 * Resolves stable stage session identifier for session key mapping.
 * @param {Record<string, unknown>} input Adapter call input payload.
 * @returns {string} Stage session identifier.
 */
function resolveStageSessionId(input) {
  return (
    readTrimmedString(input?.stageSessionId) ??
    readTrimmedString(input?.sessionId) ??
    'default'
  )
}

/**
 * Maps stage session IDs into OpenClaw `sessionKey` values.
 * @param {{ stageSessionId: string, prefix: string }} input Session mapping fields.
 * @returns {string} OpenClaw session key.
 */
function resolveOpenClawSessionKey(input) {
  const normalizedSegment = input.stageSessionId
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  const safeSegment = normalizedSegment || 'default'
  return `${input.prefix}:${safeSegment}`
}

/**
 * Builds signed `connect.params.device` fields for OpenClaw device-auth handshake.
 * @param {{ config: { clientId: string, clientMode: string, role: string, scopes: string[], clientPlatform: string, authToken?: string, deviceIdentityPath: string, deviceAuthPayloadVersion: 'v2' | 'v3' }, nonce: string }} input Device-auth inputs.
 * @returns {{ id: string, publicKey: string, signature: string, signedAt: number, nonce: string }} Signed connect device payload.
 */
function buildOpenClawConnectDeviceParams(input) {
  const identity = loadOrCreateDeviceIdentity(input.config.deviceIdentityPath)
  const signedAtMs = Date.now()
  const authTokenForSignature = input.config.authToken ?? null
  const signaturePayload = input.config.deviceAuthPayloadVersion === 'v3'
    ? buildOpenClawDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: input.config.clientId,
        clientMode: input.config.clientMode,
        role: input.config.role,
        scopes: input.config.scopes,
        signedAtMs,
        token: authTokenForSignature,
        nonce: input.nonce,
        platform: input.config.clientPlatform,
        deviceFamily: undefined,
      })
    : buildOpenClawDeviceAuthPayloadV2({
        deviceId: identity.deviceId,
        clientId: input.config.clientId,
        clientMode: input.config.clientMode,
        role: input.config.role,
        scopes: input.config.scopes,
        signedAtMs,
        token: authTokenForSignature,
        nonce: input.nonce,
      })

  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, signaturePayload),
    signedAt: signedAtMs,
    nonce: input.nonce,
  }
}

/**
 * Resolves response frame error message into one readable string.
 * @param {Record<string, unknown>} response OpenClaw response frame.
 * @returns {string} Human-readable error message.
 */
function resolveResponseErrorMessage(response) {
  const error = asObject(response.error)
  const errorMessage = readTrimmedString(error?.message)
  if (errorMessage) {
    return errorMessage
  }
  return 'OpenClaw request failed.'
}

/**
 * Parses list/string scope declarations into array form.
 * @param {unknown} value Raw scope declaration.
 * @returns {string[] | null} Normalized scopes array or null.
 */
function normalizeScopes(value) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => readTrimmedString(entry))
      .filter(Boolean)
    return normalized.length > 0 ? normalized : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalized = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  return normalized.length > 0 ? normalized : null
}

/**
 * Reads operator token scopes from sibling `device-auth.json` identity store.
 * @param {string} identityPath Device identity file path.
 * @returns {string[] | null} Token scopes or null when unavailable.
 */
function readDeviceTokenScopesFromIdentityStore(identityPath) {
  const authPath = path.join(path.dirname(identityPath), 'device-auth.json')

  let parsed = null
  try {
    parsed = JSON.parse(readFileUtf8(authPath))
  } catch {
    return null
  }

  const authStore = asObject(parsed)
  const tokens = asObject(authStore?.tokens)
  const operatorToken = asObject(tokens?.operator)
  return normalizeScopes(operatorToken?.scopes)
}

/**
 * Normalizes device-auth payload version configuration.
 * @param {unknown} value Raw payload version value.
 * @param {'v2' | 'v3'} fallbackValue Fallback version.
 * @returns {'v2' | 'v3'} Normalized payload version.
 */
function normalizeDeviceAuthPayloadVersion(value, fallbackValue) {
  const normalized = readTrimmedString(value)?.toLowerCase()
  return normalized === 'v3' ? 'v3' : normalized === 'v2' ? 'v2' : fallbackValue
}

/**
 * Ensures adapter scope config can execute `chat.send` RPC calls.
 * @param {string[]} scopes Requested OpenClaw operator scopes.
 * @returns {string[]} Scope list that always includes write or admin capability.
 */
function ensureChatSendScopes(scopes) {
  if (scopes.includes(OPENCLAW_ADMIN_SCOPE) || scopes.includes(OPENCLAW_WRITE_SCOPE)) {
    return scopes
  }

  return [...scopes, OPENCLAW_WRITE_SCOPE]
}

/**
 * Loads supported motion names from the configured Live2D model3.json file.
 * @param {string} model3Path Absolute or relative model3 JSON path.
 * @returns {{ motionNames: string[], motionLookup: Map<string, string> }} Motion catalog for prompt/response processing.
 */
function loadSupportedMotionCatalog(model3Path) {
  let motionNames = []

  try {
    const parsed = JSON.parse(readFileUtf8(model3Path))
    motionNames = readMotionNamesFromModel3(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    console.warn(
      `[STAGE-ORCH] Failed to read motion catalog from ${model3Path}. Motion directives disabled. (${message})`,
    )
  }

  if (motionNames.length === 0) {
    return {
      motionNames: [],
      motionLookup: new Map(),
    }
  }

  const motionLookup = new Map()
  for (const motionName of motionNames) {
    motionLookup.set(motionName.toLowerCase(), motionName)
  }

  return {
    motionNames,
    motionLookup,
  }
}

/**
 * Reads motion keys from a Cubism model3 JSON object.
 * @param {unknown} model3Json Parsed model3 JSON value.
 * @returns {string[]} Supported motion names.
 */
function readMotionNamesFromModel3(model3Json) {
  const parsedModel = asObject(model3Json)
  const fileReferences = asObject(parsedModel?.FileReferences)
  const motions = asObject(fileReferences?.Motions)
  if (!motions) {
    return []
  }

  const motionNames = []
  for (const motionName of Object.keys(motions)) {
    const trimmedMotionName = readTrimmedString(motionName)
    if (!trimmedMotionName) {
      continue
    }
    motionNames.push(trimmedMotionName)
  }
  return motionNames
}

/**
 * Builds first-message prompt injection that defines session motion response protocol.
 * @param {string} userText Original user text.
 * @param {string[]} motionNames Supported motion names from model metadata.
 * @returns {string} Prompt-injected user message.
 */
function buildSessionMotionProtocolPrompt(userText, motionNames) {
  if (!motionNames.length) {
    return userText
  }

  return [
    'Session instruction:',
    `For every response in this session, the first line must be exactly "${MOTION_DIRECTIVE_PREFIX}: <motion|${NO_MOTION_LABEL}>".`,
    `Allowed motion names: ${motionNames.join(', ')}.`,
    `Use "${NO_MOTION_LABEL}" when no motion should be performed.`,
    'Write the normal response content starting from line 2.',
    'Do not include any text before the first motion line.',
    '',
    `User message: ${userText}`,
  ].join('\n')
}

/**
 * Parses assistant text for a motion directive on the first line.
 * @param {{ text: string, motionLookup: Map<string, string> }} input Parse input.
 * @returns {{ text: string, motion: string | null }} Stripped text plus optional motion name.
 */
function parseAssistantResponseForMotion(input) {
  const rawText = typeof input.text === 'string' ? input.text : ''
  if (!rawText) {
    return {
      text: '',
      motion: null,
    }
  }

  const lines = rawText.split(/\r?\n/)
  const firstLine = readTrimmedString(lines[0]) ?? ''
  const motionLineMatch = firstLine.match(/^motion\s*:\s*([A-Za-z0-9._-]+)\s*$/i)
  if (!motionLineMatch) {
    return {
      text: rawText,
      motion: null,
    }
  }

  const motionToken = motionLineMatch[1].toLowerCase()
  if (NO_MOTION_ALIASES.has(motionToken)) {
    return {
      text: stripFirstLine(rawText),
      motion: null,
    }
  }

  const matchedMotion = input.motionLookup.get(motionToken)
  if (!matchedMotion) {
    // Keep the original text untouched when the first line is not in expected motion set.
    return {
      text: rawText,
      motion: null,
    }
  }

  return {
    text: stripFirstLine(rawText),
    motion: matchedMotion,
  }
}

/**
 * Removes the first line (and one optional leading blank line) from a text payload.
 * @param {string} text Input text.
 * @returns {string} Remaining text after first-line removal.
 */
function stripFirstLine(text) {
  const firstNewlineIndex = text.indexOf('\n')
  if (firstNewlineIndex < 0) {
    return ''
  }

  const withoutFirstLine = text.slice(firstNewlineIndex + 1)
  return withoutFirstLine.replace(/^\r?\n/, '')
}

/**
 * Reads UTF-8 text file content.
 * @param {string} filePath Absolute file path.
 * @returns {string} File content.
 */
function readFileUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * Parses positive integer values with fallback.
 * @param {unknown} value Raw numeric config value.
 * @param {number} fallbackValue Fallback integer.
 * @returns {number} Parsed positive integer.
 */
function normalizePositiveInteger(value, fallbackValue) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue
}

/**
 * Parses boolean-ish values with fallback.
 * @param {unknown} value Raw boolean value.
 * @param {boolean} fallbackValue Fallback boolean.
 * @returns {boolean} Parsed boolean value.
 */
function normalizeBoolean(value, fallbackValue) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'string') {
    return fallbackValue
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return fallbackValue
}

/**
 * Reads non-empty trimmed strings.
 * @param {unknown} value Unknown value.
 * @returns {string | null} Trimmed string or null.
 */
function readTrimmedString(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Coerces unknown values into plain objects.
 * @param {unknown} value Unknown value.
 * @returns {Record<string, unknown> | null} Object record or null.
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value
}

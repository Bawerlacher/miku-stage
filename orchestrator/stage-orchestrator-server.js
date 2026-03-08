/**
 * Stage Orchestrator websocket server with session routing and adapter dispatch.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DEFAULT_ORCHESTRATOR_PORT,
  DEFAULT_ORCHESTRATOR_WS_PATH,
  SUPPORTED_STAGE_COMMANDS,
} from './constants.js'
import { normalizePort, normalizeWsPath } from './config.js'
import { createStageBackendAdapter } from './adapters/index.js'
import {
  createAckEnvelope,
  createAssistantTextDeltaEnvelope,
  createAssistantTextDoneEnvelope,
  createErrorEnvelope,
  createPongEnvelope,
  createSessionInitEnvelope,
  createStageCommandEnvelope,
  parseIncomingClientEnvelope,
} from './protocol.js'

/**
 * Creates the Stage Orchestrator server controller.
 * @param {{ port?: number, wsPath?: string, adapter?: Record<string, unknown>, logger?: Console }} [input] Server configuration.
 * @returns {{ start: () => void, stop: () => Promise<void>, getState: () => Record<string, unknown> }} Server lifecycle controller.
 */
export function createStageOrchestratorServer(input = {}) {
  const port = normalizePort(input.port ?? DEFAULT_ORCHESTRATOR_PORT)
  const wsPath = normalizeWsPath(input.wsPath ?? DEFAULT_ORCHESTRATOR_WS_PATH)
  const adapter = input.adapter ?? createStageBackendAdapter()
  const logger = input.logger ?? console

  const sessions = new Map()
  const connections = new Map()
  let started = false

  const httpServer = http.createServer((request, response) => {
    const pathname = readPathname(request.url)
    if (pathname === '/healthz') {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ok: true,
          adapter: adapter.name,
          wsPath,
          activeSessions: sessions.size,
          activeConnections: connections.size,
        }),
      )
      return
    }

    response.statusCode = 404
    response.end('Not Found')
  })

  const wss = new WebSocketServer({ noServer: true })

  /**
   * Starts listening for websocket upgrades and client sessions.
   * @returns {void} Nothing.
   */
  function start() {
    if (started) {
      return
    }

    started = true
    bindServerErrorHandler()
    bindUpgradeHandler()
    bindWebSocketHandler()

    httpServer.listen(port, () => {
      logger.info(
        `[STAGE-ORCH] Listening on ws://127.0.0.1:${port}${wsPath} adapter=${adapter.name}`,
      )
    })
  }

  /**
   * Stops accepting connections and closes active sockets.
   * @returns {Promise<void>} Promise resolved after server shutdown.
   */
  async function stop() {
    if (!started) {
      return
    }

    started = false

    for (const connection of connections.values()) {
      connection.ws.close()
    }

    await Promise.allSettled([
      closeWebSocketServer(wss),
      closeHttpServer(httpServer),
    ])
  }

  /**
   * Returns a lightweight snapshot of orchestrator runtime state.
   * @returns {{ port: number, wsPath: string, adapter: string, activeSessions: number, activeConnections: number }} Runtime state summary.
   */
  function getState() {
    return {
      port,
      wsPath,
      adapter: adapter.name,
      activeSessions: sessions.size,
      activeConnections: connections.size,
    }
  }

  /**
   * Registers HTTP upgrade handling and path validation.
   * @returns {void} Nothing.
   */
  function bindUpgradeHandler() {
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = readPathname(request.url)
      if (pathname !== wsPath) {
        rejectUpgrade(socket, 404, `Stage Orchestrator websocket is available at ${wsPath}`)
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    })
  }

  /**
   * Registers error handling for HTTP listener failures.
   * @returns {void} Nothing.
   */
  function bindServerErrorHandler() {
    httpServer.on('error', (error) => {
      logger.error('[STAGE-ORCH] HTTP server error', error)
    })
  }

  /**
   * Registers websocket connection handlers.
   * @returns {void} Nothing.
   */
  function bindWebSocketHandler() {
    wss.on('connection', (ws, request) => {
      const connection = createConnectionState(ws, request.url)
      connections.set(connection.connectionId, connection)
      attachConnectionToSession(connection, connection.stageSessionId)

      logger.info(
        `[STAGE-ORCH] Connected session=${connection.stageSessionId} connection=${connection.connectionId}`,
      )

      sendSessionInit(connection)

      ws.on('message', (data) => {
        void handleClientMessage(connection, data)
      })

      ws.on('close', () => {
        detachConnection(connection)
        logger.info(
          `[STAGE-ORCH] Disconnected session=${connection.stageSessionId} connection=${connection.connectionId}`,
        )
      })

      ws.on('error', (error) => {
        logger.warn(
          `[STAGE-ORCH] Socket error session=${connection.stageSessionId} connection=${connection.connectionId}`,
          error,
        )
      })
    })
  }

  /**
   * Creates in-memory state for a newly accepted websocket connection.
   * @param {WebSocket} ws Accepted websocket socket.
   * @param {string | undefined} requestUrl Upgrade request URL.
   * @returns {{ connectionId: string, stageSessionId: string, ws: WebSocket, clientName: string | null, pageUrl: string | null }} Connection runtime state.
   */
  function createConnectionState(ws, requestUrl) {
    const request = new URL(requestUrl ?? '/', 'http://localhost')
    const requestedSessionId =
      readTrimmedString(request.searchParams.get('stageSessionId')) ??
      readTrimmedString(request.searchParams.get('sessionId'))

    return {
      connectionId: crypto.randomUUID(),
      stageSessionId: requestedSessionId ?? crypto.randomUUID(),
      ws,
      clientName: null,
      pageUrl: null,
    }
  }

  /**
   * Handles one inbound websocket message for a specific connection.
   * @param {{ connectionId: string, stageSessionId: string, ws: WebSocket, clientName: string | null, pageUrl: string | null }} connection Connection state.
   * @param {Buffer | string} rawData Raw websocket message buffer/string.
   * @returns {Promise<void>} Promise resolved after message routing.
   */
  async function handleClientMessage(connection, rawData) {
    const parsedJson = parseJsonMessage(rawData)
    if (!parsedJson.ok) {
      sendError(connection, 'bad_json', parsedJson.error.message)
      return
    }

    const parsedEnvelope = parseIncomingClientEnvelope(parsedJson.value)
    if (!parsedEnvelope.ok) {
      sendError(
        connection,
        parsedEnvelope.error.code,
        parsedEnvelope.error.message,
        parsedEnvelope.error.detail,
      )
      return
    }

    const message = parsedEnvelope.message
    touchSession(connection.stageSessionId)

    switch (message.kind) {
      case 'session_ready':
        handleSessionReady(connection, message)
        return
      case 'ping':
        sendEnvelope(connection.ws, createPongEnvelope({
          sessionId: connection.stageSessionId,
          payload: asObject(message.payload) ?? {},
        }))
        return
      case 'pong':
        return
      case 'user_text':
        await handleUserText(connection, message)
        return
      case 'stage_command':
        handleStageCommand(connection, message)
        return
      case 'client_event':
        await handleClientEvent(connection, message)
        return
      default:
        sendError(connection, 'unsupported_type', 'Unsupported message kind.')
    }
  }

  /**
   * Handles session bootstrap/update payload from the browser client.
   * @param {{ connectionId: string, stageSessionId: string, ws: WebSocket, clientName: string | null, pageUrl: string | null }} connection Connection state.
   * @param {Record<string, unknown>} message Normalized session-ready message.
   * @returns {void} Nothing.
   */
  function handleSessionReady(connection, message) {
    const payload = asObject(message.payload) ?? {}
    const requestedSessionId = readTrimmedString(message.requestedSessionId)
    if (requestedSessionId && requestedSessionId !== connection.stageSessionId) {
      attachConnectionToSession(connection, requestedSessionId)
    }

    connection.clientName = readTrimmedString(payload.client) ?? connection.clientName
    connection.pageUrl = readTrimmedString(payload.pageUrl) ?? connection.pageUrl

    sendSessionInit(connection)
  }

  /**
   * Forwards validated user text to the active backend adapter.
   * @param {{ connectionId: string, stageSessionId: string, ws: WebSocket }} connection Connection state.
   * @param {Record<string, unknown>} message Parsed user text message.
   * @returns {Promise<void>} Promise resolved after adapter events are emitted.
   */
  async function handleUserText(connection, message) {
    if (typeof adapter.onUserText !== 'function') {
      sendError(connection, 'adapter_not_implemented', 'Adapter does not support user_text.')
      return
    }

    try {
      const eventSource = adapter.onUserText({
        stageSessionId: connection.stageSessionId,
        connectionId: connection.connectionId,
        text: message.text,
        payload: message.payload,
      })
      await emitAdapterEvents(connection, eventSource)
    } catch (error) {
      logger.error('[STAGE-ORCH] Adapter user_text handler failed.', error)
      sendError(connection, 'adapter_failure', 'Backend adapter failed while handling user_text.')
    }
  }

  /**
   * Relays canonical stage commands to all clients in the same stage session.
   * @param {{ stageSessionId: string }} connection Connection state.
   * @param {Record<string, unknown>} message Parsed stage command message.
   * @returns {void} Nothing.
   */
  function handleStageCommand(connection, message) {
    const command = readTrimmedString(message.command)
    if (!command || !SUPPORTED_STAGE_COMMANDS.has(command)) {
      sendError(connection, 'unsupported_command', 'Unsupported stage command.')
      return
    }

    broadcastToSession(
      connection.stageSessionId,
      createStageCommandEnvelope({
        sessionId: connection.stageSessionId,
        command,
        payload: asObject(message.commandPayload) ?? {},
      }),
    )
  }

  /**
   * Forwards generic client events to the adapter when supported.
   * @param {{ stageSessionId: string, connectionId: string }} connection Connection state.
   * @param {Record<string, unknown>} message Parsed pass-through event message.
   * @returns {Promise<void>} Promise resolved after adapter handling.
   */
  async function handleClientEvent(connection, message) {
    if (typeof adapter.onClientEvent !== 'function') {
      sendEnvelope(connection.ws, createAckEnvelope({
        sessionId: connection.stageSessionId,
        event: String(message.sourceType ?? 'client_event'),
      }))
      return
    }

    try {
      const eventSource = adapter.onClientEvent({
        stageSessionId: connection.stageSessionId,
        connectionId: connection.connectionId,
        type: message.sourceType,
        payload: message.payload,
      })
      await emitAdapterEvents(connection, eventSource)
    } catch (error) {
      logger.error('[STAGE-ORCH] Adapter client event handler failed.', error)
      sendError(connection, 'adapter_failure', 'Backend adapter failed while handling client event.')
    }
  }

  /**
   * Emits backend adapter events as websocket protocol messages.
   * @param {{ stageSessionId: string, ws: WebSocket }} sourceConnection Source connection state.
   * @param {unknown} eventSource Adapter event value/array/iterable/async iterable.
   * @returns {Promise<void>} Promise resolved after all events are processed.
   */
  async function emitAdapterEvents(sourceConnection, eventSource) {
    const sessionId = sourceConnection.stageSessionId

    for await (const rawEvent of toAsyncIterable(eventSource)) {
      const event = asObject(rawEvent)
      if (!event) {
        continue
      }

      const eventType = readTrimmedString(event.type)
      if (!eventType) {
        continue
      }

      if (eventType === 'assistant_text_delta') {
        const text = readString(event.text)
        if (!text) {
          continue
        }
        const runId = readTrimmedString(event.runId) ?? crypto.randomUUID()
        broadcastToSession(
          sessionId,
          createAssistantTextDeltaEnvelope({
            sessionId,
            runId,
            text,
          }),
        )
        continue
      }

      if (eventType === 'assistant_text_done') {
        const text = readString(event.text) ?? ''
        const runId = readTrimmedString(event.runId) ?? crypto.randomUUID()
        broadcastToSession(
          sessionId,
          createAssistantTextDoneEnvelope({
            sessionId,
            runId,
            text,
          }),
        )
        continue
      }

      if (eventType === 'stage_command') {
        const command = readTrimmedString(event.command)
        if (!command || !SUPPORTED_STAGE_COMMANDS.has(command)) {
          continue
        }

        broadcastToSession(
          sessionId,
          createStageCommandEnvelope({
            sessionId,
            command,
            payload: asObject(event.payload) ?? {},
          }),
        )
        continue
      }

      if (eventType === 'error') {
        sendError(
          sourceConnection,
          readTrimmedString(event.code) ?? 'adapter_error',
          readString(event.message) ?? 'Adapter returned an error event.',
          event.detail,
        )
      }
    }
  }

  /**
   * Sends session bootstrap payload to a single connection.
   * @param {{ stageSessionId: string, ws: WebSocket }} connection Connection state.
   * @returns {void} Nothing.
   */
  function sendSessionInit(connection) {
    sendEnvelope(
      connection.ws,
      createSessionInitEnvelope({
        sessionId: connection.stageSessionId,
        connectedClients: getSessionConnectionCount(connection.stageSessionId),
        adapterName: adapter.name,
      }),
    )
  }

  /**
   * Adds or moves a connection into a stage session membership set.
   * @param {{ connectionId: string, stageSessionId: string }} connection Connection state.
   * @param {string} nextSessionId New target session ID.
   * @returns {void} Nothing.
   */
  function attachConnectionToSession(connection, nextSessionId) {
    if (connection.stageSessionId === nextSessionId) {
      const current = getOrCreateSession(nextSessionId)
      current.connectionIds.add(connection.connectionId)
      touchSession(nextSessionId)
      return
    }

    if (connection.stageSessionId) {
      const previous = sessions.get(connection.stageSessionId)
      if (previous) {
        previous.connectionIds.delete(connection.connectionId)
        if (previous.connectionIds.size === 0) {
          sessions.delete(previous.id)
        }
      }
    }

    const target = getOrCreateSession(nextSessionId)
    target.connectionIds.add(connection.connectionId)
    connection.stageSessionId = nextSessionId
    touchSession(nextSessionId)
  }

  /**
   * Removes a connection from in-memory connection/session tracking.
   * @param {{ connectionId: string, stageSessionId: string }} connection Connection state.
   * @returns {void} Nothing.
   */
  function detachConnection(connection) {
    connections.delete(connection.connectionId)

    const session = sessions.get(connection.stageSessionId)
    if (!session) {
      return
    }

    session.connectionIds.delete(connection.connectionId)
    if (session.connectionIds.size === 0) {
      sessions.delete(connection.stageSessionId)
    }
  }

  /**
   * Broadcasts one envelope to all clients in a stage session.
   * @param {string} sessionId Stage session ID.
   * @param {Record<string, unknown>} envelope Outbound protocol envelope.
   * @returns {void} Nothing.
   */
  function broadcastToSession(sessionId, envelope) {
    const session = sessions.get(sessionId)
    if (!session) {
      return
    }

    for (const connectionId of session.connectionIds) {
      const connection = connections.get(connectionId)
      if (!connection) {
        continue
      }
      sendEnvelope(connection.ws, envelope)
    }
  }

  /**
   * Sends a protocol error envelope to one connection.
   * @param {{ stageSessionId: string, ws: WebSocket }} connection Connection state.
   * @param {string} code Machine-readable error code.
   * @param {string} message Human-readable error message.
   * @param {unknown} [detail] Optional debug detail object.
   * @returns {void} Nothing.
   */
  function sendError(connection, code, message, detail) {
    sendEnvelope(
      connection.ws,
      createErrorEnvelope({
        sessionId: connection.stageSessionId,
        code,
        message,
        detail,
      }),
    )
  }

  /**
   * Sends one JSON envelope over a websocket if open.
   * @param {WebSocket} ws Target websocket.
   * @param {Record<string, unknown>} envelope Outbound envelope payload.
   * @returns {void} Nothing.
   */
  function sendEnvelope(ws, envelope) {
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }

    ws.send(JSON.stringify(envelope))
  }

  /**
   * Fetches an existing session or creates it when absent.
   * @param {string} sessionId Stage session identifier.
   * @returns {{ id: string, createdAt: number, lastSeenAt: number, connectionIds: Set<string> }} Session state.
   */
  function getOrCreateSession(sessionId) {
    const existing = sessions.get(sessionId)
    if (existing) {
      return existing
    }

    const created = {
      id: sessionId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      connectionIds: new Set(),
    }
    sessions.set(sessionId, created)
    return created
  }

  /**
   * Updates last-seen timestamp for a session when traffic is observed.
   * @param {string} sessionId Stage session identifier.
   * @returns {void} Nothing.
   */
  function touchSession(sessionId) {
    const session = getOrCreateSession(sessionId)
    session.lastSeenAt = Date.now()
  }

  /**
   * Returns active connection count for a session.
   * @param {string} sessionId Stage session identifier.
   * @returns {number} Number of active websocket connections in session.
   */
  function getSessionConnectionCount(sessionId) {
    const session = sessions.get(sessionId)
    return session ? session.connectionIds.size : 0
  }

  return {
    start,
    stop,
    getState,
  }
}

/**
 * Rejects an HTTP websocket upgrade with a status code + message.
 * @param {import('node:net').Socket} socket Upgrade socket.
 * @param {number} statusCode HTTP status code.
 * @param {string} message Response body message.
 * @returns {void} Nothing.
 */
function rejectUpgrade(socket, statusCode, message) {
  const reason = statusCode === 404 ? 'Not Found' : 'Bad Request'
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`,
  )
  socket.destroy()
}

/**
 * Parses websocket message data as JSON.
 * @param {Buffer | string} rawData Raw websocket frame payload.
 * @returns {{ ok: true, value: unknown } | { ok: false, error: Error }} JSON parse result.
 */
function parseJsonMessage(rawData) {
  try {
    const text = typeof rawData === 'string' ? rawData : rawData.toString()
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error('Unknown parse failure.'),
    }
  }
}

/**
 * Converts mixed return shapes into an async iterable stream.
 * @param {unknown} value Value, iterable, async iterable, or promise of those.
 * @returns {AsyncGenerator<unknown, void, void>} Async iterable wrapper.
 */
async function* toAsyncIterable(value) {
  const awaited = await value
  if (awaited === null || awaited === undefined) {
    return
  }

  if (isAsyncIterable(awaited)) {
    for await (const item of awaited) {
      yield item
    }
    return
  }

  if (isIterable(awaited)) {
    for (const item of awaited) {
      yield item
    }
    return
  }

  yield awaited
}

/**
 * Checks if a value exposes the async iterable protocol.
 * @param {unknown} value Value to check.
 * @returns {boolean} True when async iterable.
 */
function isAsyncIterable(value) {
  return Boolean(value && typeof value[Symbol.asyncIterator] === 'function')
}

/**
 * Checks if a value exposes the sync iterable protocol.
 * @param {unknown} value Value to check.
 * @returns {boolean} True when iterable.
 */
function isIterable(value) {
  return Boolean(value && typeof value[Symbol.iterator] === 'function')
}

/**
 * Reads a request pathname from URL-like input.
 * @param {string | undefined} requestUrl Incoming request URL.
 * @returns {string} Parsed pathname.
 */
function readPathname(requestUrl) {
  const parsed = new URL(requestUrl ?? '/', 'http://localhost')
  return parsed.pathname || '/'
}

/**
 * Reads a non-empty trimmed string value.
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
 * Reads a string without trimming semantics.
 * @param {unknown} value Unknown value.
 * @returns {string | null} String value or null.
 */
function readString(value) {
  return typeof value === 'string' ? value : null
}

/**
 * Coerces unknown values into plain object records.
 * @param {unknown} value Unknown candidate object.
 * @returns {Record<string, unknown> | null} Object record or null.
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value
}

/**
 * Closes an HTTP server using Promise form.
 * @param {http.Server} server HTTP server instance.
 * @returns {Promise<void>} Promise resolved when close completes.
 */
function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

/**
 * Closes a WebSocketServer using Promise form.
 * @param {WebSocketServer} server WebSocket server instance.
 * @returns {Promise<void>} Promise resolved when close completes.
 */
function closeWebSocketServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

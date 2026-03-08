/**
 * Local websocket bridge service that manages sessions and relays stage commands.
 */

import crypto from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const WSS_PORT = 5174
const STAGE_BRIDGE_PROTOCOL_VERSION = 1
const SUPPORTED_STAGE_COMMANDS = new Set(['load_model', 'model_motion', 'model_focus'])
const wss = new WebSocketServer({ port: WSS_PORT })

console.log(`[MIKU-BRIDGE] WebSocket bridge listening on :${WSS_PORT}`)

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return
  }

  ws.send(JSON.stringify(payload))
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value
}

function readType(message) {
  return typeof message?.type === 'string' ? message.type : null
}

function readCommandName(message) {
  const payload = asObject(message?.payload)
  if (!payload) {
    return null
  }

  const command =
    (typeof payload.command === 'string' && payload.command) ||
    (typeof payload.name === 'string' && payload.name) ||
    null

  if (!command) {
    return null
  }

  return command
}

function readUserText(message) {
  const payload = asObject(message?.payload)
  if (!payload) {
    return null
  }
  if (typeof payload.text !== 'string') {
    return null
  }
  const text = payload.text.trim()
  return text || null
}

function broadcastExcept(sender, payload) {
  const encoded = JSON.stringify(payload)

  wss.clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(encoded)
    }
  })
}

wss.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID()

  console.log(`[MIKU-BRIDGE] Client connected (${req.url || '/'}) session=${sessionId}`)

  sendJson(ws, {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'session_init',
    sessionId,
    payload: {
      sessionId,
      bridge: 'miku-bridge',
      connectedClients: wss.clients.size,
    },
  })

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      const type = readType(message) || 'unknown'
      const protocolVersion =
        typeof message?.v === 'number' && Number.isFinite(message.v) ? message.v : null

      console.log(
        `[MIKU-BRIDGE] Received ${type}${protocolVersion ? ` (v${protocolVersion})` : ''}`,
      )

      if (type === 'ping') {
        sendJson(ws, {
          v: STAGE_BRIDGE_PROTOCOL_VERSION,
          type: 'pong',
          sessionId,
          payload: message?.payload ?? null,
        })
        return
      }

      if (type === 'session_ready') {
        sendJson(ws, {
          v: STAGE_BRIDGE_PROTOCOL_VERSION,
          type: 'session_init',
          sessionId,
          payload: {
            sessionId,
            bridge: 'miku-bridge',
            connectedClients: wss.clients.size,
          },
        })
        return
      }

      if (type === 'user_text') {
        const text = readUserText(message)
        if (!text) {
          sendJson(ws, {
            v: STAGE_BRIDGE_PROTOCOL_VERSION,
            type: 'error',
            sessionId,
            payload: {
              code: 'bad_user_text',
              message: 'Missing text payload',
            },
          })
          return
        }

        const reply = `I heard: ${text}`
        const midpoint = Math.ceil(reply.length / 2)
        const runId = crypto.randomUUID()

        sendJson(ws, {
          v: STAGE_BRIDGE_PROTOCOL_VERSION,
          type: 'assistant_text_delta',
          sessionId,
          payload: {
            runId,
            delta: reply.slice(0, midpoint),
          },
        })

        setTimeout(() => {
          sendJson(ws, {
            v: STAGE_BRIDGE_PROTOCOL_VERSION,
            type: 'assistant_text_delta',
            sessionId,
            payload: {
              runId,
              delta: reply.slice(midpoint),
            },
          })
          sendJson(ws, {
            v: STAGE_BRIDGE_PROTOCOL_VERSION,
            type: 'assistant_text_done',
            sessionId,
            payload: {
              runId,
              finalText: reply,
            },
          })
          sendJson(ws, {
            v: STAGE_BRIDGE_PROTOCOL_VERSION,
            type: 'stage.command',
            sessionId,
            payload: {
              command: 'model_motion',
              payload: {
                motion: 'Happy',
              },
            },
          })
        }, 120)
        return
      }

      if (type === 'stage.command' || type === 'stage_command' || type === 'command') {
        const command = readCommandName(message)
        if (!command) {
          sendJson(ws, {
            v: STAGE_BRIDGE_PROTOCOL_VERSION,
            type: 'error',
            sessionId,
            payload: {
              code: 'bad_command',
              message: 'Missing command field in stage command envelope',
            },
          })
          return
        }

        if (!SUPPORTED_STAGE_COMMANDS.has(command)) {
          sendJson(ws, {
            v: STAGE_BRIDGE_PROTOCOL_VERSION,
            type: 'error',
            sessionId,
            payload: {
              code: 'unsupported_command',
              message: `Unsupported stage command: ${command}`,
            },
          })
          return
        }
      }

      const relay = {
        ...message,
        v:
          typeof message?.v === 'number' && Number.isFinite(message.v)
            ? message.v
            : STAGE_BRIDGE_PROTOCOL_VERSION,
        sessionId: typeof message?.sessionId === 'string' ? message.sessionId : sessionId,
      }

      broadcastExcept(ws, relay)
    } catch (err) {
      console.error('[MIKU-BRIDGE] Failed to parse message:', err)
    }
  })

  ws.on('close', () => {
    console.log(`[MIKU-BRIDGE] Client disconnected session=${sessionId}`)
  })
})

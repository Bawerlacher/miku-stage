/**
 * OpenClaw gateway frame/protocol helpers used by the orchestrator adapter layer.
 */

export const OPENCLAW_PROTOCOL_VERSION = 3
export const DEFAULT_OPENCLAW_GATEWAY_WS_URL = 'ws://127.0.0.1:18789'
export const DEFAULT_OPENCLAW_CLIENT_ID = 'gateway-client'
export const DEFAULT_OPENCLAW_CLIENT_MODE = 'backend'
export const DEFAULT_OPENCLAW_CLIENT_VERSION = '0.0.0'
export const DEFAULT_OPENCLAW_ROLE = 'operator'
export const DEFAULT_OPENCLAW_SCOPES = ['operator.write']

/**
 * Builds an OpenClaw `connect` request payload.
 * @param {{ protocolVersion: number, clientId: string, clientDisplayName?: string, clientVersion: string, clientPlatform: string, clientMode: string, role: string, scopes: string[], authToken?: string, authDeviceToken?: string, authPassword?: string, device?: Record<string, unknown> }} input Connect payload fields.
 * @returns {Record<string, unknown>} Connect params object for gateway handshake.
 */
export function createOpenClawConnectParams(input) {
  const auth = {}
  if (input.authToken) {
    auth.token = input.authToken
  }
  if (input.authDeviceToken) {
    auth.deviceToken = input.authDeviceToken
  }
  if (input.authPassword) {
    auth.password = input.authPassword
  }

  return {
    minProtocol: input.protocolVersion,
    maxProtocol: input.protocolVersion,
    client: {
      id: input.clientId,
      displayName: input.clientDisplayName,
      version: input.clientVersion,
      platform: input.clientPlatform,
      mode: input.clientMode,
    },
    role: input.role,
    scopes: input.scopes,
    ...(input.device ? { device: input.device } : {}),
    ...(Object.keys(auth).length > 0 ? { auth } : {}),
  }
}

/**
 * Builds a generic OpenClaw request frame.
 * @param {{ id: string, method: string, params?: unknown }} input Frame fields.
 * @returns {{ type: string, id: string, method: string, params?: unknown }} OpenClaw request frame.
 */
export function createOpenClawRequestFrame(input) {
  return {
    type: 'req',
    id: input.id,
    method: input.method,
    ...(input.params === undefined ? {} : { params: input.params }),
  }
}

/**
 * Normalizes unknown websocket payload into a gateway frame object.
 * @param {unknown} value Parsed JSON websocket payload.
 * @returns {Record<string, unknown> | null} Frame object or null when malformed.
 */
export function parseOpenClawFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value
}

/**
 * Checks whether a parsed gateway frame is a response frame.
 * @param {Record<string, unknown> | null} frame Parsed gateway frame object.
 * @returns {boolean} True when frame is of type `res`.
 */
export function isOpenClawResponseFrame(frame) {
  return Boolean(frame && frame.type === 'res' && typeof frame.id === 'string')
}

/**
 * Checks whether a parsed gateway frame is an event frame.
 * @param {Record<string, unknown> | null} frame Parsed gateway frame object.
 * @returns {boolean} True when frame is of type `event`.
 */
export function isOpenClawEventFrame(frame) {
  return Boolean(frame && frame.type === 'event' && typeof frame.event === 'string')
}

/**
 * Extracts normalized chat event fields from an OpenClaw event frame.
 * @param {Record<string, unknown>} frame Parsed event frame.
 * @returns {{ runId: string, state: string, text: string, errorMessage?: string } | null} Normalized chat event data.
 */
export function readOpenClawChatEvent(frame) {
  if (frame.event !== 'chat') {
    return null
  }

  const payload = asObject(frame.payload)
  if (!payload) {
    return null
  }

  const runId = readTrimmedString(payload.runId)
  const state = readTrimmedString(payload.state)
  if (!runId || !state) {
    return null
  }

  return {
    runId,
    state,
    text: extractChatMessageText(payload.message),
    errorMessage: readString(payload.errorMessage) ?? undefined,
  }
}

/**
 * Extracts nonce from `connect.challenge` event frames.
 * @param {Record<string, unknown>} frame Parsed event frame.
 * @returns {string | null} Challenge nonce or null.
 */
export function readOpenClawConnectChallengeNonce(frame) {
  if (frame.event !== 'connect.challenge') {
    return null
  }

  const payload = asObject(frame.payload)
  if (!payload) {
    return null
  }

  return readTrimmedString(payload.nonce)
}

/**
 * Converts configured gateway URL value into websocket protocol URL.
 * @param {string} value Configured gateway URL.
 * @returns {string} Normalized websocket URL.
 */
export function normalizeOpenClawGatewayUrl(value) {
  const resolved = new URL(value || DEFAULT_OPENCLAW_GATEWAY_WS_URL)
  if (resolved.protocol === 'http:') {
    resolved.protocol = 'ws:'
  } else if (resolved.protocol === 'https:') {
    resolved.protocol = 'wss:'
  }
  return resolved.toString()
}

/**
 * Builds the OpenClaw v3 device-auth signature payload string.
 * @param {{ deviceId: string, clientId: string, clientMode: string, role: string, scopes: string[], signedAtMs: number, token?: string | null, nonce: string, platform?: string, deviceFamily?: string }} input Device-auth payload fields.
 * @returns {string} Canonical v3 payload string.
 */
export function buildOpenClawDeviceAuthPayloadV3(input) {
  const scopes = input.scopes.join(',')
  const token = input.token ?? ''
  const platform = normalizeDeviceMetadataForAuth(input.platform)
  const deviceFamily = normalizeDeviceMetadataForAuth(input.deviceFamily)
  return [
    'v3',
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    scopes,
    String(input.signedAtMs),
    token,
    input.nonce,
    platform,
    deviceFamily,
  ].join('|')
}

/**
 * Builds the OpenClaw v2 device-auth signature payload string.
 * @param {{ deviceId: string, clientId: string, clientMode: string, role: string, scopes: string[], signedAtMs: number, token?: string | null, nonce: string }} input Device-auth payload fields.
 * @returns {string} Canonical v2 payload string.
 */
export function buildOpenClawDeviceAuthPayloadV2(input) {
  const scopes = input.scopes.join(',')
  const token = input.token ?? ''
  return [
    'v2',
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    scopes,
    String(input.signedAtMs),
    token,
    input.nonce,
  ].join('|')
}

/**
 * Extracts assistant text from OpenClaw chat payload `message` objects.
 * @param {unknown} message Chat payload message field.
 * @returns {string} Extracted text content.
 */
function extractChatMessageText(message) {
  if (typeof message === 'string') {
    return message
  }

  const messageObject = asObject(message)
  if (!messageObject) {
    return ''
  }

  if (typeof messageObject.text === 'string') {
    return messageObject.text
  }

  const content = Array.isArray(messageObject.content) ? messageObject.content : []
  const textParts = content
    .map((entry) => {
      const block = asObject(entry)
      if (!block) {
        return ''
      }
      return typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)

  return textParts.join('')
}

/**
 * Normalizes optional metadata fields for device-auth payloads.
 * @param {unknown} value Metadata field value.
 * @returns {string} Trimmed lowercase ASCII metadata value.
 */
function normalizeDeviceMetadataForAuth(value) {
  if (typeof value !== 'string') {
    return ''
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32))
}

/**
 * Reads a non-empty trimmed string from an unknown value.
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
 * Reads a string without trimming.
 * @param {unknown} value Unknown value.
 * @returns {string | null} String value or null.
 */
function readString(value) {
  return typeof value === 'string' ? value : null
}

/**
 * Coerces unknown values into plain object records.
 * @param {unknown} value Unknown value.
 * @returns {Record<string, unknown> | null} Object record or null.
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value
}

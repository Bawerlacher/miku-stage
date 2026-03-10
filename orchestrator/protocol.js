/**
 * Protocol parsing and envelope builders for Stage Orchestrator websocket traffic.
 */
import {
  STAGE_BRIDGE_PROTOCOL_VERSION,
  SUPPORTED_STAGE_COMMANDS,
} from './constants.js'

const DIRECT_STAGE_COMMAND_TYPES = new Set([
  'load_model',
  'model_motion',
  'model_focus',
])

const STRUCTURED_STAGE_COMMAND_TYPES = new Set([
  'stage.command',
  'stage_command',
  'command',
])

const PASSTHROUGH_EVENT_TYPES = new Set([
  'ui_event',
  'client_error',
  'user_audio_start',
  'user_audio_chunk',
  'user_audio_end',
])

const INTERRUPT_EVENT_TYPES = new Set([
  'interrupt',
  'stage_interrupt',
])

/**
 * Parses a raw client websocket message into a validated routing object.
 * @param {unknown} rawEnvelope Raw JSON-decoded message payload.
 * @returns {{ ok: true, message: Record<string, unknown> } | { ok: false, error: { code: string, message: string, detail?: unknown } }}
 */
export function parseIncomingClientEnvelope(rawEnvelope) {
  const envelope = asObject(rawEnvelope)
  if (!envelope) {
    return invalid('bad_envelope', 'Message must be a JSON object.')
  }

  const sourceType = readTrimmedString(envelope.type)
  if (!sourceType) {
    return invalid('bad_envelope_type', 'Message is missing a valid "type" field.')
  }

  const protocolVersion = readFiniteNumber(envelope.v) ?? undefined
  const envelopeSessionId = readTrimmedString(envelope.sessionId) ?? undefined
  const payload = asObject(envelope.payload) ?? {}

  if (sourceType === 'session_ready') {
    return valid({
      kind: 'session_ready',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
      requestedSessionId:
        readTrimmedString(payload.stageSessionId) ??
        readTrimmedString(payload.sessionId) ??
        undefined,
    })
  }

  if (sourceType === 'ping') {
    return valid({
      kind: 'ping',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
    })
  }

  if (sourceType === 'pong') {
    return valid({
      kind: 'pong',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
    })
  }

  if (sourceType === 'user_text') {
    const text = readTrimmedString(payload.text)
    if (!text) {
      return invalid('bad_user_text', 'Message type "user_text" requires payload.text.')
    }

    return valid({
      kind: 'user_text',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
      text,
    })
  }

  if (INTERRUPT_EVENT_TYPES.has(sourceType)) {
    return valid({
      kind: 'interrupt',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
      runId:
        readTrimmedString(payload.runId) ??
        readTrimmedString(payload.responseId) ??
        undefined,
      reason: readTrimmedString(payload.reason) ?? undefined,
    })
  }

  if (DIRECT_STAGE_COMMAND_TYPES.has(sourceType)) {
    return valid({
      kind: 'stage_command',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
      command: sourceType,
      commandPayload: payload,
    })
  }

  if (STRUCTURED_STAGE_COMMAND_TYPES.has(sourceType)) {
    const parsed = parseStructuredStageCommand(payload)
    if (!parsed) {
      return invalid(
        'bad_stage_command',
        'Message type "stage.command" requires a supported command field.',
      )
    }

    return valid({
      kind: 'stage_command',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
      command: parsed.command,
      commandPayload: parsed.commandPayload,
    })
  }

  if (PASSTHROUGH_EVENT_TYPES.has(sourceType)) {
    return valid({
      kind: 'client_event',
      sourceType,
      protocolVersion,
      envelopeSessionId,
      payload,
    })
  }

  return invalid(
    'unsupported_type',
    `Unsupported message type "${sourceType}" for Stage Orchestrator.`,
  )
}

/**
 * Builds a `session_init` envelope sent after connection/session binding.
 * @param {{ sessionId: string, connectedClients: number, adapterName: string }} input Session bootstrap fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createSessionInitEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'session_init',
    sessionId: input.sessionId,
    payload: {
      sessionId: input.sessionId,
      bridge: 'stage-orchestrator',
      adapter: input.adapterName,
      connectedClients: input.connectedClients,
    },
  }
}

/**
 * Builds a protocol `pong` response envelope.
 * @param {{ sessionId: string, payload?: Record<string, unknown> }} input Pong metadata and payload.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createPongEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'pong',
    sessionId: input.sessionId,
    payload: input.payload ?? {},
  }
}

/**
 * Builds an assistant streaming delta envelope.
 * @param {{ sessionId: string, runId: string, text: string }} input Assistant streaming chunk fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createAssistantTextDeltaEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'assistant_text_delta',
    sessionId: input.sessionId,
    payload: {
      runId: input.runId,
      delta: input.text,
    },
  }
}

/**
 * Builds an assistant stream completion envelope.
 * @param {{ sessionId: string, runId: string, text: string }} input Assistant completion fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createAssistantTextDoneEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'assistant_text_done',
    sessionId: input.sessionId,
    payload: {
      runId: input.runId,
      finalText: input.text,
    },
  }
}

/**
 * Builds a canonical stage command envelope.
 * @param {{ sessionId: string, command: string, payload?: Record<string, unknown> }} input Stage command fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createStageCommandEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'stage.command',
    sessionId: input.sessionId,
    payload: {
      command: input.command,
      payload: input.payload ?? {},
    },
  }
}

/**
 * Builds an interrupt control envelope.
 * @param {{ sessionId: string, payload?: Record<string, unknown> }} input Interrupt fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createInterruptEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'interrupt',
    sessionId: input.sessionId,
    payload: input.payload ?? {},
  }
}

/**
 * Builds a generic command acknowledgement envelope.
 * @param {{ sessionId: string, event: string, payload?: Record<string, unknown> }} input Ack fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createAckEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'ack',
    sessionId: input.sessionId,
    payload: {
      event: input.event,
      ...(input.payload ?? {}),
    },
  }
}

/**
 * Builds a protocol error envelope for malformed/unsupported messages.
 * @param {{ sessionId: string, code: string, message: string, detail?: unknown }} input Error payload fields.
 * @returns {{ v: number, type: string, sessionId: string, payload: Record<string, unknown> }} Outbound websocket envelope.
 */
export function createErrorEnvelope(input) {
  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: 'error',
    sessionId: input.sessionId,
    payload: {
      code: input.code,
      message: input.message,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  }
}

/**
 * Coerces unknown values into plain objects.
 * @param {unknown} value Unknown value to inspect.
 * @returns {Record<string, unknown> | null} Plain object value or null.
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value
}

/**
 * Reads a non-empty trimmed string from an unknown value.
 * @param {unknown} value Unknown value to parse.
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
 * Reads a finite number from an unknown value.
 * @param {unknown} value Unknown value to parse.
 * @returns {number | null} Finite number or null.
 */
function readFiniteNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null
  }

  return Number.isFinite(value) ? value : null
}

/**
 * Parses structured command envelopes into canonical command + payload fields.
 * @param {Record<string, unknown>} payload Parsed envelope payload object.
 * @returns {{ command: string, commandPayload: Record<string, unknown> } | null} Parsed command or null.
 */
function parseStructuredStageCommand(payload) {
  const command =
    readTrimmedString(payload.command) ??
    readTrimmedString(payload.name) ??
    readTrimmedString(payload.action)

  if (!command || !SUPPORTED_STAGE_COMMANDS.has(command)) {
    return null
  }

  const nestedPayload =
    asObject(payload.payload) ?? asObject(payload.args) ?? asObject(payload.data) ?? payload
  const commandPayload = { ...(nestedPayload ?? {}) }

  delete commandPayload.command
  delete commandPayload.name
  delete commandPayload.action
  delete commandPayload.type

  return { command, commandPayload }
}

/**
 * Creates a successful parse result container.
 * @param {Record<string, unknown>} message Normalized incoming message fields.
 * @returns {{ ok: true, message: Record<string, unknown> }} Successful parse result.
 */
function valid(message) {
  return { ok: true, message }
}

/**
 * Creates a failed parse result container.
 * @param {string} code Machine-readable error code.
 * @param {string} message Human-readable parse failure message.
 * @param {unknown} [detail] Optional detail payload for debugging.
 * @returns {{ ok: false, error: { code: string, message: string, detail?: unknown } }} Failed parse result.
 */
function invalid(code, message, detail) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(detail === undefined ? {} : { detail }),
    },
  }
}

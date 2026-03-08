/**
 * Shared bridge protocol types and normalization helpers for stage messages.
 */
export const STAGE_BRIDGE_PROTOCOL_VERSION = 1

export type StageCommandName = 'load_model' | 'model_motion' | 'model_focus'

export type StageCommand = {
  name: StageCommandName
  payload: Record<string, unknown>
}

export type StageBridgeEnvelope = {
  v?: number
  type: string
  sessionId?: string
  payload?: unknown
  event?: string
}

export type StageBridgeIncoming =
  | {
      kind: 'session_init'
      sessionId?: string
      payload: Record<string, unknown>
      protocolVersion?: number
      sourceType: string
    }
  | {
      kind: 'ping'
      sessionId?: string
      payload: Record<string, unknown>
      protocolVersion?: number
    }
  | {
      kind: 'stage_command'
      sessionId?: string
      command: StageCommand
      protocolVersion?: number
      sourceType: string
    }
  | {
      kind: 'assistant_text'
      phase: 'delta' | 'done'
      text: string
      runId?: string
      payload: Record<string, unknown>
    }
  | {
      kind: 'unsupported'
      sourceType: string
      reason: string
    }

const DIRECT_TYPE_TO_COMMAND: Record<string, StageCommandName | undefined> = {
  load_model: 'load_model',
  model_motion: 'model_motion',
  model_focus: 'model_focus',
}

const COMMAND_ALIASES: Record<string, StageCommandName | undefined> = {
  load_model: 'load_model',
  model_load: 'load_model',
  'model.load': 'load_model',
  model_motion: 'model_motion',
  motion: 'model_motion',
  'model.motion': 'model_motion',
  model_focus: 'model_focus',
  focus: 'model_focus',
  'model.focus': 'model_focus',
}

export function normalizeIncomingStageMessage(raw: unknown): StageBridgeIncoming | null {
  const envelope = asObject(raw)
  if (!envelope) {
    return null
  }

  const sourceType = readString(envelope.type)
  if (!sourceType) {
    return null
  }

  const protocolVersion = readNumber(envelope.v) ?? undefined
  const sessionId = readString(envelope.sessionId) ?? undefined
  const payload = asObject(envelope.payload) ?? {}

  if (sourceType === 'session_init') {
    return { kind: 'session_init', sessionId, payload, protocolVersion, sourceType }
  }

  if (sourceType === 'ping') {
    return { kind: 'ping', sessionId, payload, protocolVersion }
  }

  if (
    sourceType === 'assistant_text_delta' ||
    sourceType === 'assistant_text_done' ||
    sourceType === 'assistant_text'
  ) {
    const phase =
      sourceType === 'assistant_text_done'
        ? 'done'
        : sourceType === 'assistant_text_delta'
          ? 'delta'
          : readString(payload.phase) === 'done'
            ? 'done'
            : 'delta'
    const text = extractAssistantText(payload, phase)
    const runId = readString(payload.runId) ?? readString(payload.responseId) ?? undefined
    return { kind: 'assistant_text', phase, text, runId, payload }
  }

  const directCommand = DIRECT_TYPE_TO_COMMAND[sourceType]
  if (directCommand) {
    return {
      kind: 'stage_command',
      sessionId,
      protocolVersion,
      sourceType,
      command: {
        name: directCommand,
        payload,
      },
    }
  }

  if (sourceType === 'stage.command' || sourceType === 'stage_command' || sourceType === 'command') {
    const parsed = parseStructuredCommand(payload)
    if (!parsed) {
      return {
        kind: 'unsupported',
        sourceType,
        reason: 'missing or invalid command field in stage command envelope',
      }
    }

    return {
      kind: 'stage_command',
      sessionId,
      protocolVersion,
      sourceType,
      command: parsed,
    }
  }

  if (sourceType === 'event') {
    const eventName = readString(envelope.event)
    if (!eventName) {
      return {
        kind: 'unsupported',
        sourceType,
        reason: 'event message missing event name',
      }
    }

    const eventCommand = COMMAND_ALIASES[eventName]
    if (eventCommand) {
      return {
        kind: 'stage_command',
        sessionId,
        protocolVersion,
        sourceType: `event:${eventName}`,
        command: {
          name: eventCommand,
          payload,
        },
      }
    }

    if (eventName === 'stage.command' || eventName === 'stage_command') {
      const parsed = parseStructuredCommand(payload)
      if (!parsed) {
        return {
          kind: 'unsupported',
          sourceType,
          reason: `event ${eventName} missing or invalid command field`,
        }
      }

      return {
        kind: 'stage_command',
        sessionId,
        protocolVersion,
        sourceType: `event:${eventName}`,
        command: parsed,
      }
    }
  }

  return {
    kind: 'unsupported',
    sourceType,
    reason: 'message type not supported by stage runtime',
  }
}

export function buildStageCommandEnvelope(input: {
  command: StageCommandName
  payload?: Record<string, unknown>
  sessionId?: string
}): StageBridgeEnvelope {
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

function parseStructuredCommand(payload: Record<string, unknown>): StageCommand | null {
  const commandValue =
    readString(payload.command) ||
    readString(payload.name) ||
    readString(payload.action) ||
    readString(payload.type)

  const normalized = commandValue ? COMMAND_ALIASES[commandValue] : undefined
  if (!normalized) {
    return null
  }

  const commandPayloadSource =
    asObject(payload.payload) ?? asObject(payload.args) ?? asObject(payload.data) ?? payload
  const commandPayload = { ...(commandPayloadSource ?? {}) }
  delete commandPayload.command
  delete commandPayload.name
  delete commandPayload.action
  delete commandPayload.type

  return {
    name: normalized,
    payload: commandPayload,
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null
  }
  return value
}

function extractAssistantText(payload: Record<string, unknown>, phase: 'delta' | 'done') {
  const candidates: unknown[] = [
    payload.text,
    payload.delta,
    payload.chunk,
    phase === 'done' ? payload.finalText : null,
  ]

  for (const value of candidates) {
    if (typeof value === 'string') {
      return value
    }
  }

  return ''
}

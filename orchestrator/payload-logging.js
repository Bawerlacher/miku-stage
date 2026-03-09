/**
 * Shared payload logging helpers for Stage Orchestrator debug tracing.
 */
import process from 'node:process'

const DEFAULT_PAYLOAD_LOGGING_ENABLED = true
const DEFAULT_PAYLOAD_MAX_CHARS = 6_000

/**
 * Creates a payload logger for structured Stage Orchestrator traces.
 * @param {{ logger?: Console, enabled?: unknown, maxChars?: unknown }} [input] Logger options.
 * @returns {(direction: string, payload: unknown, meta?: Record<string, string>) => void} Payload logging function.
 */
export function createPayloadLogger(input = {}) {
  const logger = input.logger ?? console
  const enabled = readBooleanFromEnv(
    input.enabled ?? process.env.STAGE_ORCHESTRATOR_LOG_PAYLOADS,
    DEFAULT_PAYLOAD_LOGGING_ENABLED,
  )
  const maxChars = readPositiveIntegerFromEnv(
    input.maxChars ?? process.env.STAGE_ORCHESTRATOR_LOG_PAYLOAD_MAX_CHARS,
    DEFAULT_PAYLOAD_MAX_CHARS,
  )

  /**
   * Logs one payload entry when enabled.
   * @param {string} direction Log direction label.
   * @param {unknown} payload Payload object/string.
   * @param {Record<string, string>} [meta] Context metadata map.
   * @returns {void} Nothing.
   */
  return function logPayload(direction, payload, meta = {}) {
    if (!enabled) {
      return
    }

    const metaText = Object.entries(meta)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')

    logger.info(
      `[STAGE-ORCH] ${direction}${metaText ? ` ${metaText}` : ''} payload=${serializePayloadForLog(payload, maxChars)}`,
    )
  }
}

/**
 * Reads boolean-ish env values with fallback.
 * @param {unknown} value Unknown env-like input.
 * @param {boolean} fallbackValue Fallback value.
 * @returns {boolean} Parsed boolean.
 */
function readBooleanFromEnv(value, fallbackValue) {
  if (typeof value === 'boolean') {
    return value
  }

  const normalized = readTrimmedString(value)?.toLowerCase()
  if (!normalized) {
    return fallbackValue
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }

  return fallbackValue
}

/**
 * Reads positive integer env values with fallback.
 * @param {unknown} value Unknown env-like input.
 * @param {number} fallbackValue Fallback value.
 * @returns {number} Positive integer.
 */
function readPositiveIntegerFromEnv(value, fallbackValue) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }

  const parsed = Number.parseInt(readTrimmedString(value) ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue
}

/**
 * Serializes payload values for log output without throwing on circular refs.
 * @param {unknown} payload Payload candidate.
 * @param {number} maxChars Maximum serialized length.
 * @returns {string} Safe serialized payload string.
 */
function serializePayloadForLog(payload, maxChars) {
  const seen = new WeakSet()

  let serialized = ''
  try {
    serialized = JSON.stringify(payload, (_key, value) => {
      if (typeof value === 'bigint') {
        return `${value.toString()}n`
      }

      if (value && typeof value === 'object') {
        if (seen.has(value)) {
          return '[Circular]'
        }
        seen.add(value)
      }

      return value
    })
  } catch {
    serialized = String(payload)
  }

  if (typeof serialized !== 'string') {
    serialized = String(payload)
  }

  if (serialized.length <= maxChars) {
    return serialized
  }

  const truncatedCount = serialized.length - maxChars
  return `${serialized.slice(0, maxChars)}...<truncated ${truncatedCount} chars>`
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

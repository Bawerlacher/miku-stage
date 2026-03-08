/**
 * Shared configuration normalization helpers for orchestrator startup values.
 */
import {
  DEFAULT_ORCHESTRATOR_PORT,
  DEFAULT_ORCHESTRATOR_WS_PATH,
} from './constants.js'

/**
 * Parses and validates an orchestrator TCP port.
 * @param {unknown} value Raw port value from caller/environment.
 * @param {number} [fallbackPort] Fallback port when value is invalid.
 * @returns {number} Valid TCP port value.
 */
export function normalizePort(
  value,
  fallbackPort = DEFAULT_ORCHESTRATOR_PORT,
) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN

  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed
  }

  return fallbackPort
}

/**
 * Parses and validates an orchestrator websocket path.
 * @param {unknown} value Raw path value from caller/environment.
 * @param {string} [fallbackPath] Fallback path when value is invalid.
 * @returns {string} Normalized websocket path beginning with '/'.
 */
export function normalizeWsPath(
  value,
  fallbackPath = DEFAULT_ORCHESTRATOR_WS_PATH,
) {
  if (typeof value !== 'string') {
    return fallbackPath
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return fallbackPath
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

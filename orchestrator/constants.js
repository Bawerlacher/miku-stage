/**
 * Shared constants for Stage Orchestrator runtime and protocol behavior.
 */
export const STAGE_BRIDGE_PROTOCOL_VERSION = 1
export const DEFAULT_ORCHESTRATOR_PORT = 5174
export const DEFAULT_ORCHESTRATOR_WS_PATH = '/live/ws'
export const SUPPORTED_STAGE_COMMANDS = new Set([
  'load_model',
  'model_motion',
  'model_focus',
])

/**
 * Adapter registry for choosing orchestrator backend integrations.
 */
import { createEchoStageAdapter } from './echo-stage-adapter.js'

/**
 * Creates a backend adapter from explicit config or environment fallback.
 * @param {{ adapterName?: string }} [input] Optional adapter selection.
 * @returns {{ name: string, onUserText?: (input: Record<string, unknown>) => unknown, onClientEvent?: (input: Record<string, unknown>) => unknown }} Adapter implementation.
 */
export function createStageBackendAdapter(input = {}) {
  const requested = (input.adapterName ?? process.env.STAGE_BACKEND_ADAPTER ?? 'echo')
    .trim()
    .toLowerCase()

  switch (requested) {
    case 'echo':
      return createEchoStageAdapter()
    default:
      throw new Error(
        `Unsupported stage backend adapter "${requested}". Supported adapters: echo.`,
      )
  }
}

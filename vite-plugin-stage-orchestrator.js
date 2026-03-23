/**
 * Vite plugin that attaches the Stage Orchestrator to the Vite dev server.
 *
 * Eliminates the need to run the orchestrator as a separate process during
 * development. The orchestrator shares Vite's HTTP server and handles WebSocket
 * upgrades at the configured wsPath directly.
 */
import {
  DEFAULT_ORCHESTRATOR_WS_PATH,
} from './orchestrator/constants.js'
import { normalizeWsPath } from './orchestrator/config.js'
import { createStageOrchestratorServer } from './orchestrator/stage-orchestrator-server.js'

/**
 * Creates a Vite plugin that embeds the Stage Orchestrator into the dev server.
 * @param {{ wsPath?: string }} [options] Plugin options.
 * @returns {import('vite').Plugin} Vite plugin.
 */
export function stageOrchestratorPlugin(options = {}) {
  const wsPath = normalizeWsPath(
    options.wsPath ?? process.env.STAGE_ORCHESTRATOR_WS_PATH,
    DEFAULT_ORCHESTRATOR_WS_PATH,
  )

  return {
    name: 'vite-plugin-stage-orchestrator',

    configureServer(viteServer) {
      if (!viteServer.httpServer) {
        console.warn('[STAGE-ORCH] No HTTP server available — skipping orchestrator attach.')
        return
      }

      const orchestrator = createStageOrchestratorServer({
        wsPath,
        externalHttpServer: viteServer.httpServer,
      })

      orchestrator.start()

      viteServer.middlewares.use('/healthz', (_req, res) => {
        const state = orchestrator.getState()
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, ...state }))
      })

      viteServer.httpServer.once('close', () => {
        void orchestrator.stop()
      })
    },
  }
}

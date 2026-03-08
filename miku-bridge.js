/**
 * Local entrypoint that starts the Stage Orchestrator development service.
 */
import {
  DEFAULT_ORCHESTRATOR_PORT,
  DEFAULT_ORCHESTRATOR_WS_PATH,
} from './orchestrator/constants.js'
import {
  normalizePort,
  normalizeWsPath,
} from './orchestrator/config.js'
import { createStageOrchestratorServer } from './orchestrator/stage-orchestrator-server.js'

const port = normalizePort(
  process.env.STAGE_ORCHESTRATOR_PORT,
  DEFAULT_ORCHESTRATOR_PORT,
)
const wsPath = normalizeWsPath(
  process.env.STAGE_ORCHESTRATOR_WS_PATH,
  DEFAULT_ORCHESTRATOR_WS_PATH,
)

const orchestrator = createStageOrchestratorServer({ port, wsPath })

orchestrator.start()
bindShutdownSignals(orchestrator)

/**
 * Adds process signal handlers for graceful shutdown.
 * @param {{ stop: () => Promise<void> }} server Orchestrator server controller.
 * @returns {void} Nothing.
 */
function bindShutdownSignals(server) {
  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

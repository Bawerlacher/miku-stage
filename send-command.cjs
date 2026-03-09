/**
 * CLI helper that sends bridge protocol commands to a stage websocket endpoint.
 */
const WebSocket = require('ws')

const STAGE_BRIDGE_PROTOCOL_VERSION = 1
const DEFAULT_URL = 'ws://127.0.0.1:5174/live/ws'
const CLOSE_AFTER_MS = 1500

const STAGE_COMMANDS = new Set(['load_model', 'model_motion', 'model_focus'])

const args = process.argv.slice(2)
const commandArg = args[0]
const payloadArg = args[1]
const sessionIdArg = args[2]
const wsUrlArg = args[3]

if (!commandArg || commandArg === '--help' || commandArg === '-h') {
  printUsage()
  process.exit(0)
}

let payload = {}
if (payloadArg) {
  try {
    payload = JSON.parse(payloadArg)
  } catch (error) {
    console.error(`Invalid JSON payload: ${error.message}`)
    process.exit(1)
  }
}

const message = buildMessage({
  command: commandArg,
  payload,
  sessionId: sessionIdArg || undefined,
})
const wsUrl = resolveWsUrl(wsUrlArg || DEFAULT_URL, sessionIdArg || undefined)

const ws = new WebSocket(wsUrl)

ws.on('open', () => {
  console.log(`Connected: ${wsUrl}`)
  console.log(`Sending: ${JSON.stringify(message)}`)
  ws.send(JSON.stringify(message))
  setTimeout(() => ws.close(), CLOSE_AFTER_MS)
})

ws.on('message', (data) => {
  try {
    const parsed = JSON.parse(data.toString())
    console.log(`Reply: ${JSON.stringify(parsed, null, 2)}`)
  } catch {
    console.log(`Reply (raw): ${data.toString()}`)
  }
})

ws.on('close', () => {
  console.log('Closed')
})

ws.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`)
})

function buildMessage({ command, payload, sessionId }) {
  if (command === 'ping' || command === 'session_ready') {
    return {
      v: STAGE_BRIDGE_PROTOCOL_VERSION,
      type: command,
      sessionId,
      payload,
    }
  }

  if (STAGE_COMMANDS.has(command)) {
    return {
      v: STAGE_BRIDGE_PROTOCOL_VERSION,
      type: 'stage.command',
      sessionId,
      payload: {
        command,
        payload,
      },
    }
  }

  return {
    v: STAGE_BRIDGE_PROTOCOL_VERSION,
    type: command,
    sessionId,
    payload,
  }
}

function resolveWsUrl(rawUrl, sessionId) {
  const parsed = new URL(rawUrl)
  if (!sessionId) {
    return parsed.toString()
  }

  // Ensure this sender socket joins the same orchestrator session as the stage client.
  parsed.searchParams.set('stageSessionId', sessionId)
  return parsed.toString()
}

function printUsage() {
  console.log('Usage:')
  console.log('  node send-command.cjs <command> [payloadJson] [sessionId] [wsUrl]')
  console.log('')
  console.log('Examples:')
  console.log('  node send-command.cjs model_motion \'{"motion":"tap_body"}\'')
  console.log('  node send-command.cjs model_focus \'{"x":500,"y":420,"scale":0.85}\'')
  console.log(
    '  node send-command.cjs load_model \'{"modelUrl":"https://.../haru_greeter_t03.model3.json"}\'',
  )
  console.log(
    '  node send-command.cjs session_ready \'{"client":"openclaw-agent"}\' my-session ws://127.0.0.1:5174/live/ws',
  )
}

# Miku Stage

Vue + Pixi + Live2D interactive stage controlled by a Stage Orchestrator over WebSocket. Supports real-time chat, markdown rendering, Live2D model animation, and OpenClaw backend integration.

## What it does

- Boots Pixi into a full-screen transparent canvas over a CSS space/nebula background.
- Loads the local Cubism runtime from `public/libs/live2dcubismcore.min.js`.
- Loads a Live2D model (default: `public/live2d/miku.model3.json`).
- Connects to the Stage Orchestrator over WebSocket at `/live/ws`.
- Renders assistant responses as markdown (headers, bold, lists, code blocks).
- Applies model motions, focus, and expressions from orchestrator commands.

## Development

```sh
npm install
npm run dev
```

`npm run dev` starts Vite and the Stage Orchestrator in a single process. No second terminal needed. The orchestrator is embedded into the Vite dev server via `vite-plugin-stage-orchestrator.js`.

### Backend adapter

By default the orchestrator uses the echo adapter (mirrors your input back). To connect to OpenClaw:

```sh
STAGE_BACKEND_ADAPTER=openclaw \
OPENCLAW_GATEWAY_TOKEN='<gateway token>' \
npm run dev
```

`OPENCLAW_GATEWAY_TOKEN` can be found in `~/.openclaw/openclaw.json` under `gateway.auth.token`.

## Model configuration

Override the default model by either:

- Passing `?model=https://example.com/model.model3.json` in the URL
- Setting `window.__mikuStageConfig__ = { modelUrl: '...' }` before the app boots

## WebSocket protocol

The browser connects to `/live/ws`. All messages use a JSON envelope:

```json
{ "type": "user_text", "sessionId": "abc123", "payload": { "text": "Hello" } }
```

### Browser → Orchestrator

| Type | Description |
|---|---|
| `session_ready` | Sent on connect; announces client name and page URL |
| `user_text` | Chat message from the user |
| `interrupt` | Cancel an in-flight assistant run |
| `stage_command` | Direct stage command relay |
| `client_event` | Generic pass-through event |
| `ping` / `pong` | Keepalive |

### Orchestrator → Browser

| Type | Description |
|---|---|
| `session_init` | Session bootstrap; confirms session ID and adapter |
| `assistant_text_delta` | Streaming text chunk |
| `assistant_text_done` | End of assistant turn |
| `model_motion` | Play a named motion group |
| `model_focus` | Set model position/scale |
| `load_model` | Load a new model URL |
| `interrupt` | Stop active assistant run |
| `error` | Protocol or adapter error |
| `ack` | Delivery acknowledgement |
| `ping` / `pong` | Keepalive |

### Supported stage commands

- `load_model`: `{ modelUrl: string }`
- `model_motion`: `{ motion: string }`
- `model_focus`: `{ x?: number, y?: number, scale?: number }`

## Pairing setup (OpenClaw adapter)

When the OpenClaw adapter is used, it connects to the OpenClaw gateway as a device client and must be paired once per device identity.

### 1. Start with OpenClaw adapter

```sh
STAGE_BACKEND_ADAPTER=openclaw \
OPENCLAW_GATEWAY_TOKEN='<gateway token>' \
npm run dev
```

### 2. Approve the device pairing request

Run in another terminal after the orchestrator attempts to connect:

```sh
openclaw devices list
openclaw devices approve --latest
```

Or by request ID:

```sh
openclaw devices approve <requestId>
```

Subsequent starts reuse the paired identity and skip this step.

### 3. Optional adapter env vars

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `OPENCLAW_GATEWAY_SCOPES` | — | Comma-separated requested scopes |
| `OPENCLAW_GATEWAY_DEVICE_IDENTITY_PATH` | `~/.openclaw/identity/device.json` | Device key file |
| `OPENCLAW_GATEWAY_DEVICE_AUTH_PAYLOAD_VERSION` | `v2` | Signature payload format |
| `OPENCLAW_GATEWAY_DEVICE_TOKEN` | — | Optional device token |
| `STAGE_ORCHESTRATOR_WS_PATH` | `/live/ws` | WebSocket mount path |

### 4. Troubleshooting

- `missing scope: operator.write` — use a token whose scopes include `operator.write` or `operator.admin`.
- `pairing required` — run `openclaw devices list` and approve the pending request.
- `device signature invalid` — keep `OPENCLAW_GATEWAY_DEVICE_AUTH_PAYLOAD_VERSION=v2`.
- WebSocket connection refused — make sure `npm run dev` is running (orchestrator is now embedded in Vite).

## Sending commands from CLI

```sh
node send-command.cjs model_motion '{"motion":"tap_body"}'
node send-command.cjs model_focus '{"x":540,"y":430,"scale":0.85}'
node send-command.cjs load_model '{"modelUrl":"https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json"}'
```

## Running the orchestrator standalone

The orchestrator can still be run as a separate process (e.g. for production or testing without Vite):

```sh
STAGE_BACKEND_ADAPTER=openclaw node miku-bridge.js
```

It listens on port `5174` by default with a healthcheck at `http://127.0.0.1:5174/healthz`.

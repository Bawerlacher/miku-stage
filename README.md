# Miku Stage

Minimal Vue + Pixi + Live2D stage intended to be embedded and controlled by OpenClaw.

## What it does

- Boots Pixi into a full-screen canvas.
- Loads the local Cubism runtime from `public/libs/live2dcubismcore.min.js`.
- Loads a Live2D model (default: the public Shizuku sample model).
- Exposes a small `postMessage` API for OpenClaw to control the stage.

## Bridge protocol

The stage now supports a versioned bridge envelope:

```json
{
  "v": 1,
  "type": "stage.command",
  "sessionId": "optional-session-id",
  "payload": {
    "command": "model_motion",
    "payload": {
      "motion": "tap_body"
    }
  }
}
```

Supported stage commands:

- `load_model`: `{ modelUrl: string }`
- `model_motion`: `{ motion: string }`
- `model_focus`: `{ x?: number, y?: number, scale?: number }`

## Model configuration

Override the default model by either:

- Passing `?model=https://example.com/model.model3.json` in the URL
- Setting `window.__mikuStageConfig__ = { modelUrl: '...' }` before the app boots

## Development

```sh
npm install
npm run dev
```

## Pairing setup (OpenClaw adapter)

When Stage Orchestrator runs with `STAGE_BACKEND_ADAPTER=openclaw`, the adapter uses gateway token auth plus device-auth signing. The device must be approved in OpenClaw pairing before `chat.send` works reliably.

### 1. Start orchestrator with OpenClaw adapter

```sh
STAGE_BACKEND_ADAPTER=openclaw \
OPENCLAW_GATEWAY_TOKEN='<gateway token>' \
npm run orchestrator:dev
```

`OPENCLAW_GATEWAY_TOKEN` can come from `~/.openclaw/openclaw.json` under `gateway.auth.token`.

### 2. Approve pending device pairing

Run these in another terminal after the orchestrator attempts to connect:

```sh
openclaw devices list
openclaw devices approve --latest
```

You can also approve a specific request:

```sh
openclaw devices approve <requestId>
```

### 3. Optional adapter env vars

- `OPENCLAW_GATEWAY_WS_URL` (default: `ws://127.0.0.1:18789`)
- `OPENCLAW_GATEWAY_SCOPES` (comma-separated)
- `OPENCLAW_GATEWAY_DEVICE_IDENTITY_PATH` (default: `~/.openclaw/identity/device.json`)
- `OPENCLAW_GATEWAY_DEVICE_AUTH_PAYLOAD_VERSION` (default: `v2`)
- `OPENCLAW_GATEWAY_DEVICE_TOKEN` (optional token from `~/.openclaw/identity/device-auth.json`)

### 4. Quick troubleshooting

- `missing scope: operator.write`: use a token whose scopes include `operator.write` or `operator.admin`.
- `pairing required`: run `openclaw devices list` and approve the pending request.
- `device signature invalid`: keep `OPENCLAW_GATEWAY_DEVICE_AUTH_PAYLOAD_VERSION=v2` for this runtime.

## Sending commands from CLI

Use one generic script instead of one file per action:

```sh
node send-command.cjs model_motion '{"motion":"tap_body"}'
node send-command.cjs model_focus '{"x":540,"y":430,"scale":0.85}'
node send-command.cjs load_model '{"modelUrl":"https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json"}'
```

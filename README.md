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

## Sending commands from CLI

Use one generic script instead of one file per action:

```sh
node send-command.cjs model_motion '{"motion":"tap_body"}'
node send-command.cjs model_focus '{"x":540,"y":430,"scale":0.85}'
node send-command.cjs load_model '{"modelUrl":"https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json"}'
```

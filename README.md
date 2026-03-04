# Miku Stage

Minimal Vue + Pixi + Live2D stage intended to be embedded and controlled by OpenClaw.

## What it does

- Boots Pixi into a full-screen canvas.
- Loads the local Cubism runtime from `public/libs/live2dcubismcore.min.js`.
- Loads a Live2D model (default: the public Shizuku sample model).
- Exposes a small `postMessage` API for OpenClaw to control the stage.

## Runtime controls

- `MIKU_LOAD`: `{ modelUrl?: string }`
- `MIKU_TALK`: `{ motion?: string }`
- `MIKU_FOCUS`: `{ x?: number, y?: number, scale?: number }`
- `MIKU_PING`: asks the frame to reply with `MIKU_READY`

## Model configuration

Override the default model by either:

- Passing `?model=https://example.com/model.model3.json` in the URL
- Setting `window.__mikuStageConfig__ = { modelUrl: '...' }` before the app boots

## Development

```sh
npm install
npm run dev
```

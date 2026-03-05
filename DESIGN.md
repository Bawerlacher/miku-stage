# Miku Stage Integration Design

## Purpose

This document describes the recommended architecture for turning `miku-stage` into an interactive Live2D client that:

- runs as a normal browser client
- can optionally be embedded inside an OpenClaw canvas
- can later be replaced or complemented by native clients
- displays and animates a Live2D model in a browser/WebView
- accepts user interaction (text, clicks, voice)
- sends those interactions to OpenClaw
- receives commands from OpenClaw to update the model and UI

The goal is to keep rendering in the client, while OpenClaw remains the backend controller.

## Problem Statement

`miku-stage` currently works as a lightweight browser app:

- Vue provides the page shell
- Pixi renders the canvas
- `pixi-live2d-display` loads and animates the model

This is enough to display a model, but not enough for a full interactive assistant.

The missing piece is a reliable runtime protocol between the browser page and OpenClaw so that:

- user input can flow from the page to OpenClaw
- model commands can flow from OpenClaw back to the page
- chat, voice, and animation stay synchronized

## Recommended Architecture

Use a protocol-first design:

- `miku-stage` is primarily a browser client hosted on the OpenClaw server
- the page connects to OpenClaw over a dedicated application WebSocket
- OpenClaw canvas is an optional embedding path for supported native nodes
- future native clients should implement the same session protocol instead of depending on canvas

### Core Principle

The browser owns rendering.
OpenClaw owns intelligence and orchestration.

That means:

- the page owns Pixi, Live2D, DOM input, and audio playback
- OpenClaw owns conversation state, tools, decision-making, and action planning

OpenClaw should send intents, not direct rendering instructions against internal Pixi objects.

## System Components

### 1. OpenClaw Server

The OpenClaw server is the central controller.

Responsibilities:

- hosts the browser client as normal web content
- may also host the same frontend through the Canvas Host
- coordinates paired nodes through Gateway WebSocket node sessions and `node.invoke`
- exposes an application WebSocket endpoint for live session traffic
- manages conversation state
- runs LLM/tool logic
- decides model reactions, expressions, speech, and interruptions

### 2. Browser Client

`miku-stage` is the primary frontend client.

Responsibilities:

- render the Live2D model
- provide local UI for chat and controls
- capture microphone input when needed
- maintain a client WebSocket connection to OpenClaw
- convert server messages into model actions
- convert user actions into outbound protocol messages

This client should work in:

- a normal desktop browser
- a normal mobile browser where supported
- an OpenClaw node WebView when embedded via canvas

### 3. Canvas Host (Optional)

The Canvas Host is an optional delivery mechanism for supported OpenClaw nodes.

For this design, it can serve the same built `miku-stage` frontend:

- HTML
- JavaScript bundle
- CSS
- local Live2D assets

Canvas hosting is useful for node integration, but it should not be the core product dependency.

### 4. OpenClaw Node (Optional Canvas Adapter)

An OpenClaw node (Mac/iOS/Android/local app) is the user-facing browser surface.

Responsibilities:

- receives the canvas URL from OpenClaw
- opens it in a WebView
- runs the `miku-stage` frontend
- captures user interaction locally

The node is an optional delivery surface. It is not required for browser-first operation.

## Communication Paths

There are three separate channels. Keeping them distinct is important.

### A. Browser HTTP(S)

Purpose:

- serve the static app and assets

Examples:

- `index.html`
- built JS bundle
- `live2dcubismcore.min.js`
- local model files

This is only for loading the page and assets.

This is the primary delivery path for normal browsers.

### B. Canvas Host + `node.invoke` (Optional)

Purpose:

- tell supported nodes which canvas URL to display
- perform canvas actions like present, hide, navigate, eval, snapshot

This is infrastructure control for the node WebView itself.

It is not the runtime conversation channel for the app.

### C. Application WebSocket

Purpose:

- real-time browser-to-OpenClaw protocol for the active avatar session

This is the main runtime channel for:

- user text input
- user voice input
- model actions
- assistant text streaming
- TTS coordination
- status and acknowledgements

This should be implemented by `miku-stage` directly.

## Why WebSocket

WebSocket is the recommended primary protocol for the app layer.

Reasons:

- communication is bidirectional
- the browser needs to send user events upstream
- OpenClaw needs to push commands downstream
- it supports streaming and incremental updates cleanly
- it is suitable for future voice and interruption features

### Why Not SSE As The Main Path

SSE is acceptable for one-way server-to-browser updates, but it is weaker for this use case.

You would still need a separate upload path for:

- user chat submission
- button events
- voice chunks

That leads to a split transport design that becomes awkward once the client is interactive.

### Why Not Reuse Canvas Live Reload WebSocket

The canvas skill may inject a WebSocket for live reload during development.

That channel is not the right app protocol because:

- it is a development feature
- it is not designed as your stable session API
- its semantics are unrelated to avatar/chat state

Treat it as internal tooling, not part of the product design.

## Runtime Flow

### Boot Flow (Primary Browser Path)

1. A user opens the hosted `miku-stage` page in a normal browser.
2. `miku-stage` loads its static assets and Live2D runtime.
3. `miku-stage` opens an application WebSocket to OpenClaw.
4. The page sends `session_ready`.
5. OpenClaw responds with initial session state, model config, and UI state.
6. The page loads the configured model and becomes interactive.

### Boot Flow (Optional Canvas Path)

1. OpenClaw tells a supported node to present the same `miku-stage` page via canvas.
2. The node opens the page in its WebView.
3. The page follows the same boot path as the normal browser client.

### Text Chat Flow

1. User enters text in the page.
2. The page sends `user_text`.
3. OpenClaw processes the input.
4. OpenClaw streams response text back as `assistant_text_delta`.
5. OpenClaw sends model actions such as `model_motion` or `model_expression`.
6. The page updates the model and UI.
7. OpenClaw sends `assistant_text_done` when complete.

### Voice Flow (Initial Version)

1. User activates microphone input in the page.
2. The page captures audio chunks.
3. The page sends chunks over WebSocket.
4. OpenClaw performs speech processing and response generation.
5. OpenClaw returns text, motion, and optional TTS instructions.
6. The page plays audio and animates the model.

This can begin with chunked audio over WebSocket and evolve later if lower-latency voice is required.

## Protocol Design

Use a message envelope that is explicit and versionable.

Example shape:

```json
{
  "type": "user_text",
  "sessionId": "abc123",
  "payload": {
    "text": "Hello"
  }
}
```

### Browser -> OpenClaw Messages

- `session_ready`
- `user_text`
- `user_audio_start`
- `user_audio_chunk`
- `user_audio_end`
- `ui_event`
- `client_error`
- `pong`

### OpenClaw -> Browser Messages

- `session_init`
- `load_model`
- `assistant_text_delta`
- `assistant_text_done`
- `model_motion`
- `model_expression`
- `model_focus`
- `tts_start`
- `tts_chunk`
- `tts_end`
- `interrupt`
- `ping`

### Stage Command Contract

The stage runtime accepts canonical stage commands only:

- `load_model`
- `model_motion`
- `model_focus`

Legacy `MIKU_*` aliases are intentionally removed to keep OpenClaw integration strict and predictable.

## Frontend Responsibilities

The frontend should remain thin.

Recommended modules to split out from the current single-file `App.vue`:

- `stageRuntime`: Pixi + Live2D boot and model actions
- `stageProtocol`: WebSocket connect/reconnect and message dispatch
- `stageAudio`: microphone capture and audio playback
- `stageUi`: chat input, status display, and controls

This keeps the current simplicity while avoiding a future monolithic `App.vue`.

### Frontend State To Own Locally

- current connection status
- current model URL
- current model loaded state
- current displayed assistant text
- local user input draft
- microphone capture state
- transient animation state

### Frontend State Not To Own Authoritatively

- conversation history as the source of truth
- tool execution state
- final assistant response state
- orchestration decisions

Those belong to OpenClaw.

## Backend Responsibilities

OpenClaw should expose a dedicated session controller for the avatar.

Responsibilities:

- authenticate or associate the browser session with a node/user
- maintain conversation context
- accept inbound chat and audio events
- produce assistant text and reaction commands
- coordinate TTS generation if used
- send authoritative state updates to the browser

OpenClaw should avoid assuming details of Pixi or Vue internals.

## Deployment Model

### Recommended Production Flow

1. Build `miku-stage` into static assets.
2. Host those assets on the OpenClaw server as a normal browser-facing frontend.
3. Let the page connect back to OpenClaw over application WebSocket.
4. Optionally expose the same build through the Canvas Host for supported nodes.
5. Optionally present that same URL in an iOS/macOS/Android node WebView using canvas.

This avoids dependence on a separate Vite dev server in production and keeps one frontend usable across browser and canvas surfaces.

### Development Flow

Two development modes are reasonable:

- keep using Vite locally for rapid frontend iteration
- test direct browser delivery against the hosted backend
- test node delivery via the canvas host when integration matters

Vite is useful for frontend development, but the final deployment target should be the hosted browser build. Canvas is an optional integration target.

## Security Considerations

- The application WebSocket should not be open and anonymous by default.
- Session identity should be scoped to a node, user, or explicit token.
- `canvas action:eval` is powerful and should be treated as an administrative tool, not as the normal control path.
- The frontend should validate inbound message shapes before acting on them.
- Model URLs should be restricted or validated if remote loading is allowed.

## Failure Modes

### Connection Loss

If the WebSocket disconnects:

- show a visible connection state in the page
- attempt reconnect with backoff
- preserve enough local UI state to recover gracefully

### Model Asset Failure

If model loading fails:

- show an error overlay
- keep the socket session alive
- allow OpenClaw to send a replacement `load_model`

### Audio Permission Failure

If microphone permission is denied:

- degrade to text chat
- surface a clear UI state

## Phased Implementation Plan

### Phase 1: Stable Browser Viewer

- deploy `miku-stage` as a normal hosted browser client
- keep current model loading and motion commands
- expose a stable browser-side stage API

### Phase 2: WebSocket Session Protocol

- add client WebSocket connection
- implement message schema
- route inbound server commands to the existing stage handlers

### Phase 3: Text Interaction UI

- add input box and message display
- send `user_text`
- render streamed assistant text

### Phase 4: Voice Input and Audio Output

- add microphone capture
- send audio chunks to OpenClaw
- support TTS playback and interruptions

### Phase 5: Canvas And Multi-Client Integration

- support loading the same frontend through OpenClaw canvas
- verify iOS node behavior against the same session protocol
- keep canvas-specific glue isolated from the core app protocol

### Phase 6: Rich Presence and Polishing

- reconnection UX
- typing/thinking states
- expression presets
- better motion orchestration

### Phase 7: Native Client Expansion

- reuse the same session protocol in native clients
- keep browser/canvas as one client implementation, not the only implementation
- move native-only UX into dedicated clients without changing backend semantics

## Non-Goals

This design does not assume:

- direct backend access to Pixi objects
- using the canvas live-reload WebSocket as the product protocol
- server-side rendering of the Live2D model
- that canvas is the only delivery path
- that a generic browser is automatically an OpenClaw node

## Summary

The recommended design is:

- host `miku-stage` as a normal browser client on the OpenClaw server
- add a dedicated application WebSocket from the page to OpenClaw
- keep the client responsible for rendering and local input
- keep OpenClaw responsible for intelligence, state, and orchestration
- treat canvas as an optional embedding path for supported nodes
- treat the WebSocket message protocol as the long-term foundation for future native clients

This is the simplest architecture that scales from a passive model viewer to a browser client today, optional canvas embedding on supported nodes, and native clients later without changing the backend contract.

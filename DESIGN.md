# Miku Stage Integration Design

## Purpose

This document describes the recommended architecture for turning `miku-stage` into an interactive Live2D client that:

- runs as a normal browser client
- can later be replaced or complemented by native clients
- displays and animates a Live2D model in a browser
- accepts user interaction (text, clicks, voice)
- sends those interactions to a stage orchestrator service
- receives commands from the orchestrator to update the model and UI

The goal is to keep rendering in the client, while backend orchestration stays outside the frontend runtime.

## Problem Statement

`miku-stage` currently works as a lightweight browser app:

- Vue provides the page shell
- Pixi renders the model surface
- `pixi-live2d-display` loads and animates the model

This is enough to display a model, but not enough for a full interactive assistant.

The missing piece is a reliable runtime protocol between the browser page and a stage orchestrator so that:

- user input can flow from the page to the orchestrator/backend
- model commands can flow from the orchestrator/backend back to the page
- chat, voice, and animation stay synchronized

## Recommended Architecture

Use a protocol-first design:

- `miku-stage` is primarily a browser client with a stable app protocol
- the page connects to a dedicated Stage Orchestrator over application WebSocket
- OpenClaw integration is handled behind orchestrator adapters
- future native clients should implement the same session protocol

### Core Principle

The browser owns rendering.
The Stage Orchestrator owns session orchestration.

That means:

- the page owns Pixi, Live2D, DOM input, and audio playback
- the orchestrator owns session state, transport, and event mapping
- OpenClaw (when used) owns conversation state, tools, decision-making, and action planning

Backends should send intents, not direct rendering instructions against internal Pixi objects.

## System Components

### 1. Stage Orchestrator Service

The Stage Orchestrator is the runtime control plane for active stage sessions.

Responsibilities:

- expose a stable application WebSocket endpoint for `miku-stage`
- own stage session lifecycle, identity, and reconnect/resume behavior
- validate protocol messages and route inbound user events
- map backend text/events to canonical stage commands
- return acknowledgements, errors, and status updates to clients

### 2. OpenClaw Adapter (Optional Backend)

The OpenClaw adapter is an integration module behind the orchestrator.

Responsibilities:

- bind stage sessions to OpenClaw chat sessions when OpenClaw is used
- forward user events to OpenClaw Gateway APIs
- translate OpenClaw streaming output into orchestrator event format
- isolate OpenClaw-specific integration details from frontend/runtime code

### 3. Browser Client

`miku-stage` is the primary frontend client.

Responsibilities:

- render the Live2D model
- provide local UI for chat and controls
- capture microphone input when needed
- maintain a client WebSocket connection to Stage Orchestrator
- convert server messages into model actions
- convert user actions into outbound protocol messages

This client should work in:

- a normal desktop browser
- a normal mobile browser where supported

### 4. Native Clients (Optional, Late Phase)

Native clients (iOS/macOS/Android/desktop) are optional user-facing surfaces.

Responsibilities:

- use the same session protocol as browser clients
- forward user interaction events to Stage Orchestrator
- apply orchestrator commands to local rendering/runtime layers

Native clients are optional delivery surfaces. They are not required for browser-first operation.

## Communication Paths

There are two separate channels. Keeping them distinct is important.

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

### B. Application WebSocket

Purpose:

- real-time browser-to-Stage Orchestrator protocol for the active avatar session

This is the main runtime channel for:

- user text input
- user voice input
- model actions
- assistant text streaming
- TTS coordination
- status and acknowledgements

This is the main runtime channel between frontend and orchestrator.

## Bridge Service Topology (Primary Option)

To keep `miku-stage` lightweight and avoid coupling to OpenClaw internals, use a small stage orchestrator service as the default runtime boundary.

Responsibilities:

- own stage session lifecycle
- provide a stable session API for the browser client
- adapt to OpenClaw Gateway APIs when OpenClaw is used
- allow alternative backends (direct LLM APIs) without changing frontend protocol

### Component Boundaries

- `miku-stage UI` runs in a browser and only handles rendering, local interaction, and playback.
- `Stage Orchestrator` is the runtime controller for active stage sessions.
- `OpenClaw Gateway` is an optional backend adapter used by the orchestrator.
- `Direct LLM Backend` is an optional non-OpenClaw backend used by the orchestrator.

### Stage Orchestrator Internals

- `Session Manager`: maps `stageSessionId` to backend chat session identity and tracks connection state.
- `Prompt + Motion Mapper`: converts backend text/events into canonical stage commands.
- `Event Bus`: decouples inbound browser events, backend events, and outbound stage commands.

### Runtime Message Flow

1. Browser client connects to orchestrator endpoint (for example `/live/ws`) with `stageSessionId`.
2. Orchestrator authenticates and binds/creates a backend chat session.
3. Browser sends user interaction events (text, pointer, optional voice) to orchestrator.
4. Orchestrator forwards chat turns to backend (OpenClaw WS RPC or direct LLM API).
5. Backend returns streaming text/events.
6. Orchestrator maps backend output to stage commands:
   - `load_model`
   - `model_motion`
   - `model_focus`
7. Orchestrator pushes stage commands to browser client.
8. Browser applies commands to Live2D runtime and optionally sends acknowledgements/client telemetry.

### Design Tradeoffs

- Keeps `miku-stage` frontend protocol stable even if backend changes.
- Avoids direct dependency on OpenClaw internals inside the frontend runtime.
- Adds one service boundary, but significantly improves long-term maintainability and backend swap-ability.

## Why WebSocket

WebSocket is the recommended primary protocol for the app layer.

Reasons:

- communication is bidirectional
- the browser needs to send user events upstream
- the orchestrator/backend needs to push commands downstream
- it supports streaming and incremental updates cleanly
- it is suitable for future voice and interruption features

### Why Not SSE As The Main Path

SSE is acceptable for one-way server-to-browser updates, but it is weaker for this use case.

You would still need a separate upload path for:

- user chat submission
- button events
- voice chunks

That leads to a split transport design that becomes awkward once the client is interactive.

### Why Not Reuse Dev Live Reload WebSocket

Any live-reload socket used by frontend tooling is not the right app protocol because:

- it is a development feature
- it is not designed as your stable session API
- its semantics are unrelated to avatar/chat state

Treat it as internal tooling, not part of the product design.

## Runtime Flow

### Boot Flow (Primary Browser Path)

1. A user opens the hosted `miku-stage` page in a normal browser.
2. `miku-stage` loads its static assets and Live2D runtime.
3. `miku-stage` opens an application WebSocket to Stage Orchestrator.
4. The page sends `session_ready`.
5. Stage Orchestrator responds with initial session state, model config, and UI state.
6. The page loads the configured model and becomes interactive.

### Text Chat Flow

1. User enters text in the page.
2. The page sends `user_text`.
3. Stage Orchestrator forwards input to configured backend (OpenClaw adapter or direct LLM backend).
4. Stage Orchestrator streams response text back as `assistant_text_delta`.
5. Stage Orchestrator sends model actions such as `model_motion` or `model_expression`.
6. The page updates the model and UI.
7. Stage Orchestrator sends `assistant_text_done` when complete.

### Voice Flow (Initial Version)

1. User activates microphone input in the page.
2. The page captures audio chunks.
3. The page sends chunks over WebSocket.
4. Stage Orchestrator forwards audio to the configured backend for speech processing and response generation.
5. Stage Orchestrator returns text, motion, and optional TTS instructions.
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

### Browser -> Orchestrator Messages

- `session_ready`
- `user_text`
- `user_audio_start`
- `user_audio_chunk`
- `user_audio_end`
- `ui_event`
- `client_error`
- `pong`

### Orchestrator -> Browser Messages

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

Legacy `MIKU_*` aliases are intentionally removed to keep backend integration strict and predictable.

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

Those belong to the orchestrator/backend.

## Backend Responsibilities

Stage Orchestrator should expose a dedicated session controller for the avatar.

Responsibilities:

- authenticate or associate the browser session with a node/user
- maintain conversation context
- accept inbound chat and audio events
- call configured backend adapters (OpenClaw or direct LLM)
- produce assistant text and reaction commands
- coordinate TTS generation if used
- send authoritative state updates to the browser

Backend adapters should avoid assuming details of Pixi or Vue internals.

## Pairing Setup (OpenClaw Adapter)

When Phase 5 uses the OpenClaw adapter, the orchestrator behaves like a gateway device client, not just a plain bearer-token client.

### Why Pairing Exists

- gateway token auth alone is not enough for long-term device trust
- OpenClaw gateway issues `connect.challenge` and expects signed `connect.params.device`
- pairing approval binds this orchestrator identity to an allowed device entry

This keeps adapter auth revocable and auditable per device.

### Runtime Pairing Flow

1. Start Stage Orchestrator with `STAGE_BACKEND_ADAPTER=openclaw`.
2. Adapter opens gateway WebSocket and receives `connect.challenge`.
3. Adapter loads identity from `OPENCLAW_GATEWAY_DEVICE_IDENTITY_PATH` (default `~/.openclaw/identity/device.json`) and signs the challenge payload.
4. Gateway creates a pending device-pair request when identity is unknown.
5. Operator approves request with `openclaw devices approve <requestId>` or `openclaw devices approve --latest`.
6. Subsequent connects reuse the paired identity and can execute `chat.send`.

### Configuration Surface

- `OPENCLAW_GATEWAY_TOKEN`: gateway auth token (required for shared-token mode)
- `OPENCLAW_GATEWAY_DEVICE_TOKEN`: optional device token (alternative auth input)
- `OPENCLAW_GATEWAY_SCOPES`: requested scopes for connect role negotiation
- `OPENCLAW_GATEWAY_DEVICE_IDENTITY_PATH`: identity key file path
- `OPENCLAW_GATEWAY_DEVICE_AUTH_PAYLOAD_VERSION`: signature payload format (`v2` default)
- `OPENCLAW_GATEWAY_WS_URL`: gateway WebSocket URL

### Operational Notes

- The adapter should request write-capable scopes (`operator.write` or `operator.admin`) for `chat.send`.
- Pairing approval is a one-time operational step per device identity unless identity keys rotate.
- If pairing/auth state drifts, `openclaw devices list` is the first diagnostic command.

## Deployment Model

### Recommended Production Flow

1. Build `miku-stage` into static assets.
2. Host those assets on stage web hosting (can be OpenClaw-hosted or standalone).
3. Let the page connect to Stage Orchestrator over application WebSocket.
4. Let Stage Orchestrator route to configured backends (OpenClaw adapter or direct LLM backend).

This avoids dependence on a separate Vite dev server in production and keeps one frontend usable across browser and backend variants.

### Development Flow

Two development modes are reasonable:

- keep using Vite locally for rapid frontend iteration
- test direct browser delivery against the hosted backend
- test orchestrator integrations with OpenClaw/direct-LLM adapters

Vite is useful for frontend development, but the final deployment target should be the hosted browser build plus orchestrator runtime.

## Security Considerations

- The application WebSocket should not be open and anonymous by default.
- Session identity should be scoped to a node, user, or explicit token.
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
- allow orchestrator/backend to send a replacement `load_model`

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

### Phase 4: Stage Orchestrator Baseline

- evolve `miku-bridge.js` into a production-oriented Stage Orchestrator service
- expose a stable session API endpoint (for example `/live/ws`) with message validation and routing
- replace fake local assistant replies with pluggable backend adapter interface

### Phase 5: Backend Adapter + Session Reliability

- implement OpenClaw adapter path (plus optional direct-LLM adapter path)
- enforce stage session identity, auth binding, reconnect/resume semantics
- handle acknowledgements, errors, interrupts, and telemetry consistently

### Phase 6: Rich Presence and Polishing

- reconnection UX
- typing/thinking states
- expression presets
- better motion orchestration

### Phase 7: Voice Input and Audio Output

- add microphone capture
- send audio chunks to orchestrator
- support TTS playback and interruptions

### Phase 8: Native Client Expansion

- verify iOS/macOS/Android clients against the same session protocol
- reuse the same session protocol in native clients
- keep browser implementation as one client, not the only implementation
- move native-only UX into dedicated clients without changing backend semantics

## Non-Goals

This design does not assume:

- direct backend access to Pixi objects
- using any development live-reload WebSocket as the product protocol
- server-side rendering of the Live2D model
- that browser is the only delivery path

## Summary

The recommended design is:

- host `miku-stage` as a normal browser client (OpenClaw-hosted or standalone)
- add a dedicated application WebSocket from the page to Stage Orchestrator
- keep the client responsible for rendering and local input
- keep orchestrator responsible for session lifecycle, mapping, and runtime protocol
- keep OpenClaw as an optional backend intelligence adapter
- treat the WebSocket message protocol as the long-term foundation for future native clients

This is the simplest architecture that scales from a passive model viewer to browser-first runtime today and native surfaces later without changing the frontend protocol contract.

// miku-bridge.js
// A WebSocket Proxy that broadcasts any JSON it receives to all connected clients.
// Following the schema in DESIGN.md

import { WebSocketServer } from 'ws';

const WSS_PORT = 5174;
const wss = new WebSocketServer({ port: WSS_PORT });

console.log(`[MIKU-BRIDGE] WebSocket Central Station is active on port ${WSS_PORT}`);

wss.on('connection', (ws) => {
  console.log('[MIKU-BRIDGE] New client connected! 🎤');

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[MIKU-BRIDGE] Relaying message: ${message.type || 'unknown'}`);

      // Broadcast the message to all OTHER connected clients
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) { // 1 = OPEN
          client.send(JSON.stringify(message));
        }
      });
    } catch (err) {
      console.error('[MIKU-BRIDGE] Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[MIKU-BRIDGE] Client disconnected. 👋');
  });
});

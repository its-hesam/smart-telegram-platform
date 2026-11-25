import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { PlatformStore } from './store.js';
import type { ApiConfig } from './config.js';
export function attachRealtime(server: Server, store: PlatformStore, config: ApiConfig) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const sessions = new Map<WebSocket, string>();
  let closed = false; let polling = false; let pending = 0;
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (request.url !== '/events' || request.headers.origin !== config.APP_ORIGIN || wss.clients.size + pending >= 100) { socket.destroy(); return; }
    const name = config.NODE_ENV === 'production' ? '__Host-smart_session' : 'smart_session';
    const token = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) { socket.destroy(); return; }
    pending++;
    void store.authenticate(token).then(user => {
      if (!user || closed) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, ws => { sessions.set(ws, token); ws.on('message', () => ws.close(1008, 'Read-only stream')); ws.on('close', () => sessions.delete(ws)); });
    }).catch(() => socket.destroy()).finally(() => pending--);
  });
  const timer = setInterval(() => {
    if (polling || closed || !sessions.size) return; polling = true;
    void (async () => {
      for (const [ws, token] of sessions) {
        const user = await store.authenticate(token);
        if (!user) { ws.close(1008, 'Session expired'); continue; }
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > 65536) { ws.terminate(); continue; }
        // Bounded invalidation events carry no message/contact/profile data.
        ws.send(JSON.stringify({ version: 1, id: randomUUID(), type: 'system.resync', occurredAt: new Date().toISOString(), resourceId: 'system', traceId: randomUUID() }));
      }
    })().catch(() => { for (const ws of sessions.keys()) ws.close(1013, 'State unavailable'); }).finally(() => { polling = false; });
  }, 5000);
  timer.unref();
  return async () => { closed = true; clearInterval(timer); for (const ws of sessions.keys()) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); };
}

'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
export function RealtimeStatus() {
  const client = useQueryClient(); const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let closed = false; let attempts = 0;
    const connect = () => {
      const url = process.env.NEXT_PUBLIC_WS_URL ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`;
      ws = new WebSocket(url);
      ws.onopen = () => { setConnected(true); attempts = 0; void client.invalidateQueries(); };
      ws.onmessage = event => { try { const body = JSON.parse(event.data); if (body.version === 1 && body.type === 'system.resync') for (const key of ['accounts', 'jobs', 'campaigns', 'analytics', 'logs']) void client.invalidateQueries({ queryKey: [key] }); } catch {} };
      ws.onclose = () => { setConnected(false); if (!closed && attempts < 3) timer = setTimeout(connect, 1000 * 2 ** attempts++); };
      ws.onerror = () => ws?.close();
    };
    connect(); return () => { closed = true; if (timer) clearTimeout(timer); ws?.close(); };
  }, [client]);
  return <span className={`status ${connected ? 'status-connected' : ''}`} title="پس از اتصال مجدد، وضعیت از API دوباره دریافت می‌شود">{connected ? 'رویداد زنده' : 'به‌روزرسانی دوره‌ای'}</span>;
}

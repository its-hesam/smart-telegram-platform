import { randomUUID } from 'node:crypto';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!path.length || path.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) return Response.json({ code: 'INVALID_ROUTE' }, { status: 400 });
  const origin = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.origin !== origin) return Response.json({ code: 'INVALID_BACKEND_CONFIG' }, { status: 503 });
  const headers = new Headers();
  for (const name of ['cookie', 'content-type', 'origin', 'x-csrf-token', 'idempotency-key']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  try {
    let body: Uint8Array | undefined;
    if (!['GET', 'HEAD'].includes(request.method) && request.body) {
      const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 1024 * 1024) { await reader.cancel(); return Response.json({ code: 'PAYLOAD_TOO_LARGE' }, { status: 413 }); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(length); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; } body = bytes;
    }
    const response = await fetch(`${origin}/v1/${path.map(encodeURIComponent).join('/')}${new URL(request.url).search}`, { method: request.method, headers, ...(body ? { body: body as BodyInit } : {}), cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(300000) });
    const output = new Headers(response.headers);
    for (const name of ['connection', 'transfer-encoding', 'content-encoding', 'content-length']) output.delete(name);
    return new Response(response.body, { status: response.status, headers: output });
  } catch { return Response.json({ code: 'BACKEND_UNAVAILABLE', requestId: randomUUID() }, { status: 503 }); }
}
export { forward as GET, forward as POST, forward as PATCH, forward as DELETE };

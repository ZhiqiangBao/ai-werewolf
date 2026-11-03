import type { IncomingMessage, ServerResponse } from 'node:http';

/** 连接持有者负责 ping、监听器和订阅的完整释放。 */
export function attachEventStream(req: IncomingMessage, res: ServerResponse, unsubscribe: () => void, streams: Set<() => void>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    clearInterval(ping); streams.delete(close); req.off('close', close);
    try { unsubscribe(); } finally { if (!res.writableEnded) res.end(); }
  };
  streams.add(close); req.once('close', close);
}

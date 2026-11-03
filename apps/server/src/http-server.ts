import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { ControlAction } from '@werewolf/protocol';
import { ApiFailure, type RoomManager, type SpeechConnections, type SpeechService } from '@werewolf/session';
import { inviteNetwork } from './invite-network';
import { attachEventStream } from './event-stream';
import { shutdownResources } from './shutdown';

export interface Frontend {
  middlewares(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  close(): Promise<void>;
}

/** 构造独立 HTTP 实例；监听、恢复房间和进程生命周期由调用方负责。 */
export function createHttpServer({ manager, speech, speechConnections, webRoot }: {
  manager: RoomManager; speech: SpeechService; speechConnections: SpeechConnections; webRoot: string;
}) {
  let stopping = false;
  function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new ApiFailure(413, 'TOO_LARGE', '请求体过大');
      chunks.push(chunk as Buffer);
    }
    if (stopping) throw new ApiFailure(503, 'MANAGER_DISPOSED', '服务正在关闭，请稍后重新连接');
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 落到下面统一报错
    }
    throw new ApiFailure(400, 'BAD_REQUEST', '请求体必须是 JSON 对象');
  }

  /** 凭证从 Authorization 头读取；EventSource 和下载链接无法带头，才从 ?token= 读取。 */
  function tokenOf(req: IncomingMessage, url: URL): string {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
    return url.searchParams.get('token') ?? '';
  }

  async function renderSpeech(req: IncomingMessage, res: ServerResponse, render: (signal: AbortSignal) => ReturnType<SpeechService['render']>, message: string): Promise<void> {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    if (req.aborted || res.destroyed) controller.abort();
    try {
      const audio = await render(controller.signal);
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': audio.mimeType, 'Content-Length': audio.bytes.length, 'Cache-Control': 'private, no-store' });
      res.end(audio.bytes);
    } catch {
      if (!controller.signal.aborted) send(res, 503, { code: 'SPEECH_UNAVAILABLE', message });
    } finally {
      req.removeListener('aborted', disconnected);
      res.removeListener('close', disconnected);
    }
  }

  /** 首页共享库沿用模型库的服务级管理入口；旧房间配置仍先检查房主凭证。 */
  async function speechSettings(req: IncomingMessage, res: ServerResponse, method: string, id?: string, action?: string, roomId?: string): Promise<void> {
    if (method === 'GET' && !id) return send(res, 200, { connections: roomId ? speechConnections.views(roomId) : speechConnections.sharedViews(), builtins: speech.catalog().providers, ...(speechConnections.error ? { error: speechConnections.error } : {}) });
    if (method === 'POST' && id && action === 'test') {
      const providers = roomId ? speechConnections.providers(roomId) : speechConnections.sharedProviders();
      if (!providers.some((provider) => provider.id === id)) throw new ApiFailure(404, 'NOT_FOUND', '没有这个 TTS 来源');
      return renderSpeech(req, res, (signal) => speech.render('这是一段语音接入测试。一二三。', id, providers, 'zh-CN', { signal }), '试听失败，请核对地址、密钥、模型、音色及所选协议；未切换其他来源。');
    }
    try {
      if (method === 'POST' && roomId && id && action === 'share') return send(res, 200, speechConnections.share(roomId, id));
      if (method === 'POST' && !id) return send(res, 201, roomId ? speechConnections.save(roomId, await readBody(req)) : speechConnections.saveShared(await readBody(req)));
      if (method === 'PUT' && id && !action) return send(res, 200, roomId ? speechConnections.save(roomId, await readBody(req), id) : speechConnections.saveShared(await readBody(req), id));
      if (method === 'DELETE' && id && !action) {
        if (roomId) speechConnections.remove(roomId, id); else speechConnections.removeShared(id);
        return send(res, 200, { ok: true });
      }
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(400, 'BAD_REQUEST', error instanceof Error && !('code' in error) ? error.message : '无法保存 TTS 配置，请检查服务端存储。');
    }
    throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
  }

  const streams = new Set<() => void>();
  function stream(req: IncomingMessage, res: ServerResponse, roomId: string, token: string): void {
    const unsubscribe = manager.subscribe(roomId, token, (n) => res.write(`event: update\ndata: ${n}\n\n`));
    attachEventStream(req, res, unsubscribe, streams);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(2);
    const method = req.method ?? 'GET';
    const token = tokenOf(req, url);

    if (parts[0] === 'catalog' && method === 'GET') return send(res, 200, manager.catalog());
    if ((parts[0] === 'model-presets' || parts[0] === 'models') && !parts[1] && method === 'GET') return send(res, 200, manager.modelPresets());
    if (parts[0] === 'models' && !parts[1] && method === 'POST') return send(res, 201, manager.addModel(await readBody(req)));
    if (parts[0] === 'models' && parts[1] && method === 'DELETE') {
      manager.deleteModel(decodeURIComponent(parts[1]));
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'speech-settings') return speechSettings(req, res, method, parts[1], parts[2]);
    if (parts[0] !== 'rooms') throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
    if (parts.length === 1 && method === 'POST') return send(res, 201, manager.createRoom(await readBody(req)));

    const [, roomId, action, sub, subAction] = parts;
    if (!roomId) throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
    switch (`${method} ${action ?? ''}`) {
      case 'GET invite-network': {
        manager.getSetup(roomId, token); // 沿用房主鉴权，不能向座位或匿名访问者枚举网卡。
        const address = server.address();
        if (!address || typeof address === 'string') throw new ApiFailure(503, 'NOT_LISTENING', '服务尚未监听网络端口');
        return send(res, 200, inviteNetwork(address));
      }
      case 'GET setup':
        return send(res, 200, manager.getSetup(roomId, token));
      case 'PUT setup':
        return send(res, 200, manager.updateSetup(roomId, token, await readBody(req)));
      case 'POST seats':
        if (subAction !== 'test') break;
        return send(res, 200, await manager.testSeat(roomId, token, Number(sub)));
      case 'POST start':
        return send(res, 200, manager.start(roomId, token));
      case 'POST clone':
        return send(res, 201, manager.cloneRoom(roomId, token));
      case 'POST control': {
        const body = await readBody(req);
        return send(res, 200, manager.control(roomId, token, body.action as ControlAction));
      }
      case 'GET view':
        return send(res, 200, manager.view(roomId, token));
      case 'POST act':
        return send(res, 200, manager.act(roomId, token, await readBody(req)));
      case 'POST participate':
        return send(res, 200, manager.participate(roomId, token, await readBody(req)));
      case 'GET speech-settings':
      case 'POST speech-settings':
      case 'PUT speech-settings':
      case 'DELETE speech-settings':
        manager.getSetup(roomId, token);
        return speechSettings(req, res, method, sub, subAction, roomId);
      case 'GET speech-providers':
        manager.view(roomId, token);
        return send(res, 200, speech.catalog([...speechConnections.sharedProviders(), ...speechConnections.providers(roomId)]));
      case 'POST speech': {
        const body = await readBody(req);
        const text = manager.speechText(roomId, token, body.eventSeq);
        const providers = [...speechConnections.sharedProviders(), ...speechConnections.providers(roomId)];
        if (body.providerId !== undefined && (typeof body.providerId !== 'string' || !speech.catalog(providers).providers.some((p) => p.id === body.providerId))) {
          throw new ApiFailure(400, 'BAD_REQUEST', '请选择已配置的朗读来源');
        }
        return renderSpeech(req, res, (signal) => speech.render(text, body.providerId as string | undefined, providers, manager.speechLocale(roomId, token), { signal }), '所选来源朗读失败，请检查服务配置或稍后重试；未切换到其他来源。');
      }
      case 'GET stream':
        return stream(req, res, roomId, token);
      case 'GET audit':
        return send(res, 200, manager.audit(roomId, token));
      case 'GET export': {
        const kind = url.searchParams.get('kind') === 'god' ? 'god' : 'public';
        const body = manager.exportRecord(roomId, token, kind);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="werewolf-${roomId}-${kind}.json"`,
        });
        res.end(JSON.stringify(body, null, 2));
        return;
      }
    }
    throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
  }

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const dist = join(webRoot, 'dist');
    let file = normalize(join(dist, decodeURIComponent(pathname)));
    if (!file.startsWith(dist)) return send(res, 403, { code: 'FORBIDDEN', message: '路径不合法' });
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) file = join(dist, 'index.html');
    const exists = await stat(file).catch(() => null);
    if (!exists) return send(res, 503, { code: 'NOT_BUILT', message: '网页还没有构建，请先运行 pnpm build，或用 pnpm dev 启动开发模式' });
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  const server = createServer();
  let vite: Frontend | null = null;

  server.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (stopping) throw new ApiFailure(503, 'MANAGER_DISPOSED', '服务正在关闭，请稍后重新连接');
      if (url.pathname.startsWith('/api/v1/')) return await api(req, res, url);
      if (vite) return vite.middlewares(req, res, () => send(res, 404, { code: 'NOT_FOUND', message: '页面不存在' }));
      return await serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof ApiFailure) return send(res, e.status, { code: e.code, message: e.message });
      if (res.destroyed || res.writableEnded) return;
      console.error('请求处理失败：', (e as Error).message);
      if (!res.headersSent) send(res, 500, { code: 'INTERNAL', message: '服务器内部错误' });
    }
  });


  let shutdownPromise: Promise<0 | 1 | 2> | undefined;
  return {
    server,
    setFrontend(frontend: Frontend) { vite = frontend; },
    close({ release = () => {}, graceMs = 5000 }: { release?: () => void; graceMs?: number } = {}) {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      shutdownPromise = shutdownResources({
        stopAccepting: () => { const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); server.closeIdleConnections(); return closed; },
        closeStreams: () => { let failed = false; for (const close of [...streams]) { try { close(); } catch { failed = true; } } if (failed) throw new Error('STREAM_RELEASE_FAILED'); },
        dispose: () => { try { manager.dispose(); } finally { speech.dispose(); } },
        whenDisposed: async () => { const [result] = await Promise.all([manager.whenDisposed(), speech.whenDisposed()]); return result; },
        closeFrontend: () => vite?.close() ?? Promise.resolve(),
        forceConnections: () => server.closeAllConnections(), release, graceMs,
      });
      return shutdownPromise;
    },
  };
}

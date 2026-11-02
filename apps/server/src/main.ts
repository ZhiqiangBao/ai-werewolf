import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlAction } from '@werewolf/protocol';
import { ApiFailure, FileStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '@werewolf/session';
import { DEFAULT_HOST, inviteNetwork } from './invite-network';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const WEB = join(ROOT, 'apps', 'web');
const DATA = resolve(process.env.WEREWOLF_DATA ?? join(ROOT, 'data'));
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? DEFAULT_HOST;

const secrets = SecretBox.fromEnvOrFile(DATA);
const manager = new RoomManager({ store: new FileStore(DATA), secrets, modelsPath: join(DATA, 'models.json') });
const speech = SpeechService.configured(join(DATA, 'speech'), process.env.WEREWOLF_SPEECH_CONFIG);
const speechConnections = new SpeechConnections(join(DATA, 'speech-connections.json'), secrets, join(DATA, 'speech'));

function send(res: ServerResponse, status: number, body: unknown): void {
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

/** 首页共享库沿用模型库的服务级管理入口；旧房间配置仍先检查房主凭证。 */
async function speechSettings(req: IncomingMessage, res: ServerResponse, method: string, id?: string, action?: string, roomId?: string): Promise<void> {
  if (method === 'GET' && !id) return send(res, 200, { connections: roomId ? speechConnections.views(roomId) : speechConnections.sharedViews(), builtins: speech.catalog().providers, ...(speechConnections.error ? { error: speechConnections.error } : {}) });
  if (method === 'POST' && id && action === 'test') {
    const providers = roomId ? speechConnections.providers(roomId) : speechConnections.sharedProviders();
    if (!providers.some((provider) => provider.id === id)) throw new ApiFailure(404, 'NOT_FOUND', '没有这个 TTS 来源');
    try {
      const audio = await speech.render('这是一段语音接入测试。一二三。', id, providers);
      res.writeHead(200, { 'Content-Type': audio.mimeType, 'Content-Length': audio.bytes.length, 'Cache-Control': 'private, no-store' }); res.end(audio.bytes);
    } catch { return send(res, 503, { code: 'SPEECH_UNAVAILABLE', message: '试听失败，请核对地址、密钥、模型、音色及所选协议；未切换其他来源。' }); }
    return;
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

function stream(req: IncomingMessage, res: ServerResponse, roomId: string, token: string): void {
  const unsubscribe = manager.subscribe(roomId, token, (n) => res.write(`event: update\ndata: ${n}\n\n`));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
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
      try {
        const audio = await speech.render(text, body.providerId as string | undefined, providers);
        res.writeHead(200, { 'Content-Type': audio.mimeType, 'Content-Length': audio.bytes.length, 'Cache-Control': 'private, no-store' });
        res.end(audio.bytes);
      } catch {
        return send(res, 503, { code: 'SPEECH_UNAVAILABLE', message: '所选来源朗读失败，请检查服务配置或稍后重试；未切换到其他来源。' });
      }
      return;
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
  const dist = join(WEB, 'dist');
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
let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void } | null = null;

server.on('request', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/v1/')) return await api(req, res, url);
    if (vite) return vite.middlewares(req, res, () => send(res, 404, { code: 'NOT_FOUND', message: '页面不存在' }));
    return await serveStatic(res, url.pathname);
  } catch (e) {
    if (e instanceof ApiFailure) return send(res, e.status, { code: e.code, message: e.message });
    console.error('请求处理失败：', (e as Error).message);
    if (!res.headersSent) send(res, 500, { code: 'INTERNAL', message: '服务器内部错误' });
  }
});

if (DEV) {
  const { createServer: createVite } = await import('vite');
  vite = await createVite({
    root: WEB,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server } },
  });
}

server.listen(PORT, HOST, () => {
  manager.resumeAll();
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`AI 狼人杀已启动：http://${shown}:${PORT}/  （${DEV ? '开发模式' : '生产模式'}，数据目录 ${DATA}）`);
  const address = server.address();
  if (address && typeof address !== 'string') {
    for (const entry of inviteNetwork(address).addresses) console.log(`局域网访问：${entry.origin}/  （${entry.label}）`);
  }
});

const shutdown = () => {
  manager.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

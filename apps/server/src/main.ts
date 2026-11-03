import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataLease, FileStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '@werewolf/session';
import { DEFAULT_HOST, inviteNetwork } from './invite-network';
import { createHttpServer } from './http-server';
import { startLocalControl } from './local-control';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const WEB = join(ROOT, 'apps', 'web');
const DATA = resolve(process.env.WEREWOLF_DATA ?? join(ROOT, 'data'));
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? DEFAULT_HOST;
let stopping = false;

const releaseLease = acquireDataLease(DATA);
process.once('exit', () => { try { releaseLease(); } catch { /* 留下锁供人工核查。 */ } });
const secrets = SecretBox.fromEnvOrFile(DATA);
const manager = new RoomManager({ store: new FileStore(DATA), secrets, modelsPath: join(DATA, 'models.json') });
const speech = SpeechService.configured(join(DATA, 'speech'), process.env.WEREWOLF_SPEECH_CONFIG);
const speechConnections = new SpeechConnections(join(DATA, 'speech-connections.json'), secrets, join(DATA, 'speech'));

const http = createHttpServer({ manager, speech, speechConnections, webRoot: WEB });
const { server } = http;

let shutdownPromise: Promise<number> | undefined;
const shutdown = (): Promise<number> => {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  const requestedGrace = Number(process.env.WEREWOLF_SHUTDOWN_GRACE_MS ?? 5000);
  const grace = Number.isFinite(requestedGrace) && requestedGrace > 0 ? requestedGrace : 5000;
  shutdownPromise = (async () => {
    const code = await http.close({ release: releaseLease, graceMs: grace });
    if (code === 2) console.error('服务退出超时，仍有本地连接或资源未完成收尾。');
    else if (code === 1) console.error('服务退出时房间保存或资源释放失败。');
    return code;
  })();
  return shutdownPromise;
};
process.on('SIGINT', () => { void shutdown().then((code) => process.exit(code)); });
process.on('SIGTERM', () => { void shutdown().then((code) => process.exit(code)); });

if (DEV) {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({ root: WEB, appType: 'spa', server: { middlewareMode: true, hmr: { server } } });
  http.setFrontend(vite);
}

if (!stopping) server.listen(PORT, HOST, () => {
  manager.resumeAll();
  startLocalControl(DATA, ROOT, DEV ? 'dev' : 'production', HOST, PORT, shutdown);
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`AI 狼人杀已启动：http://${shown}:${PORT}/  （${DEV ? '开发模式' : '生产模式'}，数据目录 ${DATA}）`);
  const address = server.address();
  if (address && typeof address !== 'string') {
    for (const entry of inviteNetwork(address).addresses) console.log(`局域网访问：${entry.origin}/  （${entry.label}）`);
  }
});

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { FileStore, RoomManager, SecretBox } from '@werewolf/session';

it('真实服务器关闭 SSE 和租约并以正常状态退出', async () => {
  const temporary = mkdtempSync(join(process.cwd(), '.test-shutdown-'));
  const fixture = new RoomManager({ store: new FileStore(temporary), secrets: SecretBox.fromEnvOrFile(temporary), modelsPath: join(temporary, 'models.json'), tickMs: 0 });
  const room = fixture.createRoom(); fixture.dispose(); await fixture.whenDisposed();
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('port unavailable');
  const port = address.port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(resolve('apps/server/test/signal-fixture.mjs')).href, 'apps/server/src/main.ts'], {
    cwd: process.cwd(), env: { ...process.env, WEREWOLF_DATA: temporary, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '', requests = 0;
  const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`启动超时: ${stderr}`)), 10_000);
      child.stdout!.on('data', (chunk) => { stdout += String(chunk); if (stdout.includes('AI 狼人杀已启动')) { clearTimeout(timer); resolve(); } });
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(`提前退出: ${stderr}`)); });
    });
    const request = (url: string, init?: RequestInit) => { if (++requests > 1) throw Error('玩家 API 预算耗尽'); return fetch(url, init); };
    const base = `http://127.0.0.1:${port}/api/v1`;
    const stream = await request(`${base}/rooms/${room.roomId}/stream?token=${room.hostToken}`); expect(stream.status).toBe(200);
    const reader = stream.body!.getReader(); await reader.read();
    child.send!('shutdown');
    expect(await exit).toBe(0);
    expect((await reader.read()).done).toBe(true);
    expect(existsSync(join(temporary, '.writer-lease'))).toBe(false);
    expect(requests).toBe(1);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 20_000);

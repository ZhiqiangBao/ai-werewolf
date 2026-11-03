import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeechService } from '../src/speech';

const gate = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (gate.wait && String(args[0]).endsWith('.audio.json')) { gate.entered?.(); await gate.wait; }
    return actual.readFile(...args);
  } };
});
const dirs: string[] = [];
afterEach(async () => { gate.wait = undefined; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('已经开始读取缓存时取消，不返回缓存结果且关闭等待读取结束', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speech-cancel-read-')); dirs.push(dir);
  const synthesize = vi.fn(async () => ({ bytes: Buffer.from('audio'), mimeType: 'audio/mpeg' }));
  const service = new SpeechService(dir, [{ id: 'fake', label: 'fake', cacheIdentity: {}, synthesize }]);
  await service.render('cached');
  let release!: () => void;
  gate.wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { gate.entered = resolve; });
  const controller = new AbortController();
  const pending = service.render('cached', undefined, [], 'zh-CN', { signal: controller.signal });
  const outcome = expect(pending).rejects.toThrow('cancelled');
  await entered; controller.abort(); await outcome;
  service.dispose();
  let disposed = false; void service.whenDisposed().then(() => { disposed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10)); expect(disposed).toBe(false);
  release(); await service.whenDisposed(); expect(synthesize).toHaveBeenCalledTimes(1);
});

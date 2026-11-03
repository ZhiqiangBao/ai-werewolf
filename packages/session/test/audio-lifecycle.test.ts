import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeechService, type SpeechProvider } from '../src/speech';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
it('合成并发限制为二，失败释放槽位，同文合并且成功结果进入缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-audio-lifecycle-')); dirs.push(dir);
  const completions = new Map<string, { resolve: () => void; reject: () => void }>();
  const started: string[] = [];
  const synthesize = vi.fn<SpeechProvider['synthesize']>(async (text) => {
    started.push(text);
    await new Promise<void>((resolve, reject) => completions.set(text, { resolve, reject: () => reject(Error('fixture failure')) }));
    return { bytes: Buffer.from('test audio'), mimeType: 'audio/mpeg' };
  });
  const service = new SpeechService(dir, [{ id: 'fixture', label: 'fixture', cacheIdentity: {}, synthesize }]);
  const a = service.render('a'), same = service.render('a'), b = service.render('b');
  await vi.waitFor(() => expect(started).toHaveLength(2));
  const c = service.render('c'); await tick();
  expect(same).toBe(a); expect(started).not.toContain('c');
  const failed = expect(a).rejects.toThrow('fixture failure');
  completions.get('a')!.reject(); await failed;
  await vi.waitFor(() => expect(started).toContain('c'));
  completions.get('b')!.resolve(); completions.get('c')!.resolve();
  await Promise.all([b, c]); await tick();
  expect(await service.render('b')).toMatchObject({ mimeType: 'audio/mpeg' });
  expect(synthesize).toHaveBeenCalledTimes(3);
});

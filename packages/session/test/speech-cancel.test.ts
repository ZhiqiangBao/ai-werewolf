import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeechService, type SpeechProvider } from '../src/speech';
import { synthesizeQwen } from '../src/speech/qwen';
import { wavHeader } from '../src/speech/audio';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(taskTimeoutMs?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'speech-cancel-')); dirs.push(dir);
  const jobs = new Map<string, { signal: AbortSignal; resolve: () => void; reject: () => void }>();
  const synthesize = vi.fn<SpeechProvider['synthesize']>((text, signal) => new Promise((resolve, reject) => {
    jobs.set(text, { signal, resolve: () => resolve({ bytes: Buffer.from(text), mimeType: 'audio/mpeg' }), reject: () => reject(Error('late failure')) });
  }));
  return { service: new SpeechService(dir, [{ id: 'fake', label: 'fake', cacheIdentity: {}, synthesize }], undefined, undefined, taskTimeoutMs), jobs, synthesize };
}
const opts = (controller: AbortController) => ({ signal: controller.signal });

it('共享合成各自取消，最后一个离开后中止上游，迟到成功不能发布或进入服务缓存', async () => {
  const { service, jobs, synthesize } = await fixture();
  const a = new AbortController(), b = new AbortController();
  const one = service.render('same', undefined, [], 'zh-CN', opts(a));
  const two = service.render('same', undefined, [], 'zh-CN', opts(b));
  await vi.waitFor(() => expect(jobs.has('same')).toBe(true));
  const rejected = expect(one).rejects.toThrow('cancelled'); a.abort(); await rejected;
  expect(jobs.get('same')!.signal.aborted).toBe(false);
  jobs.get('same')!.resolve(); expect((await two).bytes.toString()).toBe('same');
  expect((await service.render('same')).bytes.toString()).toBe('same'); expect(synthesize).toHaveBeenCalledTimes(1);
  const c = new AbortController(); const abandoned = service.render('abandoned', undefined, [], 'zh-CN', opts(c));
  await vi.waitFor(() => expect(jobs.has('abandoned')).toBe(true));
  const cancelled = expect(abandoned).rejects.toThrow('cancelled'); c.abort(); await cancelled;
  expect(jobs.get('abandoned')!.signal.aborted).toBe(true);
  await expect(service.render('abandoned')).rejects.toThrow('retry later');
  jobs.get('abandoned')!.resolve();
  await vi.waitFor(() => expect(jobs.get('abandoned')!.signal.aborted).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = service.render('abandoned');
  await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(3)); jobs.get('abandoned')!.resolve(); await next;
  service.dispose(); await service.whenDisposed();
});

it('忽略取消的任务占用物理槽直到结束；排队取消、超时和迟到失败均可收尾', async () => {
  const { service, jobs, synthesize } = await fixture();
  const ca = new AbortController(), cb = new AbortController(), cq = new AbortController();
  const a = service.render('a', undefined, [], 'zh-CN', opts(ca));
  const b = service.render('b', undefined, [], 'zh-CN', opts(cb));
  await vi.waitFor(() => expect(jobs.size).toBe(2));
  const queue = service.render('queue', undefined, [], 'zh-CN', opts(cq));
  const timed = service.render('timed', undefined, [], 'zh-CN', { timeoutMs: 20 });
  const qResult = expect(queue).rejects.toThrow('cancelled'), tResult = expect(timed).rejects.toThrow('timed out');
  cq.abort(); await Promise.all([qResult, tResult]);
  const ar = expect(a).rejects.toThrow('cancelled'), br = expect(b).rejects.toThrow('cancelled'); ca.abort(); cb.abort(); await Promise.all([ar, br]);
  const next = service.render('next'); await new Promise((resolve) => setTimeout(resolve, 30));
  expect(synthesize).toHaveBeenCalledTimes(2);
  jobs.get('a')!.reject(); await vi.waitFor(() => expect(jobs.has('next')).toBe(true));
  jobs.get('next')!.resolve(); await next; jobs.get('b')!.resolve();
  service.dispose(); await service.whenDisposed();
});

it('缓存读取可以取消，关闭拒绝新请求并等待真正的上游结束', async () => {
  const { service, jobs } = await fixture();
  const cached = service.render('cached'); await vi.waitFor(() => expect(jobs.has('cached')).toBe(true)); jobs.get('cached')!.resolve(); await cached;
  const c = new AbortController(); const read = service.render('cached', undefined, [], 'zh-CN', opts(c)); const rejected = expect(read).rejects.toThrow('cancelled'); c.abort(); await rejected;
  const running = service.render('running'); const outcome = expect(running).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(jobs.has('running')).toBe(true)); service.dispose(); await outcome;
  await expect(service.render('new')).rejects.toThrow('disposed');
  let done = false; void service.whenDisposed().then(() => { done = true; }); await new Promise((resolve) => setTimeout(resolve, 20)); expect(done).toBe(false);
  jobs.get('running')!.resolve(); await service.whenDisposed(); expect(done).toBe(true);
});

it('独立等待超时不会中止其他等待者，等待队列有上限', async () => {
  const { service, jobs } = await fixture();
  const short = service.render('shared', undefined, [], 'zh-CN', { timeoutMs: 30 });
  const shortResult = expect(short).rejects.toThrow('timed out');
  const long = service.render('shared');
  await vi.waitFor(() => expect(jobs.has('shared')).toBe(true));
  await shortResult; expect(jobs.get('shared')!.signal.aborted).toBe(false);
  const queued = Array.from({ length: 127 }, (_, i) => service.render(`q${i}`).catch(() => undefined));
  await expect(service.render('overflow')).rejects.toThrow('queue full');
  const longResult = expect(long).rejects.toThrow('cancelled');
  service.dispose(); await longResult; await Promise.all(queued);
  for (const job of jobs.values()) job.resolve();
  await service.whenDisposed();
});

it('共享任务有固定期限，后来加入不续期；超期仍保留不合作上游的物理槽', async () => {
  const { service, jobs, synthesize } = await fixture(400);
  const first = service.render('same', undefined, [], 'zh-CN', { timeoutMs: 260 });
  const firstResult = expect(first).rejects.toThrow('timed out');
  const block = service.render('block'); const blockResult = expect(block).rejects.toThrow('timed out');
  await vi.waitFor(() => expect(jobs.size).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const late = service.render('same'); const lateResult = expect(late).rejects.toThrow('timed out');
  await firstResult; expect(jobs.get('same')!.signal.aborted).toBe(false);
  await Promise.all([lateResult, blockResult]);
  expect(jobs.get('same')!.signal.aborted).toBe(true);
  expect(jobs.get('block')!.signal.aborted).toBe(true);
  await expect(service.render('same')).rejects.toThrow('retry later');
  const next = service.render('next');
  await new Promise((resolve) => setTimeout(resolve, 40)); expect(synthesize).toHaveBeenCalledTimes(2);
  jobs.get('same')!.resolve(); await vi.waitFor(() => expect(jobs.has('next')).toBe(true));
  jobs.get('next')!.resolve(); await next;
  jobs.get('block')!.resolve(); service.dispose(); await service.whenDisposed();
});

it('Qwen 请求取消后迟到的有效音频不会开始写入缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speech-cancel-')); dirs.push(dir);
  vi.stubEnv('VIDEO_AUDIO_CACHE_DIRS', '');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => {
    entered(); await gate;
    return new Response(Buffer.concat([wavHeader(1000, 24000), Buffer.alloc(2000)]), { headers: { 'Content-Type': 'audio/wav' } });
  }));
  const controller = new AbortController(), output = join(dir, 'voice.wav');
  const pending = synthesizeQwen('测试', { voice: 'fixture', label: '', rate: 1, instruction: '' }, 'fixture', output, { signal: controller.signal, endpoint: 'https://example.invalid/tts', apiKey: 'fixture' });
  const rejected = expect(pending).rejects.toThrow();
  await started; controller.abort(); release(); await rejected;
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(output + '.json')).rejects.toMatchObject({ code: 'ENOENT' });
});

import { gameLanguage } from '@werewolf/protocol';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpeechProvidersView } from '@werewolf/protocol';
import { defaultSpeechConfig, speechProvider, type SpeechAudio, type SpeechConfig, type SpeechProvider } from './speech/providers';
export type { SpeechAudio, SpeechProvider, SpeechConfig, SpeechProviderConfig } from './speech/providers';

type Audio = { bytes: Buffer; mimeType: string };
type Subscriber = { resolve: (audio: Audio) => void; reject: (error: unknown) => void };
type Task = { controller: AbortController; subscribers: Set<Subscriber>; timer: ReturnType<typeof setTimeout> };
export interface SpeechRenderOptions { signal?: AbortSignal; timeoutMs?: number }
const MAX_PENDING = 128;
const WAIT_TIMEOUT_MS = 240000;
function cancelled(): Error { return Error('Speech synthesis cancelled'); }

const MIME_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/flac']);
function normalize(audio: SpeechAudio): { bytes: Buffer; mimeType: string } {
  const original = typeof audio.mimeType === 'string' ? audio.mimeType.split(';')[0].trim().toLowerCase() : '';
  const mimeType = ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(original) ? 'audio/wav' : original === 'audio/mp3' ? 'audio/mpeg' : original;
  if (!(audio.bytes instanceof Uint8Array) || !audio.bytes.length || audio.bytes.length > 40 * 1024 * 1024 || !MIME_TYPES.has(mimeType)) throw Error('Invalid synthesized audio');
  const bytes = Buffer.from(audio.bytes);
  if (mimeType === 'audio/wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('Not a WAV');
    let format = false, data = false;
    for (let at = 12; at + 8 <= bytes.length;) {
      const id = bytes.toString('ascii', at, at + 4), start = at + 8;
      let size = bytes.readUInt32LE(at + 4);
      if (id === 'fmt ') {
        if (size < 16 || start + size > bytes.length || !bytes.readUInt16LE(start + 2) || !bytes.readUInt32LE(start + 4)) throw Error('Invalid WAV format');
        format = true;
      }
      if (id === 'data') {
        size = Math.min(size, bytes.length - start);
        if (!size) throw Error('Empty WAV');
        bytes.writeUInt32LE(size, at + 4); data = true;
      }
      at = start + size + size % 2;
    }
    if (!format || !data) throw Error('Incomplete WAV');
    bytes.writeUInt32LE(bytes.length - 8, 4);
  }
  return { bytes, mimeType };
}

/** 所有提供方共用缓存、音频校验和并发预算；不隐式切换来源。 */
export class SpeechService {
  private readonly pending = new Map<string, Task>();
  private active = 0;
  private readonly waiters: { start: () => void; signal: AbortSignal; cancel: () => void }[] = [];
  private disposed = false;
  private disposedResolve?: () => void;
  private readonly disposedPromise = new Promise<void>((resolve) => { this.disposedResolve = resolve; });
  constructor(private readonly directory: string, private readonly providers: SpeechProvider[], private readonly defaultId: string | null = providers[0]?.id ?? null, private readonly configError?: string, private readonly taskTimeoutMs = WAIT_TIMEOUT_MS) {
    if (new Set(providers.map((p) => p.id)).size !== providers.length || (defaultId !== null && !providers.some((p) => p.id === defaultId))) throw Error('Invalid speech provider selection');
    if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs < 0 || taskTimeoutMs > 2147483647) throw Error('Invalid speech task timeout');
  }
  static configured(directory: string, configFile = join(dirname(directory), 'speech-providers.json')): SpeechService {
    try {
      const config: SpeechConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : defaultSpeechConfig();
      if (!Array.isArray(config.providers)) throw Error('Invalid speech providers');
      return new SpeechService(directory, config.providers.map((p) => speechProvider(p, directory, dirname(configFile))), config.defaultProviderId ?? config.providers[0]?.id ?? null);
    } catch {
      return new SpeechService(directory, [], null, '服务端朗读配置无效，请检查 speech-providers.json；浏览器原生朗读仍可独立使用。');
    }
  }
  catalog(additional: SpeechProvider[] = []): SpeechProvidersView {
    return { providers: [...this.providers, ...additional].map(({ id, label }) => ({ id, label })), defaultProviderId: this.defaultId ?? additional[0]?.id ?? null, ...(this.configError ? { error: this.configError } : {}) };
  }

  render(text: string, providerId?: string, additional: SpeechProvider[] = [], locale = 'zh-CN', options: SpeechRenderOptions = {}): Promise<Audio> {
    if (this.disposed) return Promise.reject(Error('Speech service disposed'));
    if (options.signal?.aborted) return Promise.reject(cancelled());
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2147483647)) return Promise.reject(Error('Invalid speech timeout'));
    gameLanguage(locale);
    const selected = providerId ?? this.defaultId ?? additional[0]?.id;
    const provider = [...this.providers, ...additional].find((p) => p.id === selected);
    if (!provider) return Promise.reject(new Error('Unknown speech provider'));
    const key = createHash('sha256').update(JSON.stringify({ version: 1, provider: provider.cacheIdentity, id: provider.id, text, ...(locale === 'zh-CN' ? {} : { locale }) })).digest('hex');
    let task = this.pending.get(key);
    if (task?.controller.signal.aborted) return Promise.reject(Error('Speech synthesis cancelling; retry later'));
    if (!task) {
      if (this.pending.size >= MAX_PENDING) return Promise.reject(Error('Speech synthesis queue full; retry later'));
      const controller = new AbortController();
      const subscribers = new Set<Subscriber>();
      const timer = setTimeout(() => {
        controller.abort();
        for (const subscriber of [...subscribers]) subscriber.reject(Error('Speech synthesis timed out'));
      }, this.taskTimeoutMs);
      timer.unref();
      task = { controller, subscribers, timer };
      this.pending.set(key, task);
      const current = task;
      void Promise.resolve().then(() => this.synthesize(provider, text, key, locale, current.controller.signal)).then(
        (audio) => this.finish(key, current, undefined, audio),
        (error: unknown) => this.finish(key, current, error),
      );
    }
    const current = task;
    return new Promise<Audio>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); current.subscribers.delete(subscriber); };
      const leave = (error: Error) => { cleanup(); reject(error); if (!current.subscribers.size) { clearTimeout(current.timer); current.controller.abort(); } };
      const cancel = () => leave(cancelled());
      const subscriber: Subscriber = { resolve: (audio) => { cleanup(); resolve(audio); }, reject: (error) => { cleanup(); reject(error); } };
      current.subscribers.add(subscriber);
      options.signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => leave(Error('Speech synthesis timed out')), options.timeoutMs ?? WAIT_TIMEOUT_MS);
      if (options.signal?.aborted) cancel();
    });
  }
  private finish(key: string, task: Task, error?: unknown, audio?: Audio): void {
    clearTimeout(task.timer);
    this.pending.delete(key);
    for (const subscriber of [...task.subscribers]) {
      if (audio && !task.controller.signal.aborted) subscriber.resolve(audio); else subscriber.reject(error ?? cancelled());
    }
    if (this.disposed && !this.pending.size) this.disposedResolve?.();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.controller.abort();
      for (const subscriber of [...task.subscribers]) subscriber.reject(cancelled());
    }
    if (!this.pending.size) this.disposedResolve?.();
  }
  whenDisposed(): Promise<void> { return this.disposedPromise; }
  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < 2) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        start: () => { signal.removeEventListener('abort', entry.cancel); this.active++; resolve(); },
        cancel: () => { const index = this.waiters.indexOf(entry); if (index !== -1) this.waiters.splice(index, 1); reject(cancelled()); },
      };
      this.waiters.push(entry);
      signal.addEventListener('abort', entry.cancel, { once: true });
      if (signal.aborted) entry.cancel();
    });
  }
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next.start();
  }
  private async synthesize(provider: SpeechProvider, text: string, key: string, locale: string, signal: AbortSignal): Promise<Audio> {
    signal.throwIfAborted();
    const output = join(this.directory, key + '.audio');
    try {
      const meta = JSON.parse(await readFile(output + '.json', 'utf8'));
      const bytes = await readFile(output);
      signal.throwIfAborted();
      if (meta.key === key && meta.bytes === bytes.length && meta.digest === createHash('sha256').update(bytes).digest('hex')) return normalize({ bytes, mimeType: meta.mimeType });
    } catch { signal.throwIfAborted(); /* Missing or invalid cache: synthesize again. */ }
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      const audio = normalize(await provider.synthesize(text, signal, { locale }));
      signal.throwIfAborted();
      await mkdir(this.directory, { recursive: true });
      signal.throwIfAborted();
      await writeFile(output + '.partial', audio.bytes);
      signal.throwIfAborted();
      await rename(output + '.partial', output);
      signal.throwIfAborted();
      await writeFile(output + '.json', JSON.stringify({ key, providerId: provider.id, mimeType: audio.mimeType, bytes: audio.bytes.length, digest: createHash('sha256').update(audio.bytes).digest('hex') }));
      signal.throwIfAborted();
      return audio;
    } finally { this.release(); }
  }
}

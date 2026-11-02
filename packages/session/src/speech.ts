import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpeechProvidersView } from '@werewolf/protocol';
import { defaultSpeechConfig, speechProvider, type SpeechAudio, type SpeechConfig, type SpeechProvider } from './speech/providers';
export type { SpeechAudio, SpeechProvider, SpeechConfig, SpeechProviderConfig } from './speech/providers';

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
  private readonly pending = new Map<string, Promise<{ bytes: Buffer; mimeType: string }>>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly directory: string, private readonly providers: SpeechProvider[], private readonly defaultId: string | null = providers[0]?.id ?? null, private readonly configError?: string) {
    if (new Set(providers.map((p) => p.id)).size !== providers.length || (defaultId !== null && !providers.some((p) => p.id === defaultId))) throw Error('Invalid speech provider selection');
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

  render(text: string, providerId?: string, additional: SpeechProvider[] = []): Promise<{ bytes: Buffer; mimeType: string }> {
    const selected = providerId ?? this.defaultId ?? additional[0]?.id;
    const provider = [...this.providers, ...additional].find((p) => p.id === selected);
    if (!provider) return Promise.reject(new Error('Unknown speech provider'));
    const key = createHash('sha256').update(JSON.stringify({ version: 1, provider: provider.cacheIdentity, id: provider.id, text })).digest('hex');
    const running = this.pending.get(key);
    if (running) return running;
    const task = this.synthesize(provider, text, key).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  private async synthesize(provider: SpeechProvider, text: string, key: string) {
    const output = join(this.directory, key + '.audio');
    try {
      const meta = JSON.parse(await readFile(output + '.json', 'utf8'));
      const bytes = await readFile(output);
      if (meta.key === key && meta.bytes === bytes.length && meta.digest === createHash('sha256').update(bytes).digest('hex')) return normalize({ bytes, mimeType: meta.mimeType });
    } catch { /* Missing or invalid cache: synthesize again. */ }
    if (this.active < 2) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      const signal = AbortSignal.timeout(240000);
      let aborted: (() => void) | undefined;
      const timeout = new Promise<never>((_, reject) => { aborted = () => reject(Error('Speech synthesis timed out')); signal.addEventListener('abort', aborted, { once: true }); });
      let audio: ReturnType<typeof normalize>;
      try { audio = normalize(await Promise.race([provider.synthesize(text, signal), timeout])); }
      finally { if (aborted) signal.removeEventListener('abort', aborted); }
      await mkdir(this.directory, { recursive: true });
      await writeFile(output + '.partial', audio.bytes); await rename(output + '.partial', output);
      await writeFile(output + '.json', JSON.stringify({ key, providerId: provider.id, mimeType: audio.mimeType, bytes: audio.bytes.length, digest: createHash('sha256').update(audio.bytes).digest('hex') }));
      return audio;
    } finally {
      const next = this.waiters.shift();
      if (next) next(); else this.active--;
    }
  }
}

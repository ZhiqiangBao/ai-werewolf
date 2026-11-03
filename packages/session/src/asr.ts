import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectQwenTokenPlanKey } from './project-models';
import { mimoConnection } from './speech/mimo';

export type AsrProvider = 'local' | 'qwen-token-plan' | 'mimo-token-plan';
export type LocalAsrBackend = 'transformers' | 'gguf';
export interface LocalAsrRuntime { device: string; dtype: string; versions: Record<string, string | null>; [key: string]: unknown }
export interface AsrOptions { provider?: AsrProvider; locale?: string; dataDir?: string; signal?: AbortSignal }
export interface AsrResult {
  provider: AsrProvider; inputAudioSha256: string; model: string; revision: string | null; text: string;
  rawResult: unknown; truncated: boolean | null; elapsedMs: number; options: { language: 'auto' };
  backend?: LocalAsrBackend; runtime?: LocalAsrRuntime;
}
export const LOCAL_ASR_MODEL = 'Qwen/Qwen3-ASR-0.6B-hf';
export const LOCAL_ASR_REVISION = '7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c';
export const LOCAL_GGUF_MODEL = 'handy-computer/Qwen3-ASR-1.7B-gguf';
export const LOCAL_GGUF_REVISION = '0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f';
export const LOCAL_GGUF_FILE = 'Qwen3-ASR-1.7B-Q8_0.gguf';
export const LOCAL_GGUF_SHA256 = '9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7';
export function localModelIdentity(backend: unknown) {
  if (backend === 'transformers') return { backend, model: LOCAL_ASR_MODEL, revision: LOCAL_ASR_REVISION } as const;
  if (backend === 'gguf') return { backend, model: LOCAL_GGUF_MODEL, revision: LOCAL_GGUF_REVISION } as const;
  throw Error('Unsupported local ASR backend');
}
export function validLocalRuntime(value: unknown, backend?: LocalAsrBackend): value is LocalAsrRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const runtime = value as Record<string, unknown>, versions = runtime.versions;
  if (typeof runtime.device !== 'string' || !runtime.device || typeof runtime.dtype !== 'string' || !runtime.dtype || !versions || typeof versions !== 'object' || Array.isArray(versions)) return false;
  if (backend === 'gguf' && runtime.dtype !== 'Q8_0') return false;
  const values = versions as Record<string, unknown>;
  const required = backend === 'gguf' ? ['python', 'transcribe_cpp', 'native'] : backend === 'transformers' ? ['python', 'torch', 'transformers'] : ['python'];
  return required.every((key) => typeof values[key] === 'string' && !!values[key]) && Object.values(values).every((v) => v === null || typeof v === 'string');
}
export function asrLanguage(locale: unknown): 'zh' | 'en' | 'ja' {
  if (typeof locale !== 'string' || !locale.trim()) throw Error('ASR requires an explicit zh, en or ja locale');
  let language: string;
  try { language = new Intl.Locale(locale).language; } catch { throw Error('ASR requires an explicit zh, en or ja locale'); }
  if (language !== 'zh' && language !== 'en' && language !== 'ja') throw Error('ASR requires an explicit zh, en or ja locale');
  return language;
}
export function asrProviderForLocale(provider: AsrProvider | 'auto', locale: unknown): AsrProvider {
  const language = asrLanguage(locale);
  const effective = provider === 'auto' ? (language === 'ja' ? 'qwen-token-plan' : 'local') : provider;
  if (!['local', 'qwen-token-plan', 'mimo-token-plan'].includes(effective)) throw Error('Unsupported ASR provider');
  if (language === 'ja' && effective !== 'qwen-token-plan') throw Error('Local and MiMo ASR are restricted to zh or en clips');
  return effective;
}
export const QWEN_ASR_MODEL = 'qwen-audio-3.0-asr-flash';
export const MIMO_ASR_MODEL = 'mimo-v2.5-asr';
/** Parse the same provider response for fresh recognition and persisted cache checks. */
export function parseCloudAsrResponse(provider: Exclude<AsrProvider, 'local'>, value: unknown): { text: string; truncated: boolean | null } {
  const raw = value as any;
  let text: unknown, truncated: boolean | null;
  if (provider === 'qwen-token-plan') {
    if (raw?.code || raw?.error) throw Error('Qwen Token Plan ASR response failed');
    text = raw?.output?.sentence?.text;
    truncated = raw?.output?.finish_reason === 'length' ? true : raw?.output?.finish_reason === 'stop' ? false : null;
  } else {
    if (raw?.error || !['stop', 'length'].includes(raw?.choices?.[0]?.finish_reason)) throw Error('MiMo Token Plan ASR response failed or incomplete');
    text = raw.choices[0].message?.content; truncated = raw.choices[0].finish_reason === 'length';
  }
  if (typeof text !== 'string' || !text.trim()) throw Error(`${provider} ASR returned no transcript`);
  return { text, truncated };
}
const QWEN_ENDPOINT = 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation';
export const asrAudioSha256 = (audio: Buffer) => createHash('sha256').update(audio).digest('hex');

/** All providers receive exactly the same measured mono 16 kHz PCM16 WAV bytes. */
export function assertCanonicalAsrWav(audio: Buffer) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.length > 16 * 1024 * 1024 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) !== audio.length - 8) throw Error('Expected canonical 16 kHz mono PCM16 WAV');
  let format = false, data = false;
  for (let at = 12; at + 8 <= audio.length;) {
    const name = audio.toString('ascii', at, at + 4), size = audio.readUInt32LE(at + 4), start = at + 8;
    if (start + size > audio.length) throw Error('Incomplete ASR WAV');
    if (name === 'fmt ') {
      if (format || size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1 || audio.readUInt32LE(start + 4) !== 16000 || audio.readUInt16LE(start + 14) !== 16) throw Error('Expected canonical 16 kHz mono PCM16 WAV');
      format = true;
    }
    if (name === 'data') { if (data || !size || size % 2) throw Error('Invalid ASR WAV data'); data = true; }
    at = start + size + size % 2;
  }
  if (!format || !data) throw Error('Incomplete ASR WAV');
}

async function localConnection(dataDir?: string) {
  const root = resolve(dataDir || process.env.WEREWOLF_DATA || process.env.VIDEO_DATA_DIR || 'data', 'local-asr');
  let state: { endpoint?: unknown; nonce?: unknown; pid?: unknown; backend?: unknown }, control: { token?: unknown; nonce?: unknown };
  try {
    state = JSON.parse(await readFile(resolve(root, 'service-state.json'), 'utf8'));
    control = JSON.parse(await readFile(resolve(root, 'service-control.json'), 'utf8'));
  } catch { throw Error('Local ASR connection is unavailable'); }
  if (typeof state.endpoint !== 'string' || typeof control.token !== 'string' || !control.token.trim() || /[\r\n]/.test(control.token) || typeof state.nonce !== 'string' || !state.nonce || state.nonce !== control.nonce || !Number.isSafeInteger(state.pid) || Number(state.pid) <= 0) throw Error('Local ASR connection is unavailable');
  let url: URL;
  try { url = new URL(state.endpoint); } catch { throw Error('Invalid local ASR endpoint'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw Error('Invalid local ASR endpoint');
  url.pathname = '/v1/transcribe';
  return { endpoint: url.href, token: control.token, nonce: state.nonce, pid: state.pid, ...localModelIdentity(state.backend) };
}

/** Check the authenticated local service without submitting audio. */
export async function assertLocalAsrReady(dataDir?: string, signal?: AbortSignal) {
  const local = await localConnection(dataDir);
  const healthUrl = new URL(local.endpoint); healthUrl.pathname = '/health';
  let health: any;
  try {
    const response = await fetch(healthUrl, { method: 'GET', headers: { Authorization: `Bearer ${local.token}` }, redirect: 'error', signal: signal ?? AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('Not ready');
    health = await response.json();
  } catch { signal?.throwIfAborted(); throw Error('Local ASR service is unavailable'); }
  if (health?.status !== 'ready' || health.nonce !== local.nonce || health.pid !== local.pid || health.backend !== local.backend) throw Error('Local ASR service identity or readiness changed');
  return local;
}

/** Reuse an authenticated service or invoke the caller's explicit local start once. */
export async function ensureLocalAsrReady(dataDir: string, start: () => Promise<void>) {
  const configured = async () => {
    const root = resolve(dataDir, 'local-asr');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(resolve(root, 'service-settings.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Local ASR service settings are invalid'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Local ASR service settings are invalid');
    const state = JSON.parse(await readFile(resolve(root, 'service-state.json'), 'utf8')) as { backend?: unknown; configuration?: Record<string, unknown> };
    const envKeys: Record<string, string> = { backend: 'WEREWOLF_ASR_BACKEND', device: 'WEREWOLF_ASR_DEVICE', modelDir: 'WEREWOLF_ASR_MODEL_DIR', python: 'WEREWOLF_ASR_PYTHON', bindings: 'WEREWOLF_ASR_BINDINGS_DIR', library: 'TRANSCRIBE_LIBRARY' };
    for (const [key, envKey] of Object.entries(envKeys)) {
      const desired = process.env[envKey] || settings[key];
      if (desired !== undefined && (typeof desired !== 'string' || !desired || (key === 'backend' ? state.backend : state.configuration?.[key]) !== desired)) throw Error(`Local ASR service does not match configured ${key}; restart it explicitly`);
    }
  };
  try { const service = await assertLocalAsrReady(dataDir); await configured(); return service; }
  catch (error) {
    if (!(error instanceof Error) || !['Local ASR service is unavailable', 'Local ASR connection is unavailable'].includes(error.message)) throw error;
    await start();
    const service = await assertLocalAsrReady(dataDir); await configured(); return service;
  }
}

/** Explicit provider only; no hidden prompt, language hint, billing fallback or retry route. */
export async function transcribeAudio(audio: Buffer, options: AsrOptions = {}): Promise<AsrResult> {
  assertCanonicalAsrWav(audio);
  const provider = asrProviderForLocale(options.provider ?? 'local', options.locale);
  options.signal?.throwIfAborted();
  const hash = asrAudioSha256(audio), started = performance.now(), signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000);
  let endpoint: string, headers: Record<string, string>, body: BodyInit, localIdentity: ReturnType<typeof localModelIdentity> | undefined;
  if (provider === 'local') {
    const local = await assertLocalAsrReady(options.dataDir, signal);
    localIdentity = local;
    endpoint = local.endpoint; headers = { Authorization: `Bearer ${local.token}`, 'Content-Type': 'audio/wav', 'X-ASR-Language': 'auto' }; body = new Uint8Array(audio);
  } else if (provider === 'qwen-token-plan') {
    const key = projectQwenTokenPlanKey(); if (!key?.startsWith('sk-sp-')) throw Error('Qwen Token Plan credential is unavailable');
    endpoint = QWEN_ENDPOINT; headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' };
    body = JSON.stringify({ model: QWEN_ASR_MODEL, input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio.toString('base64')}` } }] }] }, parameters: { format: 'wav', sample_rate: '16000' } });
  } else {
    const connection = mimoConnection({ billing: 'token-plan' }), key = process.env[connection.apiKeyEnv]?.trim();
    if (!key) throw Error('MiMo Token Plan credential is unavailable');
    endpoint = connection.endpoint; headers = { 'api-key': key, 'Content-Type': 'application/json' };
    body = JSON.stringify({ model: MIMO_ASR_MODEL, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio.toString('base64')}` } }] }], asr_options: { language: 'auto' } });
  }
  let response: Response;
  try { response = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal }); }
  catch { options.signal?.throwIfAborted(); throw Error(`${provider} ASR request failed`); }
  if (!response.ok) throw Error(`${provider} ASR HTTP ${response.status}`);
  let raw: any;
  try { raw = await response.json(); } catch { throw Error(`${provider} ASR returned invalid JSON`); }
  let text: unknown, model: string, revision: string | null, truncated: boolean | null;
  if (provider === 'local') {
    if (!localIdentity || raw?.audioSha256 !== hash || raw?.requestedLanguage !== 'auto' || raw?.model?.repo !== localIdentity.model || raw?.model?.revision !== localIdentity.revision || raw?.model?.backend !== localIdentity.backend || ![true, false, null].includes(raw?.truncated) || !validLocalRuntime(raw?.runtime, localIdentity.backend) || (localIdentity.backend === 'gguf' && (raw.model.file !== LOCAL_GGUF_FILE || raw.model.sha256 !== LOCAL_GGUF_SHA256))) throw Error('Local ASR response binding is invalid');
    text = raw.transcription; model = raw.model.repo; revision = raw.model.revision; truncated = raw.truncated;
  } else {
    ({ text, truncated } = parseCloudAsrResponse(provider, raw));
    model = provider === 'qwen-token-plan' ? QWEN_ASR_MODEL : MIMO_ASR_MODEL; revision = null;
  }
  if (typeof text !== 'string' || (provider !== 'local' && !text.trim())) throw Error(`${provider} ASR returned no transcript`);
  return { provider, inputAudioSha256: hash, model, revision, text, rawResult: raw, truncated, elapsedMs: Math.round(performance.now() - started), options: { language: 'auto' },
    ...(provider === 'local' ? { backend: localIdentity!.backend, runtime: raw.runtime as LocalAsrRuntime } : {}) };
}

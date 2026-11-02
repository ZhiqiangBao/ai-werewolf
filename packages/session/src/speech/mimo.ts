import { wavHeader } from './audio';
import type { VoiceProfile } from './types';

export type MimoBilling = 'api' | 'token-plan';
export interface MimoOptions {
  billing?: MimoBilling;
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  signal?: AbortSignal;
}
export const MIMO_MODEL = 'mimo-v2.5-tts';
export const MIMO_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'] as const;
const LIMIT = 40 * 1024 * 1024;

/** Resolve only the explicitly selected billing route; never borrow a different key. */
export function mimoConnection(options: MimoOptions = {}) {
  const billing = options.billing ?? 'api';
  if (billing !== 'api' && billing !== 'token-plan') throw Error('Invalid MiMo billing route');
  const prefix = billing === 'token-plan' ? 'XIAOMI_MIMO_TOKEN_PLAN' : 'XIAOMI_MIMO_API';
  const apiKeyEnv = options.apiKeyEnv ?? `${prefix}_KEY`;
  const base = process.env[options.baseUrlEnv ?? `${prefix}_URL`]?.trim() || (billing === 'api' ? 'https://api.xiaomimimo.com/v1' : '');
  if (!base) throw Error('MiMo Token Plan URL is unavailable; configure XIAOMI_MIMO_TOKEN_PLAN_URL');
  let url: URL;
  try { url = new URL(base); } catch { throw Error('Invalid MiMo base URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
    (billing === 'token-plan' ? !/^token-plan-(cn|sgp|ams)\.xiaomimimo\.com$/.test(url.hostname) : url.hostname !== 'api.xiaomimimo.com')) {
    throw Error('MiMo URL does not match the selected billing route');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/v1' && path !== '/v1/chat/completions') throw Error('MiMo needs an OpenAI-compatible /v1 URL');
  url.pathname = '/v1/chat/completions';
  return { billing, endpoint: url.href, apiKeyEnv };
}

export function mimoRequest(text: string, profile: VoiceProfile, model = MIMO_MODEL) {
  if (model !== MIMO_MODEL && model !== 'mimo-v2.5-tts-voicedesign') throw Error('Unsupported MiMo TTS model; use mimo-v2.5-tts or mimo-v2.5-tts-voicedesign');
  if (!text.trim() || text.length > 16000 || !Number.isFinite(profile.rate) || profile.rate < .5 || profile.rate > 2 || typeof profile.instruction !== 'string') throw Error('Invalid MiMo speech text or profile');
  if (profile.seed !== undefined) throw Error('MiMo TTS seed is not supported; remove the Qwen seed setting');
  if (model === MIMO_MODEL && !MIMO_VOICES.some((voice) => voice === profile.voice)) throw Error('Unsupported MiMo voice; do not reuse a Qwen voice ID');
  if (model === 'mimo-v2.5-tts-voicedesign' && !profile.instruction.trim()) throw Error('MiMo voice design needs a voice description in instruction');
  const instruction = [profile.instruction.trim(), ...(profile.rate === 1 ? [] : [`请按正常语速的 ${profile.rate} 倍朗读。`]), '只朗读给定原文，不增删或改写内容。'].filter(Boolean).join('\n');
  return { model, messages: [{ role: 'user', content: instruction }, { role: 'assistant', content: text }],
    audio: { format: 'wav', ...(model === MIMO_MODEL ? { voice: profile.voice } : {}) }, stream: false };
}

/** MiMo WAV is PCM16 mono at 24kHz. Repair streaming sizes using measured data. */
export function normalizeMimoWav(bytes: Buffer): Buffer {
  if (bytes.length < 44 || bytes.length > LIMIT || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('MiMo TTS did not return a complete WAV');
  let format = false, data: Buffer | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4), start = at + 8;
    const declared = bytes.readUInt32LE(at + 4);
    const size = id === 'data' && [0xffffffff, 0x7fffffff].includes(declared) ? bytes.length - start : declared;
    if (start + size > bytes.length) throw Error('Incomplete MiMo WAV chunk');
    if (id === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 24000 || bytes.readUInt16LE(start + 14) !== 16) throw Error('Expected MiMo 24kHz mono PCM16 WAV');
      format = true;
    }
    if (id === 'data') { if (data) throw Error('Duplicate MiMo WAV data'); data = bytes.subarray(start, start + size); }
    at = start + size + size % 2;
  }
  if (!format || !data?.length || data.length % 2) throw Error('Incomplete MiMo PCM audio');
  return Buffer.concat([wavHeader(data.length / 2, 24000), data]);
}

/** Live reading uses the documented chat/completions audio protocol, without timestamps. */
export async function synthesizeMimo(text: string, profile: VoiceProfile, model = MIMO_MODEL, options: MimoOptions = {}): Promise<Buffer> {
  const connection = mimoConnection(options), request = mimoRequest(text, profile, model);
  const key = process.env[connection.apiKeyEnv]?.trim();
  if (!key) throw Error(`MiMo TTS key is unavailable; configure ${connection.apiKeyEnv}`);
  if (connection.billing === 'api' && /^(?:tp-|ttp-)/.test(key)) throw Error('MiMo Token Plan key cannot use the ordinary API route');
  const response = await fetch(connection.endpoint, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000) });
  // Never include remote error bodies, which may echo credentials or private text.
  if (!response.ok) throw Error(`MiMo TTS HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('json') || !response.body) throw Error('MiMo TTS expected a JSON audio response');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT * 1.5) { await response.body.cancel().catch(() => {}); throw Error('MiMo TTS response is too large'); }
    chunks.push(chunk);
  }
  let body: { error?: unknown; choices?: { finish_reason?: string; message?: { audio?: { data?: unknown } } }[] };
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('MiMo TTS returned invalid JSON'); }
  const encoded = body?.choices?.[0]?.message?.audio?.data;
  if (body?.error || body?.choices?.[0]?.finish_reason !== 'stop' || typeof encoded !== 'string' || !encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Error('MiMo TTS returned incomplete or invalid audio');
  return normalizeMimoWav(Buffer.from(encoded, 'base64'));
}

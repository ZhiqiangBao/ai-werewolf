import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadQwenPresets } from '../qwen-presets';
import type { VoiceProfile, AudioMeta } from './types';
import { reuseAudio } from './audio-cache';
export type { VoiceProfile, Word, AudioMeta } from './types';

// The user authorized Token Plan. Never silently switch to a pay-as-you-go key.
const ENDPOINT = 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';
export async function synthesizeQwen(text: string, profile: VoiceProfile, model: string, output: string, options?: { signal: AbortSignal }): Promise<AudioMeta> {
  const seed = profile.seed ?? 31415;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw Error('Invalid Qwen synthesis seed');
  const input = { text, voice: profile.voice, format: 'wav', sample_rate: 24000, rate: profile.rate,
    instruction: profile.instruction, language_hints: ['zh'], word_timestamp_enabled: true, seed };
  const cacheKey = createHash('sha256').update(JSON.stringify({ model, input })).digest('hex');
  try {
    const meta = JSON.parse(await readFile(output + '.json', 'utf8')) as AudioMeta;
    const bytes = await readFile(output);
    if (meta.cacheKey === cacheKey && bytes.length === meta.bytes && bytes.subarray(0, 4).toString() === 'RIFF') return meta;
  } catch { /* Missing/incomplete cache: regenerate this clip only. */ }
  const reused = await reuseAudio(cacheKey, output);
  if (reused) return reused;
  const apiKey = process.env.WEREWOLF_TTS_API_KEY || loadQwenPresets().find((p) =>
    new URL(p.baseUrl).hostname === 'token-plan.maas.qianwenaiapi.com' && p.apiKey?.startsWith('sk-sp-'))?.apiKey;
  if (!apiKey?.startsWith('sk-sp-')) throw Error('Qwen Token Plan key is unavailable');
  const response = await fetch(ENDPOINT, { method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'enable' },
    body: JSON.stringify({ model, input }), signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000) });
  if (!response.ok) {
    let code = 'HTTP error';
    try { const body = await response.json() as Record<string, unknown>; code = String(body.code ?? body.message ?? code).slice(0, 150); } catch { /* Do not print raw HTTP bodies or credentials. */ }
    throw Error(`Qwen TTS ${response.status}: ${code}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  let audio: Buffer | undefined; let audioUrl: string | undefined; let requestId: string | undefined; let stopped = false;
  const sentences = new Map<number, AudioMeta['sentences'][number]>();
  const audioChunks: Buffer[] = [];
  function accept(event: any) {
    if (event.code) throw Error(`Qwen TTS: ${String(event.code).slice(0, 100)}`);
    requestId = event.request_id ?? requestId;
    const o = event.output ?? {};
    if (o.finish_reason === 'stop') stopped = true;
    if (o.audio?.url) audioUrl = o.audio.url;
    if (o.audio?.data) audioChunks.push(Buffer.from(o.audio.data, 'base64'));
    if (o.sentence) {
      const s = o.sentence, previous = sentences.get(s.index);
      sentences.set(s.index, { index: s.index, text: o.original_text ?? previous?.text ?? '',
        words: s.words?.length ? s.words : previous?.words ?? [] });
    }
  }
  if (contentType.includes('event-stream')) {
    const decoder = new TextDecoder(); let pending = '';
    function acceptBlock(block: string) {
      const payload = block.split(/\r?\n/).filter((line) => !/^(event|id|retry):|^:/.test(line))
        .map((line) => line.startsWith('data:') ? line.slice(5).trimStart() : line).join('\n').trim();
      if (payload && payload !== '[DONE]') accept(JSON.parse(payload));
    }
    for await (const chunk of response.body!) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        acceptBlock(block);
      }
    }
    if (pending.trim()) acceptBlock(pending);
    if (!stopped) throw Error('Qwen TTS stream ended without completion');
  } else if (contentType.includes('json')) accept(await response.json());
  else audio = Buffer.from(await response.arrayBuffer());
  if (audioUrl) {
    // Fetch generated media without forwarding the API key to the storage host.
    const url = new URL(audioUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw Error('Unsupported audio URL');
    const download = await fetch(url, { signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    if (!download.ok) throw Error(`Generated audio download HTTP ${download.status}`);
    audio = Buffer.from(await download.arrayBuffer());
  }
  audio ??= Buffer.concat(audioChunks);
  if (audio.length < 1000 || audio.subarray(0, 4).toString() !== 'RIFF') throw Error('Qwen TTS did not return a complete WAV');
  const meta: AudioMeta = { cacheKey, model, voice: profile.voice, text, sentences: [...sentences.values()], requestId, bytes: audio.length };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output + '.partial', audio);
  await rename(output + '.partial', output);
  await writeFile(output + '.json', JSON.stringify(meta, null, 2));
  return meta;
}

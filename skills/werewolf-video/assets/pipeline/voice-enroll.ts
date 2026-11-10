import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { VoiceCatalog } from './project';

const args = new Map(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return [arg.slice(0, index < 0 ? undefined : index), index < 0 ? 'true' : arg.slice(index + 1)];
}));
const project = resolve(args.get('--project-dir') || process.env.VIDEO_PROJECT_DIR || 'data/video/current');
const referenceDir = resolve(args.get('--reference-dir') || join(project, 'voice-references'));
const model = args.get('--model') || 'qwen-audio-3.1-tts-flash';
const endpoint = args.get('--endpoint') || 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization';
const apiKey = process.env[args.get('--api-key-env') || 'DASHSCOPE_API_KEY'];
const force = args.has('--force');
const design = args.has('--design');
const selectedSeats = args.get('--seats')?.split(',').map((value) => `seat-${value}`);
if (!apiKey) throw Error('Missing voice enrollment API key');
if (!/^qwen-audio-[0-9.]+-tts-(?:plus|flash)$/.test(model)) throw Error(`Unsupported target model: ${model}`);

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = async <T>(file: string, fallback?: T) => existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as T : fallback;
const request = async (body: unknown) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`Voice enrollment HTTP ${response.status}`);
  return await response.json() as any;
};
const waitReady = async (voiceId: string) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await request({ model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId } });
    const status = result.output?.status;
    if (status === 'OK') return status;
    if (status !== 'DEPLOYING') throw Error(`Voice ${voiceId} status ${String(status)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw Error(`Voice ${voiceId} did not become ready`);
};

const voicesFile = join(project, 'voices.json');
const voices = await json<VoiceCatalog>(voicesFile);
if (!voices) throw Error(`Missing ${voicesFile}`);
const manifestFile = join(project, 'voice-enrollment.json');
const loadedManifest = await json<{ model?: string; voices?: Record<string, any> }>(manifestFile);
const manifest: { model?: string; voices?: Record<string, any> } = loadedManifest ?? { model, voices: {} };
manifest.model = model;
manifest.voices ??= {};
voices.flashVoiceBindings ??= {};
await mkdir(project, { recursive: true });
const art = design && existsSync(join(project, 'art-manifest.json')) ? await json<{ seats?: { seat: number; appearance?: string; gender?: string }[] }>(join(project, 'art-manifest.json')) : undefined;
for (const key of Object.keys(voices.profiles).filter((item) => /^seat-\d+$/.test(item) && (!selectedSeats || selectedSeats.includes(item)))) {
  const referenceFile = join(referenceDir, `${key}.wav`);
  const audio = design ? undefined : await readFile(referenceFile).catch(() => undefined);
  if (!design && !audio) throw Error(`Missing reference audio ${referenceFile}`);
  const referenceSha256 = audio ? sha(audio) : undefined, previous = manifest.voices[key];
  if (!force && previous?.model === model && (design ? previous.voicePrompt : previous.referenceSha256 === referenceSha256) && previous.status === 'OK') {
    voices.flashVoiceBindings[key] = previous.voice;
    voices.profiles[key] = { ...voices.profiles[key], voice: previous.voice };
    continue;
  }
  const seat = Number(key.slice(5)), character = art?.seats?.find((item) => item.seat === seat), voicePrompt = design
    ? `${character?.gender || '中性'}，${character?.appearance || '狼人杀桌游人物'}。普通话自然清晰，音量适中，长句稳定，避免喊叫和削波。${voices.profiles[key].instruction || '沉稳、连贯、适合长段桌游发言'}。${args.get('--prompt-suffix') || ''}`
    : undefined;
  const created = design
    ? await request({ model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, voice_prompt: voicePrompt, preview_text: '这段声音用于狼人杀视频人物参考，请保持自然、清晰、稳定的普通话。', prefix: `${(args.get('--prefix') || 'werewolf').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'werewolf'}`, language_hints: ['zh'] }, parameters: { sample_rate: 24000, response_format: 'wav' } })
    : await request({ model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, prefix: `${args.get('--prefix') || 'werewolf'}-${key}`, audio: `data:audio/wav;base64,${audio!.toString('base64')}` } });
  const voice = created.output?.voice_id ?? created.output?.voice ?? created.voice;
  if (typeof voice !== 'string' || !voice.trim()) throw Error(`Voice enrollment returned no voice ID for ${key}`);
  const status = design ? 'OK' : await waitReady(voice);
  manifest.voices[key] = { voice, model, ...(design ? { voicePrompt } : { referenceSha256, referenceFile }), status, createdAt: new Date().toISOString() };
  voices.flashVoiceBindings[key] = voice;
  voices.profiles[key] = { ...voices.profiles[key], voice };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(voicesFile, JSON.stringify({ ...voices, model }, null, 2) + '\n');
  console.log(JSON.stringify({ voiceKey: key, voice, model, status }));
}
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(voicesFile, JSON.stringify({ ...voices, model }, null, 2) + '\n');
console.log(JSON.stringify({ complete: true, model, voices: Object.keys(voices.flashVoiceBindings).length, manifest: manifestFile }));

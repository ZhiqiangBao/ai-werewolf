import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { VoiceCatalog } from './project';
import { characterVoiceDirection } from './character-delivery';
import { projectTtsModel } from './tts-config';

const args = new Map(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return [arg.slice(0, index < 0 ? undefined : index), index < 0 ? 'true' : arg.slice(index + 1)];
}));
const project = resolve(args.get('--project-dir') || process.env.VIDEO_PROJECT_DIR || 'data/video/current');
const referenceDir = resolve(args.get('--reference-dir') || join(project, 'voice-references'));
const voicesFile = resolve(process.env.VIDEO_VOICES_FILE || join(project, 'voices.json'));
const voices = JSON.parse(await readFile(voicesFile, 'utf8')) as VoiceCatalog;
const model = projectTtsModel(args.get('--model'), voices);
const endpoint = args.get('--endpoint') || 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization';
const apiKey = process.env[args.get('--api-key-env') || 'DASHSCOPE_API_KEY'];
const force = args.has('--force');
const design = args.has('--design');
const selectedSeats = args.get('--seats')?.split(',').map((value) => `seat-${value}`);
const previewText = args.get('--preview-text') || '三号玩家前后说法不一致。我想先听他解释，再决定这一票投给谁。';
if (design && (Array.from(previewText).length < 15 || Array.from(previewText).length > 200)) throw Error('Voice preview text must contain 15 to 200 characters');
if (!apiKey) throw Error('Missing voice enrollment API key');
if (!/^qwen-audio-[0-9.]+-tts-(?:plus|flash)$/.test(model)) throw Error(`Unsupported target model: ${model}`);

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = async <T>(file: string, fallback?: T) => existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as T : fallback;
const request = async (body: unknown) => {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`Voice enrollment HTTP ${response.status}`);
  const result = await response.json() as any;
  if (result.code) throw Error(`Voice enrollment: ${String(result.code).slice(0, 100)}`);
  return result;
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

if (voices.model !== model) throw Error('Prepare the project with the target TTS model before enrolling voices');
if (design && !voices.theme) throw Error('Voice design requires the project portrait theme');
if (selectedSeats?.some(key => !/^seat-(?:[1-9]|1[0-2])$/.test(key) || !voices.profiles[key])) throw Error('Unknown voice enrollment seat');
const manifestFile = join(project, 'voice-enrollment.json');
type Enrollment = { model?: string; voices?: Record<string, any>; models?: Record<string, Record<string, any>> };
const loadedManifest = await json<Enrollment>(manifestFile);
const manifest: Enrollment = loadedManifest ?? { model, voices: {} };
manifest.models ??= {};
if (manifest.model && manifest.voices) manifest.models[manifest.model] = manifest.voices;
manifest.model = model;
manifest.voices = manifest.models[model] ??= {};
voices.modelVoiceBindings ??= {};
const bindings = voices.modelVoiceBindings[model] ??= {};
const bindVoice = (key: string, voice: string) => {
  bindings[key] = voice;
  if (model === 'qwen-audio-3.1-tts-flash') {
    voices.flashVoiceBindings ??= {};
    voices.flashVoiceBindings[key] = voice;
  }
};
await mkdir(project, { recursive: true });
const artFile = join(project, 'art-manifest.json');
const art = design && existsSync(artFile) ? await json<{ seats?: { seat: number; appearance?: string; gender?: string; voice?: string }[] }>(artFile) : undefined;
for (const key of Object.keys(voices.profiles).filter((item) => /^seat-\d+$/.test(item) && (!selectedSeats || selectedSeats.includes(item)))) {
  const referenceFile = join(referenceDir, `${key}.wav`);
  const audio = design ? undefined : await readFile(referenceFile).catch(() => undefined);
  if (!design && !audio) throw Error(`Missing reference audio ${referenceFile}`);
  const referenceSha256 = audio ? sha(audio) : undefined, previous = manifest.voices[key];
  const seat = Number(key.slice(5)), character = art?.seats?.find((item) => item.seat === seat);
  const direction = design ? characterVoiceDirection(voices.theme!, seat) : undefined;
  if (direction && character?.gender && character.gender !== direction.gender) throw Error(`Portrait gender conflict for ${key}`);
  const voicePrompt = direction ? [direction.designPrompt, args.get('--prompt-suffix') || ''].filter(Boolean).join(' ') : undefined;
  if (voicePrompt && Array.from(voicePrompt).length > 500) throw Error('Voice design prompt exceeds 500 characters');
  const designedProfile = direction ? { rate: direction.rate, instruction: direction.instruction, label: `${seat}号 ${direction.persona}` } : {};
  if (!force && previous?.model === model && (design ? previous.voicePrompt === voicePrompt : previous.referenceSha256 === referenceSha256)) {
    if (previous.status !== 'OK') {
      previous.status = await waitReady(previous.voice);
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    }
    bindVoice(key, previous.voice);
    voices.profiles[key] = { ...voices.profiles[key], voice: previous.voice };
    if (character) character.voice = previous.voice;
    continue;
  }
  if (!force && previous?.model === model) throw Error(`Existing ${key} voice differs from the requested design; use --force to redesign it explicitly`);
  const prefix = (args.get('--prefix') || 'werewolf').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'werewolf';
  const created = design
    ? await request({ model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, voice_prompt: voicePrompt, preview_text: previewText, prefix, language_hints: ['zh'] }, parameters: { sample_rate: 24000, response_format: 'wav' } })
    : await request({ model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, prefix, audio: `data:audio/wav;base64,${audio!.toString('base64')}` } });
  const voice = created.output?.voice_id ?? created.output?.voice ?? created.voice;
  if (typeof voice !== 'string' || !voice.startsWith(model + '-')) throw Error(`Voice enrollment returned no compatible voice ID for ${key}`);
  manifest.voices[key] = { voice, model, ...(design ? { voicePrompt, previewText, theme: voices.theme, gender: direction!.gender, appearance: direction!.appearance, persona: direction!.persona } : { referenceSha256, referenceFile }), status: 'DEPLOYING', createdAt: new Date().toISOString(), ...(previous ? { previous } : {}) };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  if (design && typeof created.output?.preview_audio?.data === 'string') {
    await mkdir(referenceDir, { recursive: true });
    await writeFile(join(referenceDir, `${key}-design-preview.wav`), Buffer.from(created.output.preview_audio.data, 'base64'));
  }
  const status = await waitReady(voice);
  manifest.voices[key].status = status;
  bindVoice(key, voice);
  voices.profiles[key] = { ...voices.profiles[key], ...designedProfile, voice };
  if (character) character.voice = voice;
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(voicesFile, JSON.stringify({ ...voices, model }, null, 2) + '\n');
  if (art) await writeFile(artFile, JSON.stringify(art, null, 2) + '\n');
  console.log(JSON.stringify({ voiceKey: key, voice, model, status }));
}
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(voicesFile, JSON.stringify({ ...voices, model }, null, 2) + '\n');
if (art) await writeFile(artFile, JSON.stringify(art, null, 2) + '\n');
console.log(JSON.stringify({ complete: true, model, voices: Object.keys(bindings).length, manifest: manifestFile }));

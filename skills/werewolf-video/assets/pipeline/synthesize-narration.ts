import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeQwen, type AudioMeta, type VoiceProfile } from './qwen';
import { projectQwenTokenPlanKey } from './project-models';
import { transcribeAudio } from '../../packages/session/src/asr';
import { canonicalAsrAudio } from './review-audio';
import { saveAudioAlignment, effectiveAudioAlignment } from './audio-alignment';
import { reviewAudioContent } from './audio-content-review';
import { readPcm, wavHeader } from './audio';
import { inspectAudio } from './audio-inspection';
import { captionsFromWords } from './timeline';

const stemPath = (output: string, stem: string) => join(output, stem);
const sha = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
const endpoints = { 'token-plan': 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer', dashscope: 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer' } as const;
const safeId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s);
type Delivery = { tag: string } | { segments: { text: string; tag?: string }[] };
type Narration = { kind: 'narration'; id: string; text: string; afterSourceSeq: number; delivery?: Delivery };
type Job = { sourceProject: string; outputDir: string; scripts: { id: string; scriptFile: string }[]; tts: { route: keyof typeof endpoints; model: string; voice: string; locale: string; rate: number; instruction: string; apiKeyEnv?: string }; asr?: { provider: 'qwen-token-plan'; enabled: true; aliasesFile?: string } };
type Deps = { synthesize?: typeof synthesizeQwen; transcribe?: typeof transcribeAudio; canonical?: typeof canonicalAsrAudio };
const tagPattern = /^[a-z][a-z0-9_-]*$/i;
function requestText(item: Narration) {
  const prefix = (tag?: string) => { assert(tag === undefined || tagPattern.test(tag), 'Invalid delivery tag'); return tag ? `[${tag}]` : ''; };
  if (!item.delivery) return item.text;
  assert(typeof item.delivery === 'object' && !Array.isArray(item.delivery), 'Invalid delivery configuration');
  if ('tag' in item.delivery) return prefix(item.delivery.tag) + item.text;
  assert(Array.isArray(item.delivery.segments) && item.delivery.segments.length > 0, 'Invalid delivery segments');
  assert.equal(item.delivery.segments.map(s => s.text).join(''), item.text, 'Delivery segments must reproduce narration exactly');
  return item.delivery.segments.map(s => prefix(s.tag) + s.text).join('');
}
function cleanMeta(meta: AudioMeta, text: string, tags: string[]): AudioMeta {
  const clean = (s: string) => tags.reduce((v, t) => v.split(`[${t}]`).join(''), s);
  return { ...meta, text, sentences: meta.sentences.map(s => ({ ...s, text: clean(s.text), words: s.words.map(w => ({ ...w, text: clean(w.text) })).filter(w => w.text.length > 0) })) };
}
function tagsFor(item: Narration): string[] { return !item.delivery ? [] : 'tag' in item.delivery ? [item.delivery.tag] : item.delivery.segments.flatMap(s => s.tag ? [s.tag] : []); }
function onlyFields(value: unknown, fields: string[], message: string) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => fields.includes(k)), message);
}
async function removeCandidate(output: string, path: string) {
  const directory = await realpath(output);
  try {
    const info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink(), 'Unsafe candidate file');
    assert.equal(dirname(await realpath(path)), directory, 'Candidate outside output directory');
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function validate(job: Job) {
  onlyFields(job, ['sourceProject', 'outputDir', 'scripts', 'tts', 'asr'], 'Unknown job configuration field');
  assert(job && typeof job.sourceProject === 'string' && job.sourceProject && typeof job.outputDir === 'string' && job.outputDir, 'sourceProject and outputDir are required');
  assert(Array.isArray(job.scripts) && job.scripts.length > 0 && job.scripts.every(s => safeId(s.id) && typeof s.scriptFile === 'string' && s.scriptFile), 'scripts require unique IDs and scriptFile');
  for (const script of job.scripts) onlyFields(script, ['id', 'scriptFile'], 'Unknown script configuration field');
  assert.equal(new Set(job.scripts.map(s => s.id)).size, job.scripts.length, 'Duplicate script ID');
  const t = job.tts; assert(t && Object.keys(t).every(k => ['route', 'model', 'voice', 'locale', 'rate', 'instruction', 'apiKeyEnv'].includes(k)), 'Unknown TTS configuration field'); assert(t && Object.hasOwn(endpoints, t.route) && typeof t.model === 'string' && t.model && typeof t.voice === 'string' && t.voice && typeof t.locale === 'string' && t.locale && Number.isFinite(t.rate) && t.rate > 0 && typeof t.instruction === 'string', 'Incomplete TTS configuration');
  const cloneModel = /^(qwen-audio-[0-9]+(?:\.[0-9]+)*-tts-plus)-/i.exec(t.voice)?.[1];
  assert(!cloneModel || t.model.toLowerCase() === cloneModel.toLowerCase(), 'Clone voice is incompatible with selected model');
  assert(t.apiKeyEnv === undefined || /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.apiKeyEnv), 'Invalid apiKeyEnv');
  if (job.asr !== undefined) { onlyFields(job.asr, ['provider', 'enabled', 'aliasesFile'], 'Unknown ASR configuration field'); assert(job.asr.enabled === true && job.asr.provider === 'qwen-token-plan' && (job.asr.aliasesFile === undefined || typeof job.asr.aliasesFile === 'string'), 'Invalid ASR configuration'); }
}
export async function synthesizeNarration(jobFile: string, checkOnly = false, deps: Deps = {}) {
  const base = dirname(resolve(jobFile)), job = JSON.parse(await readFile(jobFile, 'utf8')) as Job; validate(job);
  const sourceBytes = await readFile(join(resolve(base, job.sourceProject), 'source.json')), source = JSON.parse(sourceBytes.toString('utf8')) as { roomId: string }, sourceSha256 = sha(sourceBytes);
  assert(typeof source.roomId === 'string' && source.roomId, 'Source roomId missing');
  const aliases = job.asr?.aliasesFile ? JSON.parse(await readFile(resolve(base, job.asr.aliasesFile), 'utf8')) : {};
  const reports: unknown[] = [];
  for (const script of job.scripts) {
    const selection = JSON.parse(await readFile(resolve(base, script.scriptFile), 'utf8')) as { roomId: string; sourceSha256: string; reviewed: boolean; items: (Narration | { kind: 'source' })[] };
    assert(selection.reviewed === true && selection.roomId === source.roomId && selection.sourceSha256 === sourceSha256 && Array.isArray(selection.items), 'Script must be reviewed and match source');
    assert(selection.items.every(i => i.kind === 'source' || i.kind === 'narration'), 'Unknown script item');
    const items = selection.items.filter((i): i is Narration => i.kind === 'narration');
    assert(new Set(items.map(i => i.id)).size === items.length, 'Duplicate narration ID');
    const output = resolve(base, job.outputDir, script.id), clips: unknown[] = [];
    for (const item of items) {
      assert(safeId(item.id) && typeof item.text === 'string' && item.text.trim() && Number.isInteger(item.afterSourceSeq) && item.afterSourceSeq >= 0, 'Invalid narration item');
      const requested = requestText(item), t = job.tts, identity = { endpoint: endpoints[t.route], model: t.model, voice: t.voice, locale: t.locale, rate: t.rate, instruction: t.instruction, requestText: requested }, key = sha(JSON.stringify(identity));
      const stem = `${item.id}-${key}`, file = join(output, `${stem}.wav`), metaFile = `${file}.json`;
      let meta: AudioMeta | undefined, audio: Buffer | undefined;
      try { audio = await readFile(file); meta = JSON.parse(await readFile(metaFile, 'utf8')); assert(meta && meta.text === item.text && meta.bytes === audio.length && (meta as any).narrationKey === key && (meta as any).audioSha256 === sha(audio)); const pcm = await readPcm(file); assert(pcm.sampleRate === 24000 && !inspectAudio(pcm.samples, pcm.sampleRate).issues.length); } catch { meta = undefined; audio = undefined; }
      const invalidCache = !meta && (existsSync(file) || existsSync(metaFile));
      reports.push({ script: script.id, id: item.id, status: meta ? 'cached' : invalidCache ? 'invalid-cache' : 'pending', characters: Array.from(item.text).length, credential: t.apiKeyEnv ? (process.env[t.apiKeyEnv] ? 'available' : 'missing') : t.route === 'dashscope' ? (process.env.DASHSCOPE_API_KEY ? 'available' : 'missing') : 'project-token-plan-key-or-environment-required', ...(job.asr ? { asr: existsSync(`${file}.alignment.json`) ? 'alignment-present' : 'pending' } : {}) });
      if (checkOnly) continue;
      if (!meta || !audio) {
        await mkdir(output, { recursive: true });
        assert(!existsSync(file) && !existsSync(metaFile), `Invalid existing cache retained for manual review: ${item.id}`);
        const apiKey = t.apiKeyEnv ? process.env[t.apiKeyEnv] : t.route === 'dashscope' ? process.env.DASHSCOPE_API_KEY : projectQwenTokenPlanKey();
        if (!deps.synthesize && !apiKey) throw Error(`Missing API key for ${t.route}`);
        let success = false; const rejected: string[] = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          const candidate = join(output, `${stem}-candidate-${attempt + 1}.wav`), profile: VoiceProfile = { voice: t.voice, label: 'Narrator', locale: t.locale, rate: t.rate, instruction: t.instruction, seed: 31415 + attempt };
          const provider = await (deps.synthesize ?? synthesizeQwen)(requested, profile, t.model, candidate, { endpoint: endpoints[t.route], apiKey: apiKey ?? 'test-key' });
          const pcm = await readPcm(candidate); assert.equal(pcm.sampleRate, 24000, 'Expected 24 kHz mono PCM WAV');
          if (inspectAudio(pcm.samples, pcm.sampleRate).issues.length) { rejected.push(candidate); await writeFile(`${stemPath(output, stem)}.needs-review.json`, JSON.stringify({ status: 'needs-review', reason: 'waveform', candidates: rejected.map(c => c.slice(output.length + 1)) }, null, 2)); continue; }
          const pcmBytes = Buffer.alloc(pcm.samples.length * 2); pcm.samples.forEach((sample, n) => pcmBytes.writeInt16LE(sample, n * 2));
          audio = Buffer.concat([wavHeader(pcm.samples.length, 24000), pcmBytes]);
          meta = { ...cleanMeta(provider, item.text, tagsFor(item)), bytes: audio.length, narrationKey: key, audioSha256: sha(audio), requestText: requested } as AudioMeta;
          await writeFile(file, audio); await writeFile(`${file}.provider.json`, JSON.stringify(provider, null, 2)); await writeFile(metaFile, JSON.stringify(meta, null, 2)); await removeCandidate(output, candidate); await removeCandidate(output, `${candidate}.json`); success = true; break;
        }
        assert(success && audio && meta, `Waveform failed inspection after 3 attempts: ${item.id}`);
      }
      assert(meta && audio);
      if (job.asr) {
        const transcriptFile = `${file}.asr.json`, scratch = await mkdtemp(join(tmpdir(), 'narration-asr-'));
        let canonical: Buffer; try { canonical = await (deps.canonical ?? canonicalAsrAudio)(file, scratch); } finally { await rmdir(scratch); }
        let response: string;
        if (existsSync(transcriptFile)) { response = await readFile(transcriptFile, 'utf8'); const old = JSON.parse(response); assert(old.rawAudioSha256 === sha(audio) && old.audioSha256 === sha(canonical) && old.sourcePromptProvided === false, 'Stale ASR response'); }
        else { const result = await (deps.transcribe ?? transcribeAudio)(canonical, { provider: 'qwen-token-plan', locale: t.locale }); assert(result.provider === 'qwen-token-plan' && result.inputAudioSha256 === sha(canonical) && result.truncated !== true, 'Invalid ASR result'); response = JSON.stringify({ ...result, rawAudioSha256: sha(audio), audioSha256: sha(canonical), sourcePromptProvided: false, result: result.rawResult }, null, 2); await writeFile(transcriptFile, response); }
        const parsed = JSON.parse(response), text = parsed.text as string; assert(typeof text === 'string' && text.trim(), 'ASR returned no reliable transcript');
        const review = reviewAudioContent({ audio, sourceText: item.text, transcript: text, locale: t.locale, aliases: aliases[item.id] ?? [] });
        if (!review.matches) { const reviewFile = `${file}.needs-review.json`; await writeFile(reviewFile, JSON.stringify({ status: 'needs-review', sourceText: item.text, transcript: text, transcriptFile, audioSha256: sha(audio), transcriptSha256: sha(text) }, null, 2)); throw Error(`ASR needs-review: ${reviewFile}`); }
        if (!existsSync(`${file}.alignment.json`)) await saveAudioAlignment(file, response, t.locale, aliases[item.id] ?? []);
        else { const saved = JSON.parse(await readFile(`${file}.alignment.json`, 'utf8')); assert.deepEqual(saved.aliases, aliases[item.id] ?? [], 'Existing ASR aliases changed; retained alignment needs review'); assert.equal(saved.asrResponse, response, 'Existing alignment uses a different ASR response'); }
      }
      const aligned = await effectiveAudioAlignment(file, meta, t.locale), pcm = await readPcm(file);
      captionsFromWords(aligned.meta, pcm.samples.length / pcm.sampleRate, t.locale);
      clips.push({ id: item.id, text: item.text, audioFile: `${stem}.wav`, audioSha256: sha(audio), model: t.model, voice: t.voice, afterSourceSeq: item.afterSourceSeq });
    }
    if (!checkOnly) { await mkdir(output, { recursive: true }); await writeFile(join(output, 'narration-manifest.json'), JSON.stringify({ roomId: source.roomId, sourceSha256, clips }, null, 2)); }
  }
  return reports;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), arg = args.find(a => a.startsWith('--job='));
  if (!arg || args.filter(a => a.startsWith('--job=')).length !== 1 || args.some(a => a !== '--check-only' && a !== arg)) throw Error('Usage: node --import tsx scripts/video/synthesize-narration.ts --job=JSON [--check-only]');
  synthesizeNarration(arg.slice(6), process.argv.includes('--check-only')).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

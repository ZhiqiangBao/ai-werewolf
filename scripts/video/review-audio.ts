import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LOCAL_GGUF_FILE, LOCAL_GGUF_SHA256, MIMO_ASR_MODEL, QWEN_ASR_MODEL, asrAudioSha256, asrProviderForLocale, assertCanonicalAsrWav, localModelIdentity, parseCloudAsrResponse, transcribeAudio, validLocalRuntime, type AsrProvider, type AsrResult } from '../../packages/session/src/asr';
import { reviewAudioContent, type AudioContentReview, type TranscriptAlias } from './audio-content-review';
import { compareAsrText } from './asr-comparison';
import { assertAuthorizedProject, assertPlayerSources } from './integrity';
import { dataDir, ffmpeg, projectDir, type Clip, type Script, type VoiceCatalog } from './project';
import { assertPlayerRawAudio } from './player-audio-provenance';
import { createAudioAlignment, effectiveAudioAlignment, saveAudioAlignment } from './audio-alignment';
import { captionsFromWords } from './timeline';
import { readPcm } from './audio';

type AliasMap = Record<string, TranscriptAlias[]>;
export interface BatchReviewOptions { directory?: string; provider?: AsrProvider | 'auto'; aliases?: AliasMap; asrDataDir?: string; signal?: AbortSignal; align?: boolean; alignmentProvider?: 'qwen-token-plan'; clipIds?: string[] }
export interface BatchReviewItem { clipId: string; status: 'matching' | 'needs-review' | 'failure'; audioSha256?: string; inputAudioSha256?: string; sourceSha256?: string; transcriptSha256?: string; aliasesSha256?: string; settingsSha256?: string; transcriptFile?: string; cached?: boolean; truncated?: boolean | null; contentReview?: AudioContentReview; comparison?: ReturnType<typeof compareAsrText>; reason?: string; alignment?: string; alignmentProvider?: string; alignmentCached?: boolean; recognitionRequests?: number; alignmentRequests?: number }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const cloudIdentity = (provider: Exclude<AsrProvider, 'local'>) => provider === 'qwen-token-plan' ? { model: QWEN_ASR_MODEL, revision: null } : { model: MIMO_ASR_MODEL, revision: null };
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}` : JSON.stringify(value);
const localCacheKey = (inputSha: string, result: AsrResult) => digest(stable({ inputAudioSha256: inputSha, provider: 'local', model: result.model, revision: result.revision, backend: result.backend, runtime: result.runtime, options: { language: 'auto' } }));
function validLocalResult(result: AsrResult, inputSha: string, expected: ReturnType<typeof localModelIdentity>) {
  const raw = result.rawResult as any;
  return result.provider === 'local' && result.inputAudioSha256 === inputSha && result.model === expected.model && result.revision === expected.revision && result.backend === expected.backend && validLocalRuntime(result.runtime, expected.backend) && result.options?.language === 'auto' && typeof result.text === 'string' && [true, false, null].includes(result.truncated) && raw?.audioSha256 === inputSha && raw?.requestedLanguage === 'auto' && raw?.transcription === result.text && raw?.truncated === result.truncated && raw?.model?.repo === expected.model && raw?.model?.revision === expected.revision && raw?.model?.backend === expected.backend && stable(raw?.runtime) === stable(result.runtime) && (expected.backend !== 'gguf' || (raw?.model?.file === LOCAL_GGUF_FILE && raw?.model?.sha256 === LOCAL_GGUF_SHA256));
}
function validCloudResult(result: AsrResult, inputSha: string, provider: Exclude<AsrProvider, 'local'>) {
  try {
    const expected = cloudIdentity(provider), parsed = parseCloudAsrResponse(provider, result.rawResult);
    return result.provider === provider && result.inputAudioSha256 === inputSha && result.model === expected.model && result.revision === expected.revision && result.options?.language === 'auto' && result.text === parsed.text && result.truncated === parsed.truncated;
  } catch { return false; }
}

/** Use one deterministic 16 kHz PCM representation for every selected provider. */
export async function canonicalAsrAudio(audioFile: string, scratchDir: string): Promise<Buffer> {
  await mkdir(scratchDir, { recursive: true });
  const temporary = join(scratchDir, `${randomUUID()}.wav`);
  try {
    try { execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioFile, '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', temporary], { windowsHide: true, stdio: 'pipe', timeout: 120000 }); }
    catch { throw Error('ASR input conversion failed'); }
    const audio = await readFile(temporary); assertCanonicalAsrWav(audio); return audio;
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Persist independent recognition first; compare to source only after recognition is complete. */
export async function reviewVideoAudio(options: BatchReviewOptions = {}, transcribe = transcribeAudio) {
  const directory = resolve(options.directory ?? projectDir);
  const sourceFile = join(directory, 'source.json'), scriptFile = join(directory, 'script.json'), clipsFile = join(directory, 'clips.json');
  const sourceBytes = await readFile(sourceFile), scriptBytes = await readFile(scriptFile), clipsBytes = await readFile(clipsFile);
  const source = JSON.parse(sourceBytes.toString('utf8')) as Script;
  const script = JSON.parse(scriptBytes.toString('utf8')) as Script;
  const clips = JSON.parse(clipsBytes.toString('utf8')) as Clip[];
  assert(Array.isArray(clips) && clips.length > 0, 'No video clips to review');
  if (source.perspective === 'player' || script.perspective === 'player') {
    if (directory !== resolve(projectDir)) throw Error('Player review must use the selected VIDEO_PROJECT_DIR');
    await assertAuthorizedProject(clips);
    await assertPlayerRawAudio(source, JSON.parse(await readFile(join(directory, 'voices.json'), 'utf8')) as VoiceCatalog, clips);
  }
  assertPlayerSources(source, script, clips);
  const locale = source.locale, aliases = options.aliases ?? {};
  const provider = asrProviderForLocale(options.provider ?? 'auto', locale);
  assert(typeof locale === 'string', 'ASR requires an explicit locale');
  assert(script.locale === locale, 'ASR script and source locales differ');
  if (options.alignmentProvider && options.alignmentProvider !== 'qwen-token-plan') throw Error('Unsupported alignment provider');
  if (options.clipIds && options.clipIds.some((id) => !clips.some((clip) => clip.id === id))) throw Error('Unknown ASR clip');
  assert(aliases && typeof aliases === 'object' && !Array.isArray(aliases), 'Aliases must be keyed by clip ID');
  for (const [id, list] of Object.entries(aliases)) {
    assert(clips.some((clip) => clip.id === id) && Array.isArray(list) && list.every((a) => a && typeof a.source === 'string' && typeof a.transcript === 'string'), `Invalid aliases for clip ${id}`);
  }
  const output = join(directory, 'output', 'asr-review'), cacheDir = join(output, 'cache'), recordsDir = join(output, 'transcripts');
  await mkdir(cacheDir, { recursive: true }); await mkdir(recordsDir, { recursive: true });
  const items: BatchReviewItem[] = [];
  const asrDataDir = options.asrDataDir || process.env.WEREWOLF_DATA || dataDir;
  const localRoot = resolve(asrDataDir, 'local-asr');
  let localBinding: { state: Buffer; control: Buffer } | undefined;
  const assertSameLocalService = async () => {
    let state: Buffer, control: Buffer;
    try { state = await readFile(join(localRoot, 'service-state.json')); control = await readFile(join(localRoot, 'service-control.json')); }
    catch { throw Error('Local ASR service changed during review'); }
    if (!localBinding) localBinding = { state, control };
    else if (!localBinding.state.equals(state) || !localBinding.control.equals(control)) throw Error('Local ASR service changed during review');
  };
  for (const clip of clips.filter((item) => !options.clipIds || options.clipIds.includes(item.id))) {
    options.signal?.throwIfAborted();
    const item: BatchReviewItem = { clipId: clip.id, status: 'failure' };
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(clip.id) || resolve(clip.audioFile) !== resolve(directory, 'audio', `${clip.id}.wav`)) throw Error('Audio path does not belong to this project');
      const rawAudio = await readFile(clip.audioFile), metadataBytes = await readFile(`${clip.audioFile}.json`), meta = JSON.parse(metadataBytes.toString('utf8'));
      if (meta.text !== clip.spokenText || meta.bytes !== rawAudio.length) throw Error('Audio metadata differs from the submitted clip');
      const rawSha = digest(rawAudio), canonical = await canonicalAsrAudio(clip.audioFile, join(output, 'scratch')), inputSha = asrAudioSha256(canonical);
      if (digest(await readFile(clip.audioFile)) !== rawSha || digest(await readFile(`${clip.audioFile}.json`)) !== digest(metadataBytes)) throw Error('Audio or metadata changed during ASR review');
      let recognized: AsrResult | undefined, cacheKey = '', serviceInstanceSha256: string | undefined;
      const model = provider === 'local' ? (await assertSameLocalService(), localModelIdentity(JSON.parse(localBinding!.state.toString('utf8')).backend)) : cloudIdentity(provider);
      if (provider === 'local') {
        // Runtime versions are only known after a real result. Reuse only for the same pinned service instance.
        serviceInstanceSha256 = digest(localBinding!.state);
        for (const name of await readdir(cacheDir)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          try {
            const candidate = JSON.parse(await readFile(join(cacheDir, name), 'utf8')) as AsrResult & { serviceInstanceSha256?: string };
            if (candidate.serviceInstanceSha256 === serviceInstanceSha256 && validLocalResult(candidate, inputSha, model as ReturnType<typeof localModelIdentity>) && name === `${localCacheKey(inputSha, candidate)}.json`) {
              const { serviceInstanceSha256: _instance, ...cached } = candidate;
              recognized = cached; cacheKey = name.slice(0, -5); break;
            }
          } catch { /* Ignore unusable cache files. */ }
        }
      } else {
        cacheKey = digest(JSON.stringify({ inputAudioSha256: inputSha, provider, ...model, options: { language: 'auto' } }));
        const cacheFile = join(cacheDir, `${cacheKey}.json`);
        if (existsSync(cacheFile)) {
          let cached: AsrResult;
          try { cached = JSON.parse(await readFile(cacheFile, 'utf8')) as AsrResult; }
          catch { throw Error('ASR cached response is invalid'); }
          if (!validCloudResult(cached, inputSha, provider)) throw Error('ASR cached response is invalid');
          recognized = cached;
        }
      }
      const cached = !!recognized;
      if (!recognized) {
        if (provider === 'local') await assertSameLocalService();
        item.recognitionRequests = 1;
        recognized = await transcribe(canonical, { provider, locale, dataDir: asrDataDir, signal: options.signal });
        if (provider === 'local') await assertSameLocalService();
        if (provider === 'local') {
          if (!validLocalResult(recognized, inputSha, model as ReturnType<typeof localModelIdentity>)) throw Error('ASR result does not match the requested audio and model');
          cacheKey = localCacheKey(inputSha, recognized);
        } else if (!validCloudResult(recognized, inputSha, provider)) throw Error('ASR result does not match the requested audio and model');
        await writeFile(join(cacheDir, `${cacheKey}.json`), JSON.stringify({ ...recognized, ...(serviceInstanceSha256 ? { serviceInstanceSha256 } : {}) }, null, 2));
      }
      // The saved recognition contains no source text or alias choices.
      const transcriptFile = join(recordsDir, `${clip.id}-${cacheKey.slice(0, 16)}.json`);
      await writeFile(transcriptFile, JSON.stringify({ format: 'werewolf-independent-asr', version: 1, clipId: clip.id, rawAudioSha256: rawSha,
        audioSha256: inputSha, sourcePromptProvided: false, ...recognized, result: recognized.rawResult }, null, 2));
      Object.assign(item, { audioSha256: rawSha, inputAudioSha256: inputSha, sourceSha256: digest(clip.spokenText), transcriptSha256: digest(recognized.text),
        aliasesSha256: digest(JSON.stringify(aliases[clip.id] ?? [])), settingsSha256: digest(stable({ provider, model: recognized.model, revision: recognized.revision, ...(provider === 'local' ? { backend: recognized.backend, runtime: recognized.runtime } : {}), options: { language: 'auto' } })), transcriptFile, cached, truncated: recognized.truncated });
      if (digest(await readFile(clip.audioFile)) !== rawSha || digest(await readFile(`${clip.audioFile}.json`)) !== digest(metadataBytes)) throw Error('Audio or metadata changed during ASR review');
      if (!sourceBytes.equals(await readFile(sourceFile)) || !scriptBytes.equals(await readFile(scriptFile)) || !clipsBytes.equals(await readFile(clipsFile))) throw Error('Video source changed during ASR review');
      if (recognized.truncated === true) { item.reason = 'ASR result is truncated'; }
      else {
        try {
          const review = reviewAudioContent({ audio: rawAudio, sourceText: clip.spokenText, transcript: recognized.text, locale, aliases: aliases[clip.id] ?? [] });
          item.contentReview = review;
          item.comparison = compareAsrText(clip.spokenText, recognized.text, locale, aliases[clip.id] ?? []);
          item.status = review.matches ? 'matching' : 'needs-review';
          if (!review.matches) item.reason = 'Independent transcript differs from the source';
        } catch { item.status = 'needs-review'; item.reason = 'Transcript or explicit aliases require manual review'; }
      }
      if (item.status === 'matching' && options.align) {
        const selected = await effectiveAudioAlignment(clip.audioFile, meta, locale);
        const pcm = await readPcm(clip.audioFile);
        let needsAlignment = false;
        try { captionsFromWords(selected.meta, pcm.samples.length / pcm.sampleRate, locale); }
        catch { needsAlignment = true; }
        if (!needsAlignment) item.alignment = selected.summary ? 'existing-external-transcript' : 'provider-timestamps';
        else if (selected.summary) throw Error('Previously selected alignment cannot be used');
        else if (provider === 'qwen-token-plan') {
          try {
            const response = await readFile(transcriptFile, 'utf8');
            const alignment = createAudioAlignment({ audio: rawAudio, metadata: metadataBytes, asrResponse: response, locale, aliases: aliases[clip.id] ?? [] });
            captionsFromWords({ ...meta, sentences: [{ index: 0, text: meta.text, words: alignment.words }] }, pcm.samples.length / pcm.sampleRate, locale);
            await saveAudioAlignment(clip.audioFile, response, locale, aliases[clip.id] ?? []);
            item.alignment = 'independent-qwen-word-times'; item.alignmentProvider = provider; item.alignmentCached = cached;
          } catch { item.status = 'failure'; item.reason = 'alignment-required: independent Qwen word boundaries could not be verified'; }
        } else if (options.alignmentProvider === 'qwen-token-plan') {
          if (new Intl.Locale(locale).language === 'zh') {
            item.status = 'failure'; item.reason = 'alignment-required: external transcript alignment does not support zh'; item.alignmentRequests = 0;
          } else {
            const result = await reviewVideoAudio({ ...options, provider: 'qwen-token-plan', alignmentProvider: undefined, clipIds: [clip.id] }, transcribe);
            const aligned = result.items[0];
            item.alignmentProvider = 'qwen-token-plan'; item.alignmentCached = aligned.cached; item.alignmentRequests = aligned.recognitionRequests ?? 0;
            if (aligned.status === 'matching') item.alignment = aligned.alignment;
            else { item.status = aligned.status; item.reason = aligned.reason; }
          }
        } else { item.status = 'failure'; item.reason = 'alignment-required: provide verified word boundaries or explicitly select Qwen alignment'; }
      }
    } catch (error) {
      if (options.signal?.aborted) options.signal.throwIfAborted();
      item.status = 'failure';
      // Provider errors are deliberately not copied into reports: they may contain remote text or credentials.
      item.reason = error instanceof Error && /^(Audio path|Audio metadata|Audio or metadata changed|Video source changed|Local ASR service changed|ASR input conversion|ASR result does not match|ASR cached response is invalid)/.test(error.message) ? error.message : 'ASR recognition failed';
    }
    items.push(item);
    await writeFile(join(output, 'report.json'), JSON.stringify({ format: 'werewolf-audio-asr-review', version: 1, roomId: source.roomId, provider, locale,
      audioSemanticReview: 'independent-transcript-only', criticalReview: 'required', recognitionRequests: items.reduce((n, item) => n + (item.recognitionRequests ?? 0), 0), alignmentRequests: items.reduce((n, item) => n + (item.alignmentRequests ?? 0), 0), items }, null, 2));
  }
  return { roomId: source.roomId, provider, locale, items };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: { provider: { type: 'string' }, aliases: { type: 'string' }, align: { type: 'boolean' }, 'alignment-provider': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('VIDEO_PROJECT_DIR=DIR node --import tsx scripts/video/review-audio.ts [--provider=auto|local|qwen-token-plan|mimo-token-plan] [--aliases=JSON_FILE] [--align] [--alignment-provider=qwen-token-plan]'); process.exit(0); }
  const provider = (values.provider ?? 'auto') as AsrProvider | 'auto';
  const aliases = values.aliases ? JSON.parse(await readFile(resolve(values.aliases), 'utf8')) as AliasMap : undefined;
  const report = await reviewVideoAudio({ provider, aliases, align: values.align, alignmentProvider: values['alignment-provider'] as 'qwen-token-plan' | undefined });
  console.log(JSON.stringify({ roomId: report.roomId, provider: report.provider, matching: report.items.filter((item) => item.status === 'matching').length,
    needsReview: report.items.filter((item) => item.status === 'needs-review').length, failures: report.items.filter((item) => item.status === 'failure').length }));
  if (report.items.some((item) => item.status !== 'matching')) process.exitCode = 1;
}

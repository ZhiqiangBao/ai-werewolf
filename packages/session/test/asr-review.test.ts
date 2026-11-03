import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { wavHeader } from '../src/speech/audio';
import { LOCAL_ASR_MODEL, LOCAL_ASR_REVISION, LOCAL_GGUF_MODEL, LOCAL_GGUF_REVISION, LOCAL_GGUF_FILE, LOCAL_GGUF_SHA256, MIMO_ASR_MODEL, QWEN_ASR_MODEL, asrAudioSha256, type AsrOptions, type AsrResult, type LocalAsrBackend } from '../src/asr';
import { canonicalAsrAudio, reviewVideoAudio } from '../../../scripts/video/review-audio';
import { createAudioAlignment } from '../../../scripts/video/audio-alignment';
import { auditAudio } from '../../../scripts/video/audit-audio';

const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function localResult(input: Buffer, text = 'Player one.', truncated: boolean | null = false, backend: LocalAsrBackend = 'transformers'): AsrResult {
  const model = backend === 'gguf' ? LOCAL_GGUF_MODEL : LOCAL_ASR_MODEL, revision = backend === 'gguf' ? LOCAL_GGUF_REVISION : LOCAL_ASR_REVISION;
  const runtime = { device: backend === 'gguf' ? 'vulkan' : 'cuda:0', dtype: backend === 'gguf' ? 'Q8_0' : 'float16', versions: { python: '3.11', runtime: backend, ...(backend === 'gguf' ? { transcribe_cpp: '0.4.1', native: 'fixture' } : { torch: '2', transformers: '4' }) } };
  const rawResult = { transcription: text, audioSha256: asrAudioSha256(input), requestedLanguage: 'auto', truncated,
    model: { repo: model, revision, backend, ...(backend === 'gguf' ? { file: LOCAL_GGUF_FILE, sha256: LOCAL_GGUF_SHA256 } : {}) }, runtime };
  return { provider: 'local', inputAudioSha256: asrAudioSha256(input), model, revision, backend, runtime, text, rawResult, truncated, elapsedMs: 1, options: { language: 'auto' } };
}
async function fixture() {
  const base = resolve('data/asr-review-tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-')); await mkdir(join(directory, 'audio'));
  await mkdir(join(directory, 'local-asr'));
  await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'fixture', pid: 42, backend: 'transformers' }));
  await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ nonce: 'fixture', token: 'secret-test-token' }));
  const audioFile = join(directory, 'audio', '001-1.wav'), pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
  const audio = Buffer.concat([wavHeader(24000, 24000), pcm]); await writeFile(audioFile, audio);
  async function setText(text: string) {
    const entry = { sourceSeq: 1, type: 'speech', speaker: '1号', voiceKey: 'seat-1', seat: 1, text, visibility: 'public', data: {} };
    const source = { roomId: 'fixture', perspective: 'god', status: 'ended', locale: 'en', cast: [], events: [], result: null, presetName: 'fixture', chapters: [{ day: 1, phase: 'day', title: 'Day 1', entries: [entry] }] };
    const clip = { ...entry, id: '001-1', day: 1, phase: 'day', chapter: 'Day 1', part: 1, parts: 1, spokenText: text, audioFile };
    await writeFile(join(directory, 'source.json'), JSON.stringify(source)); await writeFile(join(directory, 'script.json'), JSON.stringify(source));
    await writeFile(join(directory, 'clips.json'), JSON.stringify([clip]));
    await writeFile(`${audioFile}.json`, JSON.stringify({ text, bytes: audio.length }));
  }
  await setText('Player 1.');
  return { directory, audio, audioFile, setText };
}

describe('批量独立音频核对', () => {
  it('只处理明确选择的片段，未知片段在调用服务前拒绝', async () => {
    const f = await fixture();
    for (const name of ['source.json', 'script.json']) {
      const file = join(f.directory, name), script = JSON.parse(await readFile(file, 'utf8'));
      script.chapters[0].entries.push({ ...script.chapters[0].entries[0], sourceSeq: 2 });
      await writeFile(file, JSON.stringify(script));
    }
    const file = join(f.directory, 'clips.json'), clips = JSON.parse(await readFile(file, 'utf8'));
    clips.push({ ...clips[0], sourceSeq: 2, id: '002-1', audioFile: join(f.directory, 'audio', '002-1.wav') });
    await writeFile(file, JSON.stringify(clips));
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => localResult(input));
    const options = { directory: f.directory, asrDataDir: f.directory };
    await expect(reviewVideoAudio({ ...options, clipIds: ['missing'] }, transcribe)).rejects.toThrow('Unknown ASR clip');
    expect(transcribe).not.toHaveBeenCalled();
    const report = await reviewVideoAudio({ ...options, clipIds: ['001-1'] }, transcribe);
    expect(report.items).toMatchObject([{ clipId: '001-1', status: 'matching' }]);
    expect(report.items).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('波形预检和修复后检标明字时待审核，完整检查仍拒绝缺失字时', async () => {
    const f = await fixture();
    const waveform = await auditAudio(f.directory, join(f.directory, 'output/waveform.json'), false, true);
    expect(waveform).toMatchObject({ validationScope: 'waveform-only-caption-timing-pending', failedClipIds: [] });
    const full = await auditAudio(f.directory, join(f.directory, 'output/full.json'), false);
    expect(full.validationScope).toBe('waveform-and-caption-timing');
    expect(full.failedClipIds).toEqual(['001-1']);
    expect(full.clips[0].alignmentError).toBeTruthy();
  });
  it('固定16k输入，先落盘独立转写并绑定音频/原文；原稿变更复用识别而不再次调用', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => localResult(input));
    const first = await reviewVideoAudio({ directory: f.directory, asrDataDir: f.directory }, transcribe);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(first.items[0]).toMatchObject({ status: 'matching', audioSha256: digest(f.audio), sourceSha256: digest('Player 1.'), cached: false, truncated: false });
    expect(first.items[0]).toMatchObject({ transcriptSha256: digest('Player one.'), aliasesSha256: digest('[]'), contentReview: { audioSha256: digest(f.audio), sourceSha256: digest('Player 1.'), transcriptSha256: digest('Player one.'), matches: true } });
    expect(first.items[0].settingsSha256).toMatch(/^[a-f0-9]{64}$/);
    const transcript = JSON.parse(await readFile(first.items[0].transcriptFile!, 'utf8'));
    expect(transcript).toMatchObject({ text: 'Player one.', inputAudioSha256: first.items[0].inputAudioSha256, rawAudioSha256: digest(f.audio), sourcePromptProvided: false });
    expect(JSON.stringify(transcript)).not.toContain('Player 1.');
    const report = JSON.parse(await readFile(join(f.directory, 'output/asr-review/report.json'), 'utf8'));
    expect(report).toMatchObject({ criticalReview: 'required', audioSemanticReview: 'independent-transcript-only' });
    await f.setText('Player 2.');
    const second = await reviewVideoAudio({ directory: f.directory, asrDataDir: f.directory }, transcribe);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(second.items[0]).toMatchObject({ status: 'needs-review', sourceSha256: digest('Player 2.'), cached: true });
    expect(second.items[0].comparison?.normalized.edits).toBeGreaterThan(0);
  });
  it('相同原音转换结果逐字节一致；识别截断不报告匹配', async () => {
    const f = await fixture();
    const one = await canonicalAsrAudio(f.audioFile, join(f.directory, 'scratch'));
    const two = await canonicalAsrAudio(f.audioFile, join(f.directory, 'scratch'));
    expect(one).toEqual(two); expect(asrAudioSha256(one)).toBe(asrAudioSha256(two));
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => localResult(input, 'Player one.', true));
    const report = await reviewVideoAudio({ directory: f.directory, asrDataDir: f.directory }, transcribe);
    expect(report.items[0]).toMatchObject({ status: 'failure', truncated: true, reason: 'ASR result is truncated' });
    expect(JSON.parse(await readFile(report.items[0].transcriptFile!, 'utf8')).truncated).toBe(true);
  });
  it('本地模型和运行时变更不会命中旧缓存；静音空结果和未知截断状态可保存并复用', async () => {
    const f = await fixture();
    let backend: LocalAsrBackend = 'transformers', runtimeVersion = 'first';
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => {
      const result = localResult(input, backend === 'gguf' ? '' : 'Player one.', backend === 'gguf' ? null : false, backend);
      result.runtime!.versions.runtime = runtimeVersion;
      return result;
    });
    const run = () => reviewVideoAudio({ directory: f.directory, asrDataDir: f.directory }, transcribe);
    const first = await run();
    expect(first.items[0]).toMatchObject({ status: 'matching', cached: false });
    backend = 'gguf'; runtimeVersion = 'gguf-first';
    const switchService = async (nonce: string) => {
      await writeFile(join(f.directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce, pid: 42, backend }));
      await writeFile(join(f.directory, 'local-asr', 'service-control.json'), JSON.stringify({ nonce, token: 'fixture' }));
    };
    await switchService('gguf-first');
    const second = await run();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(second.items[0]).toMatchObject({ status: 'needs-review', cached: false, truncated: null, transcriptSha256: digest('') });
    expect(second.items[0].settingsSha256).not.toBe(first.items[0].settingsSha256);
    expect(JSON.parse(await readFile(second.items[0].transcriptFile!, 'utf8'))).toMatchObject({ text: '', truncated: null, backend: 'gguf' });
    const cached = await run();
    expect(cached.items[0]).toMatchObject({ status: 'needs-review', cached: true, truncated: null });
    expect(transcribe).toHaveBeenCalledTimes(2);
    runtimeVersion = 'gguf-second'; await switchService('gguf-second');
    const third = await run();
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(third.items[0].settingsSha256).not.toBe(second.items[0].settingsSha256);
    expect((await readdir(join(f.directory, 'output', 'asr-review', 'cache'))).length).toBe(3);
  });
  it('Q5 的旧 GGUF 缓存不会被当作 Q8 结果复用', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'q8', pid: 42, backend: 'gguf' }));
    await writeFile(join(f.directory, 'local-asr', 'service-control.json'), JSON.stringify({ nonce: 'q8', token: 'fixture' }));
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => localResult(input, 'Player one.', false, 'gguf'));
    const options = { directory: f.directory, asrDataDir: f.directory };
    const first = await reviewVideoAudio(options, transcribe);
    expect(first.items[0]).toMatchObject({ cached: false, status: 'matching' });
    const cache = join(f.directory, 'output', 'asr-review', 'cache');
    const [name] = await readdir(cache), file = join(cache, name), stale = JSON.parse(await readFile(file, 'utf8'));
    stale.rawResult.model.file = 'Qwen3-ASR-1.7B-Q5_K_M.gguf';
    stale.rawResult.model.sha256 = '034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0';
    await writeFile(file, JSON.stringify(stale));
    const second = await reviewVideoAudio(options, transcribe);
    expect(second.items[0]).toMatchObject({ cached: false, status: 'matching' });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });
  it('识别期间原稿改变时保留独立转写但拒绝用旧稿判定', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => {
      await f.setText('Player 2.');
      return localResult(input);
    });
    const result = await reviewVideoAudio({ directory: f.directory, asrDataDir: f.directory }, transcribe);
    expect(result.items[0]).toMatchObject({ status: 'failure', reason: 'Audio or metadata changed during ASR review' });
    expect(JSON.parse(await readFile(result.items[0].transcriptFile!, 'utf8')).text).toBe('Player one.');
  });
  it('批量识别中本地服务被替换时拒绝该结果', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => {
      await writeFile(join(f.directory, 'local-asr', 'service-control.json'), JSON.stringify({ nonce: 'new', token: 'new' }));
      return localResult(input);
    });
    const result = await reviewVideoAudio({ directory: f.directory, asrDataDir: f.directory }, transcribe);
    expect(result.items[0]).toMatchObject({ status: 'failure', reason: 'Local ASR service changed during review' });
  });
  it('来源之外的音频在识别前拒绝且不调用服务', async () => {
    const f = await fixture(), clipFile = join(f.directory, 'clips.json'), clips = JSON.parse(await readFile(clipFile, 'utf8'));
    clips[0].audioFile = resolve('data/other.wav'); await writeFile(clipFile, JSON.stringify(clips));
    const transcribe = vi.fn<typeof import('../src/asr').transcribeAudio>();
    const result = await reviewVideoAudio({ directory: f.directory }, transcribe);
    expect(transcribe).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ status: 'failure', reason: 'Audio path does not belong to this project' });
  });
  it('玩家视角不能绕过当前座位项目及授权检查向 ASR 发送数据', async () => {
    const f = await fixture();
    for (const name of ['source.json', 'script.json']) {
      const file = join(f.directory, name), script = JSON.parse(await readFile(file, 'utf8'));
      script.perspective = 'player'; script.playerSeat = 1; await writeFile(file, JSON.stringify(script));
    }
    const transcribe = vi.fn<typeof import('../src/asr').transcribeAudio>();
    await expect(reviewVideoAudio({ directory: f.directory, provider: 'qwen-token-plan' }, transcribe)).rejects.toThrow(/selected VIDEO_PROJECT_DIR/);
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('日语素材在 MiMo 识别或缓存读取之前拒绝', async () => {
    const f = await fixture();
    for (const name of ['source.json', 'script.json']) {
      const file = join(f.directory, name), script = JSON.parse(await readFile(file, 'utf8'));
      script.locale = 'ja'; await writeFile(file, JSON.stringify(script));
    }
    const transcribe = vi.fn<typeof import('../src/asr').transcribeAudio>();
    await expect(reviewVideoAudio({ directory: f.directory, provider: 'mimo-token-plan' }, transcribe)).rejects.toThrow(/restricted to zh or en/);
    await expect(reviewVideoAudio({ directory: f.directory, provider: 'local' }, transcribe)).rejects.toThrow(/restricted to zh or en/);
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('日语 auto 选择 Qwen，缺失或不一致的语言在转写前拒绝', async () => {
    const f = await fixture(); await f.setText('こんにちは');
    for (const name of ['source.json', 'script.json']) {
      const file = join(f.directory, name), script = JSON.parse(await readFile(file, 'utf8'));
      script.locale = 'ja'; await writeFile(file, JSON.stringify(script));
    }
    const transcribe = vi.fn(async (input: Buffer, _options?: AsrOptions): Promise<AsrResult> => ({ provider: 'qwen-token-plan', inputAudioSha256: asrAudioSha256(input), model: QWEN_ASR_MODEL, revision: null,
      text: 'こんにちは', rawResult: { output: { sentence: { text: 'こんにちは' } } }, truncated: null, elapsedMs: 1, options: { language: 'auto' } }));
    const report = await reviewVideoAudio({ directory: f.directory }, transcribe);
    expect(report).toMatchObject({ provider: 'qwen-token-plan', locale: 'ja', items: [{ status: 'matching' }] });
    expect(transcribe.mock.calls[0][1]).toMatchObject({ provider: 'qwen-token-plan', locale: 'ja' });
    const scriptFile = join(f.directory, 'script.json'), script = JSON.parse(await readFile(scriptFile, 'utf8'));
    script.locale = 'en'; await writeFile(scriptFile, JSON.stringify(script));
    await expect(reviewVideoAudio({ directory: f.directory }, transcribe)).rejects.toThrow(/locales differ/);
    expect(transcribe).toHaveBeenCalledTimes(1);
    const sourceFile = join(f.directory, 'source.json'), source = JSON.parse(await readFile(sourceFile, 'utf8'));
    delete source.locale; await writeFile(sourceFile, JSON.stringify(source));
    await expect(reviewVideoAudio({ directory: f.directory }, transcribe)).rejects.toThrow(/explicit zh, en or ja/);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('不可靠字时先停止，明确授权 Qwen 后复用本地结果并自动导入同次词边界', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer, options?: AsrOptions): Promise<AsrResult> => options?.provider === 'local' ? localResult(input) : ({
      provider: 'qwen-token-plan', inputAudioSha256: asrAudioSha256(input), model: QWEN_ASR_MODEL, revision: null,
      text: 'Player one.', rawResult: { output: { sentence: { text: 'Player one.', words: [{ text: 'Player', begin_time: 10, end_time: 300 }, { text: ' one', begin_time: 300, end_time: 700 }] } } },
      truncated: null, elapsedMs: 1, options: { language: 'auto' } }));
    const common = { directory: f.directory, asrDataDir: f.directory, align: true };
    const first = await reviewVideoAudio(common, transcribe);
    expect(first.items[0]).toMatchObject({ status: 'failure', reason: expect.stringContaining('alignment-required') });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const second = await reviewVideoAudio({ ...common, alignmentProvider: 'qwen-token-plan' }, transcribe);
    expect(second.items[0]).toMatchObject({ status: 'matching', cached: true, alignment: 'independent-qwen-word-times', alignmentProvider: 'qwen-token-plan', alignmentCached: false });
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(`${f.audioFile}.alignment.json`, 'utf8'))).toMatchObject({ audioSha256: digest(f.audio), method: 'external-transcript', engine: QWEN_ASR_MODEL });
    expect(await readFile(f.audioFile)).toEqual(f.audio);
    const third = await reviewVideoAudio({ ...common, alignmentProvider: 'qwen-token-plan' }, transcribe);
    expect(third.items[0]).toMatchObject({ status: 'matching', alignment: 'existing-external-transcript' });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });
  it('中文需要外部对齐时不请求不支持的 Qwen 导入；原字时有效时正常通过', async () => {
    const f = await fixture(); await f.setText('你好');
    for (const name of ['source.json', 'script.json']) {
      const file = join(f.directory, name), script = JSON.parse(await readFile(file, 'utf8'));
      script.locale = 'zh-CN'; await writeFile(file, JSON.stringify(script));
    }
    const transcribe = vi.fn(async (input: Buffer, options?: AsrOptions): Promise<AsrResult> => {
      expect(options?.provider).toBe('local');
      return localResult(input, '你好');
    });
    const options = { directory: f.directory, asrDataDir: f.directory, provider: 'local' as const, align: true, alignmentProvider: 'qwen-token-plan' as const };
    const missing = await reviewVideoAudio(options, transcribe);
    expect(missing.items[0]).toMatchObject({ status: 'failure', reason: 'alignment-required: external transcript alignment does not support zh', recognitionRequests: 1, alignmentRequests: 0, contentReview: { matches: true } });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const metadataFile = `${f.audioFile}.json`, meta = JSON.parse(await readFile(metadataFile, 'utf8'));
    meta.sentences = [{ index: 0, text: '你好', words: [{ text: '你', begin_time: 10, end_time: 250 }, { text: '好', begin_time: 260, end_time: 600 }] }];
    await writeFile(metadataFile, JSON.stringify(meta));
    const valid = await reviewVideoAudio(options, transcribe);
    expect(valid.items[0]).toMatchObject({ status: 'matching', cached: true, alignment: 'provider-timestamps' });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('Qwen 内容核对直接复用同次词边界，不重复调用', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => ({ provider: 'qwen-token-plan', inputAudioSha256: asrAudioSha256(input), model: QWEN_ASR_MODEL, revision: null,
      text: 'Player one.', rawResult: { output: { sentence: { text: 'Player one.', words: [{ text: 'Player', begin_time: 10, end_time: 300 }, { text: ' one', begin_time: 300, end_time: 700 }] } } },
      truncated: null, elapsedMs: 1, options: { language: 'auto' } }));
    const report = await reviewVideoAudio({ directory: f.directory, provider: 'qwen-token-plan', align: true }, transcribe);
    expect(report.items[0]).toMatchObject({ status: 'matching', recognitionRequests: 1, alignment: 'independent-qwen-word-times', alignmentCached: false });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const savedReport = JSON.parse(await readFile(join(f.directory, 'output/asr-review/report.json'), 'utf8'));
    expect(savedReport).toMatchObject({ recognitionRequests: 1, alignmentRequests: 0 });
  });
  it.each(['malformed', 'stale'] as const)('内容匹配后遇到 %s 对齐文件仍明确失败', async (kind) => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => ({ provider: 'qwen-token-plan', inputAudioSha256: asrAudioSha256(input), model: QWEN_ASR_MODEL, revision: null,
      text: 'Player one.', rawResult: { output: { sentence: { text: 'Player one.', words: [{ text: 'Player', begin_time: 10, end_time: 300 }, { text: ' one', begin_time: 300, end_time: 700 }] } } },
      truncated: null, elapsedMs: 1, options: { language: 'auto' } }));
    const options = { directory: f.directory, provider: 'qwen-token-plan' as const, align: true };
    expect((await reviewVideoAudio(options, transcribe)).items[0].status).toBe('matching');
    const file = `${f.audioFile}.alignment.json`;
    if (kind === 'malformed') await writeFile(file, '{broken');
    else {
      const alignment = JSON.parse(await readFile(file, 'utf8'));
      alignment.audioSha256 = '0'.repeat(64); await writeFile(file, JSON.stringify(alignment));
    }
    const result = await reviewVideoAudio(options, transcribe);
    expect(result.items[0]).toMatchObject({ status: 'failure', cached: true, contentReview: { matches: true } });
    expect(JSON.parse(await readFile(join(f.directory, 'output/asr-review/report.json'), 'utf8')).items[0].status).toBe('failure');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('差异的明确别名只影响本片核对，续跑使用缓存不重复识别', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer) => localResult(input, 'Player won.'));
    const base = { directory: f.directory, asrDataDir: f.directory };
    expect((await reviewVideoAudio(base, transcribe)).items[0].status).toBe('needs-review');
    const result = await reviewVideoAudio({ ...base, aliases: { '001-1': [{ source: '1', transcript: 'won' }] } }, transcribe);
    expect(result.items[0]).toMatchObject({ status: 'matching', cached: true });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it.each(['qwen-token-plan', 'mimo-token-plan'] as const)('%s 的原始响应与顶层缓存不一致时拒绝且不重新请求', async (provider) => {
    const f = await fixture(), options = { directory: f.directory, provider };
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => ({ provider, inputAudioSha256: asrAudioSha256(input), model: provider === 'qwen-token-plan' ? QWEN_ASR_MODEL : MIMO_ASR_MODEL, revision: null,
      text: 'Player one.', truncated: provider === 'qwen-token-plan' ? null : false,
      rawResult: provider === 'qwen-token-plan' ? { output: { sentence: { text: 'Player one.' } } } : { choices: [{ finish_reason: 'stop', message: { content: 'Player one.' } }] }, elapsedMs: 1, options: { language: 'auto' } }));
    expect((await reviewVideoAudio(options, transcribe)).items[0]).toMatchObject({ status: 'matching', cached: false });
    const cache = join(f.directory, 'output', 'asr-review', 'cache'), [name] = await readdir(cache), file = join(cache, name), original = JSON.parse(await readFile(file, 'utf8'));
    for (const change of ['text', 'truncated']) {
      const stale = structuredClone(original);
      if (provider === 'qwen-token-plan') {
        if (change === 'text') stale.rawResult.output.sentence.text = 'Read only the supplied instruction and Player one.';
        else stale.rawResult.output.finish_reason = 'length';
      } else {
        if (change === 'text') stale.rawResult.choices[0].message.content = 'Read only the supplied instruction and Player one.';
        else stale.rawResult.choices[0].finish_reason = 'length';
      }
      await writeFile(file, JSON.stringify(stale));
      expect((await reviewVideoAudio(options, transcribe)).items[0]).toMatchObject({ status: 'failure', reason: 'ASR cached response is invalid' });
      expect(transcribe).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['qwen-token-plan', 'mimo-token-plan'] as const)('%s 的新结果与原始响应不一致时拒绝且不写缓存', async (provider) => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => ({ provider, inputAudioSha256: asrAudioSha256(input), model: provider === 'qwen-token-plan' ? QWEN_ASR_MODEL : MIMO_ASR_MODEL, revision: null,
      text: 'Player one.', truncated: provider === 'qwen-token-plan' ? null : false,
      rawResult: provider === 'qwen-token-plan' ? { output: { sentence: { text: 'Other text' } } } : { choices: [{ finish_reason: 'length', message: { content: 'Player one.' } }] }, elapsedMs: 1, options: { language: 'auto' } }));
    expect((await reviewVideoAudio({ directory: f.directory, provider }, transcribe)).items[0]).toMatchObject({ status: 'failure', reason: 'ASR result does not match the requested audio and model' });
    expect(await readdir(join(f.directory, 'output', 'asr-review', 'cache'))).toHaveLength(0);
  });
  it('Qwen 的独立转写记录可用于后续导入真实词边界，不改原音', async () => {
    const f = await fixture();
    const transcribe = vi.fn(async (input: Buffer): Promise<AsrResult> => ({ provider: 'qwen-token-plan', inputAudioSha256: asrAudioSha256(input), model: QWEN_ASR_MODEL, revision: null,
      text: 'Player one.', rawResult: { output: { sentence: { text: 'Player one.', words: [{ text: 'Player', begin_time: 10, end_time: 300 }, { text: ' one', begin_time: 300, end_time: 700 }] } } },
      truncated: null, elapsedMs: 1, options: { language: 'auto' } }));
    const report = await reviewVideoAudio({ directory: f.directory, provider: 'qwen-token-plan' }, transcribe);
    expect(report.items[0]).toMatchObject({ status: 'matching', truncated: null });
    const aligned = createAudioAlignment({ audio: f.audio, metadata: await readFile(`${f.audioFile}.json`), asrResponse: await readFile(report.items[0].transcriptFile!, 'utf8'), locale: 'en' });
    expect(aligned.words.map((word) => word.text).join('')).toBe('Player 1.');
    expect(await readFile(f.audioFile)).toEqual(f.audio);
  });
});

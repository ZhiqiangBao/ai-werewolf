import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { wavHeader } from '../src/speech/audio';
import { assertPreviousAlignment, assertTimelineAlignments, createAudioAlignment, effectiveAudioAlignment, saveAudioAlignment } from '../../../scripts/video/audio-alignment';
import { assertNonUniformWordTimes, captionsFromWords, sourceCaptionWords } from '../../../scripts/video/timeline';
import type { AudioMeta } from '../src/speech/types';
import type { TimedClip } from '../../../scripts/video/project';
import { auditAudio } from '../../../scripts/video/audit-audio';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const audio = Buffer.concat([wavHeader(30 * 24000, 24000), Buffer.alloc(30 * 24000 * 2)]);
const text = '3番Vincent、11番にvote。';
const metadata = Buffer.from(JSON.stringify({ text, model: 'fixture', voice: 'fixture', cacheKey: 'fixture', bytes: audio.length, sentences: [] }));
const words = [
  { text: '3', begin_time: 100, end_time: 200 }, { text: '番', begin_time: 200, end_time: 300 },
  { text: 'ヴィ', begin_time: 300, end_time: 400 }, { text: 'ン', begin_time: 400, end_time: 450 }, { text: 'セント', begin_time: 450, end_time: 600, punctuation: '、' },
  { text: '1', begin_time: 25440, end_time: 25560 }, { text: '1', begin_time: 25560, end_time: 25680 },
  { text: '番', begin_time: 25680, end_time: 25880 }, { text: 'に', begin_time: 25880, end_time: 26000 },
  { text: 'ボー', begin_time: 26000, end_time: 26300 }, { text: 'ト', begin_time: 26300, end_time: 26500, punctuation: '。' },
];
const transcript = '3番ヴィンセント、11番にボート。';
const aliases = [{ source: 'Vincent', transcript: 'ヴィンセント' }, { source: 'vote', transcript: 'ボート' }];
const response = (overrides: Record<string, unknown> = {}, sentence = { text: transcript, words }) => JSON.stringify({ model: 'fixture-independent-asr', rawAudioSha256: sha(audio), sourcePromptProvided: false, result: { output: { sentence } }, ...overrides });
const input = () => ({ audio, metadata, asrResponse: response(), locale: 'ja', aliases });

describe('独立 ASR 词边界导入', () => {
  it('合并名字和分词数字的真实首尾边界，逐词消费且原文不变', () => {
    const aligned = createAudioAlignment(input());
    expect(aligned.method).toBe('external-transcript');
    expect(aligned.sourceSha256).toBe(sha(Buffer.from(text)));
    expect(aligned.transcriptSha256).toBe(sha(Buffer.from(transcript)));
    expect(aligned.aliasesSha256).toBe(sha(Buffer.from(JSON.stringify(aliases))));
    expect(aligned.wordTimesSha256).toBe(sha(Buffer.from(JSON.stringify(words))));
    expect(aligned.mappedWordsSha256).toBe(sha(Buffer.from(JSON.stringify(aligned.words))));
    expect(aligned.words.map((word) => word.text).join('')).toBe(text);
    expect(aligned.words.find((word) => word.text.includes('Vincent'))).toMatchObject({ begin_time: 300, end_time: 600 });
    expect(aligned.words.find((word) => word.text.includes('11'))).toMatchObject({ begin_time: 25440, end_time: 25680 });
    expect(aligned.words.find((word) => word.text.includes('vote'))).toMatchObject({ begin_time: 26000, end_time: 26500 });
    const meta = JSON.parse(metadata.toString()) as AudioMeta;
    expect(captionsFromWords({ ...meta, sentences: [{ index: 0, text, words: aligned.words }] }, 30, 'ja').map((cue) => cue.text).join('')).toBe(text);
  });
  it('ASR 词与别名边界相交时整体合并，不估算该词内的时间', () => {
    const changed = [...words];
    changed.splice(1, 2, { text: '番ヴィ', begin_time: 200, end_time: 400 });
    const aligned = createAudioAlignment({ ...input(), asrResponse: response({}, { text: transcript, words: changed }) });
    expect(aligned.words.find((word) => word.text.includes('Vincent'))).toMatchObject({ text: '番Vincent', begin_time: 200, end_time: 600 });
  });
  it('拒绝漏词、重复词、错字、未确认别名、过期音频和不可靠时间', () => {
    expect(() => createAudioAlignment({ ...input(), aliases: [] })).toThrow(/does not match source|differs from the source/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({ sourcePromptProvided: true }) })).toThrow(/source prompt/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({ rawAudioSha256: 'wrong' }) })).toThrow(/bound to the original audio/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({}, { text: transcript, words: words.slice(1) }) })).toThrow(/ASR words differ/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({}, { text: transcript, words: [...words, words.at(-1)!] }) })).toThrow(/out of order|ASR words differ/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({}, { text: transcript.replace('11', '12'), words }) })).toThrow(/differs from the source/);
    const late = words.map((word) => ({ ...word })); late.at(-1)!.end_time = 31000;
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({}, { text: transcript, words: late }) })).toThrow(/outside audio duration/);
    const gap = words.map((word) => ({ ...word })); gap[6].begin_time = 27000; gap[6].end_time = 27100;
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({}, { text: transcript, words: gap }) })).toThrow(/out of order|gap/);
  });
  it('拒绝明确截断的 ASR 响应；未知截断状态保持可用', async () => {
    const marked = response({ truncated: true });
    const finishLength = response({ truncated: null, result: { output: { finish_reason: 'length', sentence: { text: transcript, words } } } });
    expect(() => createAudioAlignment({ ...input(), asrResponse: marked })).toThrow(/Truncated ASR response/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: finishLength })).toThrow(/Truncated ASR response/);
    expect(() => createAudioAlignment({ ...input(), asrResponse: response({ truncated: null }) })).not.toThrow();
    const base = resolve('data/video-alignment-tests'); await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, 'truncated-')), file = join(dir, 'audio.wav'), asrFile = join(dir, 'asr.json'), aliasFile = join(dir, 'aliases.json');
    await writeFile(file, audio); await writeFile(`${file}.json`, metadata); await writeFile(aliasFile, JSON.stringify(aliases));
    for (const value of [marked, finishLength]) {
      await writeFile(asrFile, value);
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/video/import-audio-alignment.ts', `--audio=${file}`, `--asr-response=${asrFile}`, '--locale=ja', `--aliases=${aliasFile}`], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Truncated ASR response/);
      expect(existsSync(`${file}.alignment.json`)).toBe(false);
    }
  });
  it('长串近似等分时阻断，正常变动的词时间不误报', () => {
    const synthetic = Array.from({ length: 20 }, (_, i) => ({ begin_time: i * 257, end_time: (i + 1) * 257 }));
    expect(() => assertNonUniformWordTimes(synthetic)).toThrow(/uniformly spaced/);
    expect(() => sourceCaptionWords({ text: 'あ'.repeat(20), sentences: [{ index: 0, text: '', words: synthetic.map((w) => ({ ...w, text: 'あ' })) }] } as AudioMeta, 'ja')).toThrow(/uniformly spaced/);
    const varied = synthetic.map((word, i) => ({ begin_time: word.begin_time, end_time: word.end_time - (i % 3) * 4 }));
    expect(() => assertNonUniformWordTimes(varied)).not.toThrow();
    const uniformWords = synthetic.map((word) => ({ ...word, text: 'あ' }));
    const uniformText = 'あ'.repeat(20);
    const meta = Buffer.from(JSON.stringify({ text: uniformText, bytes: audio.length, sentences: [] }));
    expect(() => createAudioAlignment({ audio, metadata: meta, asrResponse: response({}, { text: uniformText, words: uniformWords }), locale: 'ja' })).toThrow(/uniformly spaced/);
  });
  it('sidecar 不改原文件，绑定丢失或被篡改时不回退', async () => {
    const base = resolve('data/video-alignment-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')), file = join(directory, 'audio.wav');
    await writeFile(file, audio); await writeFile(`${file}.json`, metadata);
    const saved = await saveAudioAlignment(file, response(), 'ja', aliases);
    await expect(saveAudioAlignment(file, response(), 'ja', aliases)).rejects.toThrow();
    expect(await readFile(file)).toEqual(audio); expect(await readFile(`${file}.json`)).toEqual(metadata);
    const originalMeta = JSON.parse(metadata.toString()) as AudioMeta;
    const selected = await effectiveAudioAlignment(file, originalMeta, 'ja');
    expect(selected.summary).toMatchObject({ method: 'external-transcript', engine: 'fixture-independent-asr', audioSha256: sha(audio) });
    expect(() => assertPreviousAlignment(undefined, selected.summary)).toThrow(/missing or changed/);
    expect(selected.meta.alignment).toEqual({ method: 'external-transcript', engine: 'fixture-independent-asr' });
    const captions = captionsFromWords(selected.meta, 30, 'ja');
    const clip = { id: 'test', audioFile: file, audioMeta: originalMeta, audioDuration: 30, captions, captionAlignment: selected.summary } as TimedClip;
    await expect(assertTimelineAlignments([clip], 'ja')).resolves.toBeUndefined();
    const sidecarFile = `${file}.alignment.json`, originalSidecar = await readFile(sidecarFile, 'utf8');
    const forged = { ...saved, words: saved.words.map((word, index) => index ? word : { ...word, begin_time: 10 }) };
    await writeFile(sidecarFile, JSON.stringify(forged));
    await expect(effectiveAudioAlignment(file, originalMeta, 'ja')).rejects.toThrow(/sidecar changed/);
    await writeFile(sidecarFile, originalSidecar);
    await writeFile(file, Buffer.concat([audio.subarray(0, audio.length - 2), Buffer.from([1, 2])]));
    await expect(effectiveAudioAlignment(file, originalMeta, 'ja')).rejects.toThrow(/bound to the original audio/);
    await writeFile(file, audio);
    await writeFile(`${file}.json`, JSON.stringify({ ...originalMeta, cacheKey: 'changed' }));
    await expect(effectiveAudioAlignment(file, originalMeta, 'ja')).rejects.toThrow(/metadata changed/);
    await writeFile(`${file}.json`, metadata);
    await unlink(sidecarFile);
    await expect(assertTimelineAlignments([clip], 'ja')).rejects.toThrow(/alignment selection changed/);
  });
  it('命令行显式导入和核验，不覆盖原音频、元数据或已有 sidecar', async () => {
    const base = resolve('data/video-alignment-tests'); await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, 'cli-')), file = join(dir, 'audio.wav');
    const asrFile = join(dir, 'asr.json'), aliasFile = join(dir, 'aliases.json');
    await writeFile(file, audio); await writeFile(`${file}.json`, metadata);
    await writeFile(asrFile, response()); await writeFile(aliasFile, JSON.stringify(aliases));
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/video/import-audio-alignment.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
    const args = [`--audio=${file}`, `--asr-response=${asrFile}`, '--locale=ja', `--aliases=${aliasFile}`];
    const imported = cli(...args);
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({ method: 'external-transcript', audioSha256: sha(audio) });
    expect(await readFile(file)).toEqual(audio); expect(await readFile(`${file}.json`)).toEqual(metadata);
    const sidecar = await readFile(`${file}.alignment.json`);
    expect(cli(...args).status).not.toBe(0);
    expect(await readFile(`${file}.alignment.json`)).toEqual(sidecar);
    const checked = cli(`--audio=${file}`, '--locale=ja', '--check');
    expect(checked.status, checked.stderr).toBe(0);
    await writeFile(file, Buffer.concat([audio.subarray(0, audio.length - 2), Buffer.from([1, 2])]));
    expect(cli(`--audio=${file}`, '--locale=ja', '--check').status).not.toBe(0);
  });
  it('audit 选中后 sidecar 丢失时记录失败并保留绑定，timeline 不回退或覆盖产物', async () => {
    const base = resolve('data/video-alignment-tests'); await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, 'audit-')), file = join(dir, 'audio.wav');
    await writeFile(file, audio); await writeFile(`${file}.json`, metadata);
    await saveAudioAlignment(file, response(), 'ja', aliases);
    const script = { roomId: 'fixture', perspective: 'god', status: 'ended', locale: 'ja' };
    await writeFile(join(dir, 'source.json'), JSON.stringify(script)); await writeFile(join(dir, 'script.json'), JSON.stringify(script));
    await writeFile(join(dir, 'clips.json'), JSON.stringify([{ id: '001-1', sourceSeq: 1, voiceKey: 'judge', audioFile: file, spokenText: text, chapter: 'fixture' }]));
    const first = await auditAudio(dir, join(dir, 'output', 'audio-audit.json'), false);
    expect(first.clips[0].alignment?.method).toBe('external-transcript');
    await unlink(`${file}.alignment.json`);
    const second = await auditAudio(dir, join(dir, 'output', 'audio-audit.json'), false);
    expect(second.clips[0].alignment).toEqual(first.clips[0].alignment);
    expect(second.clips[0].alignmentError).toMatch(/missing or changed/);
    await writeFile(join(dir, 'master.wav'), 'old master');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/video/timeline.ts'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, VIDEO_ROOM: 'fixture', VIDEO_PLAYER_SEAT: '', VIDEO_PROJECT_DIR: dir, VIDEO_DATA_DIR: dir } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Previously selected external alignment is missing or changed/);
    expect(await readFile(join(dir, 'master.wav'), 'utf8')).toBe('old master');
    expect(existsSync(join(dir, 'audio-normalized'))).toBe(false);
    expect(existsSync(join(dir, 'subtitles'))).toBe(false);
  });
});

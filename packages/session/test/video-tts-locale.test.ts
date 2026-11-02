import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { auditAudio } from '../../../scripts/video/audit-audio';
import { wavHeader } from '../../../scripts/video/audio';
import { assertPlayerSources } from '../../../scripts/video/integrity';
import { buildClips, clipVoiceProfile, spokenText, type Script, type VoiceCatalog } from '../../../scripts/video/project';
import { repairAudio } from '../../../scripts/video/repair-audio';
import type { SpeechSynthesizer } from '../../../scripts/video/tts-types';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('werewolf-tts-locale-')) throw Error('测试目录不在临时工作区');
    await rm(directory, { recursive: true, force: true });
  }
});

it('合成配置使用原局语言，旧默认指令安全适配并保留用户配置', async () => {
  const voices = JSON.parse(await readFile('scripts/video/voices.json', 'utf8')) as VoiceCatalog;
  const clip = { id: 'clip', voiceKey: 'seat-1', data: {} };
  vi.stubEnv('VIDEO_LOCALE', 'ja');
  const en = clipVoiceProfile(voices, clip, 'en');
  expect(en).toMatchObject({ voice: voices.profiles['seat-1'].voice, locale: 'en', languageHints: ['en'] });
  expect(en.instruction).toContain('English');
  const ja = clipVoiceProfile(voices, clip, 'ja');
  expect(ja).toMatchObject({ locale: 'ja', languageHints: ['ja'] });
  expect(ja.instruction).toContain('日本語');
  const zh = clipVoiceProfile(voices, clip, 'zh-CN');
  expect(zh.instruction).toBe(voices.profiles['seat-1'].instruction);
  expect(zh.languageHints).toEqual(['zh']);
  const custom = { ...voices, profiles: { ...voices.profiles, 'seat-1': { ...voices.profiles['seat-1'], voice: 'custom', instruction: '用户自定义普通话说明。' } } };
  expect(clipVoiceProfile(custom, clip, 'en')).toMatchObject({ voice: 'custom', instruction: '用户自定义普通话说明。', locale: 'en', languageHints: ['en'] });
  const cue = { voiceKey: 'judge', data: { presentationOnly: true, presentationKey: 'seer-open' } };
  expect(clipVoiceProfile(voices, cue, 'ja').instruction).toContain('日本語');
  const customCue = { ...voices, judgeCues: { 'seer-open': { instruction: '自定义提示' } } };
  expect(clipVoiceProfile(customCue, cue, 'ja').instruction).toBe('自定义提示');
  const dialect = { ...custom, profiles: { ...custom.profiles, 'seat-1': { ...custom.profiles['seat-1'], locale: 'yue-HK', languageHints: ['zh'] } } };
  expect(clipVoiceProfile(dialect, clip, 'yue-HK')).toMatchObject({ locale: 'yue-HK', languageHints: ['zh'] });
});

it('英文日文原话保持数字与标点，旧中文朗读格式保持不变并通过完整性检查', () => {
  expect(spokenText('【投票】2→3\n结束')).toBe('投票。二投给三。结束');
  expect(spokenText('Seat 2 → 3\nOkay.', 'en')).toBe('Seat 2 → 3\nOkay.');
  expect(spokenText('2番 → 3番', 'ja')).toBe('2番 → 3番');
  const source: Script = { locale: 'en', roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended', cast: [], events: [], result: null,
    chapters: [{ day: 1, phase: 'day', title: 'Day 1', entries: [{ sourceSeq: 1, type: 'speech', speaker: '1', voiceKey: 'seat-1', seat: 1, text: 'Seat 2 → 3.', visibility: 'public', data: {} }] }] };
  const clips = buildClips(source);
  expect(clips[0].spokenText).toBe('Seat 2 → 3.');
  expect(() => assertPlayerSources(source, source, clips)).not.toThrow();
  expect(() => assertPlayerSources(source, source, [{ ...clips[0], spokenText: 'Seat 二 → 3.' }])).toThrow('Spoken text');
});

it('显式自定义适配器收到原局语言和提示，不更换模型或文本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-tts-locale-')); directories.push(directory);
  const adapter = join(directory, 'adapter.mjs');
  await writeFile(adapter, 'export async function synthesize(text, profile, model) { return { text, profile, model }; }');
  vi.stubEnv('VIDEO_TTS_PROVIDER', 'fixture'); vi.stubEnv('VIDEO_TTS_ADAPTER', adapter); vi.stubEnv('VIDEO_LOCALE', 'ja');
  const { synthesizeSpeech } = await import('../../../scripts/video/tts');
  const voices: VoiceCatalog = { model: 'custom-model', profiles: { judge: { voice: 'custom-voice', label: '', rate: 1, instruction: 'User instruction' } } };
  const result = await synthesizeSpeech('Seat 2.', clipVoiceProfile(voices, { voiceKey: 'judge', data: {} }, 'en'), voices.model, 'unused.wav');
  expect(result).toMatchObject({ text: 'Seat 2.', model: 'custom-model', profile: { locale: 'en', languageHints: ['en'], instruction: 'User instruction', voice: 'custom-voice' } });
});

it('定点修复把原局日语而非画面英语传给模拟适配器', async () => {
  vi.stubEnv('VIDEO_LOCALE', 'en');
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-tts-locale-')); directories.push(directory);
  await mkdir(join(directory, 'audio'));
  const source: Script = { locale: 'ja', roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended', cast: [], events: [], result: null,
    chapters: [{ day: 1, phase: 'day', title: '1日目', entries: [{ sourceSeq: 1, type: 'speech', speaker: '1', voiceKey: 'seat-1', seat: 1, text: '2番です。', visibility: 'public', data: {} }] }] };
  const clip = { ...buildClips(source)[0], audioFile: join(directory, 'audio', '001-1.wav') };
  const pcm = Buffer.alloc(24000 * 2);
  const bytes = Buffer.concat([wavHeader(24000, 24000), pcm]);
  await writeFile(clip.audioFile, bytes);
  await writeFile(clip.audioFile + '.json', JSON.stringify({ cacheKey: 'synthetic', model: 'custom-model', voice: 'custom-voice', text: clip.spokenText, bytes: bytes.length,
    sentences: [{ index: 0, text: clip.spokenText, words: [{ text: clip.spokenText, begin_time: 100, end_time: 800 }] }] }));
  const voices: VoiceCatalog = { model: 'custom-model', profiles: { 'seat-1': { voice: 'custom-voice', label: '', rate: 1, instruction: '自定义' } } };
  for (const [name, value] of Object.entries({ 'source.json': source, 'script.json': source, 'clips.json': [clip], 'voices.json': voices })) await writeFile(join(directory, name), JSON.stringify(value));
  const audit = await auditAudio(directory, join(directory, 'audit.json'), false);
  const synthesize = vi.fn<SpeechSynthesizer>(async () => { throw Error('模拟结束'); });
  await repairAudio(directory, { auto: true, audit, maxAttempts: 1, synthesize });
  expect(synthesize).toHaveBeenCalledOnce();
  expect(synthesize.mock.calls[0][0]).toBe('2番です。');
  expect(synthesize.mock.calls[0][1]).toMatchObject({ locale: 'ja', languageHints: ['ja'], instruction: '自定义', voice: 'custom-voice' });
  expect(synthesize.mock.calls[0][2]).toBe('custom-model');
});

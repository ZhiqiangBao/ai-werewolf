import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editScript } from '../../../scripts/video/editorial';
import { buildClips, type Script } from '../../../scripts/video/project';
import { assertPlayerSources } from '../../../scripts/video/integrity';
import { encodingSettings, videoEncodingArgs } from '../../../scripts/video/encoding';
import { reuseAudio } from '../../../scripts/video/audio-cache';

const temporary: { dir: string; files: string[] }[] = [];
async function fixture(name: string, content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-video-adapter-'));
  const file = join(dir, name); temporary.push({ dir, files: [file] });
  await writeFile(file, content);
  return file;
}
afterEach(async () => {
  vi.unstubAllEnvs(); vi.resetModules();
  for (const item of temporary.splice(0)) {
    for (const file of item.files) await unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(item.dir);
  }
});

describe('explicit TTS provider selection', () => {
  it('fails for an unknown provider instead of sending it to the Qwen billing route', async () => {
    vi.stubEnv('VIDEO_TTS_PROVIDER', 'other-provider'); vi.stubEnv('VIDEO_TTS_ADAPTER', '');
    const { loadSynthesizer } = await import('../../../scripts/video/tts');
    await expect(loadSynthesizer()).rejects.toThrow('no automatic provider or billing fallback');
  });
  it('loads an explicitly configured adapter and preserves its provider-specific parameters', async () => {
    const file = await fixture('adapter.mjs', 'export async function synthesize(text, profile, model, output) { return { text, voice: profile.voice, model, output, marker: "local-fixture" }; }');
    vi.stubEnv('VIDEO_TTS_PROVIDER', 'local-fixture'); vi.stubEnv('VIDEO_TTS_ADAPTER', file);
    const { loadSynthesizer } = await import('../../../scripts/video/tts');
    const synthesize = await loadSynthesizer();
    const result = await synthesize('待合成原文', { voice: 'fixture-voice', label: '测试', rate: 1, instruction: '' }, 'fixture-model', 'fixture.wav');
    expect(result).toEqual({ text: '待合成原文', voice: 'fixture-voice', model: 'fixture-model', output: 'fixture.wav', marker: 'local-fixture' });
  });
  it('rejects an adapter without the synthesis export', async () => {
    const file = await fixture('invalid.mjs', 'export const unrelated = true;');
    vi.stubEnv('VIDEO_TTS_PROVIDER', 'local-fixture'); vi.stubEnv('VIDEO_TTS_ADAPTER', file);
    const { loadSynthesizer } = await import('../../../scripts/video/tts');
    await expect(loadSynthesizer()).rejects.toThrow('must export async function synthesize');
  });
});

it('reuses only complete audio with the exact provider request key', async () => {
  const audio = await fixture('source.wav', 'RIFF-complete-cache-fixture');
  const item = temporary.at(-1)!;
  const meta = { cacheKey: 'same-text-voice-model-and-instruction', bytes: Buffer.byteLength('RIFF-complete-cache-fixture'), text: '真实台词' };
  item.files.push(audio + '.json'); await writeFile(audio + '.json', JSON.stringify(meta));
  vi.stubEnv('VIDEO_AUDIO_CACHE_DIRS', JSON.stringify([item.dir]));
  const output = join(item.dir, 'reused.wav');
  item.files.push(output, output + '.json', output + '.partial');
  expect(await reuseAudio('changed-voice-or-text', output)).toBeUndefined();
  expect(await reuseAudio(meta.cacheKey, output)).toEqual(meta);
  expect(await readFile(output)).toEqual(await readFile(audio));
  await writeFile(audio, 'RIFF-truncated');
  expect(await reuseAudio(meta.cacheKey, join(item.dir, 'broken.wav'))).toBeUndefined();
});

it('caps the first video encode and rejects contradictory bitrate settings', () => {
  const settings = encodingSettings({ VIDEO_ENCODER: 'h264_nvenc', VIDEO_REQUIRE_GPU: '1', VIDEO_BITRATE_KBPS: '850', VIDEO_MAXRATE_KBPS: '1200' });
  const options = videoEncodingArgs(settings);
  expect(options.slice(options.indexOf('-b:v'), options.indexOf('-b:v') + 6)).toEqual(['-b:v', '850k', '-maxrate', '1200k', '-bufsize', '2400k']);
  expect(settings.strictGpu).toBe(true);
  expect(() => encodingSettings({ VIDEO_BITRATE_KBPS: '1200', VIDEO_MAXRATE_KBPS: '500' })).toThrow('Invalid VIDEO_MAXRATE_KBPS');
  expect(() => encodingSettings({ VIDEO_AUDIO_KBPS: 'NaN' })).toThrow('Invalid VIDEO_AUDIO_KBPS');
});

it('keeps mandatory judge results before appended commentary and preserves player quotes and facts', async () => {
  const data = { kind: 'sheriff', outcome: 'elected', seat: 1, rows: [{ target: 1, weight: 3 }], conclusion: '1号当选警长。' };
  const player = { sourceSeq: 10, type: 'speech', speaker: '2号', seat: 2, voiceKey: 'seat-2', text: '这是原始玩家发言。', visibility: 'public', data: {} };
  const source: Script = { roomId: 'fixture', perspective: 'god', presetName: '测试', status: 'ended', cast: [], result: null,
    events: [{ sourceSeq: 9, day: 1, phase: 'day', type: 'vote.result', audience: 'public', spoken: true, text: '投票结果。', data }],
    chapters: [{ day: 1, phase: 'day', title: '第1天', entries: [{ sourceSeq: 9, type: 'vote.result', speaker: '法官', voiceKey: 'judge', text: '投票结果。', visibility: 'public', data }, player] }] };
  const file = await fixture('narration.json', JSON.stringify({ roomId: 'fixture', edits: { '9': { reason: '保留结果', after: [{ text: '警徽已经产生。', reason: '依据刚公布的投票' }] } } }));
  vi.stubEnv('VIDEO_NARRATION_FILE', file);
  const edited = await editScript(source), entries = edited.chapters[0].entries;
  expect(entries.map((e) => e.voiceKey)).toEqual(['judge', 'judge', 'commentator', 'seat-2']);
  expect(entries[0].data.replayThrough).toBe(8);
  expect(entries[2].data.replayThrough).toBe(9);
  expect(entries.at(-1)).toEqual(player);
  expect(edited.events).toEqual(source.events);
  const clips = buildClips(edited);
  expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length);
  expect(() => assertPlayerSources(source, edited, clips)).not.toThrow();
  const forged = structuredClone(clips);
  forged.at(-1)!.spokenText = '这是一段从未说过的话。';
  expect(() => assertPlayerSources(source, edited, forged)).toThrow('Spoken text changed');
  const rewritten = structuredClone(clips);
  rewritten.at(-1)!.text = '我换了一个观点。';
  rewritten.at(-1)!.spokenText = '我换了一个观点。';
  expect(() => assertPlayerSources(source, edited, rewritten)).toThrow('Player words changed');
});

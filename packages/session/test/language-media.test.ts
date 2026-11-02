import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { synthesizeQwen } from '../src/speech/qwen';
import { wavHeader } from '../src/speech/audio';
import { replay } from '../../../scripts/video/replay';
import type { Fact, Script } from '../../../scripts/video/project';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('werewolf-language-media-')) throw Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

it('Qwen 请求区分英语、日语及方言提示；缓存不混用，原文和音色不被更改', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-language-media-')); directories.push(directory);
  const bytes = Buffer.concat([wavHeader(1000, 24000), Buffer.alloc(2000)]);
  const inputs: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)); inputs.push(input);
    return new Response(JSON.stringify({ output: { audio: { data: bytes.toString('base64') } } }), { headers: { 'Content-Type': 'application/json' } });
  }));
  const profile = { voice: 'fixture-voice', label: '', instruction: 'Read exactly.', rate: 1 };
  const options = { endpoint: 'https://example.invalid/tts', apiKey: 'fixture-key' };
  const output = join(directory, 'voice.wav');
  const en = await synthesizeQwen('same text {0}', { ...profile, locale: 'en' }, 'fixture', output, options);
  const ja = await synthesizeQwen('same text {0}', { ...profile, locale: 'ja' }, 'fixture', output, options);
  await synthesizeQwen('same text {0}', { ...profile, locale: 'yue-HK', languageHints: ['zh'] }, 'fixture', output, options);
  expect(en.cacheKey).not.toBe(ja.cacheKey);
  expect(inputs.map((input) => input.language_hints)).toEqual([['en'], ['ja'], ['zh']]);
  expect(inputs.every((input) => input.text === 'same text {0}' && input.voice === 'fixture-voice')).toBe(true);
});

it('视频仅从当前事实前缀恢复具体死因，旧记录缺少原因时不猜测', () => {
  const fact = (sourceSeq: number, type: string, data: Fact['data']): Fact => ({ sourceSeq, day: 1, phase: 'day', type, data, text: '', audience: 'public', spoken: false });
  const script: Script = { roomId: 'fixture', perspective: 'god', presetName: 'fixture', status: 'ended', cast: [1, 2, 3, 4, 5, 6].map((seat) => ({ seat, name: String(seat), role: 'villager', roleName: '村人', factionName: '好人', voiceKey: 'seat-' + seat })), chapters: [], result: null, events: [
    fact(1, 'phase', {}),
    fact(2, 'night.resolution', { deaths: [{ seat: 1, causes: ['poison'] }, { seat: 2, causes: ['wolf', 'poison'] }, { seat: 6 }] }),
    fact(3, 'dawn', { deaths: [1, 2, 6] }),
    fact(4, 'exile', { seat: 3 }),
    fact(5, 'hunter.shot', { target: 4 }),
    fact(6, 'explode', { seat: 5 }),
  ] };
  expect(replay(script, 1).deaths.size).toBe(0);
  expect(replay({ ...script, perspective: 'seat' }, 2).deaths.size).toBe(0);
  expect([...replay({ ...script, perspective: 'seat' }, 3).deaths.values()]).toEqual([['night'], ['night'], ['night']]);
  const night = replay(script, 2);
  expect(night.deaths.get(1)).toEqual(['poison']); expect(night.deaths.get(2)).toEqual(['wolf', 'poison']);
  expect(night.deaths.get(6)).toEqual(['night']); expect(night.alive.has(5)).toBe(true);
  expect([...replay(script, 6).deaths.values()]).toEqual([['poison'], ['wolf', 'poison'], ['night'], ['exile'], ['shot'], ['explode']]);
});

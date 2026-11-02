import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { synthesizeQwen } from '../src/speech/qwen';
import { wavHeader } from '../src/speech/audio';
import { SecretBox } from '../src/secret';
import { projectQwenTokenPlanKey } from '../src/project-models';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !basename(dir).startsWith('werewolf-qwen-seed-')) throw Error('Test directory is outside its temporary workspace');
    await rm(dir, { recursive: true, force: true });
  }
});

it('preserves the legacy default request key and varies only the seed for an explicit retake', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-qwen-seed-')); directories.push(dir);
  vi.stubEnv('WEREWOLF_TTS_API_KEY', 'sk-sp-fixture-not-a-real-key'); vi.stubEnv('VIDEO_AUDIO_CACHE_DIRS', '');
  const audio = Buffer.concat([wavHeader(1000, 24000), Buffer.alloc(2000)]);
  const send = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body)).input;
    return new Response(JSON.stringify({ output: { audio: { data: audio.toString('base64') }, original_text: input.text,
      sentence: { index: 0, words: [{ text: input.text, begin_time: 0, end_time: 40 }] } } }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', send);
  const profile = { voice: 'fixture-voice', label: '', rate: 1, instruction: '原指令' };
  const input = { text: '测试。', voice: profile.voice, format: 'wav', sample_rate: 24000, rate: 1,
    instruction: profile.instruction, language_hints: ['zh'], word_timestamp_enabled: true, seed: 31415 };
  const expected = createHash('sha256').update(JSON.stringify({ model: 'fixture-model', input })).digest('hex');
  const output = join(dir, 'voice.wav');
  const first = await synthesizeQwen('测试。', profile, 'fixture-model', output);
  expect(first.cacheKey).toBe(expected);
  expect((await synthesizeQwen('测试。', profile, 'fixture-model', output)).cacheKey).toBe(expected);
  expect(send).toHaveBeenCalledTimes(1);
  const next = await synthesizeQwen('测试。', { ...profile, seed: 31416 }, 'fixture-model', output);
  expect(next.cacheKey).not.toBe(first.cacheKey); expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(send.mock.calls[1][1]?.body)).input).toEqual({ ...input, seed: 31416 });
});

it('rejects an invalid seed before accessing credentials or the network', async () => {
  const send = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', send);
  await expect(synthesizeQwen('测试。', { voice: '', label: '', instruction: '', rate: 1, seed: NaN }, '', 'unused.wav')).rejects.toThrow('Invalid Qwen synthesis seed');
  expect(send).not.toHaveBeenCalled();
});

it('默认凭据只读项目加密库，并且不会读取或生成外部全局配置与新主密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-qwen-seed-')); directories.push(dir);
  vi.stubEnv('WEREWOLF_DATA', dir); vi.stubEnv('WEREWOLF_SECRET', '');
  vi.stubEnv('WEREWOLF_QWEN_SETTINGS', join(dir, 'unread-global.json'));
  const key = 'sk-sp-project-fixture-only', secrets = SecretBox.fromEnvOrFile(dir);
  const master = await readFile(join(dir, 'secret.key'), 'utf8');
  await writeFile(join(dir, 'models.json'), JSON.stringify({ version: 2, models: [{ baseUrl: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1', apiKeyEnc: secrets.encrypt(key) }] }));
  expect(projectQwenTokenPlanKey()).toBe(key);
  expect(await readFile(join(dir, 'secret.key'), 'utf8')).toBe(master);
  await rm(join(dir, 'secret.key'));
  expect(projectQwenTokenPlanKey()).toBeUndefined();
});

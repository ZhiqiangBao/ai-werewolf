import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

it('reuses only intact matching references and preserves the last successful files on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-reference-test-'));
  const referenceDir = join(directory, 'voice-references');
  const log = join(directory, 'requests.json');
  const manifestFile = join(referenceDir, 'manifest.json');
  const wavFile = join(referenceDir, 'seat-1.wav');
  const mock = pathToFileURL(resolve('packages/session/test/fixtures/voice-reference-fetch.mjs')).href;
  const model = 'qwen-audio-3.0-tts-plus';
  const profiles = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
    `seat-${index + 1}`,
    { voice: `${model}-voice${index + 1}`, label: `seat-${index + 1}`, rate: 0.81 + index / 100, instruction: `自定义表演 ${index + 1}` },
  ]));
  const command = ['--import', 'tsx', '--import', mock, resolve('scripts/video/generate-voice-references.ts'),
    `--project-dir=${directory}`, '--theme=gufeng', '--endpoint=https://voice-test.invalid/synthesis', '--api-key-env=REFERENCE_TEST_KEY'];
  const env = { ...process.env, REFERENCE_TEST_KEY: 'synthetic-key', WEREWOLF_REFERENCE_TEST_REQUESTS: log,
    VIDEO_AUDIO_CACHE_DIRS: JSON.stringify([referenceDir]) };
  const run = (extra: string[] = [], fail = false) => promisify(execFile)(process.execPath, [...command, ...extra], {
    env: { ...env, WEREWOLF_REFERENCE_TEST_FAIL: fail ? '1' : '0' }, windowsHide: true,
  });
  const requests = async () => JSON.parse(await readFile(log, 'utf8')) as Array<{ model: string; input: Record<string, unknown> }>;
  const manifest = async () => JSON.parse(await readFile(manifestFile, 'utf8'));
  const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  try {
    await writeFile(log, '[]');
    await writeFile(join(directory, 'voices.json'), JSON.stringify({ theme: 'gufeng', model, profiles }));
    const firstText = '--text=第一段参考文本';
    const secondText = '--text=更换后的参考文本';
    await run([firstText]);
    let sent = await requests();
    expect(sent).toHaveLength(12);
    for (let index = 0; index < 12; index++) {
      const profile = profiles[`seat-${index + 1}`];
      expect(sent[index]).toMatchObject({ model, input: { text: '第一段参考文本', voice: profile.voice, rate: profile.rate, instruction: profile.instruction } });
      expect((await manifest()).references[`seat-${index + 1}`]).toMatchObject({ rate: profile.rate, instruction: profile.instruction });
    }
    const initial = await readFile(wavFile);
    await run([firstText]);
    expect(await requests()).toHaveLength(12);
    expect(await readFile(wavFile)).toEqual(initial);

    await run([secondText]);
    sent = await requests();
    expect(sent).toHaveLength(24);
    expect(sent.slice(12).every(request => request.input.text === '更换后的参考文本')).toBe(true);
    const valid = await readFile(wavFile);
    const damaged = Buffer.from(valid);
    damaged[100] ^= 0xff;
    await writeFile(wavFile, damaged);
    expect(damaged).toHaveLength(valid.length);
    await run([secondText]);
    expect(await requests()).toHaveLength(25);
    const repaired = await readFile(wavFile);
    expect(repaired).not.toEqual(damaged);
    expect((await manifest()).references['seat-1']).toMatchObject({ bytes: repaired.length, sha256: sha256(repaired) });

    await run([secondText, '--force']);
    expect(await requests()).toHaveLength(37);
    const beforeFailure = await readFile(wavFile);
    const metadataBeforeFailure = await readFile(`${wavFile}.json`);
    const manifestBeforeFailure = await readFile(manifestFile);
    await expect(run([secondText, '--force'], true)).rejects.toThrow('Qwen TTS 503');
    expect(await requests()).toHaveLength(38);
    expect(await readFile(wavFile)).toEqual(beforeFailure);
    expect(await readFile(`${wavFile}.json`)).toEqual(metadataBeforeFailure);
    expect(await readFile(manifestFile)).toEqual(manifestBeforeFailure);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

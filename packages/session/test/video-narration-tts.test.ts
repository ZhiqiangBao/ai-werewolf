import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeNarration } from '../../../scripts/video/synthesize-narration';
import { wavHeader } from '../../../scripts/video/audio';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
it('keeps independent scripts and tagged request text separate, reuses only matching audio, and preserves word times', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'narration-test-')); dirs.push(dir);
  const source = Buffer.from(JSON.stringify({ roomId: 'synthetic-room' })), hash = createHash('sha256').update(source).digest('hex');
  await writeFile(join(dir, 'source.json'), source);
  const selection = (text: string, delivery?: unknown) => ({ roomId: 'synthetic-room', sourceSha256: hash, reviewed: true, items: [{ kind: 'narration', id: 'clip', text, afterSourceSeq: 1, delivery }] });
  await writeFile(join(dir, 'one.json'), JSON.stringify(selection('Hello world.', { segments: [{ text: 'Hello ', tag: 'curious' }, { text: 'world.', tag: 'serious' }] })));
  await writeFile(join(dir, 'two.json'), JSON.stringify(selection('Hello world.')));
  const job = { sourceProject: '.', outputDir: 'out', scripts: [{ id: 'short', scriptFile: 'one.json' }, { id: 'full', scriptFile: 'two.json' }], tts: { route: 'dashscope', model: 'synthetic-model', voice: 'voice', locale: 'en-US', rate: 1, instruction: '' } };
  const jobFile = join(dir, 'job.json'); await writeFile(jobFile, JSON.stringify(job));
  const calls: string[] = []; const endpoints: (string | undefined)[] = [];
  const synthesize: NonNullable<NonNullable<Parameters<typeof synthesizeNarration>[2]>['synthesize']> = async (text, profile, model, output, options) => {
    calls.push(text); endpoints.push(options?.endpoint); const samples = Buffer.alloc(48000); for (let i = 0; i < 24000; i++) samples.writeInt16LE(Math.round(Math.sin(i * .07) * 5000), i * 2);
    const audio = Buffer.concat([wavHeader(24000, 24000), samples]); await writeFile(output, audio); await writeFile(output + '.json', '{}');
    return { cacheKey: 'synthetic', model, voice: profile.voice, text, bytes: audio.length, sentences: [{ index: 0, text, words: [...(text.includes('[curious]') ? [{ text: '[curious]', begin_time: 0, end_time: 1 }] : []), { text: 'Hello ', begin_time: 80, end_time: 300 }, ...(text.includes('[serious]') ? [{ text: '[serious]', begin_time: 300, end_time: 301 }] : []), { text: 'world.', begin_time: 400, end_time: 850 }] }] };
  };
  expect((await synthesizeNarration(jobFile, true, { synthesize })).map((r: any) => r.status)).toEqual(['pending', 'pending']);
  await synthesizeNarration(jobFile, false, { synthesize }); expect(calls).toEqual(['[curious]Hello [serious]world.', 'Hello world.']); expect(endpoints).toEqual([
    'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer',
    'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer'
  ]); expect((await readdir(join(dir, 'out/short'))).some(name => name.includes('-candidate-'))).toBe(false);
  const manifest = JSON.parse(await readFile(join(dir, 'out/short/narration-manifest.json'), 'utf8'));
  const meta = JSON.parse(await readFile(join(dir, 'out/short', manifest.clips[0].audioFile + '.json'), 'utf8'));
  expect(meta.text).toBe('Hello world.'); expect(meta.sentences[0].words.map((w: any) => w.begin_time)).toEqual([80, 400]);
  await synthesizeNarration(jobFile, false, { synthesize }); expect(calls).toHaveLength(2);
  await writeFile(join(dir, 'out/short', manifest.clips[0].audioFile + '.json'), '{broken');
  expect((await synthesizeNarration(jobFile, true, { synthesize }) as any[])[0].status).toBe('invalid-cache');
  await expect(synthesizeNarration(jobFile, false, { synthesize })).rejects.toThrow('Invalid existing cache');
  await writeFile(join(dir, 'out/short', manifest.clips[0].audioFile + '.json'), JSON.stringify(meta));
  job.tts.voice = 'other'; await writeFile(jobFile, JSON.stringify(job)); await synthesizeNarration(jobFile, false, { synthesize }); expect(calls).toHaveLength(4);
});
it('rejects inconsistent delivery and stops immediately on provider errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'narration-test-')); dirs.push(dir); const source = Buffer.from('{"roomId":"r"}'); await writeFile(join(dir, 'source.json'), source);
  const selection = { roomId: 'r', sourceSha256: createHash('sha256').update(source).digest('hex'), reviewed: true, items: [{ kind: 'narration', id: 'clip', text: 'Hello world.', afterSourceSeq: 1, delivery: { segments: [{ text: 'changed' }] } }] };
  await writeFile(join(dir, 'script.json'), JSON.stringify(selection)); const jobFile = join(dir, 'job.json'); await writeFile(jobFile, JSON.stringify({ sourceProject: '.', outputDir: 'out', scripts: [{ id: 's', scriptFile: 'script.json' }], tts: { route: 'token-plan', model: 'm', voice: 'v', locale: 'en-US', rate: 1, instruction: '' } }));
  await expect(synthesizeNarration(jobFile, true)).rejects.toThrow('segments');
  delete (selection.items[0] as any).delivery; await writeFile(join(dir, 'script.json'), JSON.stringify(selection)); let count = 0;
  await expect(synthesizeNarration(jobFile, false, { synthesize: async () => { count++; throw Error('HTTP 429'); } })).rejects.toThrow('429'); expect(count).toBe(1);
});

it('rejects unknown configuration fields and mismatched cloned voices without revealing their values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'narration-test-')); dirs.push(dir);
  const file = join(dir, 'job.json');
  const job: any = { sourceProject: '.', outputDir: 'out', scripts: [{ id: 's', scriptFile: 'script.json' }], tts: { route: 'dashscope', model: 'qwen-audio-3.1-tts-flash', voice: 'qwen-audio-3.0-tts-plus-example', locale: 'en-US', rate: 1, instruction: '' } };
  await writeFile(file, JSON.stringify(job)); await expect(synthesizeNarration(file, true)).rejects.toThrow('incompatible');
  job.tts.voice = 'longanlingxin_v3.1';
  for (const target of [job, job.tts, job.scripts[0]]) {
    target.apiKey = 'sensitive-literal'; await writeFile(file, JSON.stringify(job));
    await expect(synthesizeNarration(file, true)).rejects.toThrow(/Unknown .* configuration field/); delete target.apiKey;
  }
  job.asr = { provider: 'qwen-token-plan', enabled: true, apiKey: 'sensitive-literal' };
  await writeFile(file, JSON.stringify(job)); await expect(synthesizeNarration(file, true)).rejects.toThrow('Unknown ASR configuration field');
});

it('retains rejected waveform candidates for review but removes the successful candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'narration-test-')); dirs.push(dir);
  const source = Buffer.from('{"roomId":"r"}'); await writeFile(join(dir, 'source.json'), source);
  const script = { roomId: 'r', sourceSha256: createHash('sha256').update(source).digest('hex'), reviewed: true, items: [{ kind: 'narration', id: 'clip', text: 'Hello world.', afterSourceSeq: 1 }] };
  await writeFile(join(dir, 'script.json'), JSON.stringify(script));
  const jobFile = join(dir, 'job.json'); await writeFile(jobFile, JSON.stringify({ sourceProject: '.', outputDir: 'out', scripts: [{ id: 's', scriptFile: 'script.json' }], tts: { route: 'token-plan', model: 'qwen-audio-3.0-tts-plus', voice: 'qwen-audio-3.0-tts-plus-clone', locale: 'en-US', rate: 1, instruction: '' } }));
  let attempts = 0;
  await synthesizeNarration(jobFile, false, { synthesize: async (text, profile, model, output) => {
    attempts++; const samples = Buffer.alloc(48000); if (attempts === 2) for (let i = 0; i < 24000; i++) samples.writeInt16LE(Math.round(Math.sin(i * .07) * 5000), i * 2);
    const audio = Buffer.concat([wavHeader(24000, 24000), samples]); await writeFile(output, audio); await writeFile(output + '.json', '{}');
    return { cacheKey: 'x', model, voice: profile.voice, text, bytes: audio.length, sentences: [{ index: 0, text, words: [{ text: 'Hello ', begin_time: 80, end_time: 300 }, { text: 'world.', begin_time: 400, end_time: 850 }] }] };
  } });
  expect(attempts).toBe(2); const files = await readdir(join(dir, 'out/s'));
  expect(files.some(f => f.endsWith('-candidate-1.wav'))).toBe(true); expect(files.some(f => f.endsWith('-candidate-2.wav'))).toBe(false);
  expect(files.some(f => f.endsWith('.needs-review.json'))).toBe(true);
});

it('rejects misspelled CLI flags before opening a job or contacting a service', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../../scripts/video/synthesize-narration.ts', import.meta.url)), '--job=missing.json', '--check-only=true'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Usage:');
  expect(result.stderr).not.toContain('ENOENT');
});

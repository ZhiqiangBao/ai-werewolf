import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { inspectAudio } from '../../../scripts/video/audio-inspection';
import { auditAudio, audioDigest } from '../../../scripts/video/audit-audio';
import { repairAudio } from '../../../scripts/video/repair-audio';
import { wavHeader } from '../../../scripts/video/audio';
import { buildClips, clipVoiceProfile, type Script } from '../../../scripts/video/project';
import type { SpeechSynthesizer } from '../../../scripts/video/tts-types';

const rate = 24000, directories: string[] = [];
function voice() { return Int16Array.from({ length: rate * 2 }, (_, i) => Math.round(5000 * Math.sin(i * 2 * Math.PI * 173 / rate))); }
function damaged(gain = 1) {
  const samples = voice();
  // The observed defect was a 0.5–0.7s negative plateau with one-LSB dither.
  for (let i = rate; i < rate * 1.6; i++) samples[i] = Math.round((-32767 - i % 2) * gain);
  return samples;
}
function wav(samples: Int16Array) {
  const pcm = Buffer.alloc(samples.length * 2); samples.forEach((n, i) => pcm.writeInt16LE(n, i * 2));
  return Buffer.concat([wavHeader(samples.length, rate), pcm]);
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-audio-inspection-')); directories.push(dir);
  await mkdir(join(dir, 'audio'));
  const entries = [1, 2].map((seat) => ({ sourceSeq: seat, type: 'speech', speaker: `${seat}号`, voiceKey: `seat-${seat}`, seat, text: '测试发言。', visibility: 'public', data: {} }));
  const script: Script = { roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended', cast: [], events: [], result: null,
    chapters: [{ day: 1, phase: 'day', title: '第1天', entries }] };
  const clips = buildClips(script).map((c) => ({ ...c, audioFile: join(dir, 'audio', `${c.id}.wav`) }));
  for (const [i, c] of clips.entries()) {
    const bytes = wav(i ? voice() : damaged());
    const meta = { cacheKey: `original-${i}`, model: 'fixture', voice: `fixed-${i + 1}`, text: c.spokenText, bytes: bytes.length,
      sentences: [{ index: 0, text: c.spokenText, words: [{ text: c.spokenText, begin_time: 100, end_time: 1500 }] }] };
    await writeFile(c.audioFile, bytes); await writeFile(c.audioFile + '.json', JSON.stringify(meta));
  }
  for (const [name, value] of Object.entries({ 'source.json': script, 'script.json': script, 'clips.json': clips,
    'voices.json': { model: 'fixture', profiles: Object.fromEntries([1, 2].map((n) => [`seat-${n}`, { voice: `fixed-${n}`, label: '', rate: 1, instruction: '原指令' }])) } })) {
    await writeFile(join(dir, name), JSON.stringify(value));
  }
  return { dir, clips };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !basename(dir).startsWith('werewolf-audio-inspection-')) throw Error('Test directory is outside its temporary workspace');
    await rm(dir, { recursive: true, force: true });
  }
});

describe('audio defect detection calibrated against held-sample failures', () => {
  it.each([1, .65, .3])('finds the held-sample defect even after gain %s hides the clipped peak', (gain) => {
    const issues = inspectAudio(damaged(gain), rate).issues;
    expect(issues.some((e) => e.kind === 'dc-flatline' && e.start <= 1.001 && e.end >= 1.599)).toBe(true);
  });
  it('accepts voiced audio with an isolated full-scale peak and ordinary silent pauses', () => {
    const samples = voice(); samples[100] = 32767; samples[101] = 32767;
    samples.fill(0, 5000, 8000);
    expect(inspectAudio(samples, rate).issues).toEqual([]);
  });
  it('finds repeated hard clipping without emitting a separate report row for every pitch cycle', () => {
    const samples = Int16Array.from(voice(), (_, i) => Math.max(-32768, Math.min(32767, Math.round(60000 * Math.sin(i * 2 * Math.PI * 90 / rate)))));
    const issues = inspectAudio(samples, rate).issues;
    expect(issues.some((e) => e.kind === 'clipping')).toBe(true);
    expect(issues.length).toBeLessThan(5);
  });
  it('flags an empty voice track while accepting a valid streaming WAV declaration', () => {
    expect(inspectAudio(new Int16Array(rate), rate).issues[0].kind).toBe('silent');
    expect(() => inspectAudio(new Int16Array(), rate)).toThrow('non-empty');
  });
});

describe('selective fresh-seed repair', () => {
  it('automatically repairs only the detected clip, rejects another bad take and persists the accepted seed', async () => {
    const { dir, clips } = await fixture(), before = await auditAudio(dir, join(dir, 'output/before.json'), false);
    expect(before.failedClipIds).toEqual([clips[0].id]);
    const original = await readFile(clips[0].audioFile), healthy = await readFile(clips[1].audioFile);
    const synthesize = vi.fn<SpeechSynthesizer>(async (text, profile, model, output) => {
      const bytes = wav(profile.seed === 31416 ? damaged() : voice()); await writeFile(output, bytes);
      return { cacheKey: `take-${profile.seed}`, model, voice: profile.voice, text, bytes: bytes.length,
        sentences: [{ index: 0, text, words: [{ text, begin_time: 100, end_time: 1500 }] }] };
    });
    const report = await repairAudio(dir, { auto: true, audit: before, synthesize });
    expect(report.complete).toBe(true); expect(synthesize).toHaveBeenCalledTimes(2);
    expect(report.entries[0].seed).toBe(31417);
    expect(await readFile(report.entries[0].backup!)).toEqual(original);
    expect(await readFile(clips[1].audioFile)).toEqual(healthy);
    expect((await auditAudio(dir, join(dir, 'output/after.json'), false)).failedClipIds).toEqual([]);
    const catalog = JSON.parse(await readFile(join(dir, 'voices.json'), 'utf8'));
    expect(clipVoiceProfile(catalog, clips[0])).toMatchObject({ seed: 31417, voice: 'fixed-1', instruction: '原指令', rate: 1 });
  });
  it('keeps the original audio and settings if every generated take still has an error', async () => {
    const { dir, clips } = await fixture(), original = await readFile(clips[0].audioFile), settings = await readFile(join(dir, 'voices.json'));
    const synthesize: SpeechSynthesizer = async (text, p, model, output) => {
      const bytes = wav(damaged()); await writeFile(output, bytes);
      return { cacheKey: '', model, voice: p.voice, text, bytes: bytes.length, sentences: [] };
    };
    const report = await repairAudio(dir, { auto: true, maxAttempts: 2, synthesize });
    expect(report.complete).toBe(false);
    expect(await readFile(clips[0].audioFile)).toEqual(original);
    expect(await readFile(join(dir, 'voices.json'))).toEqual(settings);
  });
  it('rejects stale audit data before calling the external service', async () => {
    const { dir, clips } = await fixture(), audit = await auditAudio(dir, join(dir, 'output/before.json'), false);
    await writeFile(clips[0].audioFile, wav(voice()));
    const synthesize = vi.fn<SpeechSynthesizer>();
    await expect(repairAudio(dir, { auto: true, audit, synthesize })).rejects.toThrow('Stale audio audit');
    expect(synthesize).not.toHaveBeenCalled();
    expect(audioDigest(await readFile(clips[0].audioFile))).not.toBe(audit.clips[0].digest);
  });
});

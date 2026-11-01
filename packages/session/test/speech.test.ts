import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { SpeechService } from '../src/speech';
import { wavHeader } from '../../../scripts/video/audio';
import type { SpeechSynthesizer } from '../../../scripts/video/tts-types';

const directories: string[] = [];
async function directory() {
  const d = await mkdtemp(join(tmpdir(), 'werewolf-live-speech-')); directories.push(d); return d;
}
afterEach(async () => {
  for (const d of directories.splice(0)) {
    if (!resolve(d).startsWith(resolve(tmpdir()) + sep) || !d.includes('werewolf-live-speech-')) throw Error('测试目录越界');
    await rm(d, { recursive: true, force: true });
  }
});
const synthesize = vi.fn<SpeechSynthesizer>(async (text, profile, model, output) => {
  await mkdir(dirname(output), { recursive: true });
  const header = wavHeader(3, 24000); header.writeUInt32LE(0x7fffffff, 4); header.writeUInt32LE(0x7fffffff, 40);
  await writeFile(output, Buffer.concat([header, Buffer.from([1, 0, 2, 0, 3, 0])]));
  return { cacheKey: 'fixture', model, voice: profile.voice, text, sentences: [], bytes: 50 };
});

describe('网页朗读音频服务', () => {
  it('合并多页面同时请求同一条发言，并修正流式 WAV 长度', async () => {
    synthesize.mockClear();
    const service = new SpeechService(await directory(), synthesize);
    const [a, b] = await Promise.all([service.render('2号发言。测试。'), service.render('2号发言。测试。')]);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.readUInt32LE(4)).toBe(a.length - 8);
    expect(a.readUInt32LE(40)).toBe(6);
    expect(a.readUInt32LE(24)).toBe(24000);
    expect([...a.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);
  });
  it('提供方失败后允许重试，坏音频不会作为成功结果返回', async () => {
    const fake = vi.fn<SpeechSynthesizer>().mockRejectedValueOnce(new Error('fixture failure'))
      .mockImplementationOnce(async (text, profile, model, output) => {
        await writeFile(output, 'invalid wav');
        return { cacheKey: '', model, voice: profile.voice, text, sentences: [], bytes: 11 };
      }).mockImplementation(synthesize);
    const service = new SpeechService(await directory(), fake);
    await expect(service.render('发言')).rejects.toThrow('fixture failure');
    await expect(service.render('发言')).rejects.toThrow('Not a WAV');
    expect((await service.render('发言')).toString('ascii', 0, 4)).toBe('RIFF');
    expect(fake).toHaveBeenCalledTimes(3);
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAudioAlignment, effectiveAudioAlignment, saveAudioAlignment } from '../../../scripts/video/audio-alignment';

type Token = { text: string; begin_time: number; end_time: number; punctuation?: string };
const token = (text: string, begin_time: number, end_time: number): Token => ({ text, begin_time, end_time });
function input(text: string, words: Token[], locale = 'en') {
  const audio = Buffer.alloc(44 + 16000 * 2 * 3);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  const metadata = Buffer.from(JSON.stringify({ text, bytes: audio.length, sentences: [] }));
  const response = { rawAudioSha256: createHash('sha256').update(audio).digest('hex'), sourcePromptProvided: false,
    model: 'synthetic', result: { output: { sentence: { text, words } } } };
  return { audio, metadata, locale, response };
}
const align = (x: ReturnType<typeof input>) => createAudioAlignment({ ...x, asrResponse: JSON.stringify(x.response) });

describe('external ASR token alignment', () => {
  it.each([
    ['en', "Hello, world!", [token(' ', 5, 20), token('Hello', 25, 180), token(',', 180, 200), token(' ', 200, 240), token('world', 250, 480), token('!', 480, 500), token(' ', 500, 510)]],
    ['ja', 'こんにちは、世界。', [token('こんにちは', 10, 210), token('、', 210, 230), token(' ', 230, 260), token('世界', 270, 480), token('。', 480, 500)]],
    ['en', "Don't go.", [token('Don', 10, 100), token("'", 100, 120), token('t', 120, 150), token(' ', 150, 170), token('go', 180, 320), token('.', 320, 340)]],
  ])('preserves actual word boundaries and source for %s', (locale, text, words) => {
    const result = align(input(text, words, locale));
    expect(result.words.map((word) => word.text).join('')).toBe(text);
    expect(result.words[0].begin_time).toBe(words.find((word) => /[\p{L}\p{N}]/u.test(word.text))!.begin_time);
    expect(result.words.at(-1)!.end_time).toBe(words.filter((word) => /[\p{L}\p{N}]/u.test(word.text)).at(-1)!.end_time);
    expect(result.wordTimesSha256).toBe(createHash('sha256').update(JSON.stringify(words)).digest('hex'));
  });
  it('rejects omitted and extra lexical tokens, changed numbers, invalid ordering and bounds', () => {
    const base = [token('seat', 10, 100), token(' ', 100, 110), token('two', 120, 240)];
    for (const words of [base.slice(0, 2), [...base, token('extra', 250, 300)], [base[0], base[1], token('three', 120, 240)], [base[0], token(' ', 100, 4000), base[2]], [base[0], token(' ', 5, 110), base[2]]]) {
      expect(() => align(input('seat two', words))).toThrow();
    }
  });
  it('rejects uniform raw timestamps even when some tokens are whitespace', () => {
    const words = Array.from({ length: 21 }, (_, i) => token(i % 2 ? ' ' : 'a', i * 50, (i + 1) * 50));
    expect(() => align(input(words.map((w) => w.text).join(''), words))).toThrow(/uniformly spaced/);
  });
  it('recomputes sidecar bindings and rejects tampering with skipped tokens', async () => {
    const x = input('Hello world', [token('Hello', 10, 110), token(' ', 110, 130), token('world', 140, 300)]);
    const dir = await mkdtemp(join(tmpdir(), 'asr-token-'));
    try {
      const file = join(dir, 'audio.wav');
      await writeFile(file, x.audio); await writeFile(`${file}.json`, x.metadata);
      const saved = await saveAudioAlignment(file, JSON.stringify(x.response), x.locale);
      const checked = await effectiveAudioAlignment(file, JSON.parse(x.metadata.toString()), x.locale);
      expect(checked.summary?.wordTimesSha256).toBe(saved.wordTimesSha256);
      const sidecar = JSON.parse(await readFile(`${file}.alignment.json`, 'utf8'));
      sidecar.asrResponse = sidecar.asrResponse.replace('"end_time":130', '"end_time":131');
      await writeFile(`${file}.alignment.json`, JSON.stringify(sidecar));
      await expect(effectiveAudioAlignment(file, JSON.parse(x.metadata.toString()), x.locale)).rejects.toThrow(/changed or is stale/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

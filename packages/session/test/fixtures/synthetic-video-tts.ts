// Deterministic test signal and synthetic timings; never used as real speech.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { wavHeader } from '../../../../scripts/video/audio';
import type { SpeechSynthesizer } from '../../src/speech/types';

/** A reproducible test-only signal encodes both source sequence and speaker seat. */
export function syntheticTone(text: string, sourceSeq: number, seat: number) {
  const textHash = createHash('sha256').update(text).digest().readUInt16BE(0) % 599;
  return 300 + ((sourceSeq * 131 + seat * 67 + textHash) % 600) * 8;
}

export const synthesize: SpeechSynthesizer = async (text, profile, model, output) => {
  const samples = 28800, pcm = Buffer.alloc(samples * 2);
  await mkdir(dirname(output), { recursive: true });
  const sourceSeq = Number(/^\d+/.exec(basename(output))?.[0]), seat = Number(/^(\d+)号/.exec(profile.label)?.[1] ?? 0);
  if (!Number.isInteger(sourceSeq) || sourceSeq < 1) throw Error('Synthetic tone needs a source sequence');
  const frequency = syntheticTone(text, sourceSeq, seat);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * frequency * i / 24000)), i * 2);
  await writeFile(output, Buffer.concat([wavHeader(samples, 24000), pcm]));
  const meta = { cacheKey: `synthetic-${text}`, provider: 'synthetic-test', model, voice: profile.voice, text, bytes: pcm.length + 44,
    sentences: [{ index: 0, text, words: [{ text, begin_time: 10, end_time: 1100 }] }] };
  await writeFile(`${output}.json`, JSON.stringify(meta));
  return meta;
};

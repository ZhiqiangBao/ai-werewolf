import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const log = process.env.WEREWOLF_REFERENCE_TEST_REQUESTS;
if (!log) throw Error('Missing synthetic reference request log');

globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://voice-test.invalid/synthesis');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
  const requests = JSON.parse(await readFile(log, 'utf8'));
  requests.push(JSON.parse(options.body));
  await writeFile(log, JSON.stringify(requests));
  if (process.env.WEREWOLF_REFERENCE_TEST_FAIL === '1') return new Response(null, { status: 503 });

  // A valid mono 16-bit PCM WAV, with different audio bytes for each request.
  const dataSize = 2048;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(requests.length * 100, offset);
  return new Response(wav, { headers: { 'content-type': 'audio/wav' } });
};

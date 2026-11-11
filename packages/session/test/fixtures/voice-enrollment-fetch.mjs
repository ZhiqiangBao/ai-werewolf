import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const file = process.env.WEREWOLF_VOICE_TEST_REQUESTS;
if (!file) throw Error('Missing synthetic voice request log');
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://voice-test.invalid/customization');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key');
  const body = JSON.parse(options.body);
  const requests = JSON.parse(await readFile(file, 'utf8'));
  requests.push(body);
  await writeFile(file, JSON.stringify(requests));
  return Response.json(body.input.action === 'create_voice'
    ? { output: { voice_id: `${body.input.target_model}-vd-portrait`, preview_audio: { data: Buffer.from('RIFF-test-preview').toString('base64') } } }
    : { output: { status: 'OK' } });
};

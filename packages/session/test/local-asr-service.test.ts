import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = path.resolve('scripts/asr/service.mjs');
let data: string;
let port: number;
let token: string;
const command = (action: string, extra: string[] = [], targetPort = port) => exec(process.execPath,
  [script, action, '--data-dir', data, '--port', String(targetPort), ...extra], { timeout: 30000, env: { ...process.env, WEREWOLF_ASR_MODEL_DIR: path.join(data, 'configured-model') } });
const url = (endpoint: string) => `http://127.0.0.1:${port}${endpoint}`;
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' });

function wav(seconds = 1) {
  const rate = 8000;
  const size = rate * seconds * 2;
  const b = Buffer.alloc(44 + size);
  b.write('RIFF', 0); b.writeUInt32LE(36 + size, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40);
  return b;
}

async function availablePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => s.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = s.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const result = address.port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return result;
}

describe('isolated local ASR service', () => {
  beforeAll(async () => {
    data = await mkdtemp(path.join(os.tmpdir(), 'werewolf-asr-test-'));
    await mkdir(path.join(data, 'local-asr'));
    await writeFile(path.join(data, 'local-asr', 'TEST-ONLY'), 'isolated test backend\n');
    port = await availablePort();
    await command('start', ['--test-backend']);
    token = JSON.parse(await readFile(path.join(data, 'local-asr', 'service-control.json'), 'utf8')).token;
  }, 45000);

  afterAll(async () => {
    if (data && port) await command('stop').catch(() => {});
    if (data) await rm(data, { recursive: true, force: true });
  }, 30000);

  it('authenticates every endpoint and does not allow prompt or arbitrary fields', async () => {
    for (const [endpoint, method] of [['/health', 'GET'], ['/shutdown', 'POST'], ['/v1/transcribe', 'POST']] as const) {
      expect((await fetch(url(endpoint), { method })).status).toBe(401);
    }
    expect((await fetch(url('/v1/transcribe?prompt=hello'), { method: 'POST', headers: headers(), body: wav() })).status).toBe(404);
    expect((await fetch(url('/v1/transcribe'), { method: 'POST', headers: { ...headers(), 'X-Prompt': 'secret' }, body: wav() })).status).toBe(400);
    expect((await fetch(url('/v1/transcribe'), { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{"prompt":"secret"}' })).status).toBe(415);
    expect((await fetch(url('/v1/transcribe'), { method: 'POST', headers: { ...headers(), 'X-ASR-Language': 'fr' }, body: wav() })).status).toBe(400);
    const health = await (await fetch(url('/health'), { headers: headers() })).json();
    expect(health).toMatchObject({ status: 'ready', model: { backend: 'test' }, runtime: { device: 'test' }, offlineGuard: { denied: 0 } });
  });

  it('uses settings while explicit environment and CLI values take precedence', async () => {
    const settings = path.join(data, 'local-asr', 'service-settings.json');
    const original = JSON.parse(await readFile(path.join(data, 'local-asr', 'service-state.json'), 'utf8')).configuration;
    await writeFile(settings, JSON.stringify({ backend: 'gguf', device: 'gpu', modelDir: path.join(data, 'another-model'), python: path.join(data, 'another-python') }));
    try {
      await expect(command('start', ['--test-backend'])).rejects.toThrow(/different settings/);
      const override = await command('start', ['--test-backend', '--backend', 'transformers', '--python', original.python]);
      expect(JSON.parse(override.stdout).status).toBe('ready');
      const env = { ...process.env, WEREWOLF_ASR_MODEL_DIR: path.join(data, 'configured-model'), WEREWOLF_ASR_BACKEND: 'transformers', WEREWOLF_ASR_PYTHON: original.python };
      const envOverride = await exec(process.execPath, [script, 'start', '--data-dir', data, '--port', String(port), '--test-backend'], { timeout: 30000, env });
      expect(JSON.parse(envOverride.stdout).status).toBe('ready');
    } finally {
      await rm(settings);
    }
  }, 30000);

  it('validates WAV bytes and duration and reports independent provenance and truncation', async () => {
    expect((await fetch(url('/v1/transcribe'), { method: 'POST', headers: headers(), body: Buffer.from('not a wav') })).status).toBe(400);
    expect((await fetch(url('/v1/transcribe'), { method: 'POST', headers: headers(), body: wav(121) })).status).toBe(400);
    const tooLarge = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(url('/v1/transcribe'), { method: 'POST', headers: { ...headers(), 'Content-Length': String(16 * 1024 * 1024 + 1) } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end();
    });
    expect(tooLarge).toBe(413);
    const response = await fetch(url('/v1/transcribe'), { method: 'POST', headers: { ...headers(), 'X-ASR-Language': 'ja' }, body: wav() });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ transcription: 'test', language: 'English', requestedLanguage: 'ja', truncated: true, inputAudio: { sampleRate: 16000, channels: 1, sourceSampleRate: 8000 } });
    expect(result.audioSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.inputAudio.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawDecode).toBe('language English<asr_text>test');
  }, 30000);

  it('rejects concurrent inference, keeps start idempotent, and does not log transcript or token', async () => {
    const health = await (await fetch(url('/health'), { headers: headers() })).json();
    const duplicate = await command('start', ['--test-backend']);
    expect(JSON.parse(duplicate.stdout).pid).toBe(health.pid);
    await expect(command('start', ['--test-backend', '--backend', 'gguf'])).rejects.toThrow(/different settings/);
    const first = fetch(url('/v1/transcribe'), { method: 'POST', headers: headers(), body: wav() });
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await fetch(url('/v1/transcribe'), { method: 'POST', headers: headers(), body: wav() });
    expect(second.status).toBe(429);
    expect((await first).status).toBe(200);
    const log = await readFile(path.join(data, 'local-asr', 'service.log'), 'utf8');
    expect(log).not.toContain(token);
    expect(log).not.toContain('language English<asr_text>test');
  }, 30000);

  it('will not stop a process from a stale state file or overwrite an occupied port', async () => {
    await command('stop');
    const foreign = createServer();
    await new Promise<void>((resolve, reject) => foreign.once('error', reject).listen(port, '127.0.0.1', resolve));
    try {
      await writeFile(path.join(data, 'local-asr', 'service-state.json'), JSON.stringify({ pid: process.pid, port, nonce: 'stale', dataDir: data, project: path.resolve('.') }));
      expect((await command('stop')).stdout).toContain('No matching');
      await expect(command('start', ['--test-backend'])).rejects.toThrow(/occupied/);
      expect(foreign.listening).toBe(true);
    } finally {
      await new Promise<void>(resolve => foreign.close(() => resolve()));
    }
  }, 30000);

  it('requires an explicit test marker and fails closed when the real model manifest is missing', async () => {
    await rm(path.join(data, 'local-asr', 'TEST-ONLY'));
    await expect(command('start', ['--test-backend'])).rejects.toThrow(/test marker/i);
    await expect(command('start')).rejects.toThrow(/loading failed/i);
    await writeFile(path.join(data, 'local-asr', 'model-manifest.json'), JSON.stringify({ format: 'werewolf-local-asr-model', version: 1,
      repo: 'Qwen/Qwen3-ASR-0.6B-hf', revision: '7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c', directory: path.join(data, 'different-model'), files: [] }));
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(command('start')).rejects.toThrow(/directory mismatch/i);
  }, 30000);
});

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SpeechService } from '../src/speech';
import { speechProvider } from '../src/speech/providers';

// Standalone opt-in diagnostic: four cold requests, each followed by a hot read.
// No room, conversation, response body, URL, credential, or audio is logged.
if (!process.argv.slice(2).includes('--live')) {
  console.error('Pass --live to explicitly run the real Qwen TTS measurement.');
  process.exit(1);
}
const samples = [
  { kind: 'short', text: '三号发言，我投给五号。' },
  { kind: 'short', text: '四号发言，我暂时相信二号。' },
  { kind: 'long', text: '我是六号玩家。昨晚没有发生出局，今天先听大家的发言。我会关注投票理由和前后逻辑，也希望每个人清楚说明自己的判断。等所有玩家发言结束后，我再决定这一轮投给谁。' },
  { kind: 'long', text: '我是七号玩家。刚才几位玩家的说法有不同之处，我想先确认他们对昨晚信息的理解。我不会因为一句话就确定身份，会结合投票、发言顺序和之后的解释，再做出自己的选择。' },
];
const root = join('data', 'diagnostics', 'four-evaluations', 'audio-lifecycle', randomUUID());
await mkdir(root, { recursive: true });
const originalFetch = globalThis.fetch;
const priorCache = process.env.VIDEO_AUDIO_CACHE_DIRS;
delete process.env.VIDEO_AUDIO_CACHE_DIRS;
let start = 0, firstMediaMs: number | null = null, firstPcmMs: number | null = null, upstreamCompleteMs: number | null = null;
let wavPrefix = Buffer.alloc(0);
let calls = 0, downloads = 0, mode = 'none';
const elapsed = () => Math.round(performance.now() - start);
// Qwen is requested as WAV. Locate the data chunk before counting actual PCM;
// the first nonempty transfer may consist only of RIFF headers.
function media(chunk: Uint8Array) {
  if (!chunk.length) return;
  if (firstMediaMs === null) firstMediaMs = elapsed();
  if (firstPcmMs !== null || wavPrefix.length > 1024 * 1024) return;
  wavPrefix = Buffer.concat([wavPrefix, chunk]);
  if (wavPrefix.length < 12 || wavPrefix.toString('ascii', 0, 4) !== 'RIFF' || wavPrefix.toString('ascii', 8, 12) !== 'WAVE') return;
  for (let at = 12; at + 8 <= wavPrefix.length;) {
    const id = wavPrefix.toString('ascii', at, at + 4), size = wavPrefix.readUInt32LE(at + 4), next = at + 8;
    if (id === 'data') { if (wavPrefix.length > next) firstPcmMs = elapsed(); return; }
    if (next + size > wavPrefix.length) return;
    at = next + size + size % 2;
  }
}
globalThis.fetch = async (input, init) => {
  const post = init?.method === 'POST';
  if (post) calls++; else downloads++;
  const response = await originalFetch(input, init);
  const contentType = response.headers.get('content-type') ?? '';
  const isSse = contentType.includes('event-stream'), isJson = contentType.includes('json');
  mode = isSse ? 'sse' : post ? 'post-body' : 'download';
  if (!response.body) return response;
  const decoder = new TextDecoder(); let pending = '';
  const inspect = (block: string) => {
    const payload = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    try {
      const event = JSON.parse(payload);
      const value = event?.output?.audio?.data;
      if (typeof value === 'string') media(Buffer.from(value, 'base64'));
    } catch { /* No audio event, or incomplete/non-JSON data. */ }
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          if (isSse && pending.trim()) inspect(pending);
          upstreamCompleteMs = elapsed(); controller.close(); return;
        }
        if (isSse) {
          pending += decoder.decode(result.value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(pending))) {
            inspect(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length);
          }
        } else if (!isJson) media(result.value);
        controller.enqueue(result.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
const results: unknown[] = [];
try {
  for (const [index, sample] of samples.entries()) {
    const directory = join(root, `sample-${index + 1}`);
    const provider = speechProvider({ id: 'qwen-token-plan', label: 'Token Plan Qwen', type: 'qwen-token-plan' }, directory, directory);
    const service = new SpeechService(directory, [provider]);
    for (const cache of ['cold', 'hot'] as const) {
      start = performance.now(); firstMediaMs = null; firstPcmMs = null; upstreamCompleteMs = null; wavPrefix = Buffer.alloc(0); calls = 0; downloads = 0; mode = 'none';
      try {
        const audio = await service.render(sample.text);
        results.push({ sample: index + 1, kind: sample.kind, characters: [...sample.text].length, cache, calls, downloads, mode, firstMediaMs, firstPcmMs, upstreamCompleteMs, serviceReadyMs: elapsed(), bytes: audio.bytes.length, outcome: 'success' });
      } catch (error) {
        const e = error as Error & { cause?: { code?: string } };
        results.push({ sample: index + 1, kind: sample.kind, characters: [...sample.text].length, cache, calls, downloads, mode, firstMediaMs, firstPcmMs, upstreamCompleteMs, serviceReadyMs: elapsed(), outcome: 'failure', errorName: e.name, errorCode: e.cause?.code ?? null });
        break;
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  if (priorCache !== undefined) process.env.VIDEO_AUDIO_CACHE_DIRS = priorCache;
}
const result = { date: new Date().toISOString(), provider: 'qwen-token-plan', model: 'qwen-audio-3.0-tts-plus', notes: 'firstMediaMs may be WAV headers; firstPcmMs is first byte in WAV data chunk, not audible playback; upstreamCompleteMs is last consumed upstream response body completion; serviceReadyMs is complete SpeechService render.', results };
await writeFile(join(root, 'summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

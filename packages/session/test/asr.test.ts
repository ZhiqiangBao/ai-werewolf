import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { wavHeader } from '../src/speech/audio';
import { LOCAL_ASR_MODEL, LOCAL_ASR_REVISION, LOCAL_GGUF_MODEL, LOCAL_GGUF_REVISION, LOCAL_GGUF_FILE, LOCAL_GGUF_SHA256, asrAudioSha256, asrProviderForLocale, ensureLocalAsrReady, validLocalRuntime, transcribeAudio } from '../src/asr';

vi.mock('../src/project-models', () => ({ projectQwenTokenPlanKey: () => 'sk-sp-fixture-key' }));
const audio = Buffer.concat([wavHeader(3200, 16000), Buffer.alloc(6400, 42)]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('独立 ASR 提供方契约', () => {
  it('按语言选择服务；日语禁止本地和 MiMo，缺失或未知语言不能发请求', async () => {
    expect(asrProviderForLocale('auto', 'zh-CN')).toBe('local');
    expect(asrProviderForLocale('auto', 'en')).toBe('local');
    expect(asrProviderForLocale('auto', 'ja')).toBe('qwen-token-plan');
    expect(asrProviderForLocale('qwen-token-plan', 'en')).toBe('qwen-token-plan');
    const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal('fetch', fetch);
    for (const options of [{ provider: 'local', locale: 'ja' }, { provider: 'mimo-token-plan', locale: 'ja' }, { provider: 'qwen-token-plan' }, { provider: 'local', locale: 'fr' }] as const)
      await expect(transcribeAudio(audio, options)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(validLocalRuntime({ device: 'vulkan', dtype: 'Q5', versions: { python: '3.11', nativeCommit: null } })).toBe(true);
    expect(validLocalRuntime({ device: 'vulkan', dtype: 'Q5', versions: { python: '', nativeCommit: null } })).toBe(false);
  });
  it('只在本地服务缺失时启动一次，已就绪服务复用且身份异常不会另启', async () => {
    const base = resolve('data/asr-client-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'start-')); await mkdir(join(directory, 'local-asr'));
    let nonce = 'expected';
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ status: 'ready', nonce, pid: 42, backend: 'transformers' }));
    vi.stubGlobal('fetch', fetch);
    const start = vi.fn(async () => {
      await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'expected', pid: 42, backend: 'transformers' }));
      await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ token: 'fixture', nonce: 'expected' }));
    });
    await ensureLocalAsrReady(directory, start);
    await ensureLocalAsrReady(directory, start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    nonce = 'wrong';
    await expect(ensureLocalAsrReady(directory, start)).rejects.toThrow(/identity or readiness/);
    expect(start).toHaveBeenCalledTimes(1);
    nonce = 'expected';
    await writeFile(join(directory, 'local-asr', 'service-settings.json'), JSON.stringify({ backend: 'gguf' }));
    await expect(ensureLocalAsrReady(directory, start)).rejects.toThrow(/does not match configured backend/);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('Qwen Token Plan 只发送原音、auto参数，不发送原稿或提示', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ output: { sentence: { text: '独立识别', words: [] } } }));
    vi.stubGlobal('fetch', fetch);
    const result = await transcribeAudio(audio, { provider: 'qwen-token-plan', locale: 'ja', sourceText: 'SECRET SOURCE', prompt: 'SECRET PROMPT' } as any);
    expect(result).toMatchObject({ provider: 'qwen-token-plan', inputAudioSha256: asrAudioSha256(audio), model: 'qwen-audio-3.0-asr-flash', text: '独立识别', truncated: null, options: { language: 'auto' } });
    const [url, init] = fetch.mock.calls[0], request = JSON.parse(String(init?.body));
    expect(String(url)).toBe('https://token-plan.maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation');
    expect(request.parameters).toEqual({ format: 'wav', sample_rate: '16000' });
    expect(request.input.messages[0].content).toEqual([{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio.toString('base64')}` } }]);
    expect(JSON.stringify(request)).not.toMatch(/SECRET|language_hints|prompt|context/);
  });
  it('MiMo Token Plan 使用 api-key 和 auto，日语在发送前拒绝', async () => {
    vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_URL', 'https://token-plan-cn.xiaomimimo.com/v1');
    vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_KEY', 'fixture-mimo-key');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ choices: [{ finish_reason: 'stop', message: { content: 'independent' } }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await transcribeAudio(audio, { provider: 'mimo-token-plan', locale: 'en' });
    expect(result).toMatchObject({ model: 'mimo-v2.5-asr', text: 'independent', inputAudioSha256: asrAudioSha256(audio), truncated: false });
    const [url, init] = fetch.mock.calls[0], request = JSON.parse(String(init?.body));
    expect(String(url)).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(init?.headers).toMatchObject({ 'api-key': 'fixture-mimo-key' });
    expect(request).toEqual({ model: 'mimo-v2.5-asr', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio.toString('base64')}` } }] }], asr_options: { language: 'auto' } });
    await expect(transcribeAudio(audio, { provider: 'mimo-token-plan', locale: 'ja' })).rejects.toThrow(/restricted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('默认本地原样传字节并核对服务返回的音频哈希与模型版本', async () => {
    const base = resolve('data/asr-client-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')); await mkdir(join(directory, 'local-asr'));
    await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'fixture-nonce', pid: 42, backend: 'transformers' }));
    await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ token: 'fixture-local-token', nonce: 'fixture-nonce' }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).endsWith('/health') ? json({ status: 'ready', nonce: 'fixture-nonce', pid: 42, backend: 'transformers' }) : json({ transcription: '本地结果', audioSha256: asrAudioSha256(audio), requestedLanguage: 'auto', truncated: false, model: { repo: LOCAL_ASR_MODEL, revision: LOCAL_ASR_REVISION, backend: 'transformers' }, runtime: { device: 'cuda:0', dtype: 'float16', versions: { python: '3.11', torch: '2', transformers: '4' } } }));
    vi.stubGlobal('fetch', fetch);
    const result = await transcribeAudio(audio, { dataDir: directory, locale: 'en' });
    expect(result).toMatchObject({ provider: 'local', model: LOCAL_ASR_MODEL, revision: LOCAL_ASR_REVISION, text: '本地结果', inputAudioSha256: asrAudioSha256(audio) });
    const [url, init] = fetch.mock.calls[1];
    expect(String(url)).toBe('http://127.0.0.1:5291/v1/transcribe');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-local-token', 'X-ASR-Language': 'auto', 'Content-Type': 'audio/wav' });
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(audio);
  });
  it('本地失败不回退到云端，错误正文及密钥不泄露', async () => {
    const base = resolve('data/asr-client-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')); await mkdir(join(directory, 'local-asr'));
    await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'fixture-nonce', pid: 42, backend: 'transformers' }));
    await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ token: 'fixture-secret', nonce: 'fixture-nonce' }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).endsWith('/health') ? json({ status: 'ready', nonce: 'fixture-nonce', pid: 42, backend: 'transformers' }) : json({ message: 'fixture-secret remote-body' }, 503)); vi.stubGlobal('fetch', fetch);
    await expect(transcribeAudio(audio, { dataDir: directory, locale: 'en' })).rejects.toThrow('local ASR HTTP 503');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('本地 health 身份不一致时不发送音频', async () => {
    const base = resolve('data/asr-client-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')); await mkdir(join(directory, 'local-asr'));
    await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'expected', pid: 42, backend: 'transformers' }));
    await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ token: 'fixture-secret', nonce: 'expected' }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ status: 'ready', nonce: 'different', pid: 42 })); vi.stubGlobal('fetch', fetch);
    await expect(transcribeAudio(audio, { dataDir: directory, locale: 'en' })).rejects.toThrow(/identity or readiness changed/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/health');
  });
  it('接受已知 Q8 GGUF 的空转写和未知截断状态，拒绝错误文件摘要', async () => {
    const base = resolve('data/asr-client-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')); await mkdir(join(directory, 'local-asr'));
    await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'n', pid: 42, backend: 'gguf' }));
    await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ token: 'fixture', nonce: 'n' }));
    const model = { repo: LOCAL_GGUF_MODEL, revision: LOCAL_GGUF_REVISION, backend: 'gguf', file: LOCAL_GGUF_FILE, sha256: LOCAL_GGUF_SHA256 };
    const runtime = { device: 'vulkan', dtype: 'Q8_0', versions: { python: '3.11', transcribe_cpp: '0.4.1', native: 'fixture', nativeCommit: null } };
    expect(LOCAL_GGUF_FILE).toBe('Qwen3-ASR-1.7B-Q8_0.gguf');
    expect(LOCAL_GGUF_SHA256).toBe('9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7');
    let badHash = false, badDtype = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).endsWith('/health') ? json({ status: 'ready', nonce: 'n', pid: 42, backend: 'gguf' }) : json({ transcription: '', audioSha256: asrAudioSha256(audio), requestedLanguage: 'auto', truncated: null, model: { ...model, sha256: badHash ? '034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0' : model.sha256 }, runtime: { ...runtime, dtype: badDtype ? 'Q5_K_M' : runtime.dtype } }));
    vi.stubGlobal('fetch', fetch);
    expect(await transcribeAudio(audio, { dataDir: directory, locale: 'en' })).toMatchObject({ model: LOCAL_GGUF_MODEL, revision: LOCAL_GGUF_REVISION, backend: 'gguf', runtime, text: '', truncated: null });
    badHash = true;
    await expect(transcribeAudio(audio, { dataDir: directory, locale: 'en' })).rejects.toThrow(/binding is invalid/);
    badHash = false; badDtype = true;
    await expect(transcribeAudio(audio, { dataDir: directory, locale: 'en' })).rejects.toThrow(/binding is invalid/);
  });
  it('未知本地后端在发送音频前拒绝', async () => {
    const base = resolve('data/asr-client-tests'); await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')); await mkdir(join(directory, 'local-asr'));
    await writeFile(join(directory, 'local-asr', 'service-state.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:5291', nonce: 'n', pid: 42, backend: 'unknown' }));
    await writeFile(join(directory, 'local-asr', 'service-control.json'), JSON.stringify({ token: 'fixture', nonce: 'n' }));
    const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal('fetch', fetch);
    await expect(transcribeAudio(audio, { dataDir: directory, locale: 'en' })).rejects.toThrow(/Unsupported local ASR backend/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('云端失败不输出返回正文或凭据，也不重试到其他线路', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ message: 'sk-sp-fixture-key remote-secret-body' }, 403)); vi.stubGlobal('fetch', fetch);
    const error = await transcribeAudio(audio, { provider: 'qwen-token-plan', locale: 'en' }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('qwen-token-plan ASR HTTP 403');
    expect((error as Error).message).not.toMatch(/fixture-key|remote-secret-body/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('拒绝非16k输入，不发网络请求', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal('fetch', fetch);
    const wrong = Buffer.concat([wavHeader(1000, 24000), Buffer.alloc(2000)]);
    await expect(transcribeAudio(wrong, { provider: 'qwen-token-plan' })).rejects.toThrow(/16 kHz/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

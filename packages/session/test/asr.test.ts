import { afterEach, describe, expect, it, vi } from 'vitest';
import { asrProviderForLocale, parseCloudAsrResponse, transcribeAudio } from '../src/asr';

function canonicalWav() {
  const audio = Buffer.alloc(44 + 16000 * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DASHSCOPE_API_KEY;
});

describe('Qwen DashScope ASR', () => {
  it('keeps the explicit route and allows Chinese, English, and Japanese', () => {
    expect(asrProviderForLocale('qwen-dashscope', 'zh-CN')).toBe('qwen-dashscope');
    expect(asrProviderForLocale('qwen-dashscope', 'en-US')).toBe('qwen-dashscope');
    expect(asrProviderForLocale('qwen-dashscope', 'ja-JP')).toBe('qwen-dashscope');
    expect(asrProviderForLocale('auto', 'zh-CN')).toBe('local');
  });

  it('parses the documented sentence response without inventing truncation', () => {
    expect(parseCloudAsrResponse('qwen-dashscope', { output: { sentence: { text: '你好。' } } })).toEqual({ text: '你好。', truncated: null });
  });

  it('uses the official DashScope endpoint, model, and credential route', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-test-dashscope';
    const response = { output: { sentence: { text: '你好。', words: [{ text: '你好', begin_time: 20, end_time: 240 }, { text: '。', begin_time: 240, end_time: 300 }] } }, request_id: 'test' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-dashscope');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('qwen-audio-3.1-asr-flash');
      expect(body.parameters).toEqual({ format: 'wav', sample_rate: '16000' });
      return { ok: true, json: async () => response } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await transcribeAudio(canonicalWav(), { provider: 'qwen-dashscope', locale: 'zh-CN' });
    expect(result).toMatchObject({ provider: 'qwen-dashscope', model: 'qwen-audio-3.1-asr-flash', text: '你好。', truncated: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

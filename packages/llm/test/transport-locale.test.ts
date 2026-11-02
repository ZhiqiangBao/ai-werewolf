import { expect, it, vi } from 'vitest';
import { apiBase, apiUrl, type ApiProtocol } from '@werewolf/protocol';
import { remoteAdapter } from '../src/adapters';
import type { DecideRequest } from '../src/types';
import { HttpError, runRequest } from '../src/transport';

function request(locale?: string): DecideRequest {
  return { seat: 1, messages: [], tools: [], config: { baseUrl: '', model: '', apiKey: null, temperature: 0, timeoutSec: 0.01, toolMode: 'tools' }, ...(locale ? { projection: { locale } as DecideRequest['projection'] } : {}) };
}

it.each([['en', 'seconds'], ['ja', '秒'], ['zh-CN', '秒']])('超时错误使用 %s 局语言', async (locale, expected) => {
  const result = await runRequest(request(locale), (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  expect(result.failureKind).toBe('timeout');
  expect(result.error).toContain(expected);
  if (locale === 'en') expect(result.error).not.toContain('超过');
});

it('翻译本地错误包装但保留服务商原文并脱敏', async () => {
  const req = request('en'); req.config.apiKey = 'secret-value';
  const result = await runRequest(req, async () => { throw new HttpError(503, 'provider says secret-value'); });
  expect(result.error).toContain('provider says ***');
  expect(result.error).not.toContain('接口返回');
});


it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 的英文 URL 校验无需网络且不出现中文', async (protocol: ApiProtocol) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    for (const baseUrl of ['https://user:pass@example.com/v1', 'https://example.com/v1/' + (protocol === 'responses' ? 'messages' : 'responses')]) {
      const req = request('en');
      req.config = { ...req.config, baseUrl, model: 'test', apiProtocol: protocol };
      const result = await remoteAdapter(protocol).decide(req);
      expect(result.ok).toBe(false);
      expect(result.error).not.toMatch(/\p{Script=Han}/u);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('URL 校验默认中文，显式日文及有效地址保持兼容', () => {
  expect(() => apiBase('https://user:pass@example.com')).toThrow('无凭证');
  expect(() => apiUrl('https://example.com/v1/responses', 'chat_completions', 'ja')).toThrow('一致しません');
  expect(apiUrl('https://example.com', 'responses', 'en')).toBe('https://example.com/v1/responses');
});

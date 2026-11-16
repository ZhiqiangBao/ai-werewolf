import { expect, it } from 'vitest';
import { defaultServerWebTools, serverWebToolSupport } from '../src/index';

it('网页工具默认开启，并按协议和模型声明能力', () => {
  expect(defaultServerWebTools()).toEqual({ search: true, extractor: true });
  expect(serverWebToolSupport('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1', 'qwen3.8-max', 'responses', 'high')).toEqual({ search: 'supported', extractor: 'supported' });
  expect(serverWebToolSupport('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1', 'qwen3.8-max', 'responses', 'off')).toMatchObject({ search: 'supported', extractor: 'unsupported' });
  expect(serverWebToolSupport('https://api.deepseek.com/v1', 'deepseek-v4-pro', 'chat_completions')).toMatchObject({ search: 'unsupported', extractor: 'unsupported' });
});

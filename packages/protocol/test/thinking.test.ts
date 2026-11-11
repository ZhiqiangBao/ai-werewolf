import { expect, it } from 'vitest';
import { API_PROTOCOLS, defaultThinkingMode, thinkingOptions, thinkingParameters, type ApiProtocol } from '../src/index';

const aliyun = 'https://token-plan.maas.qianwenaiapi.com/v1';
const deepseek = 'https://api.deepseek.com';
const levels = ['low', 'medium', 'high'] as const;
const supported = (base: string, model: string, protocol: ApiProtocol = 'chat_completions') => thinkingOptions(base, model, protocol).filter((o) => o.supported).map((o) => o.value);

it('Qwen4 的三种协议提供真实三档，深度映射 xhigh，默认不额外传参', () => {
  for (const protocol of API_PROTOCOLS) {
    const model = 'qwen4-max-preview';
    expect(supported(aliyun, model, protocol)).toEqual(['default', 'off', ...levels]);
    expect(defaultThinkingMode(aliyun, model, protocol)).toBe('low');
    expect(thinkingParameters(aliyun, model, 'default', protocol)).toEqual({});
    expect(thinkingOptions(aliyun, model, protocol).find(option => option.value === 'high')?.hint).toContain('xhigh');
    for (const mode of levels) {
      const effort = mode === 'high' ? 'xhigh' : mode;
      expect(thinkingParameters(aliyun, model, mode, protocol)).toEqual(protocol === 'responses'
        ? { reasoning: { effort } }
        : protocol === 'anthropic_messages'
          ? { thinking: { type: 'enabled' }, output_config: { effort } }
          : { enable_thinking: true, reasoning_effort: effort });
    }
    expect(thinkingParameters(aliyun, model, 'off', protocol)).toEqual(protocol === 'responses'
      ? { reasoning: { effort: 'none' } }
      : protocol === 'anthropic_messages' ? { thinking: { type: 'disabled' } } : { enable_thinking: false });
  }
});

it('DeepSeek 官方当前名称和兼容别名在三种协议下支持关闭与三档', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    for (const protocol of API_PROTOCOLS) {
      const base = protocol === 'anthropic_messages' ? `${deepseek}/anthropic` : deepseek;
      expect(supported(base, model, protocol)).toEqual(['default', 'off', ...levels]);
      expect(defaultThinkingMode(base, model, protocol)).toBe('low');
      expect(thinkingParameters(base, model, 'default', protocol)).toEqual({});
      for (const mode of ['off', ...levels] as const) {
        const effort = mode === 'high' ? 'max' : mode === 'medium' ? 'high' : mode;
        expect(thinkingParameters(base, model, mode, protocol)).toEqual(protocol === 'responses'
          ? { reasoning: { effort: mode === 'off' ? 'none' : effort } }
          : mode === 'off' ? { thinking: { type: 'disabled' } }
            : protocol === 'anthropic_messages'
              ? { thinking: { type: 'enabled' }, output_config: { effort } }
              : { thinking: { type: 'enabled' }, reasoning_effort: effort });
      }
    }
  }
});

it('MiMo Responses 只提供真实的开关，不把等效参数伪装成三档', () => {
  for (const host of ['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com']) {
    for (const model of ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']) {
      const base = `https://${host}/v1`;
      expect(supported(base, model, 'responses')).toEqual(['default', 'off']);
      expect(defaultThinkingMode(base, model, 'responses')).toBe('default');
      expect(thinkingParameters(base, model, 'default', 'responses')).toEqual({});
      expect(thinkingParameters(base, model, 'off', 'responses')).toEqual({ reasoning: { effort: 'none' } });
      const option = thinkingOptions(base, model, 'responses').find((o) => o.value === 'low')!;
      expect(option.hint).toContain('仅支持思考开关');
      for (const mode of levels) expect(() => thinkingParameters(base, model, mode, 'responses')).toThrow();
    }
  }
});

it('GLM-5 与 GLM-5.1 官方入口不提供不存在的强度档，GLM-5.2 只有两个真实档', () => {
  const base = 'https://api.z.ai/api/paas/v4';
  for (const model of ['GLM-5', 'GLM-5.1']) {
    expect(supported(base, model)).toEqual(['default', 'off']);
    expect(thinkingOptions(base, model).find((o) => o.value === 'low')!.hint).toContain('仅支持思考开关');
  }
  expect(supported(base, 'GLM-5.2')).toEqual(['default', 'off', 'medium', 'high']);
  expect(thinkingParameters(base, 'GLM-5.2', 'medium')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  expect(thinkingParameters(base, 'GLM-5.2', 'high')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  for (const model of ['glm-5.3', 'glm-5.3-flash']) {
    expect(supported(base, model)).toEqual(['default', ...levels]);
    expect(() => thinkingParameters(base, model, 'off')).toThrow();
  }
});

it('保留百炼旧版 Pro、Qwen 预算与未知入口的边界', () => {
  expect(supported(aliyun, 'deepseek-v4-pro')).toEqual(['default', 'off', 'medium', 'high']);
  for (const protocol of ['responses', 'anthropic_messages'] as const) {
    expect(supported(aliyun, 'deepseek-v4-pro', protocol)).toEqual(['default', 'off', 'medium', 'high']);
    expect(supported(aliyun, 'deepseek-v4-pro-0813', protocol)).toEqual(['default', 'off', ...levels]);
    expect(supported(aliyun, 'deepseek-v4.1-flash-1017', protocol)).toEqual(['default', 'off', ...levels]);
    for (const model of ['deepseek-flash', 'mimo-v2.6-pro', 'qwen4-max-preview']) {
      expect(supported('https://gateway.invalid/v1', model, protocol)).toEqual(['default']);
    }
  }
  expect(supported('https://gateway.invalid/v1', 'deepseek-flash')).toEqual(['default', 'off']);
  expect(thinkingParameters(aliyun, 'qwen3.7-plus', 'low')).toEqual({ enable_thinking: true, thinking_budget: 1024 });
  expect(thinkingParameters(aliyun, 'qwen3.8-max', 'high')).toEqual({ enable_thinking: true, reasoning_effort: 'xhigh' });
  expect(defaultThinkingMode('http://127.0.0.1:1234/v1', 'Qwen&&Gemma')).toBe('default');
  for (const protocol of API_PROTOCOLS) {
    expect(thinkingParameters('', '', 'default', protocol)).toEqual({});
    expect(defaultThinkingMode('', '', protocol)).toBe('default');
  }
});

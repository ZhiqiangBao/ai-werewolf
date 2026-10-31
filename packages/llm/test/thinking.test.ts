import { describe, expect, it } from 'vitest';
import { thinkingOptions, thinkingParameters } from '@werewolf/protocol';

const tokenPlan = 'https://token-plan.maas.qianwenaiapi.com/v1';
const native = 'https://api.example.com/v1';

describe('思考强度与接口能力', () => {
  it('跟随模型不追加参数，保持旧配置行为', () => {
    expect(thinkingParameters(tokenPlan, 'qwen3.8-flash')).toEqual({});
    expect(thinkingParameters(native, 'custom-model', 'default')).toEqual({});
  });

  it('Qwen3.8 三档使用独立的原生力度，不混用预算，也不限制正文', () => {
    for (const [mode, effort] of [['low', 'low'], ['medium', 'medium'], ['high', 'xhigh']] as const) {
      expect(thinkingParameters(tokenPlan, 'qwen3.8-flash', mode)).toEqual({ enable_thinking: true, reasoning_effort: effort });
    }
  });

  it('较早 Qwen 的三档仅调整思考预算', () => {
    const params = ['low', 'medium', 'high'].map((mode) => thinkingParameters(tokenPlan, 'qwen3.7-plus', mode as 'low' | 'medium' | 'high'));
    expect(params.map((p) => p.thinking_budget)).toEqual([1024, 4096, 16384]);
    expect(params.every((p) => p.enable_thinking === true && !('max_tokens' in p) && !('reasoning_effort' in p))).toBe(true);
  });

  it('百炼旧版 DeepSeek Pro 的轻度不可用，标准和深度映射到两个真实档位', () => {
    const options = thinkingOptions(tokenPlan, 'deepseek-v4-pro');
    expect(options.find((o) => o.value === 'low')?.supported).toBe(false);
    expect(() => thinkingParameters(tokenPlan, 'deepseek-v4-pro', 'low')).toThrow('没有独立的轻度档');
    expect(thinkingParameters(tokenPlan, 'deepseek-v4-pro', 'medium')).toEqual({ enable_thinking: true, reasoning_effort: 'high' });
    expect(thinkingParameters(tokenPlan, 'deepseek-v4-pro', 'high')).toEqual({ enable_thinking: true, reasoning_effort: 'max' });
    expect(thinkingParameters(native, 'deepseek-v4-pro', 'low')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  });

  it('GLM5.3 可调力度但不能关闭，GLM5.2 在百炼使用预算', () => {
    expect(thinkingOptions(tokenPlan, 'glm-5.3').filter((o) => o.supported).map((o) => o.value)).toEqual(['default', 'low', 'medium', 'high']);
    expect(() => thinkingParameters(tokenPlan, 'glm-5.3', 'off')).toThrow('不能关闭');
    expect(thinkingParameters(tokenPlan, 'glm-5.3', 'high')).toEqual({ enable_thinking: true, reasoning_effort: 'max' });
    expect(thinkingParameters(tokenPlan, 'glm-5.2', 'low')).toEqual({ enable_thinking: true, thinking_budget: 1024 });
    expect(thinkingOptions(native, 'glm-5.2').find((o) => o.value === 'low')?.supported).toBe(false);
  });

  it('未知接口不显示未经确认的强度，已有关闭选项兼容', () => {
    expect(thinkingOptions(native, 'custom-model').filter((o) => o.supported).map((o) => o.value)).toEqual(['default', 'off']);
    expect(thinkingParameters(native, 'custom-model', 'off')).toEqual({ thinking: { type: 'disabled' } });
  });
});

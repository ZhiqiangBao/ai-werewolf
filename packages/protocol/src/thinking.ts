/** 档位只调整思考参数，不改变正文长度、系统消息或工具定义。 */
export const THINKING_MODES = ['default', 'off', 'low', 'medium', 'high'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];
type Level = Exclude<ThinkingMode, 'default' | 'off'>;

interface ThinkingProfile {
  switchParam: 'enable_thinking' | 'thinking';
  forced: boolean;
  budget?: boolean;
  effort?: Partial<Record<Level, string>>;
}

function profile(baseUrl: string, name: string): ThinkingProfile {
  const model = name.toLowerCase();
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* 未选接口时也可显示默认选项。 */ }
  const aliyun = /(^|\.)(qianwenaiapi\.com|aliyuncs\.com)$/.test(host);
  const switchParam = aliyun || /^qwen/.test(model) ? 'enable_thinking' : 'thinking';
  const forced = /^glm-5\.3/.test(model) || /^qwen3\.7-max-preview/.test(model) ||
    /^qwen3\.8-2\.4t/.test(model) || /^(?:minimax[/-])?minimax-m2/i.test(model) ||
    /^deepseek-r1/.test(model) || /^kimi-k2\.7-code/.test(model);
  const base = { switchParam, forced } as const;
  if (/^qwen3\.8-(?:max|flash|omni|2\.4t|27b)/.test(model) && !model.includes('preview')) {
    return { ...base, effort: { low: 'low', medium: 'medium', high: 'xhigh' } };
  }
  if (/^qwen3(?:[.\-]|$)|^qwen-(?:plus|flash)/.test(model)) return { ...base, budget: true };
  if (/^deepseek-v4/.test(model)) {
    // 百炼旧版 Pro 将 low/medium 都映射到 high，不能假装有三个不同档位。
    const twoLevels = aliyun && /^deepseek-v4-pro$/.test(model);
    return { ...base, effort: { ...(twoLevels ? {} : { low: 'low' }), medium: 'high', high: 'max' } };
  }
  if (/^glm-5\.3/.test(model)) return { ...base, effort: { low: 'low', medium: 'high', high: 'max' } };
  if (/^glm-(?:5(?:\.[12])?|4\.[567])(?:-|$)/.test(model)) {
    if (aliyun) return { ...base, budget: true };
    if (/^glm-5\.2/.test(model)) return { ...base, effort: { medium: 'high', high: 'max' } };
  }
  if (aliyun && /^kimi-k2\.[567]/.test(model)) return { ...base, budget: true };
  return base;
}

export interface ThinkingOption {
  value: ThinkingMode;
  label: string;
  supported: boolean;
  hint: string;
}

const labels: Record<ThinkingMode, string> = { default: '跟随模型', off: '关闭', low: '轻度', medium: '标准', high: '深度' };
const budget: Record<Level, number> = { low: 1024, medium: 4096, high: 16384 };

export function thinkingOptions(baseUrl: string, model: string): ThinkingOption[] {
  const p = profile(baseUrl, model);
  return THINKING_MODES.map((value) => {
    if (value === 'default') return { value, label: labels[value], supported: true, hint: '使用模型默认的思考强度。' };
    if (value === 'off') return { value, label: labels[value], supported: !p.forced,
      hint: p.forced ? '这个模型始终思考，不能关闭；可以选择它支持的强度。' : '关闭思考，减少等待；需要接口支持。' };
    const supported = !!p.budget || !!p.effort?.[value];
    const hint = p.budget ? `${labels[value]}：思考预算 ${budget[value]} token，不限制正文长度。` :
      p.effort?.[value] ? `${labels[value]}：使用模型的 ${p.effort[value]} 推理力度。` :
      p.effort ? '这个接口没有独立的轻度档，请选择标准或深度。' : '尚未确认这个模型支持强度调节，请使用跟随模型。';
    return { value, label: labels[value], supported, hint };
  });
}

/** 统一档位转换为对应接口的参数；不同时传 reasoning_effort 与 thinking_budget。 */
export function thinkingParameters(baseUrl: string, model: string, mode: ThinkingMode = 'default'): Record<string, unknown> {
  if (mode === 'default') return {};
  const option = thinkingOptions(baseUrl, model).find((o) => o.value === mode);
  if (!option?.supported) throw new Error(`不支持该思考档位：${option?.hint ?? String(mode)}`);
  const p = profile(baseUrl, model);
  const parameters: Record<string, unknown> = p.switchParam === 'enable_thinking'
    ? { enable_thinking: mode !== 'off' } : { thinking: { type: mode === 'off' ? 'disabled' : 'enabled' } };
  if (mode !== 'off') {
    if (p.budget) parameters.thinking_budget = budget[mode];
    else parameters.reasoning_effort = p.effort![mode];
  }
  return parameters;
}

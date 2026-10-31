/** 档位只调整思考参数，不改变正文长度、系统消息或工具定义。 */
import { isDashscopeEndpoint, type ApiProtocol } from './api';
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

function nativeProfile(baseUrl: string, model: string, protocol: ApiProtocol): { kind: 'effort' | 'budget' | 'unknown'; off: boolean; effort?: Partial<Record<Level, string>>; dashscope?: boolean } {
  if (isDashscopeEndpoint(baseUrl)) {
    const p = profile(baseUrl, model);
    const known = /^qwen3\.8-(?:max|flash|2\.4t|27b)/i.test(model) || /^deepseek-v4/i.test(model) || /^glm-5\.[23]/i.test(model);
    if (known) {
      const two = /^glm-5\.2(?:-|$)|^deepseek-v4-pro$/i.test(model);
      const effort = two ? { medium: 'high', high: 'max' } : /^qwen/i.test(model) ? { low: 'low', medium: 'medium', high: 'xhigh' } : { low: 'low', medium: 'high', high: 'max' };
      return { kind: 'effort', off: !p.forced, effort, dashscope: true };
    }
    if (protocol === 'anthropic_messages' && p.budget) return { kind: 'budget', off: !p.forced, dashscope: true };
    return { kind: 'unknown', off: false, dashscope: true };
  }
  const name = model.toLowerCase().replace(/\./g, '-');
  if (protocol === 'responses') return { kind: /^(?:gpt-[56](?:-|$)|o[134](?:-|$))/.test(name) ? 'effort' : 'unknown', off: false };
  const adaptive = /^claude-(?:(?:opus-4-[678]|sonnet-4-6)(?:-|$)|(?:opus|sonnet|haiku|fable|mythos)-5(?:-|$)|mythos-preview)/.test(name);
  if (adaptive) return { kind: 'effort', off: !/^claude-(?:(?:opus|sonnet)-5-5|(?:fable|mythos)-5|mythos-preview)/.test(name) };
  return { kind: /^claude-(?:3-7-sonnet|(?:opus|sonnet|haiku)-4(?:-|$))/.test(name) ? 'budget' : 'unknown', off: /^claude-(?:3-7-sonnet|(?:opus|sonnet|haiku)-4(?:-|$))/.test(name) };
}

/** 未配置档位时优先轻度；没有真实轻度档的接口继续使用模型默认，不自动关闭思考。 */
export function defaultThinkingMode(baseUrl: string, model: string, protocol: ApiProtocol = 'chat_completions'): ThinkingMode {
  if (protocol !== 'chat_completions') {
    const p = nativeProfile(baseUrl, model, protocol);
    return p.kind === 'budget' || (p.kind === 'effort' && (!p.effort || p.effort.low)) ? 'low' : 'default';
  }
  const p = profile(baseUrl, model);
  return p.budget || p.effort?.low ? 'low' : 'default';
}

export function thinkingOptions(baseUrl: string, model: string, protocol: ApiProtocol = 'chat_completions'): ThinkingOption[] {
  if (protocol !== 'chat_completions') {
    const native = nativeProfile(baseUrl, model, protocol);
    return THINKING_MODES.map((value) => ({ value, label: labels[value],
      supported: value === 'default' || (value === 'off' ? native.off : native.kind === 'budget' || (native.kind === 'effort' && (!native.effort || !!native.effort[value]))),
      hint: value === 'default' ? '使用所选协议的模型默认设置。' : value === 'off' ? (native.off ? '通过原生协议关闭思考。' : '尚未确认该协议和型号支持关闭；可以使用受支持的强度。') : native.kind === 'budget' ? `思考预算 ${budget[value]} token。` : native.kind === 'effort' ? `通过原生协议设置 ${value} 力度。` : '尚未确认该协议和型号的强度参数，请使用跟随模型。',
    }));
  }
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
export function thinkingParameters(baseUrl: string, model: string, mode: ThinkingMode = 'default', protocol: ApiProtocol = 'chat_completions'): Record<string, unknown> {
  if (mode === 'default') return {};
  const option = thinkingOptions(baseUrl, model, protocol).find((o) => o.value === mode);
  if (!option?.supported) throw new Error(`不支持该思考档位：${option?.hint ?? String(mode)}`);
  const native = nativeProfile(baseUrl, model, protocol);
  if (protocol === 'responses') return { reasoning: { effort: mode === 'off' ? 'none' : native.effort?.[mode] ?? mode } };
  if (protocol === 'anthropic_messages') {
    if (mode === 'off') return { thinking: { type: 'disabled' } };
    return native.kind === 'budget' ? { thinking: { type: 'enabled', budget_tokens: budget[mode] } } : { thinking: { type: native.dashscope ? 'enabled' : 'adaptive' }, output_config: { effort: native.effort?.[mode] ?? mode } };
  }
  const p = profile(baseUrl, model);
  const parameters: Record<string, unknown> = p.switchParam === 'enable_thinking'
    ? { enable_thinking: mode !== 'off' } : { thinking: { type: mode === 'off' ? 'disabled' : 'enabled' } };
  if (mode !== 'off') {
    if (p.budget) parameters.thinking_budget = budget[mode];
    else parameters.reasoning_effort = p.effort![mode];
  }
  return parameters;
}

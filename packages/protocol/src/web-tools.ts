import type { ApiProtocol } from './api';

export type ServerWebTool = 'web_search' | 'web_extractor';
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface ServerWebToolsConfig {
  search: boolean;
  extractor: boolean;
}

export interface ServerWebToolSupport {
  search: CapabilityState;
  extractor: CapabilityState;
  reason?: string;
}

export const defaultServerWebTools = (): ServerWebToolsConfig => ({ search: true, extractor: true });

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; }
}

function dashscopeHost(host: string): boolean {
  return /(^|\.)(qianwenaiapi\.com|aliyuncs\.com)$/.test(host);
}

function openAiHost(host: string): boolean {
  return host === 'api.openai.com' || host.endsWith('.openai.azure.com');
}

function modelMatches(model: string, pattern: RegExp): boolean {
  return pattern.test(model.trim());
}

const DASH_SCOPE_SEARCH = /^(?:qwen4-max-preview|qwen3\.(?:5|6|7|8)-(?:max(?:-preview|-\d{4})?|plus(?:-\d{4})?|flash(?:-\d{4})?|2\.4t-a95b|27b)|qwen3\.8-omni-flash|deepseek-v4(?:-pro(?:-0813)?|-flash-0731)|deepseek-v4\.1-flash-1017|glm-5\.2|kimi-k3(?:\.1-pro)?)$/i;
const DASH_SCOPE_EXTRACTOR = /^(?:qwen3\.(?:5|6|7|8)-(?:max(?:-preview|-\d{4})?|plus(?:-\d{4})?|flash(?:-\d{4})?|2\.4t-a95b|27b)|deepseek-v4(?:-pro(?:-0813)?|-flash-0731)|deepseek-v4\.1-flash-1017|glm-5\.2|kimi-k3(?:\.1-pro)?)$/i;
const ANTHROPIC_MODEL = /^(?:claude|qwen|deepseek|glm-|kimi-)/i;
const OPENAI_MODEL = /^(?:gpt-|o\d)/i;

/** Provider/model capability declaration for hosted server-side web tools. */
export function serverWebToolSupport(baseUrl: string, model: string, protocol: ApiProtocol = 'responses', thinkingMode?: string): ServerWebToolSupport {
  const host = hostOf(baseUrl);
  if (protocol === 'chat_completions') return { search: 'unsupported', extractor: 'unsupported', reason: 'Chat Completions 没有统一的服务端网页工具协议' };
  if (protocol === 'responses') {
    if (dashscopeHost(host)) {
      const search = modelMatches(model, DASH_SCOPE_SEARCH) ? 'supported' : 'unknown';
      const extractor = modelMatches(model, DASH_SCOPE_EXTRACTOR) && thinkingMode !== 'off' ? 'supported' : modelMatches(model, DASH_SCOPE_EXTRACTOR) ? 'unsupported' : 'unknown';
      return { search, extractor, ...(extractor === 'unsupported' ? { reason: '网页提取需要启用思考模式' } : {}) };
    }
    if (openAiHost(host)) return { search: modelMatches(model, OPENAI_MODEL) ? 'supported' : 'unknown', extractor: 'unsupported', reason: 'OpenAI Responses 当前统一提供 web_search，未提供 web_extractor' };
    return { search: 'unknown', extractor: 'unknown', reason: '自定义 Responses 网关的网页工具能力未声明' };
  }
  if (dashscopeHost(host) || host === 'api.anthropic.com') {
    const supported = modelMatches(model, ANTHROPIC_MODEL);
    return { search: supported ? 'supported' : 'unknown', extractor: supported ? 'supported' : 'unknown' };
  }
  return { search: 'unknown', extractor: 'unknown', reason: '自定义 Anthropic 网关的网页工具能力未声明' };
}

export const API_PROTOCOLS = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = {
  chat_completions: 'Chat Completions', responses: 'Responses', anthropic_messages: 'Anthropic Messages',
};

export function apiProtocol(value: unknown): ApiProtocol {
  if (value === undefined) return 'chat_completions';
  if (!API_PROTOCOLS.includes(value as ApiProtocol)) throw new Error('无效的接口协议');
  return value as ApiProtocol;
}

const paths: Record<ApiProtocol, string> = { chat_completions: '/chat/completions', responses: '/responses', anthropic_messages: '/messages' };

/** 同时接受 API 根地址与完整端点；绝不在协议之间自动切换。 */
export function apiBase(value: string, protocol: ApiProtocol = 'chat_completions'): string {
  const base = value.trim().replace(/\/+$/, '');
  if (!base || base.includes('${')) return '';
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('接口地址必须是无凭证、无查询参数的 HTTP(S) 地址');
  const endpoint = Object.values(paths).find((p) => url.pathname.endsWith(p));
  if (endpoint) {
    if (endpoint !== paths[protocol]) throw new Error(`接口地址与 ${API_PROTOCOL_LABELS[protocol]} 协议不匹配`);
    return base;
  }
  return /\/v\d+(?:beta)?$/.test(url.pathname) ? base : `${base}/v1`;
}

export function apiUrl(value: string, protocol: ApiProtocol = 'chat_completions'): string {
  const base = apiBase(value, protocol);
  return base.endsWith(paths[protocol]) ? base : `${base}${paths[protocol]}`;
}

export interface TokenUsage {
  /** 包含缓存读取和写入的总输入 token；不据此推断实际账单折扣。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 仅识别已经核对过的百炼服务域名，其他兼容网关按通用协议处理。 */
export function isDashscopeEndpoint(baseUrl: string): boolean {
  try { return /(^|\.)(qianwenaiapi\.com|aliyuncs\.com)$/.test(new URL(baseUrl).hostname); } catch { return false; }
}

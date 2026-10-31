import type { DecideRequest, DecideResult } from './types';

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}`); }
}

export function redact(text: string, key: string | null): string {
  return (key ? text.split(key).join('***') : text).replace(/\b(sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1***');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** 只在尚未读取任何响应内容前重试。所有协议、降级和退避共用调用方的总时限。 */
export async function post(
  url: string, body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal,
  onEvent?: (event: Record<string, any>) => void,
): Promise<any> {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal.aborted || attempt >= 2) throw error;
      await delay(800 * (attempt + 1), signal);
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await delay(800 * (attempt + 1), signal);
      continue;
    }
    break;
  }
  if (!response.ok) throw new HttpError(response.status, await response.text());
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new HttpError(response.status, `返回的不是 JSON：${text.slice(0, 200)}`); }
  }
  if (!onEvent) throw new HttpError(response.status, '没有流式事件解析器');
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(response.status, '流式响应没有正文');
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let done = false;
  const dispatch = () => {
    const text = data.join('\n'); data = [];
    if (!text) return;
    if (text === '[DONE]') { done = true; return; }
    let event: Record<string, any>;
    try { event = JSON.parse(text); } catch { throw new HttpError(200, '流式事件不是合法 JSON'); }
    onEvent(event);
  };
  const line = (value: string) => {
    const text = value.replace(/\r$/, '');
    if (!text) dispatch();
    else if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) { buffer += decoder.decode(); break; }
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const current = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); line(current);
        if (done) break;
      }
    }
    if (buffer.trim() && !done) line(buffer);
    if (!done) dispatch();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return undefined;
}

export function failure(started: number, error: string, extra: Partial<DecideResult> = {}): DecideResult {
  return { ok: false, error, toolCallIds: [], latencyMs: Date.now() - started, ...extra };
}

/** 对所有协议提供相同的取消、超时分类与错误脱敏，不返回不完整的原生工具链。 */
export async function runRequest(
  req: DecideRequest,
  execute: (signal: AbortSignal, started: number, onDelta: NonNullable<DecideRequest['onDelta']>) => Promise<DecideResult>,
): Promise<DecideResult> {
  const started = Date.now();
  const budget = AbortSignal.timeout(Math.max(1, Math.ceil(req.config.timeoutSec * 1000)));
  const signal = req.signal ? AbortSignal.any([req.signal, budget]) : budget;
  const partial = { thinking: '', reply: '' };
  try {
    return await execute(signal, started, (delta) => {
      partial.thinking += delta.thinking ?? ''; partial.reply += delta.reply ?? ''; req.onDelta?.(delta);
    });
  } catch (error) {
    const notes: Partial<DecideResult> = { fatal: true, ...partial,
      ...(partial.reply ? { assistant: { role: 'assistant', content: partial.reply } } : {}),
      ...(partial.reply || partial.thinking ? { raw: { partial: true, ...partial } } : {}),
    };
    if (req.signal?.aborted) return failure(started, '请求已取消', { ...notes, failureKind: 'cancelled' });
    if (budget.aborted) return failure(started, `超过 ${req.config.timeoutSec} 秒没有完成回复`, { ...notes, failureKind: 'timeout' });
    if (error instanceof HttpError) return failure(started, redact(`接口返回 ${error.status}：${error.body.slice(0, 300)}`, req.config.apiKey), { ...notes, failureKind: 'http' });
    return failure(started, redact(`请求失败：${(error as Error).message}`, req.config.apiKey), { ...notes, failureKind: 'network' });
  }
}

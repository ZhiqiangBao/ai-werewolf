import { gameText, type ApiProtocol, type BodyEndKind, type FirstContentKind, type ObservationOutcome } from '@werewolf/protocol';
import type { DecideRequest, DecideResult } from './types';
import { AdapterObserver, measured, missing, type ObservationSpan } from './observation';
import { streamContentKind, UsageSnapshot } from './observation-content';

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly observationOutcome: 'http_error' | 'parse_error' = 'http_error') { super(`HTTP ${status}`); }
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

export const abortedOutcome = (signal: AbortSignal): 'timeout' | 'cancelled' => signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';

/** 只在尚未读取任何响应内容前重试。所有协议、降级和退避共用调用方的总时限。 */
export async function post(
  url: string, body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal,
  onEvent?: (event: Record<string, any>) => void, locale?: string,
  observation?: { observer: AdapterObserver; request: ObservationSpan; protocol: ApiProtocol },
): Promise<any> {
  let response: Response | undefined;
  let active: ObservationSpan | undefined;
  let headersAt: number | undefined;
  let firstByte: number | undefined;
  let firstContent: number | undefined;
  let firstKind: FirstContentKind | undefined;
  let parseMs = 0;
  let parsed = false;
  let bodyEnd: BodyEndKind | undefined;
  let bodyEndAt: number | undefined;
  let parsedOutputAt: number | undefined;
  let protocolEnded = false;
  let usage: UsageSnapshot | undefined;
  const now = () => observation!.observer.now();
  const finishAttempt = (outcome: ObservationOutcome) => {
    if (!active) return;
    const end = now();
    const reason = signal.aborted ? 'cancelled_before_point' : 'failed_before_point';
    const contentMissing = outcome === 'success' ? 'not_emitted' : reason;
    const duration = measured(end - active.started);
    active.finish(outcome, { status: response?.status, bodyEndKind: bodyEnd,
      ...(firstKind ? { firstContentKind: firstKind } : {}),
      metrics: { httpAttemptMs: duration, requestSendMs: missing('not_observable'), providerQueueMs: missing('not_observable'),
        headersMs: headersAt === undefined ? missing(reason) : measured(headersAt - active.started),
        firstBodyByteMs: firstByte === undefined ? missing(headersAt === undefined ? reason : response?.headers.get('content-type')?.includes('text/event-stream') ? contentMissing : 'not_observable') : measured(firstByte - active.started),
        firstStreamContentMs: firstContent === undefined ? missing(headersAt === undefined ? reason : response?.headers.get('content-type')?.includes('text/event-stream') ? contentMissing : 'not_applicable') : measured(firstContent - active.started),
        bodyConsumeMs: headersAt === undefined ? missing(reason) : measured((bodyEndAt ?? end) - headersAt),
        parseMs: parsed ? measured(parseMs) : missing(headersAt === undefined || signal.aborted || outcome === 'network_error' ? reason : 'not_applicable'),
        parsedOutputAvailableMs: parsedOutputAt === undefined ? missing(response?.headers.get('content-type')?.includes('text/event-stream') ? 'not_applicable' : reason) : measured(parsedOutputAt - active.started),
      }, ...(usage ? { usage: { ...usage.value(), sourceHttpAttemptId: active.id } } : {}) });
    active = undefined;
  };
  const recordUsage = (raw: unknown) => { usage?.merge(raw); };
  const backoff = async (attempt: number, retryReason: 'network' | '429' | '5xx') => {
    const wait = 800 * (attempt + 1);
    const span = observation?.observer.start('backoff', observation.request.id, { requestId: observation.request.id, attemptIndex: attempt, retryReason, metrics: { plannedWaitMs: measured(wait) } });
    try { await delay(wait, signal); span?.finish('success', { metrics: { plannedWaitMs: measured(wait), backoffMs: measured(now() - span.started) } }); }
    catch (error) { span?.finish(signal.aborted ? abortedOutcome(signal) : 'network_error', { metrics: { plannedWaitMs: measured(wait), backoffMs: measured(now() - span.started) } }); throw error; }
  };
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    // Keep JSON.stringify inside the retry loop, at the original fetch argument position.
    headersAt = firstByte = firstContent = bodyEndAt = parsedOutputAt = undefined; firstKind = undefined; bodyEnd = undefined; protocolEnded = false; parseMs = 0; parsed = false; response = undefined;
    usage = observation ? new UsageSnapshot(observation.protocol) : undefined;
    try {
      const serialize = observation?.observer.start('local_span', observation.request.id, { requestId: observation.request.id, operation: 'serialize', attemptIndex: attempt });
      let serialized: string;
      try { serialized = JSON.stringify(body); serialize?.finish('success', { metrics: { serializeMs: measured(now() - serialize.started) } }); }
      catch (error) { serialize?.finish('local_error', { metrics: { serializeMs: measured(now() - serialize.started) } }); throw error; }
      active = observation?.observer.start('http_attempt', observation.request.id, { requestId: observation.request.id, attemptIndex: attempt });
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: serialized, signal });
      if (active) headersAt = now();
    } catch (error) {
      finishAttempt(signal.aborted ? abortedOutcome(signal) : 'network_error');
      if (signal.aborted || attempt >= 2) throw error;
      await backoff(attempt, 'network');
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      try { await response.body?.cancel(); bodyEnd = 'discarded'; if (active) bodyEndAt = now(); finishAttempt('http_error'); }
      catch (error) { bodyEnd = signal.aborted ? 'cancelled' : 'error'; finishAttempt(signal.aborted ? abortedOutcome(signal) : 'network_error'); throw error; }
      await backoff(attempt, response.status === 429 ? '429' : '5xx');
      continue;
    }
    break;
  }
  try {
    if (!response.ok) {
      const text = await response.text(); bodyEnd = 'eof'; if (active) bodyEndAt = now();
      // The error body was already consumed by the original path.  Extract only
      // numeric usage when observation is enabled, without changing HttpError.
      if (active && usage) { try { recordUsage(JSON.parse(text)?.usage); } catch { /* non-JSON errors retain the original behavior */ } }
      throw new HttpError(response.status, text);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const text = await response.text(); bodyEnd = 'eof'; if (active) bodyEndAt = now();
      const parseStart = active ? now() : 0;
      if (active) parsed = true;
      try {
        const result = JSON.parse(text);
        if (active) parsedOutputAt = now();
        if (usage) recordUsage(result?.usage);
        return result;
      } catch { throw new HttpError(response.status, gameText(locale, '返回的不是 JSON：{0}', text.slice(0, 200)), 'parse_error'); }
      finally { if (active) parseMs += now() - parseStart; }
    }
    if (!onEvent) throw new HttpError(response.status, gameText(locale, '没有流式事件解析器'));
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(response.status, gameText(locale, '流式响应没有正文'));
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let done = false;
    const dispatch = () => {
      const text = data.join('\n'); data = [];
      if (!text) return;
      if (text === '[DONE]') { done = true; return; }
      let event: Record<string, any>;
      const parseStart = active ? now() : 0;
      if (active) parsed = true;
      try { event = JSON.parse(text); } catch { throw new HttpError(200, gameText(locale, '流式事件不是合法 JSON'), 'parse_error'); }
      finally { if (active) parseMs += now() - parseStart; }
      if (observation && active) {
        if (firstContent === undefined) { const kind = streamContentKind(observation.protocol, event); if (kind) { firstContent = now(); firstKind = kind; } }
        if (observation.protocol === 'chat_completions') recordUsage(event.usage);
        else if (observation.protocol === 'responses') recordUsage(event.response?.usage);
        else { recordUsage(event.message?.usage); recordUsage(event.usage); }
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'message_stop') protocolEnded = true;
      const processStart = active ? now() : 0;
      try { onEvent(event); } finally { if (active) parseMs += now() - processStart; }
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
        if (active && firstByte === undefined && chunk.value.byteLength) firstByte = now();
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const current = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); line(current);
          if (done) break;
        }
      }
      if (buffer.trim() && !done) line(buffer);
      if (!done) dispatch();
      bodyEnd = done || protocolEnded ? 'protocol_end' : 'eof';
      if (active) bodyEndAt = now();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    bodyEnd ??= signal.aborted ? 'cancelled' : 'error';
    finishAttempt(signal.aborted ? abortedOutcome(signal) : error instanceof HttpError ? error.observationOutcome : 'network_error');
    throw error;
  } finally {
    finishAttempt('success');
  }
  return undefined;
}

export function failure(started: number, error: string, extra: Partial<DecideResult> = {}): DecideResult {
  return { ok: false, error, toolCallIds: [], latencyMs: Date.now() - started, ...extra };
}

/** 对所有协议提供相同的取消、超时分类与错误脱敏，不返回不完整的原生工具链。 */
export async function runRequest(
  req: DecideRequest,
  execute: (signal: AbortSignal, started: number, onDelta: NonNullable<DecideRequest['onDelta']>, observation?: { observer: AdapterObserver; adapter: ObservationSpan }) => Promise<DecideResult>,
): Promise<DecideResult> {
  const started = Date.now();
  const observer = req.observation ? new AdapterObserver(req.observation) : undefined;
  const adapter = observer?.start('adapter_execution', observer.callId);
  // Preserve the original rejected Promise for an invalid timeout, while closing
  // its observation span even if constructing the timeout signal throws.
  let budget: AbortSignal;
  try { budget = AbortSignal.timeout(Math.max(1, Math.ceil(req.config.timeoutSec * 1000))); }
  catch (error) { adapter?.finish('local_error', { metrics: { adapterExecutionMs: measured(observer!.now() - adapter.started) }, httpAttemptsStarted: 0, httpAttemptsFinished: 0, compatibilityFallbacks: 0 }); throw error; }
  let signal: AbortSignal;
  try { signal = req.signal ? AbortSignal.any([req.signal, budget]) : budget; }
  catch (error) { adapter?.finish('local_error', { metrics: { adapterExecutionMs: measured(observer!.now() - adapter.started) }, httpAttemptsStarted: 0, httpAttemptsFinished: 0, compatibilityFallbacks: 0 }); throw error; }
  const partial = { thinking: '', reply: '' };
  const adapterFields = () => ({ metrics: { adapterExecutionMs: measured(observer!.now() - adapter!.started) },
    httpAttemptsStarted: observer!.attemptsStarted, httpAttemptsFinished: observer!.attemptsFinished, compatibilityFallbacks: Math.max(0, observer!.requestsStarted - 1) });
  try {
    const result = await execute(signal, started, (delta) => {
      partial.thinking += delta.thinking ?? ''; partial.reply += delta.reply ?? ''; req.onDelta?.(delta);
    }, observer && adapter ? { observer, adapter } : undefined);
    adapter?.finish(result.ok ? 'success' : observer!.requestsStarted === 0 ? 'local_error' : result.fatal ? 'local_error' : 'invalid_tool', adapterFields());
    return result;
  } catch (error) {
    adapter?.finish(req.signal?.aborted ? 'cancelled' : budget.aborted ? 'timeout' : observer!.requestsStarted === 0 ? 'local_error' : error instanceof HttpError ? error.observationOutcome : 'network_error', adapterFields());
    const notes: Partial<DecideResult> = { fatal: true, ...partial,
      ...(partial.reply ? { assistant: { role: 'assistant', content: partial.reply } } : {}),
      ...(partial.reply || partial.thinking ? { raw: { partial: true, ...partial } } : {}),
    };
    if (req.signal?.aborted) return failure(started, gameText(req.projection?.locale ?? req.locale, '请求已取消'), { ...notes, failureKind: 'cancelled' });
    if (budget.aborted) return failure(started, gameText(req.projection?.locale ?? req.locale, '超过 {0} 秒没有完成回复', req.config.timeoutSec), { ...notes, failureKind: 'timeout' });
    if (error instanceof HttpError) return failure(started, redact(gameText(req.projection?.locale ?? req.locale, '接口返回 {0}：{1}', error.status, error.body.slice(0, 300)), req.config.apiKey), { ...notes, failureKind: 'http' });
    return failure(started, redact(gameText(req.projection?.locale ?? req.locale, '请求失败：{0}', (error as Error).message), req.config.apiKey), { ...notes, failureKind: 'network' });
  }
}

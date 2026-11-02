import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterObservationEvent, ApiProtocol, DecideObservationPort, ToolSpec } from '@werewolf/protocol';
import { remoteAdapter } from '../src/adapters';

const tool: ToolSpec = { name: 'vote', title: 'vote', description: 'private-tool-description', params: [] };
const config = (apiProtocol: ApiProtocol) => ({ apiProtocol, baseUrl: 'http://localhost:1234/v1', model: 'observation-test', apiKey: 'private-key', temperature: 0.5, timeoutSec: 30, toolMode: 'tools' as const });
const port = () => {
  let time = 0;
  const events: AdapterObservationEvent[] = [];
  const observation: DecideObservationPort = { callId: 'call-1', clock: { monotonicMs: () => ++time, wallTimeMs: () => 0 }, emit: (event) => events.push(event) };
  return { events, observation };
};
const request = (protocol: ApiProtocol, observation?: DecideObservationPort, stream = true) => ({ seat: 1 as const, messages: [{ role: 'user' as const, content: 'private-message' }], tools: [tool], config: config(protocol), observation, stream });
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const streams: Record<ApiProtocol, unknown[]> = {
  chat_completions: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'private-id', function: { name: '', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'vote', arguments: '{}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 0, completion_tokens: 3 } },
  ],
  responses: [
    { type: 'response.function_call_arguments.delta', delta: '{}' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', name: 'vote', call_id: 'private-id', arguments: '{}' }], usage: { input_tokens: 0, output_tokens: 3 } } },
  ],
  anthropic_messages: [
    { type: 'message_start', message: { usage: { input_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'private-id', name: 'vote', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('数值观测旁路', () => {
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 纯工具流保留业务结果、usage 存在性和隐私', async (protocol) => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => { bodies.push(String(init.body)); return sse(streams[protocol]); }));
    const control = await remoteAdapter(protocol).decide(request(protocol));
    const { observation, events } = port();
    const deltas: unknown[] = [];
    const observed = await remoteAdapter(protocol).decide({ ...request(protocol, observation), onDelta: (delta) => deltas.push(delta) });
    expect(observed.call).toEqual(control.call);
    expect(observed.assistant).toEqual(control.assistant);
    expect(observed.usage).toEqual(control.usage);
    expect(bodies[0]).toBe(bodies[1]);
    expect(deltas).toEqual([]);
    const starts = events.filter((e) => e.kind === 'http_attempt' && e.phase === 'start');
    const ends = events.filter((e) => e.kind === 'http_attempt' && e.phase === 'end');
    expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
    expect(starts[0].httpAttemptId).toBe(starts[0].id);
    expect(ends[0].id).toBe(starts[0].id);
    expect(ends[0].firstContentKind).toBe(protocol === 'responses' ? 'tool_arguments' : 'tool_name');
    expect(ends[0].bodyEndKind).toBe('protocol_end');
    expect(ends[0].usage?.outputTokens).toBe(3);
    expect(ends[0].usage?.sourceHttpAttemptId).toBe(starts[0].id);
    expect(ends[0].usage?.inputTokens).toBe(protocol === 'anthropic_messages' ? 4 : 0);
    expect(JSON.stringify(events)).not.toMatch(/private-|localhost|vote/);
    expect(events.filter((e) => e.kind === 'adapter_execution' && e.phase === 'end')).toHaveLength(1);
  });

  it('非流式正文独立记录解析，首字节和流式首内容不伪造', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { tool_calls: [{ id: 'id', function: { name: 'vote', arguments: '{}' } }] } }], usage: { prompt_tokens: 0 } })));
    const { observation, events } = port();
    expect((await remoteAdapter('chat_completions').decide(request('chat_completions', observation, false))).ok).toBe(true);
    const end = events.find((e) => e.kind === 'http_attempt' && e.phase === 'end')!;
    expect(end.metrics?.firstBodyByteMs).toEqual({ valueMs: null, reason: 'not_observable' });
    expect(end.metrics?.firstStreamContentMs).toEqual({ valueMs: null, reason: 'not_applicable' });
    expect(end.metrics?.parsedOutputAvailableMs?.valueMs).not.toBeNull();
    expect(end.usage).toMatchObject({ inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, completeness: 'partial' });
  });

  it('Anthropic 分段合并 usage 时不把未报告的缓存量推断为零', async () => {
    const events = structuredClone(streams.anthropic_messages) as any[];
    events[0].message.usage = { input_tokens: 10 };
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const observed = port();
    expect((await remoteAdapter('anthropic_messages').decide(request('anthropic_messages', observed.observation))).usage)
      .toMatchObject({ inputTokens: 10, outputTokens: 3 });
    const usage = observed.events.find((e) => e.kind === 'http_attempt' && e.phase === 'end')?.usage;
    expect(usage).toMatchObject({ inputTokens: null, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, completeness: 'partial' });
    events[0].message.usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const complete = port();
    await remoteAdapter('anthropic_messages').decide(request('anthropic_messages', complete.observation));
    expect(complete.events.find((e) => e.kind === 'http_attempt' && e.phase === 'end')?.usage)
      .toMatchObject({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, completeness: 'complete' });
  });

  it('429、500 后重试成功，退避与每次 HTTP 的标识均独立', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(sse(streams.chat_completions));
    vi.stubGlobal('fetch', fetch);
    const { observation, events } = port();
    const promise = remoteAdapter('chat_completions').decide(request('chat_completions', observation));
    await vi.runAllTimersAsync();
    expect((await promise).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    const attempts = events.filter((e) => e.kind === 'http_attempt' && e.phase === 'end');
    expect(attempts.map((e) => e.status)).toEqual([429, 500, 200]);
    expect(new Set(attempts.map((e) => e.id)).size).toBe(3);
    const waits = events.filter((e) => e.kind === 'backoff' && e.phase === 'end');
    expect(waits.map((e) => e.retryReason)).toEqual(['429', '5xx']);
    expect(waits.map((e) => e.metrics?.plannedWaitMs?.valueMs)).toEqual([800, 1600]);
  });

  it('组合兼容回退与热记忆按实际请求变体分别记录', async () => {
    const success = { choices: [{ message: { tool_calls: [{ id: 'id', function: { name: 'vote', arguments: '{}' } }] } }] };
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); sent.push(body);
      if (body.stream) return new Response('stream unsupported', { status: 400 });
      if (body.tool_choice === 'required') return new Response('tool_choice unsupported', { status: 400 });
      return Response.json(success);
    }));
    const first = port();
    const req = request('chat_completions', first.observation);
    req.config.model = 'observation-fallback-unique';
    expect((await remoteAdapter('chat_completions').decide(req)).ok).toBe(true);
    const variants = first.events.filter((e) => e.kind === 'http_request' && e.phase === 'start');
    expect(variants.map((e) => e.variantReason)).toEqual(['initial', 'stream_unsupported', 'tool_choice_unsupported']);
    expect(variants.map((e) => e.features)).toMatchObject([
      { stream: true, toolChoice: 'required', compatibilityMemory: 'cold' },
      { stream: false, toolChoice: 'required', compatibilityMemory: 'cold' },
      { stream: false, toolChoice: 'auto', compatibilityMemory: 'cold' },
    ]);
    const second = port();
    expect((await remoteAdapter('chat_completions').decide({ ...req, observation: second.observation })).ok).toBe(true);
    const warm = second.events.filter((e) => e.kind === 'http_request' && e.phase === 'start');
    expect(warm).toHaveLength(1);
    expect(warm[0].features).toMatchObject({ stream: false, toolChoice: 'auto', compatibilityMemory: 'warm' });
    expect(sent).toHaveLength(4);
  });

  it('无内容与损坏流都结束观测，且不会把私密错误写入事件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: not-json-private\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    const { observation, events } = port();
    const result = await remoteAdapter('responses').decide(request('responses', observation));
    expect(result.ok).toBe(false);
    const end = events.find((e) => e.kind === 'http_attempt' && e.phase === 'end')!;
    expect(end.outcome).toBe('parse_error');
    expect(end.bodyEndKind).toBe('error');
    expect(end.metrics?.firstStreamContentMs).toEqual({ valueMs: null, reason: 'failed_before_point' });
    expect(JSON.stringify(events)).not.toContain('not-json-private');
    for (const start of events.filter((e) => e.phase === 'start')) expect(events.filter((e) => e.phase === 'end' && e.id === start.id)).toHaveLength(1);
  });

  it('流中取消保留已收到的 usage 和首内容，并以取消结束一次', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          const chunk = { choices: [{ delta: { content: 'private-delta' } }], usage: { prompt_tokens: 8 } };
          streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.signal.addEventListener('abort', () => streamController.error(controller.signal.reason), { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const { observation, events } = port();
    const result = await remoteAdapter('chat_completions').decide({ ...request('chat_completions', observation), signal: controller.signal, onDelta: () => controller.abort() });
    expect(result.failureKind).toBe('cancelled');
    const attempt = events.find((e) => e.kind === 'http_attempt' && e.phase === 'end')!;
    expect(attempt).toMatchObject({ outcome: 'cancelled', bodyEndKind: 'cancelled', firstContentKind: 'reply', usage: { inputTokens: 8, outputTokens: null } });
    expect(JSON.stringify(events)).not.toContain('private-delta');
    for (const start of events.filter((e) => e.phase === 'start')) expect(events.filter((e) => e.phase === 'end' && e.id === start.id)).toHaveLength(1);
  });

  it('网络失败重试沿用预算，且序列化仍逐次发生', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new Error('private-network-error')).mockResolvedValueOnce(sse(streams.chat_completions));
    vi.stubGlobal('fetch', fetch);
    const { observation, events } = port();
    const promise = remoteAdapter('chat_completions').decide(request('chat_completions', observation));
    await vi.runAllTimersAsync();
    expect((await promise).ok).toBe(true);
    expect(events.filter((e) => e.kind === 'local_span' && e.phase === 'end' && e.operation === 'serialize')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'http_attempt' && e.phase === 'end').map((e) => e.outcome)).toEqual(['network_error', 'success']);
    expect(events.find((e) => e.kind === 'backoff' && e.phase === 'end')?.retryReason).toBe('network');
    expect(JSON.stringify(events)).not.toContain('private-network-error');
  });

  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 响应头前超时结束请求与尝试且不重试', async (protocol) => {
    const fetch = vi.fn(async (_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })));
    vi.stubGlobal('fetch', fetch);
    const { observation, events } = port();
    const req = request(protocol, observation); req.config.timeoutSec = 0.01;
    const result = await remoteAdapter(protocol).decide(req);
    expect(result.failureKind).toBe('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.kind === 'http_attempt' && e.phase === 'end')).toMatchObject({ outcome: 'timeout', metrics: { headersMs: { valueMs: null, reason: 'cancelled_before_point' } } });
    expect(events.find((e) => e.kind === 'http_request' && e.phase === 'end')?.outcome).toBe('timeout');
    expect(events.find((e) => e.kind === 'adapter_execution' && e.phase === 'end')?.outcome).toBe('timeout');
  });

  it('观测回调抛错不会影响结果；取消流时所有开始的段恰好结束一次', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(streams.responses)));
    const throwing = port().observation; throwing.emit = () => { throw new Error('observer error'); };
    expect((await remoteAdapter('responses').decide(request('responses', throwing))).ok).toBe(true);
    const { observation, events } = port();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))));
    const promise = remoteAdapter('responses').decide({ ...request('responses', observation), signal: controller.signal });
    controller.abort();
    expect((await promise).failureKind).toBe('cancelled');
    for (const start of events.filter((e) => e.phase === 'start')) expect(events.filter((e) => e.phase === 'end' && e.id === start.id)).toHaveLength(1);
  });

  it('非法超时配置维持原来的拒绝，并关闭本地适配器观测', async () => {
    const { observation, events } = port();
    const req = request('responses', observation); req.config.timeoutSec = Number.NaN;
    await expect(remoteAdapter('responses').decide(req)).rejects.toThrow();
    expect(events.filter((e) => e.kind === 'adapter_execution' && e.phase === 'end')).toMatchObject([{ outcome: 'local_error' }]);
    expect(events.filter((e) => e.kind === 'http_attempt')).toHaveLength(0);
  });
});

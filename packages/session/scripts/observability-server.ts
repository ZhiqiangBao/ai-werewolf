import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { SyntheticResponsePlan } from '../src/observability/synthetic-service';

const plans = new Map<string, SyntheticResponsePlan>();
let active = 0;
const waiters: (() => void)[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const send = (value: unknown) => { if (process.connected) process.send?.(value); };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function payload(plan: SyntheticResponsePlan): { json: unknown; events: string[] } {
  const { call, protocol } = plan;
  if (protocol === 'chat_completions') {
    const tool = call && !plan.jsonMode ? { id: 'synthetic-call', type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } } : undefined;
    const content = call && plan.jsonMode ? JSON.stringify(call) : call ? null : '好的。';
    const message = { role: 'assistant', content, ...(tool ? { tool_calls: [tool] } : {}) };
    return { json: { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 3 } }, events: [
      sse({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, ...tool }] } : { content } }] }),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }), 'data: [DONE]\n\n',
    ] };
  }
  if (protocol === 'responses') {
    const item = call ? { type: 'function_call', call_id: 'synthetic-call', name: call.tool, arguments: JSON.stringify(call.args) }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的。' }] };
    const response = { status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3 } };
    const first = call ? { type: 'response.output_item.added', output_index: 0, item } : { type: 'response.output_text.delta', delta: '好的。' };
    return { json: response, events: [sse(first), sse({ type: 'response.completed', response }), 'data: [DONE]\n\n'] };
  }
  const block = call ? { type: 'tool_use', id: 'synthetic-call', name: call.tool, input: call.args } : { type: 'text', text: '好的。' };
  const message = { role: 'assistant', content: [block], stop_reason: call ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  return { json: message, events: [sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    sse({ type: 'content_block_start', index: 0, content_block: block }),
    sse({ type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 3 } }), sse({ type: 'message_stop' })] };
}

const server = createServer(async (req, res) => {
  req.resume();
  const id = req.headers['x-synthetic-attempt-id'];
  const plan = typeof id === 'string' ? plans.get(id) : undefined;
  if (!plan || typeof id !== 'string') { res.writeHead(400).end(); return; }
  plans.delete(id);
  const entered = performance.now();
  if (plan.capacity && active >= plan.capacity) await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  const started = performance.now();
  let headersAt: number | null = null, firstBodyAt: number | null = null, firstContentAt: number | null = null, bodyEndAt: number | null = null, finished = false;
  try {
    await sleep(plan.headersMs);
    if (plan.disconnect) { req.socket.destroy(); return; }
    const status = plan.status ?? 200;
    res.writeHead(status, { 'content-type': plan.stream ? 'text/event-stream' : 'application/json' });
    res.flushHeaders();
    headersAt = performance.now();
    if (status >= 400) {
      const messages = { unsupported_stream: 'stream is unsupported', unsupported_tool_choice: 'tool_choice is unsupported', unsupported_json: 'response_format is unsupported' };
      firstBodyAt = performance.now(); res.end(JSON.stringify({ error: { message: plan.errorKind ? messages[plan.errorKind] : 'synthetic failure' } })); bodyEndAt = performance.now(); finished = true; return;
    }
    const data = payload(plan);
    await sleep(plan.firstContentMs);
    if (plan.malformed) { firstBodyAt = performance.now(); res.end(plan.stream ? 'data: {invalid\n\n' : '{invalid'); bodyEndAt = performance.now(); finished = true; return; }
    if (plan.noContent) {
      firstBodyAt = performance.now();
      const ending = plan.protocol === 'anthropic_messages'
        ? `${sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10 } } })}${sse({ type: 'message_stop' })}`
        : plan.protocol === 'responses' ? `${sse({ type: 'response.completed', response: { status: 'completed', output: [] } })}data: [DONE]\n\n`
          : 'data: [DONE]\n\n';
      res.end(`: heartbeat\n\n${ending}`); bodyEndAt = performance.now(); finished = true; return;
    }
    if (!plan.stream) { firstBodyAt = performance.now(); res.end(JSON.stringify(data.json)); bodyEndAt = performance.now(); finished = true; return; }
    if (plan.hangAfterContent || plan.disconnectAfterContent) {
      const count = plan.protocol === 'anthropic_messages' ? 2 : 1;
      for (let i = 0; i < count; i++) { const at = performance.now(); firstBodyAt ??= at; if (i === count - 1) firstContentAt = at; res.write(data.events[i]); }
      if (plan.disconnectAfterContent) { await sleep(30); req.socket.destroy(); return; }
      if (!res.destroyed) await new Promise<void>((resolve) => res.once('close', resolve));
      return;
    }
    const chunks = Math.max(plan.chunks, data.events.length);
    for (let i = 0; i < chunks; i++) {
      if (res.destroyed) return;
      // Keep the terminal event last, so long-response chunks are actually consumed.
      const tail = data.events.at(-1)!;
      const body = data.events.slice(0, -1);
      const at = performance.now();
      firstBodyAt ??= at;
      if (i === (plan.protocol === 'anthropic_messages' ? 1 : 0)) firstContentAt = at;
      res.write(i === chunks - 1 ? tail : (body[i] ?? ': heartbeat\n\n'));
      if (i + 1 < chunks) await sleep(plan.chunkIntervalMs);
    }
    res.end(); bodyEndAt = performance.now(); finished = true;
  } finally {
    send({ type: 'truth', truth: { attemptId: id, source: 'synthetic',
      planned: { headersMs: plan.headersMs, firstContentMs: plan.firstContentMs, chunks: plan.chunks, chunkIntervalMs: plan.chunkIntervalMs,
        status: plan.status ?? 200, capacity: plan.capacity ?? null },
      queueMs: plan.omitQueue ? null : started - entered, headersMs: headersAt === null ? null : headersAt - started,
      firstBodyByteMs: firstBodyAt === null ? null : firstBodyAt - started,
      firstStreamContentMs: firstContentAt === null ? null : firstContentAt - started,
      bodyConsumeMs: bodyEndAt === null || headersAt === null ? null : bodyEndAt - headersAt,
      elapsedMs: performance.now() - started, finished } });
    active--; waiters.shift()?.();
  }
});
server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') send({ type: 'ready', port: address.port }); });
process.on('message', (message: { type: string; id?: string; plan?: SyntheticResponsePlan }) => {
  if (message.type === 'register' && message.id && message.plan) {
    if (plans.has(message.id)) return;
    plans.set(message.id, message.plan); send({ type: 'registered', id: message.id });
  }
  if (message.type === 'close') { server.close(() => process.exit(0)); server.closeAllConnections(); }
});
process.on('disconnect', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });

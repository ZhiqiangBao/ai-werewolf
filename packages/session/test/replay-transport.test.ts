import { afterEach, describe, expect, it, vi } from 'vitest';
import { replayRequest } from '../src/diagnostics/replay-transport';
import type { ApiProtocol } from '@werewolf/protocol';

const request = { endpoint: 'https://example.test/v1', body: { model: 'test', stream: true, nested: { value: 3 } }, binding: 'test', timeoutSec: 1 };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const sse = (...chunks: string[]) => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const send = (protocol: ApiProtocol, response: Response) => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response)); return replayRequest(request, protocol, 'secret'); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('replay transport', () => {
  it.each([
    ['chat_completions', { model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: 'hi', reasoning_content: 'hidden', tool_calls: [{ id: 'c', function: { name: 'act', arguments: '{}' } }] } }], usage: { total_tokens: 4, extra: 'hidden' } }],
    ['responses', { model: 'm', status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'hidden' }] }, { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }, { type: 'function_call', call_id: 'c', name: 'act', arguments: '{}' }], usage: { total_tokens: 4, extra: 'hidden' } }],
    ['anthropic_messages', { model: 'm', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 'c', name: 'act', input: {} }], usage: { total_tokens: 4, extra: 'hidden' } }],
  ] as const)('extracts %s JSON and sends the original request once', async (protocol, data) => {
    const result = await send(protocol, json(data));
    expect(result).toMatchObject({ status: 'completed', text: 'hi', calls: [{ id: 'c', name: 'act', arguments: '{}' }], usage: { total_tokens: 4 }, responseModel: 'm', httpAttempts: 1 });
    expect(JSON.stringify(result)).not.toContain('hidden');
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(request.endpoint); expect(options?.body).toBe(JSON.stringify(request.body));
    expect(options?.method).toBe('POST');
    expect(options?.headers).toMatchObject(protocol === 'anthropic_messages' ? { 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' } : { Authorization: 'Bearer secret' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('parses split CRLF and multiline chat SSE including tool fragments', async () => {
    const result = await send('chat_completions', sse('data: {"choices":[{"delta":{"content":"hi","tool_calls":[{"index":0,"id":"c","function":{"name":"act","arguments":"{"}}]}}]}\r', '\n\r\ndata: {"choices":\r\ndata: [{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\ndata: [DONE]\r\n\r\n'));
    expect(result).toMatchObject({ status: 'completed', text: 'hi', calls: [{ id: 'c', name: 'act', arguments: '{}' }] });
  });
  it('parses Responses SSE and excludes reasoning', async () => {
    const result = await send('responses', sse('data: {"type":"response.reasoning_text.delta","delta":"hidden"}\n\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"c","name":"act","arguments":""}}\n\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{}"}\n\ndata: {"type":"response.completed","response":{"status":"completed","model":"m"}}\n\n'));
    expect(result).toMatchObject({ status: 'completed', text: 'hi', calls: [{ id: 'c', name: 'act', arguments: '{}' }] }); expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it('parses Anthropic SSE and stop reason', async () => {
    const result = await send('anthropic_messages', sse('data: {"type":"message_start","message":{"model":"m"}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"act","input":{}}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\ndata: {"type":"message_stop"}\n\n'));
    expect(result).toMatchObject({ status: 'completed', calls: [{ id: 'c', name: 'act', arguments: '{}' }] });
  });
  it.each([
    ['chat_completions', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
    ['responses', 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'],
    ['anthropic_messages', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\ndata: {"type":"message_stop"}\n\n'],
  ] as const)('fails incomplete %s while preserving partial text', async (protocol, stream) => {
    expect(await send(protocol, sse(stream))).toMatchObject({ status: 'failed', failureKind: 'invalid_response', text: 'partial' });
  });
  it('rejects truncated JSON and unterminated SSE events', async () => {
    expect(await send('chat_completions', json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }))).toMatchObject({ status: 'failed', text: 'partial' });
    expect(await send('chat_completions', sse('data: [DONE]'))).toMatchObject({ status: 'failed', failureKind: 'invalid_response' });
  });
  it('rejects a chat completion without a message or actual stream output', async () => {
    expect(await send('chat_completions', json({ choices: [{ finish_reason: 'stop' }] }))).toMatchObject({ status: 'failed', failureKind: 'invalid_response' });
    expect(await send('chat_completions', sse('data: [DONE]\n\n'))).toMatchObject({ status: 'failed', failureKind: 'invalid_response' });
  });
  it('does not expose HTTP response bodies or retry', async () => {
    const result = await send('responses', new Response('secret response', { status: 401 }));
    expect(result).toMatchObject({ status: 'failed', failureKind: 'http', httpAttempts: 1 }); expect(JSON.stringify(result)).not.toContain('secret'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('times out without exposing errors or retrying', async () => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('secret'))))));
    const pending = replayRequest(request, 'chat_completions', 'secret'); await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: 'failed', failureKind: 'timeout', httpAttempts: 1 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['https://user:pass@example.test', 'https://example.test/?key=x', 'https://example.test/#x', 'file:///etc/passwd'])('rejects invalid endpoint %s before fetching', async (endpoint) => {
    vi.stubGlobal('fetch', vi.fn()); expect(await replayRequest({ ...request, endpoint }, 'responses', null)).toMatchObject({ status: 'failed', httpAttempts: 0 }); expect(fetch).not.toHaveBeenCalled();
  });
});

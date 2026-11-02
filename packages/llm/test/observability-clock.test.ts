import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterObservationEvent, ApiProtocol, DecideObservationPort, ToolSpec } from '@werewolf/protocol';
import { remoteAdapter } from '../src/adapters';

const tool: ToolSpec = { name: 'vote', title: 'vote', description: 'vote', params: [] };
const encode = (items: unknown[]) => items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
const output = { type: 'function_call', call_id: 'call', name: 'vote', arguments: '{}' };
const scripts: Record<ApiProtocol, [unknown[], unknown[], unknown[]]> = {
  chat_completions: [
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: '', arguments: '' } }] } }] }],
    [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'vote', arguments: '{}' } }] } }] }],
    [{ usage: { prompt_tokens: 2, completion_tokens: 1 }, choices: [] }],
  ],
  responses: [
    [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call', name: '', arguments: '' } }],
    [{ type: 'response.output_item.added', output_index: 0, item: output }],
    [{ type: 'response.completed', response: { status: 'completed', output: [output], usage: { input_tokens: 2, output_tokens: 1 } } }],
  ],
  anthropic_messages: [
    [{ type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, { type: 'ping' }],
    [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'vote', input: {} } }],
    [{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }],
  ],
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('controlled monotonic transport observations', () => {
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s measures headers, first byte, tool content and body end despite wall-clock jumps', async (protocol) => {
    let now = 0, wall = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const observations: AdapterObservationEvent[] = [];
    const observation: DecideObservationPort = { callId: `controlled-${protocol}`, clock: { monotonicMs: () => now, wallTimeMs: () => wall }, emit: (event) => observations.push(event) };
    const onDelta = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => {
      now = 20; wall = -100_000;
      let index = 0;
      const chunks = scripts[protocol];
      const stream = new ReadableStream<Uint8Array>({ pull(controller) {
        if (index === chunks.length) { controller.close(); return; }
        now = [50, 60, 90][index]; wall = [500_000, -700_000, 1_000_000][index];
        controller.enqueue(new TextEncoder().encode(encode(chunks[index]) + (index === chunks.length - 1 ? 'data: [DONE]\n\n' : '')));
        index++;
      } }, { highWaterMark: 0 });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const result = await remoteAdapter(protocol).decide({ seat: 1, messages: [{ role: 'user', content: 'observe timing' }], tools: [tool], stream: true, onDelta, observation,
      config: { apiProtocol: protocol, baseUrl: 'http://localhost:1234/v1', model: 'clock-test', apiKey: null, temperature: 0, timeoutSec: 5, toolMode: 'tools' } });
    expect(result.call).toEqual({ tool: 'vote', args: {} });
    expect(result.latencyMs).toBe(900_000); // Legacy latency continues to follow Date.now().
    expect(onDelta).not.toHaveBeenCalled();
    const start = observations.find((event) => event.kind === 'http_attempt' && event.phase === 'start')!;
    const end = observations.find((event) => event.kind === 'http_attempt' && event.phase === 'end')!;
    expect(start.atMs).toBe(0);
    expect(end.atMs).toBe(90);
    expect(end.bodyEndKind).toBe('protocol_end');
    expect(end.firstContentKind).toBe('tool_name');
    const actual = end.metrics!;
    for (const [key, expected] of Object.entries({ headersMs: 20, firstBodyByteMs: 50, firstStreamContentMs: 60, bodyConsumeMs: 70, httpAttemptMs: 90, parseMs: 0 })) {
      const measurement = actual[key as keyof typeof actual]!;
      expect(measurement.valueMs, key).not.toBeNull();
      if (measurement.valueMs === null) throw new Error(`missing ${key}`);
      expect(Math.abs(measurement.valueMs - expected), key).toBeLessThanOrEqual(0.001);
      expect(measurement.source).toBe('client');
    }
    expect(actual.requestSendMs).toEqual({ valueMs: null, reason: 'not_observable' });
    expect(actual.providerQueueMs).toEqual({ valueMs: null, reason: 'not_observable' });
    expect(observations.find((event) => event.kind === 'adapter_execution' && event.phase === 'end')?.metrics?.adapterExecutionMs)
      .toEqual({ valueMs: 90, source: 'client' });
  });
});

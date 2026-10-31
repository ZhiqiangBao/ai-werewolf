import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiBase, apiUrl, defaultThinkingMode, thinkingParameters, toolToJsonSchema, type ApiProtocol, type ToolSpec } from '@werewolf/protocol';
import { anthropicAdapter, anthropicInput, chatMessages, feedbackMessages, migrateTranscript, protocolBinding, remoteAdapter, responsesAdapter, responsesInput, type AdapterConfig, type TranscriptMessage } from '../src/index';

const vote: ToolSpec = { name: 'vote', title: '投票', description: '投给整数座位号或 null 弃票。', params: [{ kind: 'seat', name: 'target', label: '投给', options: [1, 2, 3, 5, 12], nullable: true, nullLabel: '弃票' }] };
const history: TranscriptMessage[] = [{ role: 'system', content: '仅依据自己的私有视角。' }, { role: 'user', name: 'judge', content: '请投票。' }];

describe('协议边界与原生续接', () => {
  let server: Server;
  let baseUrl: string;
  const requests: { path: string; headers: Record<string, any>; body: any }[] = [];
  let handler: (body: any) => { json?: any; events?: any[]; status?: number; close?: boolean };
  const config = (apiProtocol: ApiProtocol): AdapterConfig => ({ apiProtocol, baseUrl, model: 'test-model', apiKey: 'unit-secret-not-a-real-key', temperature: .7, timeoutSec: 3, toolMode: 'tools' });
  const request = (protocol: ApiProtocol, messages = history) => remoteAdapter(protocol).decide({ seat: 1, config: config(protocol), messages, tools: [vote], stream: true, cacheKey: 'room-a:seat-1' });
  const output = (calls = 1) => [
    { type: 'reasoning', id: 'rs_private', summary: [{ type: 'summary_text', text: '检查票型。' }], encrypted_content: 'opaque-reasoning' },
    { type: 'message', id: 'msg_private', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '已决定。', annotations: [] }], status: 'completed' },
    ...Array.from({ length: calls }, (_, i) => ({ type: 'function_call', id: `fc_${i}`, call_id: `call_${i}`, name: 'vote', arguments: '{"target":5}', status: 'completed' })),
  ];
  const blocks = (calls = 1) => [
    { type: 'thinking', thinking: '检查票型。', signature: 'opaque-signature' },
    ...Array.from({ length: calls }, (_, i) => ({ type: 'tool_use', id: `toolu_${i}`, name: 'vote', input: { target: 5 } })),
  ];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (b) => { raw += b; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ path: req.url!, headers: req.headers, body });
        const response = handler(body);
        if (response.events) {
          res.writeHead(response.status ?? 200, { 'Content-Type': 'text/event-stream' });
          for (const e of response.events) {
            // 分割 UTF-8 字节，验证不依赖 TCP 分片或完整行。
            const data = Buffer.from(`event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`);
            for (let i = 0; i < data.length; i += 7) res.write(data.subarray(i, i + 7));
          }
          if (response.close !== false) res.end();
        } else { res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response.json)); }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('完整端点不重复拼接，旧协议缺省兼容，错误协议地址直接拒绝', () => {
    for (const [protocol, path] of [['chat_completions', '/chat/completions'], ['responses', '/responses'], ['anthropic_messages', '/messages']] as const) {
      expect(apiUrl(baseUrl, protocol)).toBe(baseUrl + path);
      expect(apiUrl(baseUrl + path, protocol)).toBe(baseUrl + path);
    }
    expect(apiBase('https://example.com')).toBe('https://example.com/v1');
    expect(() => apiUrl(baseUrl + '/chat/completions', 'responses')).toThrow('不匹配');
    expect(() => apiBase('https://user:secret@example.com/v1')).toThrow('无凭证');
  });

  it('Responses 完整 output（含 phase 和加密推理）在下一轮原样回传，缓存与座位独立', async () => {
    const items = output();
    handler = () => ({ json: { status: 'completed', output: items, usage: { input_tokens: 3000, output_tokens: 100, input_tokens_details: { cached_tokens: 2500 } } } });
    const result = await request('responses');
    expect(result.call).toEqual({ tool: 'vote', args: { target: 5 } });
    expect(result.assistant?.role === 'assistant' && result.assistant.native?.items).toEqual(items);
    expect(result.usage).toEqual({ inputTokens: 3000, outputTokens: 100, cacheReadTokens: 2500, cacheWriteTokens: 0 });
    const next = [...history, result.assistant!, { role: 'tool', callId: 'call_0', content: '已采纳' } as const, { role: 'user', name: '12', content: '第1天12号发言：我是好人。' } as const];
    await request('responses', next);
    const sent = requests.at(-1)!;
    expect(sent.path).toBe('/v1/responses');
    expect(sent.body.store).toBe(false);
    expect(sent.body.previous_response_id).toBeUndefined();
    expect(sent.body.include).toContain('reasoning.encrypted_content');
    expect(sent.body.input.slice(2, 2 + items.length)).toEqual(items);
    expect(sent.body.input.at(-2)).toEqual({ type: 'function_call_output', call_id: 'call_0', output: '已采纳' });
    expect(sent.body.input.at(-1)).toEqual({ role: 'user', content: '[12]\n第1天12号发言：我是好人。' });
    const firstKey = sent.body.prompt_cache_key;
    await responsesAdapter.decide({ seat: 2, config: config('responses'), messages: history, tools: [vote], cacheKey: 'room-a:seat-2' });
    expect(requests.at(-1)!.body.prompt_cache_key).not.toBe(firstKey);
    expect(JSON.stringify(responsesInput(history, config('responses')))).not.toContain('opaque-reasoning');
  });

  it('Responses SSE 只接受已完成结果，半截流和错误事件不产生行动', async () => {
    const items = output();
    handler = () => ({ events: [{ type: 'response.reasoning_summary_text.delta', delta: '检查票型。' }, ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })), { type: 'response.completed', response: { status: 'completed', output: items } }] });
    expect((await request('responses')).call?.args.target).toBe(5);
    handler = () => ({ events: [{ type: 'response.reasoning_summary_text.delta', delta: '尚未完成' }, { type: 'response.output_item.added', output_index: 0, item: items.at(-1) }] });
    const partial = await request('responses');
    expect(partial.ok).toBe(false); expect(partial.call).toBeUndefined(); expect(partial.thinking).toBe('尚未完成');
    expect(partial.fatal).toBe(true);
  });

  it('Anthropic SSE 保留 thinking 签名、工具结果紧跟调用，缓存读写统一计数', async () => {
    handler = () => ({ events: [
      { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检查票型。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_0', name: 'vote', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"target":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '5}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }, { type: 'message_stop' },
    ] });
    const result = await request('anthropic_messages');
    expect(result.call).toEqual({ tool: 'vote', args: { target: 5 } });
    expect(result.assistant?.role === 'assistant' && result.assistant.native?.items).toEqual(blocks());
    expect(result.usage).toEqual({ inputTokens: 3010, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 1000 });
    const next: TranscriptMessage[] = [...history, result.assistant!, { role: 'tool', callId: 'toolu_0', content: '已采纳。' }, { role: 'user', name: '3', content: '3号发言：先听。' }];
    await request('anthropic_messages', next);
    const sent = requests.at(-1)!;
    expect(sent.path).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe(config('anthropic_messages').apiKey);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body.messages[1].content).toEqual(blocks());
    expect(sent.body.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_0', content: '已采纳。' });
    expect(sent.body.messages.at(-1).content[1]).toMatchObject({ type: 'text', text: '[3]\n3号发言：先听。' });
    expect(sent.body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.body.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.body.tool_choice.type).toBe('auto');
  });

  it('多个调用全部获得错误回执，不挑选一个执行；两个协议的工具 Schema 一致', async () => {
    for (const protocol of ['responses', 'anthropic_messages'] as const) {
      handler = () => ({ json: protocol === 'responses' ? { status: 'completed', output: output(2) } : { content: blocks(2), stop_reason: 'tool_use' } });
      const result = await request(protocol);
      expect(result.ok).toBe(false); expect(result.call).toBeUndefined(); expect(result.toolCallIds).toHaveLength(2);
      const feedback = feedbackMessages(result, result.error!);
      expect(feedback.filter((m) => m.role === 'tool')).toHaveLength(2);
      await request(protocol, [...history, ...feedback]);
      const body = requests.at(-1)!.body;
      if (protocol === 'responses') {
        expect(body.input.filter((i: any) => i.type === 'function_call_output')).toHaveLength(2);
        expect(body.tools[0].parameters).toEqual(toolToJsonSchema(vote));
      } else {
        expect(body.messages.at(-1).content.filter((i: any) => i.type === 'tool_result' && i.is_error)).toHaveLength(2);
        expect(body.tools[0].input_schema).toEqual(toolToJsonSchema(vote));
      }
    }
  });

  it('旧存档迁移不改 Chat 请求；跨协议/凭证仅转换语义，原生私有块不跨绑定', () => {
    const legacy = [{ role: 'user', name: '2', content: '2号发言：你好。' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'vote', arguments: '{"target":5}' } }] }, { role: 'tool', tool_call_id: 'call_0', content: '已采纳' }] as const;
    const migrated = migrateTranscript(structuredClone([...legacy]));
    expect(chatMessages(migrated)).toEqual(legacy);
    const own = config('responses');
    const native: TranscriptMessage = { role: 'assistant', content: null, calls: [{ id: 'call_0', name: 'vote', arguments: '{"target":5}' }], native: { protocol: 'responses', binding: protocolBinding(own), items: output() } };
    const transcript = [...history, native, { role: 'tool', callId: 'call_0', content: '已采纳' } as const];
    expect(responsesInput(transcript, own)).toContainEqual(output()[0]);
    const replaced = responsesInput(transcript, { ...own, apiKey: 'a-different-key' });
    expect(JSON.stringify(replaced)).not.toContain('opaque-reasoning');
    expect(replaced.at(-1)!.call_id).toBe(replaced.at(-2)!.call_id);
    const cross = anthropicInput(transcript, config('anthropic_messages'));
    expect(JSON.stringify(cross)).not.toContain('opaque-reasoning');
    expect(cross.messages.at(-1)!.content[0].tool_use_id).toBe(cross.messages.at(-2)!.content[0].id);
  });

  it('三个协议各自映射思考参数，不给未知原生型号发送未经确认的参数', () => {
    expect(defaultThinkingMode(baseUrl, 'gpt-5', 'responses')).toBe('low');
    expect(thinkingParameters(baseUrl, 'gpt-5', 'low', 'responses')).toEqual({ reasoning: { effort: 'low' } });
    expect(thinkingParameters(baseUrl, 'claude-sonnet-4-6', 'low', 'anthropic_messages')).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(thinkingParameters(baseUrl, 'claude-sonnet-4-5', 'low', 'anthropic_messages')).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } });
    expect(defaultThinkingMode(baseUrl, 'qwen-test', 'responses')).toBe('default');
    expect(() => thinkingParameters(baseUrl, 'qwen-test', 'low', 'responses')).toThrow('不支持');
    const aliyun = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
    expect(defaultThinkingMode(aliyun, 'qwen3.8-flash', 'responses')).toBe('low');
    expect(thinkingParameters(aliyun, 'qwen3.8-flash', 'high', 'responses')).toEqual({ reasoning: { effort: 'xhigh' } });
    expect(thinkingParameters(aliyun, 'qwen3.8-flash', 'low', 'anthropic_messages')).toEqual({ thinking: { type: 'enabled' }, output_config: { effort: 'low' } });
    expect(defaultThinkingMode(aliyun, 'deepseek-v4-pro', 'responses')).toBe('default');
    expect(defaultThinkingMode(aliyun, 'glm-5.2', 'anthropic_messages')).toBe('default');
  });

  it('JSON 文本模式两种原生接口均可解析，旁听仍允许只回正文', async () => {
    for (const protocol of ['responses', 'anthropic_messages'] as const) {
      handler = () => ({ json: protocol === 'responses' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"tool":"vote","args":{"target":5}}' }] }] } : { content: [{ type: 'text', text: '{"tool":"vote","args":{"target":5}}' }] } });
      const result = await remoteAdapter(protocol).decide({ seat: 1, config: { ...config(protocol), toolMode: 'json' }, tools: [vote], messages: history });
      expect(result.call).toEqual({ tool: 'vote', args: { target: 5 } });
      handler = () => ({ json: protocol === 'responses' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我听到了。' }] }] } : { content: [{ type: 'text', text: '我听到了。' }] } });
      const listen = await remoteAdapter(protocol).decide({ seat: 1, config: config(protocol), tools: [vote], messages: history, toolChoice: 'auto' });
      expect(listen.ok).toBe(true); expect(listen.call).toBeUndefined(); expect(listen.reply).toBe('我听到了。');
    }
  });

  it('Anthropic 半截工具、残缺参数和已取消请求不会提交行动或悄悄换协议', async () => {
    const before = requests.length;
    handler = () => ({ events: [{ type: 'message_start', message: { role: 'assistant', usage: {} } }, { type: 'content_block_start', index: 0, content_block: blocks()[1] }] });
    const result = await request('anthropic_messages');
    expect(result.ok).toBe(false); expect(result.call).toBeUndefined(); expect(requests.length - before).toBe(1);
    const controller = new AbortController(); controller.abort();
    const canceled = await anthropicAdapter.decide({ seat: 1, config: config('anthropic_messages'), messages: history, tools: [vote], signal: controller.signal });
    expect(canceled.failureKind).toBe('cancelled'); expect(requests.length - before).toBe(1);
  });

  it('两个原生协议读取流时仍受同一总时限约束，保留已收到的展示思考但不重试工具', async () => {
    for (const protocol of ['responses', 'anthropic_messages'] as const) {
      const before = requests.length;
      handler = () => ({ close: false, events: protocol === 'responses' ? [{ type: 'response.reasoning_text.delta', delta: '正在检查' }] : [
        { type: 'message_start', message: { role: 'assistant', usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '正在检查' } },
      ] });
      const result = await remoteAdapter(protocol).decide({ seat: 1, config: { ...config(protocol), timeoutSec: .1 }, messages: history, tools: [vote], stream: true });
      expect(result.failureKind).toBe('timeout'); expect(result.thinking).toBe('正在检查'); expect(result.call).toBeUndefined();
      expect(result.latencyMs).toBeLessThan(1000); expect(requests.length - before).toBe(1);
    }
  });
});

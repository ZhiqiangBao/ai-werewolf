import { buildRules, createGame, projectSeat, seatTools, submit, waitingSeats } from '@werewolf/engine';
import type { ApiProtocol } from '@werewolf/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { buildMessages, feedbackMessages, remoteAdapter, type DecideRequest, type TranscriptMessage } from '../src/index';

const seer = 4;
const target = 1;
const apiKey = 'fixture-key-for-model';
const thinking = '先核对要查验的座位。';
const opaque = 'fixture-opaque-reasoning';
const signature = 'fixture-opaque-signature';
const tool = 'seer_inspect';

const protocols = [
  { protocol: 'chat_completions', path: '/v1/chat/completions', locale: 'zh-CN', menu: '请选择今晚要查验的玩家。', schemaLabel: '真实座位号（整数）', feedback: '工具调用错误：', result: '查验结果：1号是狼人。' },
  { protocol: 'responses', path: '/v1/responses', locale: 'en', menu: 'Choose tonight’s inspection target.', schemaLabel: 'actual integer seat number', feedback: 'Tool-call error: ', result: 'Inspection result: Player 1 is Werewolf.' },
  { protocol: 'anthropic_messages', path: '/v1/messages', locale: 'ja', menu: '今夜の占い対象を選んでください。', schemaLabel: '実際の整数席番号', feedback: 'ツール呼び出しエラー：', result: '占い結果：1番は人狼です。' },
] as const;

function seerTurn(locale: string) {
  const deal = ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'];
  const { state: initial, events } = createGame({ id: 'protocol-fixture', rules: buildRules('classic9', {}, { locale }), seed: 'protocol-fixture', deal });
  let state = initial;
  for (let turn = 0; turn < 30 && !projectSeat(state, events, seer).task?.tools.some((spec) => spec.name === tool); turn++) {
    const next = submit(state, { seat: waitingSeats(state)[0], call: { tool: '', args: {} }, auto: true });
    expect(next.error).toBeUndefined();
    state = next.state;
    events.push(...next.events);
  }
  const projection = projectSeat(state, events, seer);
  expect(projection.task?.tools.map((spec) => spec.name)).toContain(tool);
  return { state, events, projection, decisionId: projection.task!.decisionId };
}

function modelRequest(protocol: ApiProtocol, game: ReturnType<typeof seerTurn>): DecideRequest {
  return {
    seat: seer, projection: game.projection, messages: buildMessages(game.projection, ''), tools: seatTools(game.state, seer),
    config: { baseUrl: 'https://fixture.invalid/v1', apiProtocol: protocol, model: 'fixture-model', apiKey, temperature: 0, toolMode: 'tools', timeoutSec: 3 },
    cacheKey: `fixture-room:seat-${seer}`, stream: true,
  };
}

function sse(events: unknown[]) {
  const encoded = new TextEncoder().encode(events.map((event) => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\r\n\r\n`).join(''));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 13) controller.enqueue(encoded.subarray(offset, offset + 13));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function toolStream(protocol: ApiProtocol, id: string, value: number | string, complete = true) {
  const input = { targetSeat: value };
  const args = JSON.stringify(input);
  const first = '{"targetSeat":';
  const rest = args.slice(first.length);
  if (protocol === 'chat_completions') {
    const delta = (data: unknown) => ({ choices: [{ delta: data }] });
    const call = { id, type: 'function', function: { name: tool, arguments: args } };
    return { call, events: [
      delta({ reasoning_content: thinking }),
      delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name: tool, arguments: first } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: rest } }] }),
      '[DONE]',
    ] };
  }
  if (protocol === 'responses') {
    const items = [
      { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: thinking }], encrypted_content: opaque },
      { type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.', annotations: [] }], status: 'completed' },
      { type: 'function_call', id: 'fc_fixture', call_id: id, name: tool, arguments: args, status: 'completed' },
    ];
    return { items, events: [
      { type: 'response.reasoning_summary_text.delta', delta: thinking },
      ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
      ...(complete ? [{ type: 'response.completed', response: { status: 'completed', output: items } }] : []),
    ] };
  }
  const items = [
    { type: 'thinking', thinking, signature },
    { type: 'tool_use', id, name: tool, input },
  ];
  return { items, events: [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: tool, input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: first } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: rest } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ...(complete ? [{ type: 'message_stop' }] : []),
  ] };
}

function mockModel(...replies: Response[]) {
  const requests: { path: string; body: Record<string, any>; headers: Headers }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return replies.shift() ?? Response.json({ error: 'Unexpected model request' }, { status: 400 });
  }));
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

it('模型思考选项通过三种适配器发送原生参数，MiMo 仅关闭思考', async () => {
  for (const { protocol } of protocols) {
    for (const model of ['qwen4-max-preview', 'deepseek-flash']) {
      const req = modelRequest(protocol, seerTurn('zh-CN'));
      const baseUrl = model.startsWith('qwen') ? 'https://token-plan.maas.qianwenaiapi.com/v1'
        : protocol === 'anthropic_messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com';
      req.config = { ...req.config, baseUrl, model, thinkingMode: 'high' };
      const requests = mockModel(sse(toolStream(protocol, 'effort-inspection', target).events));
      expect((await remoteAdapter(protocol).decide(req)).ok).toBe(true);
      expect(requests).toHaveLength(1);
      const effort = model.startsWith('qwen') ? 'xhigh' : 'max';
      const body = requests[0].body;
      expect(body.model).toBe(model);
      if (protocol === 'responses') expect(body.reasoning).toEqual({ effort });
      else if (protocol === 'anthropic_messages') {
        expect(body.thinking).toEqual({ type: 'enabled' });
        expect(body.output_config).toEqual({ effort });
      } else expect(body).toMatchObject({ reasoning_effort: effort, ...(model.startsWith('qwen') ? { enable_thinking: true } : { thinking: { type: 'enabled' } }) });
      expect(body).not.toHaveProperty('thinking_budget');
    }
  }
  const req = modelRequest('responses', seerTurn('zh-CN'));
  req.config = { ...req.config, baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', thinkingMode: 'off' };
  const requests = mockModel(sse(toolStream('responses', 'mimo-inspection', target).events));
  expect((await remoteAdapter('responses').decide(req)).ok).toBe(true);
  expect(requests[0].body.reasoning).toEqual({ effort: 'none' });
});

it('三个模型协议按本局语言完成查验纠错，后续连接失败时安全结束旁听', async () => {
  for (const { protocol, path, locale, menu, schemaLabel, feedback, result } of protocols) {
    const game = seerTurn(locale);
    const req = modelRequest(protocol, game);
    const invalid = toolStream(protocol, 'invalid-inspection', String(target));
    const valid = toolStream(protocol, 'valid-inspection', target);
    const disconnected = protocol === 'chat_completions'
      ? Response.json({ error: `invalid key ${apiKey}` }, { status: 401 })
      : sse(toolStream(protocol, 'interrupted-inspection', target, false).events);
    const requests = mockModel(sse(invalid.events), sse(valid.events), disconnected);
    const adapter = remoteAdapter(protocol);
    const first = await adapter.decide(req);
    expect(first).toMatchObject({ ok: true, call: { tool, args: { targetSeat: '1' } }, thinking, toolCallIds: ['invalid-inspection'] });
    const sent = requests[0];
    expect(sent.path).toBe(path);
    expect(sent.headers.get(protocol === 'anthropic_messages' ? 'x-api-key' : 'authorization')).toBe(protocol === 'anthropic_messages' ? apiKey : `Bearer ${apiKey}`);
    expect(JSON.stringify(sent.body)).toContain(menu);
    const definition = sent.body.tools.map((entry: any) => entry.function ?? entry).find((entry: any) => entry.name === tool);
    expect(definition).not.toHaveProperty('operation');
    expect(definition.parameters ?? definition.input_schema).toEqual({
      type: 'object',
      properties: { targetSeat: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9], description: expect.stringContaining(schemaLabel) } },
      required: ['targetSeat'],
      additionalProperties: false,
    });

    const rejected = submit(game.state, { seat: seer, call: first.call!, decisionId: game.decisionId });
    expect(rejected.error?.code).toBe('INVALID_ARGUMENT');
    expect(rejected.state.pending?.id).toBe(game.decisionId);
    expect(rejected.events.map((event) => event.type)).toEqual(['action.rejected']);
    const receipt = feedbackMessages(first, rejected.error!.reason, locale);
    expect(receipt[1]).toEqual({ role: 'tool', callId: 'invalid-inspection', content: expect.stringContaining(feedback), isError: true });
    const answer = await adapter.decide({ ...req, messages: [...req.messages, ...receipt] });
    expect(answer).toMatchObject({ ok: true, call: { tool, args: { targetSeat: target } }, toolCallIds: ['valid-inspection'] });
    const retry = requests[1].body;
    switch (protocol) {
      case 'chat_completions':
        expect(retry.messages.slice(-2)).toEqual([
          { role: 'assistant', content: null, tool_calls: [invalid.call] },
          { role: 'tool', tool_call_id: 'invalid-inspection', content: receipt[1].content },
        ]);
        expect(JSON.stringify(retry.messages)).not.toContain(thinking);
        break;
      case 'responses':
        expect(retry).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false });
        expect(retry).not.toHaveProperty('previous_response_id');
        expect(retry.input.slice(req.messages.length)).toEqual([
          ...invalid.items!, { type: 'function_call_output', call_id: 'invalid-inspection', output: receipt[1].content },
        ]);
        break;
      case 'anthropic_messages':
        expect(retry.messages.slice(-2)).toEqual([
          { role: 'assistant', content: invalid.items },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'invalid-inspection', content: receipt[1].content, is_error: true }] },
        ]);
        expect(JSON.stringify(retry)).not.toContain('cache_control');
        break;
    }
    const accepted = submit(rejected.state, { seat: seer, call: answer.call!, decisionId: game.decisionId });
    expect(accepted.error).toBeUndefined();
    expect(accepted.events.filter((event) => event.type === 'seer.result')).toEqual([
      expect.objectContaining({ text: result, payload: { target, result: 'wolf' } }),
    ]);

    const projection = projectSeat(accepted.state, [...game.events, ...rejected.events, ...accepted.events], seer);
    const followUp = await adapter.decide({
      ...req, projection, toolChoice: 'auto',
      messages: [...req.messages, ...receipt, answer.assistant!,
        { role: 'tool', callId: 'valid-inspection', content: result }, buildMessages(projection, '')[1]],
    });
    expect(followUp).toMatchObject({ ok: false, fatal: true, failureKind: 'http', toolCallIds: [] });
    expect(followUp.call).toBeUndefined();
    expect(followUp.assistant).toBeUndefined();
    expect(requests.map((request) => request.path)).toEqual([path, path, path]);
    if (protocol === 'chat_completions') {
      expect(followUp.error).toContain('接口返回 401');
      expect(followUp.error).toContain('invalid key ***');
      expect(followUp.error).not.toContain(apiKey);
    } else {
      expect(followUp.thinking).toBe(thinking);
      expect(followUp.error).toContain(protocol === 'responses' ? 'Streaming connection ended early' : 'ストリームが途中で終了');
    }
  }
});

it('同模型同凭证的两个席位分别发送各自投影，更换凭证续接时仅迁移语义工具链', async () => {
  const game = seerTurn('en');
  const req = modelRequest('responses', game);
  const callId = 'seat-four-inspection';
  const modelCall = toolStream('responses', callId, target);
  const listen = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Understood.' }] }] });
  const requests = mockModel(sse(modelCall.events), listen(), listen(), listen());
  const adapter = remoteAdapter('responses');
  const answer = await adapter.decide(req);
  expect(answer).toMatchObject({ ok: true, call: { tool, args: { targetSeat: target } } });
  const accepted = submit(game.state, { seat: seer, call: answer.call!, decisionId: game.decisionId });
  expect(accepted.error).toBeUndefined();
  const inspection = accepted.events.find((event) => event.type === 'seer.result')!.text;
  const events = [...game.events, ...accepted.events];
  const own = projectSeat(accepted.state, events, seer);
  const otherSeat = 7;
  const other = projectSeat(accepted.state, events, otherSeat);
  const messages: TranscriptMessage[] = [...req.messages, answer.assistant!, { role: 'tool', callId, content: 'Action accepted.' }, buildMessages(own, '')[1]];
  const continuation = { ...req, projection: own, messages, toolChoice: 'auto' as const };
  expect((await adapter.decide(continuation)).ok).toBe(true);
  expect((await adapter.decide({
    ...continuation, seat: otherSeat, projection: other, messages: buildMessages(other, ''),
    tools: seatTools(accepted.state, otherSeat), cacheKey: `fixture-room:seat-${otherSeat}`,
  })).ok).toBe(true);
  expect((await adapter.decide({ ...continuation, config: { ...req.config, apiKey: 'fixture-replacement-key' } })).ok).toBe(true);

  expect(requests).toHaveLength(4);
  const ownBody = requests[1].body;
  const otherBody = requests[2].body;
  const rebound = requests[3].body;
  expect(ownBody.input).toContainEqual(modelCall.items![0]);
  expect(JSON.stringify(ownBody.input)).toContain(inspection);
  expect(ownBody.prompt_cache_key).toBe(requests[0].body.prompt_cache_key);
  expect(otherBody.prompt_cache_key).not.toBe(ownBody.prompt_cache_key);
  expect(otherBody.model).toBe(ownBody.model);
  expect(requests[2].headers.get('authorization')).toBe(requests[1].headers.get('authorization'));
  expect(otherBody.tools.map((definition: { name: string }) => definition.name)).not.toContain(tool);
  const otherHistory = JSON.stringify(otherBody.input);
  for (const privateValue of [inspection, callId, opaque]) expect(otherHistory).not.toContain(privateValue);
  expect(rebound.prompt_cache_key).not.toBe(ownBody.prompt_cache_key);
  expect(JSON.stringify(rebound.input)).not.toContain(opaque);
  const mappedCall = rebound.input.find((item: any) => item.type === 'function_call');
  expect(mappedCall).toMatchObject({ name: tool, arguments: '{"targetSeat":1}' });
  expect(mappedCall.call_id).not.toBe(callId);
  expect(rebound.input).toContainEqual({ type: 'function_call_output', call_id: mappedCall.call_id, output: 'Action accepted.' });
});

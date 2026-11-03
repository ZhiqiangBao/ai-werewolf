import { describe, expect, it, vi } from 'vitest';
import { thinkingOptions, thinkingParameters, type ApiProtocol, type ThinkingMode } from '@werewolf/protocol';
import { testConnection, type AdapterConfig } from '@werewolf/llm';
import { remoteAdapter } from '../../llm/src/adapters';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const url = 'https://example.com/v1';
const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const cases: [string, string, ApiProtocol][] = [
  [url, 'qwen3.7-plus', 'chat_completions'],
  [dashscope, 'deepseek-v4-pro', 'chat_completions'],
  [url, 'custom-model', 'chat_completions'],
  [url, 'gpt-5', 'responses'],
  [dashscope, 'deepseek-v4-pro', 'responses'],
  [url, 'unknown', 'responses'],
  [url, 'claude-sonnet-4-5', 'anthropic_messages'],
  [url, 'claude-sonnet-4-6', 'anthropic_messages'],
  [url, 'unknown', 'anthropic_messages'],
];

describe('思考选项语言', () => {
  it.each(cases)('%s / %s / %s 只改变标签和提示，不改变能力和请求参数', (baseUrl, model, protocol) => {
    const before = thinkingOptions(baseUrl, model, protocol);
    expect(before.map((o) => o.value)).toEqual(['default', 'off', 'low', 'medium', 'high']);
    const parameters = before.filter((o) => o.supported).map((o) => thinkingParameters(baseUrl, model, o.value, protocol));
    for (const locale of ['en', 'ja']) {
      const translated = thinkingOptions(baseUrl, model, protocol, locale);
      expect(translated.map((o) => [o.value, o.supported])).toEqual(before.map((o) => [o.value, o.supported]));
      expect(translated.every((o) => o.label && o.hint && o.hintKey)).toBe(true);
      expect(translated.filter((o) => o.supported).map((o) => thinkingParameters(baseUrl, model, o.value, protocol))).toEqual(parameters);
      if (locale === 'en') expect(JSON.stringify(translated.map(({ label, hint }) => ({ label, hint })))).not.toMatch(/[\u3400-\u9fff]/);
      else expect(translated.find((o) => o.value === 'default')!.label).toBe('モデル既定');
    }
  });
  it('默认中文保持既有标签、动态预算和具体不可用原因', () => {
    const budget = thinkingOptions(url, 'qwen3.7-plus');
    expect(budget.map((o) => o.label)).toEqual(['跟随模型', '关闭', '轻度', '标准', '深度']);
    expect(budget.find((o) => o.value === 'low')!.hint).toBe('轻度：思考预算 1024 token，不限制正文长度。');
    const low = thinkingOptions(dashscope, 'deepseek-v4-pro').find((o) => o.value === 'low')!;
    expect(low.hint).toBe('这个接口没有独立的轻度档，请选择标准或深度。');
    expect(low).toMatchObject({ supported: false, hintKey: '这个接口没有独立的轻度档，请选择标准或深度。' });
    const nativeLow = thinkingOptions(dashscope, 'deepseek-v4-pro', 'responses', 'en').find((o) => o.value === 'low')!;
    expect(nativeLow).toMatchObject({ supported: false, hint: 'This API has no separate low effort; choose Standard or High.' });
    expect(() => thinkingParameters(dashscope, 'deepseek-v4-pro', 'low', 'responses', 'en')).toThrow('no separate low effort');
  });
  it('界面语言切换时旧记录的具体不支持原因随之改变，对局语言不变', () => {
    const store = new MemoryStore(), secrets = SecretBox.ephemeral();
    const initial = new RoomManager({ store, secrets, tickMs: 0 });
    const { roomId, hostToken } = initial.createRoom({ locale: 'zh-CN' });
    initial.dispose();
    const rec = store.loadAll()[0];
    Object.assign(rec.seats[0], { adapter: 'openai_compatible', baseUrl: dashscope, model: 'deepseek-v4-pro', thinkingMode: 'low' as ThinkingMode });
    store.save(rec);
    const restored = new RoomManager({ store, secrets, tickMs: 0 });
    try {
      const en = restored.getSetup(roomId, hostToken, 'en');
      expect(en.locale).toBe('zh-CN');
      expect(en.validationErrors).toContain('Player 1: This API has no separate low effort; choose Standard or High.');
      const ja = restored.getSetup(roomId, hostToken, 'ja');
      expect(ja.validationErrors).toContain('1番：この API には独立した軽度設定がありません。標準または深度を選んでください。');
      expect(restored.getSetup(roomId, hostToken).validationErrors).toContain('1号：这个接口没有独立的轻度档，请选择标准或深度。');
    } finally { restored.dispose(); }
  });
  it('拒绝配置时携带稳定提示模板供接口选择界面语言', () => {
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom();
      expect(() => manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, adapter: 'openai_compatible', baseUrl: dashscope, model: 'glm-5.3', thinkingMode: 'off' }] }))
        .toThrow(expect.objectContaining({ localization: { key: '这个模型始终思考，不能关闭；可以选择它支持的强度。', values: undefined } }));
    } finally { manager.dispose(); }
  });
});

describe('连接检查的界面语言', () => {
  const config = (apiProtocol: ApiProtocol): AdapterConfig => ({ apiProtocol, baseUrl: url, model: 'test', apiKey: 'secret-value', temperature: 0, timeoutSec: 5, toolMode: 'tools' });
  const replies = {
    chat_completions: { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'ping', arguments: '{"ok":true}' } }] } }] },
    responses: { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'ping', arguments: '{"ok":true}' }] },
    anthropic_messages: { content: [{ type: 'tool_use', id: 'c1', name: 'ping', input: { ok: true } }] },
  };
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 使用对应协议发送本地化测试，不发送对局投影', async (protocol) => {
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json(replies[protocol]); }));
    try {
      const result = await testConnection(config(protocol), undefined, 'en');
      expect(result).toMatchObject({ ok: true, message: 'Connection successful; the model returned a ping call.' });
      expect(JSON.stringify(sent)).toContain('This is an API connection test.');
      expect(JSON.stringify(sent)).toContain('ping');
      expect(JSON.stringify(sent)).not.toContain('这是一次');
      expect(sent).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 失败信息按界面语言包装并保留脱敏后的提供方原文', async (protocol) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider secret-value', { status: 400 })));
    try {
      const result = await testConnection(config(protocol), undefined, 'en');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('provider ***');
      expect(result.message).not.toMatch(/[\u3400-\u9fff]|secret-value/);
    } finally { vi.unstubAllGlobals(); }
  });
  it('对局投影语言优先于连接请求备用语言', async () => {
    const req = { seat: 1, locale: 'ja', projection: { locale: 'en' } as any, messages: [], tools: [], config: { ...config('responses'), baseUrl: 'https://user:pass@example.com/v1' } };
    const result = await remoteAdapter('responses').decide(req);
    expect(result.error).not.toMatch(/[\u3400-\u9fff]/);
  });
  it('模拟座位按界面语言显示连接检查结果', async () => {
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom({ locale: 'zh-CN' });
      expect((await manager.testSeat(roomId, hostToken, 1, 'ja')).message).toBe('シミュレーションプレイヤーには接続は不要です。');
      expect((await manager.testSeat(roomId, hostToken, 1)).message).toBe('模拟玩家不需要联网。');
    } finally { manager.dispose(); }
  });
});

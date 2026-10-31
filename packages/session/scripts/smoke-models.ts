import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockAdapter, openaiAdapter, type Adapter } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';
import { ModelLibrary } from '../src/model-library';

if (!process.argv.includes('--live')) throw new Error('需显式传入 --live；在内存对局中测试 3 类真实请求，行动错误最多重试 5 次，其余使用模拟玩家。');
const library = new ModelLibrary(SecretBox.fromEnvOrFile('data'), join('data', 'models.json'));
const models = library.list().filter((m) => m.apiKey && m.apiProtocol === 'chat_completions' && new URL(m.baseUrl).host.startsWith('token-plan.'));
const flash = models.find((m) => m.model === 'qwen3.8-flash');
const pro = models.find((m) => m.model === 'deepseek-v4-pro');
if (!flash || !pro) throw new Error('需要已配置的 Token Plan qwen3.8-flash 和 deepseek-v4-pro');
const used = new Set<string>();
const decisions = new Map<string, string>();
const retryOnly = process.argv.includes('--retry-only');
let injected = false;
let injectedSeat: number | undefined;
let injectedDecision: string | undefined;
const results: Record<string, unknown>[] = [];
const adapter: Adapter = {
  async decide(req) {
    const names = req.projection?.task?.tools.map((t) => t.name) ?? [];
    const key = req.toolChoice === 'auto' && req.projection?.phase === 'day' ? 'listen' :
      req.toolChoice !== 'auto' && names.includes('speak') ? 'speech' :
      req.toolChoice !== 'auto' && names.includes('vote') ? 'vote' : '';
    if (retryOnly && key !== 'vote') return mockAdapter.decide(req);
    if (retryOnly && !injected && key === 'vote') {
      injected = true;
      injectedSeat = req.seat;
      injectedDecision = req.projection!.task!.decisionId;
      return { ok: true, call: { tool: 'speak', args: { content: '错误工具，不应公开' } },
        assistant: { role: 'assistant', content: null, calls: [{ id: 'injected_wrong_tool', name: 'speak', arguments: '{"content":"错误工具，不应公开"}' }] },
        toolCallIds: ['injected_wrong_tool'], latencyMs: 0 };
    }
    if (retryOnly && (req.seat !== injectedSeat || req.projection?.task?.decisionId !== injectedDecision)) return mockAdapter.decide(req);
    const decision = `${req.seat}:${req.projection?.task?.decisionId}`;
    const retry = key !== 'listen' && decisions.get(key) === decision && results.filter((r) => r.purpose === key).length < 5;
    if (!key || (used.has(key) && !retry)) return mockAdapter.decide(req);
    used.add(key);
    if (key !== 'listen') decisions.set(key, decision);
    const model = key === 'speech' ? pro : flash;
    const result = await openaiAdapter.decide({
      ...req, stream: true,
      config: { ...req.config, baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey, thinkingMode: 'off' },
    });
    const valid = result.ok && (key === 'listen' ? !result.call : names.includes(result.call?.tool ?? ''));
    const afterToolError = req.messages.some((m) => m.role === 'tool' && m.callId === 'injected_wrong_tool' && m.content.includes('工具调用错误'));
    const row = { purpose: key, model: model.model, seat: req.seat, ok: result.ok, valid, afterToolError, tool: result.call?.tool, latencyMs: result.latencyMs, failureKind: result.failureKind, error: result.error };
    results.push(row);
    console.log(JSON.stringify(row));
    return result;
  },
};
const store = new MemoryStore();
const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
const { roomId, hostToken } = manager.createRoom();
try {
  manager.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
  manager.start(roomId, hostToken);
  await manager.whenIdle(roomId);
  const view = manager.view(roomId, hostToken);
  const audit = manager.audit(roomId, hostToken);
  const summary = { at: new Date().toISOString(), status: view.room.status, paused: view.room.paused,
    fallbacks: view.projection!.events.filter((e) => e.type === 'action.fallback').length,
    rejected: audit.filter((a) => !a.ok).length, results };
  mkdirSync('data/diagnostics', { recursive: true });
  writeFileSync(`data/diagnostics/model-smoke-${retryOnly ? 'retry' : 'latest'}.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.status, paused: summary.paused, fallbacks: summary.fallbacks, rejected: summary.rejected }));
  if ((retryOnly ? ['vote'] : ['listen', 'speech', 'vote']).some((purpose) => !results.some((r) => r.purpose === purpose && r.valid)) ||
      (retryOnly && !results.some((r) => r.afterToolError && r.valid)) || summary.status !== 'ended' || summary.paused || summary.fallbacks) process.exitCode = 1;
} finally { manager.dispose(); }

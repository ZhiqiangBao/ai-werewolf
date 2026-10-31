import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { API_PROTOCOLS, type ToolCall } from '@werewolf/protocol';
import { getAdapter, mockDecision, type Adapter, type DecideRequest } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

describe('多协议对局、存档与重启', () => {
  for (const protocol of API_PROTOCOLS) it(`${protocol} 逐条旁听、正式行动与暂停重启后可完成整局，不重复执行行动`, async () => {
    const pending = new Map<string, DecideRequest>();
    const sent: { seat: number; body: any }[] = [];
    let serial = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (b) => { raw += b; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const input = pending.get(body.model)!;
        sent.push({ seat: input.seat, body });
        const call: ToolCall | undefined = input.toolChoice === 'auto' ? undefined : mockDecision(input.projection!, input.projection!.task!.tools);
        const id = `call_${input.seat}_${++serial}`;
        const reply = call ? null : `私有旁听回复_${input.seat}`;
        const response = protocol === 'chat_completions' ? { choices: [{ message: { role: 'assistant', content: reply, ...(call ? { tool_calls: [{ id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } }] } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } } }
          : protocol === 'responses' ? { status: 'completed', output: [{ type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: `opaque_seat_${input.seat}` }, ...(call ? [{ type: 'function_call', id: `fc_${id}`, call_id: id, name: call.tool, arguments: JSON.stringify(call.args), status: 'completed' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }])], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 50 } } }
            : { content: [{ type: 'thinking', thinking: '', signature: `opaque_seat_${input.seat}` }, ...(call ? [{ type: 'tool_use', id, name: call.tool, input: call.args }] : [{ type: 'text', text: reply }])], stop_reason: call ? 'tool_use' : 'end_turn', usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 50 } };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    let calls = 0;
    let reached!: () => void;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { reached = resolve; });
    const adapter: Adapter = { async decide(req) {
      expect(req.config.apiProtocol).toBe(protocol);
      if (++calls === 25) {
        reached();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      pending.set(req.config.model, req);
      return getAdapter('openai_compatible', req.config.apiProtocol).decide(req);
    } };
    const store = new MemoryStore();
    const secrets = SecretBox.ephemeral();
    let manager = new RoomManager({ store, secrets, tickMs: 0, adapters: { openai_compatible: adapter } });
    const { roomId, hostToken } = manager.createRoom();
    try {
      manager.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0, ruleValues: { 'sheriff.enabled': false }, seats: Array.from({ length: 9 }, (_, i) => ({ seat: i + 1, adapter: 'openai_compatible', apiProtocol: protocol, model: `seat-${i + 1}`, baseUrl, apiKey: 'unit-test-secret', thinkingMode: 'default' })) });
      manager.start(roomId, hostToken);
      await barrier;
      manager.control(roomId, hostToken, 'pause');
      release();
      await manager.whenIdle(roomId);
      manager.dispose();
      const snapshot = store.loadAll()[0];
      expect(snapshot.status).toBe('running'); expect(snapshot.paused).toBe(true);
      expect(snapshot.state!.rules.toolsetVersion).toBe(2);
      expect(snapshot.threads!.every((t) => t.formatVersion === 2)).toBe(true);
      const before = snapshot.actions.length;
      expect(before).toBeGreaterThan(0);
      manager = new RoomManager({ store, secrets, tickMs: 0, adapters: { openai_compatible: adapter } });
      manager.control(roomId, hostToken, 'resume');
      await manager.whenIdle(roomId);
      const view = manager.view(roomId, hostToken);
      expect(view.room.status).toBe('ended'); expect(view.room.paused).toBe(false);
      manager.dispose();
      const record = store.loadAll()[0];
      expect(record.actions.length).toBeGreaterThan(before);
      expect(new Set(record.actions.map((a) => `${a.decisionId}:${a.seat}`)).size).toBe(record.actions.length);
      expect(record.events.some((e) => e.type === 'action.fallback')).toBe(false);
      const audit = store.readAudit(roomId);
      expect(audit.some((a) => a.purpose === 'listen')).toBe(true);
      expect(audit.some((a) => a.purpose === 'action')).toBe(true);
      expect(audit.filter((a) => a.ok).every((a) => a.apiProtocol === protocol && a.usage?.cacheReadTokens === 50)).toBe(true);
      expect(audit.filter((a) => a.ok).every((a) => a.request?.apiProtocol === protocol && (a.request?.tools.length ?? 0) > 0)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('unit-test-secret');
      for (const { seat, body } of sent) {
        for (let other = 1; other <= 9; other++) if (other !== seat) {
          expect(JSON.stringify(body)).not.toContain(`opaque_seat_${other}`);
          expect(JSON.stringify(body)).not.toContain(`私有旁听回复_${other}`);
        }
      }
    } finally { manager.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30000);
});

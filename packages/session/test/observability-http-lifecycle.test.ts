import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultGameTiming, type ApiProtocol, type ObservationEvent, type Projection } from '@werewolf/protocol';
import { mockAdapter, remoteAdapter, type Adapter, type DecideRequest } from '@werewolf/llm';
import { DEAL12, TestGame } from '../../engine/test/harness';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

type Operation = 'pause' | 'end' | 'decision_changed' | 'dispose';
const protocols: ApiProtocol[] = ['chat_completions', 'responses', 'anthropic_messages'];
const operations: Operation[] = ['pause', 'end', 'decision_changed', 'dispose'];

/** A real loopback service sends one synthetic thinking delta and holds the connection open. */
async function heldService(protocol: ApiProtocol): Promise<{ server: Server; baseUrl: string; arrived: Promise<void> }> {
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const chunks = protocol === 'chat_completions' ? [{ choices: [{ delta: { reasoning_content: 'synthetic-progress' } }] }]
        : protocol === 'responses' ? [{ type: 'response.reasoning_text.delta', delta: 'synthetic-progress' }]
          : [{ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 2 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'synthetic-progress' } }];
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''));
      reached();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, arrived };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe('real loopback HTTP cancellation lifecycle', () => {
  for (const protocol of protocols) for (const operation of operations) {
    it(`${protocol} / ${operation}: one terminal model call and one terminal HTTP attempt`, async () => {
      const service = await heldService(protocol);
      const dir = mkdtempSync(join(tmpdir(), 'werewolf-http-lifecycle-'));
      const store = new MemoryStore(); const secrets = SecretBox.ephemeral();
      const setup = new RoomManager({ store, secrets, tickMs: 0 }); setup.createRoom(); setup.dispose();
      const rec = store.loadAll()[0]; store.rooms.clear();
      const game = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false }, seed: 'http-lifecycle-fixed' });
      game.night({ kill: null, inspect: 1 });
      game.until((g) => g.waiting().some((s) => g.toolsOf(s).some((t) => t.name === 'speak')) &&
        g.waiting().some((speaker) => g.alive().some((seat) => seat !== speaker && g.view(seat).interrupts.some((t) => t.name === 'wolf_explode'))));
      const speaker = game.waiting().find((seat) => game.toolsOf(seat).some((t) => t.name === 'speak'))!;
      const wolf = game.alive().find((seat) => seat !== speaker && game.view(seat).interrupts.some((t) => t.name === 'wolf_explode'))!;
      const timing = defaultGameTiming(); for (const value of Object.values(timing)) value.intervalMs = 0;
      Object.assign(rec, { id: 'fixed-lifecycle', hostToken: 'host', spectatorToken: 'spectator',
        seatTokens: Array.from({ length: 12 }, (_, i) => `seat-${i + 1}`), createdAt: 100_000,
        status: 'running', paused: true, aiPacingMs: 0, timing, rules: game.state.rules, seed: game.state.seed,
        state: game.state, events: game.events, actions: game.actions, deadlines: {}, heardSeq: game.state.seq,
        threads: [{ seat: speaker, seen: game.state.seq, messages: [] }] });
      for (const seat of rec.seats) {
        seat.controller = seat.seat === speaker ? 'ai' : 'human';
        seat.adapter = 'openai_compatible'; seat.apiProtocol = protocol; seat.baseUrl = service.baseUrl;
        seat.model = 'lifecycle-model'; seat.thinkingMode = 'default';
      }
      store.save(rec);
      const events: ObservationEvent[] = [];
      let actionRequest: DecideRequest | undefined;
      let progress!: () => void;
      const receivedContent = new Promise<void>((resolve) => { progress = resolve; });
      const adapter: Adapter = { decide(req) {
        if (req.toolChoice === 'auto') return mockAdapter.decide(req);
        actionRequest = req;
        return remoteAdapter(protocol).decide({ ...req, onDelta: (delta) => { req.onDelta?.(delta); if (delta.thinking) progress(); } });
      } };
      const manager = new RoomManager({ store, secrets, tickMs: 0, now: () => 100_000, sleep: async () => {}, adapters: { openai_compatible: adapter },
        observability: { mappingPath: join(dir, 'mapping.json'), sink: { emit: (event) => events.push(event) } } });
      try {
        manager.control(rec.id, rec.hostToken, 'resume');
        await service.arrived;
        await receivedContent;
        expect(actionRequest?.observation).toBeDefined();
        const callId = actionRequest!.observation!.callId;
        const attemptStart = events.find((event) => event.kind === 'http_attempt' && event.phase === 'start' && event.callId === callId);
        expect(attemptStart).toBeDefined();
        if (operation === 'dispose') manager.dispose();
        else if (operation === 'decision_changed') {
          const projection = manager.view(rec.id, rec.seatTokens[wolf - 1]).projection as Projection;
          expect(manager.act(rec.id, rec.seatTokens[wolf - 1], { decisionId: projection.actionWindowId, tool: 'wolf_explode', args: {} }).ok).toBe(true);
        } else manager.control(rec.id, rec.hostToken, operation);
        await waitFor(() => events.some((event) => event.kind === 'http_attempt' && event.phase === 'end' && event.id === attemptStart!.id));
        const matchingCalls = events.filter((event) => event.kind === 'model_call' && event.id === callId);
        const attempts = events.filter((event) => event.kind === 'http_attempt' && event.id === attemptStart!.id);
        expect(matchingCalls.map((event) => event.phase)).toEqual(['start', 'end']);
        expect(attempts.map((event) => event.phase)).toEqual(['start', 'end']);
        expect(matchingCalls[1].outcome).toBe('cancelled');
        expect(matchingCalls[1].cancelReason).toBe(operation);
        expect(attempts[1].outcome).toBe(operation === 'dispose' ? 'incomplete' : 'cancelled');
        expect(attempts[1].callId).toBe(callId);
        if (operation !== 'dispose') {
          expect(attempts[1].firstContentKind).toBe('thinking');
          expect(attempts[1].metrics?.firstBodyByteMs).toEqual({ valueMs: expect.any(Number), source: 'client' });
          expect(attempts[1].metrics?.firstStreamContentMs).toEqual({ valueMs: expect.any(Number), source: 'client' });
        }
        if (operation === 'dispose') {
          const count = events.length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(events).toHaveLength(count);
          manager.control(rec.id, rec.hostToken, 'end');
        }
        await manager.whenIdle(rec.id);
      } finally {
        try { if (manager.view(rec.id, rec.hostToken).room.status === 'running') manager.control(rec.id, rec.hostToken, 'end'); } catch { /* already stopped */ }
        manager.dispose();
        service.server.closeAllConnections();
        await new Promise<void>((resolve) => service.server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);
  }
});

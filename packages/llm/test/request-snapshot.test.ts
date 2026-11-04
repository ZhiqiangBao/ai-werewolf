import { afterEach, expect, it, vi } from 'vitest';
import type { ApiProtocol, ModelRequestInfo } from '@werewolf/protocol';
import { remoteAdapter, type DecideRequest } from '../src/index';
import { protocolBinding } from '../src/transcript';
import { requestSnapshot } from '../src/request-snapshot';

const key = 'fixture-secret-key';
function fixture(protocol: ApiProtocol): DecideRequest {
  return {
    seat: 1, messages: [{ role: 'user', content: 'fixture message' }], tools: [], stream: true,
    config: { apiProtocol: protocol, baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: key, temperature: 0.2, toolMode: 'tools', timeoutSec: 12 },
  };
}

afterEach(() => vi.unstubAllGlobals());

it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('captures the actual %s request without authentication', async (protocol) => {
  const req = fixture(protocol);
  const snapshots: ModelRequestInfo[] = [];
  const sent: { endpoint: string; body: unknown; headers: Headers }[] = [];
  req.onRequest = (info) => snapshots.push(info);
  vi.stubGlobal('fetch', vi.fn(async (endpoint: string, init: RequestInit) => {
    sent.push({ endpoint, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return Response.json(protocol === 'chat_completions' ? { choices: [{ message: { content: 'ok' } }] }
      : protocol === 'responses' ? { status: 'completed', output: [] } : { content: [], stop_reason: 'end_turn' });
  }));
  await remoteAdapter(protocol).decide(req);
  expect(sent).toHaveLength(1);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].replay).toEqual({ endpoint: sent[0].endpoint, body: sent[0].body, binding: protocolBinding(req.config), timeoutSec: 12 });
  expect(snapshots[0].replay?.body.stream).toBe(true);
  expect(JSON.stringify(snapshots[0])).not.toContain(key);
  expect(JSON.stringify(snapshots[0])).not.toMatch(/authorization|x-api-key/i);
  expect(sent[0].headers.get(protocol === 'anthropic_messages' ? 'x-api-key' : 'authorization')).toContain(key);
});

it('captures each chat compatibility fallback with the body actually sent', async () => {
  const req = fixture('chat_completions');
  req.config.baseUrl = 'https://fallback-fixture.invalid/v1';
  const snapshots: ModelRequestInfo[] = [];
  const bodies: unknown[] = [];
  req.onRequest = (info) => snapshots.push(info);
  vi.stubGlobal('fetch', vi.fn(async (_endpoint: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? Response.json({ error: 'stream unsupported' }, { status: 400 })
      : bodies.length === 2 ? Response.json({ error: 'tool_choice unsupported' }, { status: 400 })
      : Response.json({ choices: [{ message: { content: 'ok' } }] });
  }));
  await remoteAdapter('chat_completions').decide(req);
  expect(bodies).toHaveLength(3);
  expect(snapshots.map((s) => s.replay?.body)).toEqual(bodies);
  expect(bodies).toMatchObject([{ stream: true, tool_choice: 'required' }, { tool_choice: 'required' }, { tool_choice: 'auto' }]);
  expect(bodies[1]).not.toHaveProperty('stream');
});

it('clones nested body and drops replay for unsafe URLs or uncloneable bodies', () => {
  const req = fixture('responses');
  const info: ModelRequestInfo = { apiProtocol: 'responses', tools: [] };
  const body = { input: [{ content: 'before' }] };
  const snapshot = requestSnapshot(req, 'https://fixture.invalid/v1/responses', body, info);
  body.input[0].content = 'after';
  expect(snapshot.replay?.body).toEqual({ input: [{ content: 'before' }] });
  for (const url of ['ftp://fixture.invalid/path', 'https://user:pass@fixture.invalid/path', 'https://fixture.invalid/path?key=secret', 'https://fixture.invalid/path#secret', 'https://fixture.invalid/path?', 'https://fixture.invalid/path#', 'invalid']) {
    expect(requestSnapshot(req, url, body, info)).toEqual(info);
  }
  expect(requestSnapshot(req, 'https://fixture.invalid/', { bad: () => {} }, info)).toEqual(info);
});

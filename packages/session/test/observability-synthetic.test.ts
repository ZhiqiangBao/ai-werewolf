import { describe, expect, it } from 'vitest';
import { createSyntheticFetch } from '../src/observability/synthetic-fetch';
import { formalSyntheticPlan, overheadSyntheticPlan, SYNTHETIC_SCENARIOS } from '../src/observability/synthetic-plan';
import { startSyntheticService } from '../src/observability/synthetic-service';
import { getAdapter } from '@werewolf/llm';

describe('synthetic plan', () => {
  it('keeps formal matrix, warmups, failures and paired overhead explicit', () => {
    expect(SYNTHETIC_SCENARIOS.map((s) => s.id)).toEqual(Array.from({ length: 15 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`));
    const plan = formalSyntheticPlan();
    expect(plan.filter((x) => x.phase === 'warmup')).toHaveLength(9);
    expect(plan.filter((x) => x.phase === 'measurement')).toHaveLength(189);
    const overhead = overheadSyntheticPlan();
    expect(overhead).toHaveLength(360);
    for (let i = 0; i < overhead.length; i += 2) {
      const [a, b] = overhead.slice(i, i + 2);
      expect([a.scenario, a.protocol, a.seed, a.pair]).toEqual([b.scenario, b.protocol, b.seed, b.pair]);
      expect(a.observation).not.toBe(b.observation);
      expect(a.observation).toBe(a.order === 'BA');
    }
  });

  it('associates concurrent calls and retries without modifying body or contacting other origins', async () => {
    const registered: string[] = [];
    const seen: string[] = [];
    const wrapper = createSyntheticFetch({
      origins: ['http://127.0.0.1:1234'],
      async register(_origin, id, plan: string) { await Promise.resolve(); registered.push(`${id}:${plan}`); },
      fetch: async (_input, init) => {
        seen.push(`${new Headers(init?.headers).get('x-synthetic-attempt-id')}:${init?.body}`);
        return new Response('{}');
      },
    });
    await Promise.all(['a', 'b'].map((name) => wrapper.run((id) => `${name}-${id}`, async () => {
      for (let i = 0; i < 2; i++) {
        wrapper.setAttempt(`${name}${i}`);
        await wrapper.fetch('http://127.0.0.1:1234/path', { method: 'POST', body: 'original' });
      }
    })));
    expect(registered.sort()).toEqual(['a0:a-a0', 'a1:a-a1', 'b0:b-b0', 'b1:b-b1']);
    expect(seen.sort()).toEqual(['a0:original', 'a1:original', 'b0:original', 'b1:original']);
    await expect(wrapper.fetch('http://example.com/')).rejects.toThrow(/non-runner origin/);
    await expect(wrapper.fetch('http://127.0.0.1:1234/')).rejects.toThrow(/call context/);
    expect(() => createSyntheticFetch({ origins: ['http://localhost:1234'], async register() {} })).toThrow(/runner-created/);
  });

  it('registers isolated attempts with an independent loopback process and records its own truth', async () => {
    const service = await startSyntheticService();
    try {
      const wrapper = createSyntheticFetch({ origins: [service.origin], register: (_origin, id, plan: Parameters<typeof service.register>[1]) => service.register(id, plan) });
      const result = await wrapper.run(() => ({ protocol: 'responses' as const, stream: false, headersMs: 1, firstContentMs: 1, chunks: 1, chunkIntervalMs: 0 }), async () => {
        wrapper.setAttempt('attempt-1');
        return wrapper.fetch(`${service.origin}/v1/responses`, { method: 'POST', body: '{"original":true}' });
      });
      expect(await result.json()).toMatchObject({ status: 'completed' });
      // IPC delivery is asynchronous, so permit it to arrive before closing the process.
      for (let i = 0; i < 50 && !service.truth.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(service.truth).toHaveLength(1);
      expect(service.truth[0]).toMatchObject({ attemptId: 'attempt-1', finished: true });
      expect(service.truth[0].headersMs).toBeGreaterThanOrEqual(0);
      expect(service.truth[0].firstBodyByteMs).toBeGreaterThanOrEqual(0);
      expect(service.truth[0].firstStreamContentMs).toBeNull();
      expect(service.truth[0].bodyConsumeMs).toBeGreaterThanOrEqual(0);
    } finally { await service.close(); }
  }, 10000);

  it('returns parsable streaming responses through each real protocol adapter', async () => {
    const service = await startSyntheticService();
    const original = globalThis.fetch;
    try {
      for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
        const wrapper = createSyntheticFetch({ origins: [service.origin], register: (_origin, id, plan: Parameters<typeof service.register>[1]) => service.register(id, plan), fetch: original });
        globalThis.fetch = wrapper.fetch;
        const result = await wrapper.run(() => ({ protocol, stream: true, headersMs: 1, firstContentMs: 1, chunks: 4, chunkIntervalMs: 1,
          call: { tool: 'synthetic_tool', args: { target: 2 } } }), () => {
          wrapper.setAttempt(protocol);
          return getAdapter('openai_compatible', protocol).decide({ seat: 1, messages: [], tools: [{ name: 'synthetic_tool', title: 'test', description: 'test', params: [] }], toolChoice: 'required', stream: true,
            config: { apiProtocol: protocol, baseUrl: service.origin, model: 'synthetic', apiKey: null, temperature: 0, toolMode: 'tools', timeoutSec: 5 } });
        });
        expect(result.ok, protocol).toBe(true);
        expect(result.call, protocol).toEqual({ tool: 'synthetic_tool', args: { target: 2 } });
      }
    } finally { globalThis.fetch = original; await service.close(); }
  }, 10000);
});

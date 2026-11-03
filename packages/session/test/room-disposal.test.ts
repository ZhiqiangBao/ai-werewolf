import { expect, it, vi } from 'vitest';
import type { Adapter } from '@werewolf/llm';
import { API_PROTOCOLS } from '@werewolf/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

it('flushes each room before aborting requests in the next room', async () => {
  vi.useFakeTimers();
  const store = new MemoryStore();
  const requested = new Set<string>();
  let secondRoom = '';
  let firstRoom = '';
  let observedStatus: string | undefined;
  let secondAborted = false;
  const adapter: Adapter = {
    decide: ({ cacheKey, signal }) => new Promise(() => {
      const roomId = cacheKey!.split(':')[1];
      requested.add(roomId);
      signal!.addEventListener('abort', () => {
        if (roomId === secondRoom) {
          secondAborted = true;
          observedStatus = store.loadAll().find((r) => r.id === firstRoom)?.status;
        }
      });
    }),
  };
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter }, sleep: async () => {} });
  try {
    const first = manager.createRoom();
    const second = manager.createRoom();
    firstRoom = first.roomId;
    secondRoom = second.roomId;
    manager.start(first.roomId, first.hostToken);
    manager.start(second.roomId, second.hostToken);
    for (let i = 0; i < 100 && (!requested.has(firstRoom) || !requested.has(secondRoom)); i++) await Promise.resolve();
    expect(requested.has(firstRoom)).toBe(true);
    expect(requested.has(secondRoom)).toBe(true);
    expect(store.loadAll().find((r) => r.id === firstRoom)?.status).toBe('setup');
    expect(secondAborted).toBe(false);
    manager.dispose();
    expect(secondAborted).toBe(true);
    expect(observedStatus).toBe('running');
  } finally {
    manager.dispose();
    vi.useRealTimers();
  }
});

it('dispose 是幂等终态，拒绝新工作并保留授权只读视图', async () => {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
  const { roomId, hostToken } = manager.createRoom();
  const pending = manager.whenDisposed();
  expect(manager.whenDisposed()).toBe(pending);
  manager.dispose(); manager.dispose();
  expect(() => manager.createRoom()).toThrow('服务正在关闭');
  expect(() => manager.updateSetup(roomId, hostToken, {})).toThrow('服务正在关闭');
  expect(() => manager.start(roomId, hostToken)).toThrow('服务正在关闭');
  expect(() => manager.control(roomId, hostToken, 'resume')).toThrow('服务正在关闭');
  expect(() => manager.subscribe(roomId, hostToken, () => {})).toThrow('服务正在关闭');
  await expect(manager.testSeat(roomId, hostToken, 1)).rejects.toMatchObject({ code: 'MANAGER_DISPOSED' });
  expect(() => manager.updateSetup(roomId, 'invalid', {})).toThrow('凭证无效');
  expect(manager.getSetup(roomId, hostToken).roomId).toBe(roomId);
  expect((await pending).durable).toBe(true);
  await manager.whenIdle(roomId);
});

it('忽略取消的模型迟到 resolve、reject、delta 均不再提交，且等待可完成', async () => {
  const pending: { resolve: (value: any) => void; reject: (error: Error) => void; delta?: (value: { thinking?: string }) => void }[] = [];
  const adapter: Adapter = { decide: (req) => new Promise((resolve, reject) => pending.push({ resolve, reject, delta: req.onDelta })) };
  const store = new MemoryStore(), manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter }, sleep: async () => {} });
  const { roomId, hostToken } = manager.createRoom(); manager.start(roomId, hostToken);
  for (let i = 0; i < 100 && pending.length < 2; i++) await Promise.resolve();
  expect(pending.length).toBeGreaterThan(1);
  let notified = 0; const unsubscribe = manager.subscribe(roomId, hostToken, () => { notified++; });
  const idle = manager.whenIdle(roomId); manager.dispose();
  const report = await manager.whenDisposed(); await idle;
  expect(report.externalUnconfirmed).toBeGreaterThan(0);
  const before = structuredClone(store.loadAll()); const beforeView = structuredClone(manager.view(roomId, hostToken)); const beforeAudit = manager.audit(roomId, hostToken); const beforeNotifications = notified;
  pending[0].delta?.({ thinking: 'late' }); pending[0].resolve({ ok: true, call: { tool: 'speak', args: { content: 'late' } }, toolCallIds: [], latencyMs: 0 });
  pending[1].reject(new Error('late rejection'));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(store.loadAll()).toEqual(before); expect(manager.view(roomId, hostToken)).toEqual(beforeView); expect(manager.audit(roomId, hostToken)).toEqual(beforeAudit); expect(notified).toBe(beforeNotifications);
  unsubscribe();
});

it('永不返回的注入等待不会阻止本地退出', async () => {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, sleep: () => new Promise(() => {}) });
  const { roomId, hostToken } = manager.createRoom(); manager.start(roomId, hostToken);
  const idle = manager.whenIdle(roomId); manager.dispose();
  const report = await manager.whenDisposed(); expect(report.durable).toBe(true); expect(report.externalUnconfirmed).toBeGreaterThan(0); await idle;
});

it('暂停后立刻恢复仍会重新调度，退出封口不会改变正常恢复时序', async () => {
  let calls = 0;
  const adapter: Adapter = { decide: () => { calls++; return new Promise(() => {}); } };
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter }, sleep: async () => {} });
  const { roomId, hostToken } = manager.createRoom(); manager.start(roomId, hostToken);
  for (let i = 0; i < 100 && !calls; i++) await Promise.resolve();
  const firstWave = calls; expect(firstWave).toBeGreaterThan(0);
  manager.control(roomId, hostToken, 'pause'); manager.control(roomId, hostToken, 'resume');
  for (let i = 0; i < 100 && calls <= firstWave; i++) await Promise.resolve();
  expect(calls).toBeGreaterThan(firstWave);
  manager.dispose(); await manager.whenDisposed();
});

it.each(API_PROTOCOLS)('%s 的未完成原生响应不会在退出后追加', async (protocol) => {
  const calls: { resolve: (value: any) => void; protocol: string | undefined }[] = [];
  const adapter: Adapter = { decide: (req) => new Promise((resolve) => calls.push({ resolve, protocol: req.config.apiProtocol })) };
  const store = new MemoryStore(), manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { openai_compatible: adapter }, sleep: async () => {} });
  const { roomId, hostToken } = manager.createRoom();
  manager.updateSetup(roomId, hostToken, { aiPacingMs: 0, seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, adapter: 'openai_compatible' as const, apiProtocol: protocol, model: 'fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture' })) });
  manager.start(roomId, hostToken);
  for (let i = 0; i < 100 && !calls.length; i++) await Promise.resolve();
  expect(calls.length).toBeGreaterThan(0); expect(calls.every((c) => c.protocol === protocol)).toBe(true);
  manager.dispose(); await manager.whenDisposed();
  const before = structuredClone(store.loadAll());
  for (const call of calls) call.resolve({ ok: true, assistant: { role: 'assistant', content: 'late', native: { items: [{ type: 'fixture' }] } }, toolCallIds: [], latencyMs: 0 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(store.loadAll()).toEqual(before);
});

it('单房间保存失败被报告且不阻止后续房间保存', async () => {
  class FailingStore extends MemoryStore {
    failId = ''; saves: string[] = [];
    override save(room: Parameters<MemoryStore['save']>[0]): void {
      this.saves.push(room.id); if (room.id === this.failId) throw new Error('synthetic'); super.save(room);
    }
  }
  const store = new FailingStore(), manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  const a = manager.createRoom(), b = manager.createRoom(); store.saves = []; store.failId = a.roomId;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    manager.dispose(); const report = await manager.whenDisposed();
    expect(store.saves).toEqual([a.roomId, b.roomId]);
    expect(report.durable).toBe(false); expect(report.rooms).toEqual([{ roomId: a.roomId, saved: false, errorCode: 'ROOM_SAVE_FAILED' }, { roomId: b.roomId, saved: true }]);
  } finally { log.mockRestore(); }
});

it('在途连接检查取消且不等待不合作的传输，新检查直接拒绝', async () => {
  let signal: AbortSignal | undefined, requests = 0;
  vi.stubGlobal('fetch', (_url: unknown, options: RequestInit) => { requests++; signal = options.signal ?? undefined; return new Promise(() => {}); });
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    const { roomId, hostToken } = manager.createRoom();
    manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, adapter: 'openai_compatible', model: 'fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture' }] });
    const pending = manager.testSeat(roomId, hostToken, 1);
    for (let i = 0; i < 100 && !requests; i++) await Promise.resolve();
    expect(requests).toBe(1); manager.dispose();
    expect((await pending).message).toContain('连接检查已取消');
    await manager.whenDisposed(); expect(signal?.aborted).toBe(true);
    await expect(manager.testSeat(roomId, hostToken, 1)).rejects.toMatchObject({ code: 'MANAGER_DISPOSED' });
    expect(requests).toBe(1);
  } finally { manager.dispose(); vi.unstubAllGlobals(); }
});

it('在途连接检查按房间分别取消并保存，活动 whenIdle 不等待连接检查', async () => {
  class OrderedStore extends MemoryStore {
    log: string[] = [];
    override save(room: Parameters<MemoryStore['save']>[0]): void { this.log.push(`save:${room.id}`); super.save(room); }
  }
  const store = new OrderedStore(); let issued = 0;
  vi.stubGlobal('fetch', (_url: unknown, options: RequestInit) => { const n = ++issued; options.signal!.addEventListener('abort', () => store.log.push(`abort:${n}`)); return new Promise(() => {}); });
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    const a = manager.createRoom(), b = manager.createRoom();
    for (const room of [a, b]) manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, adapter: 'openai_compatible', model: 'fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture' }] });
    const first = manager.testSeat(a.roomId, a.hostToken, 1), second = manager.testSeat(b.roomId, b.hostToken, 1);
    for (let i = 0; i < 100 && issued < 2; i++) await Promise.resolve();
    expect(issued).toBe(2); await manager.whenIdle(a.roomId);
    store.log = []; manager.dispose();
    expect((await first).ok).toBe(false); expect((await second).ok).toBe(false); await manager.whenDisposed();
    expect(store.log).toEqual(['abort:1', `save:${a.roomId}`, 'abort:2', `save:${b.roomId}`]);
  } finally { manager.dispose(); vi.unstubAllGlobals(); }
});

it.each([false, true])('退出同步记录每个在途模型调用一次取消，观测开启=%s', async (observed) => {
  const dir = mkdtempSync(join(process.cwd(), '.test-dispose-'));
  const pending: { resolve: (v: any) => void; reject: (e: Error) => void }[] = [];
  const adapter: Adapter = { decide: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const store = new MemoryStore();
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter }, sleep: async () => {},
    ...(observed ? { observability: { mappingPath: join(dir, 'map.json'), sink: { emit: () => {} } } } : {}) });
  try {
    const { roomId, hostToken } = manager.createRoom(); manager.start(roomId, hostToken);
    for (let i = 0; i < 100 && pending.length < 2; i++) await Promise.resolve();
    expect(pending.length).toBeGreaterThan(1); manager.dispose();
    const cancellations = manager.audit(roomId, hostToken).filter((row) => row.failureKind === 'cancelled');
    expect(cancellations).toHaveLength(pending.length);
    for (const row of cancellations) {
      expect(row).toMatchObject({ model: 'mock', ok: false, error: 'dispose' });
      expect(row.decisionId).toBeTruthy(); expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      expect(row.messages).toBeUndefined(); expect(row.request).toBeUndefined(); expect(row.response).toBeUndefined(); expect(row.toolCall).toBeUndefined();
    }
    await manager.whenDisposed();
    pending[0].resolve({ ok: true, toolCallIds: [], latencyMs: 0 }); pending[1].reject(new Error('late'));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(manager.audit(roomId, hostToken).filter((row) => row.failureKind === 'cancelled')).toEqual(cancellations);
  } finally { manager.dispose(); await manager.whenDisposed(); rmSync(dir, { recursive: true, force: true }); }
});

it('取消审计失败不阻止两房间逐次取消和最终保存，报告不可持久化', async () => {
  class AuditFailStore extends MemoryStore {
    failId = ''; log: string[] = [];
    override appendAudit(roomId: string, entry: Parameters<MemoryStore['appendAudit']>[1]): void {
      this.log.push(`audit:${roomId}`); if (roomId === this.failId) throw new Error('synthetic'); super.appendAudit(roomId, entry);
    }
    override save(room: Parameters<MemoryStore['save']>[0]): void { this.log.push(`save:${room.id}`); super.save(room); }
  }
  const store = new AuditFailStore(), requests = new Set<string>();
  const adapter: Adapter = { decide: ({ cacheKey, signal }) => new Promise(() => {
    const room = cacheKey!.split(':')[1]; requests.add(room); signal!.addEventListener('abort', () => store.log.push(`abort:${room}`));
  }) };
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter }, sleep: async () => {} });
  const a = manager.createRoom(), b = manager.createRoom(); manager.start(a.roomId, a.hostToken); manager.start(b.roomId, b.hostToken);
  for (let i = 0; i < 100 && requests.size < 2; i++) await Promise.resolve();
  expect(requests.size).toBe(2); store.log = []; store.failId = a.roomId;
  manager.dispose(); const report = await manager.whenDisposed();
  expect(report.durable).toBe(false); expect(report.errors).toContain('ROOM_CANCEL_AUDIT_FAILED');
  expect(report.rooms.every((room) => room.saved)).toBe(true);
  const firstSave = store.log.indexOf(`save:${a.roomId}`), secondAbort = store.log.indexOf(`abort:${b.roomId}`);
  expect(store.log.indexOf(`audit:${a.roomId}`)).toBeLessThan(firstSave);
  expect(store.log.indexOf(`abort:${a.roomId}`)).toBeLessThan(firstSave);
  expect(firstSave).toBeLessThan(secondAbort);
  expect(secondAbort).toBeLessThan(store.log.indexOf(`save:${b.roomId}`));
});

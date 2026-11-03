import { afterEach, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@werewolf/protocol';
import { mockAdapter, mockDecision, type Adapter, type DecideRequest, type DecideResult } from '@werewolf/llm';
import { ApiFailure as PackageFailure, MemoryStore, RoomManager, SecretBox } from '../src/index';
import { ApiFailure as ManagerFailure } from '../src/manager';
import { ApiFailure as ServiceFailure } from '../src/room-failure';
import { RoomPersistence } from '../src/room-persistence';
import { RoomViewService } from '../src/room-view';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function record(start = false) {
  const store = new MemoryStore();
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  const { roomId, hostToken } = manager.createRoom();
  if (start) {
    const setup = manager.updateSetup(roomId, hostToken, { aiPacingMs: 0, seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' as const })) });
    for (const seat of setup.tokens.seats) manager.participate(roomId, seat.token, { ready: true });
    manager.start(roomId, hostToken);
  }
  manager.dispose();
  return store.loadAll().find((room) => room.id === roomId)!;
}

it('300ms 内的保存合并为一次，立即 flush 会取消原来的定时保存', () => {
  const rec = record();
  vi.useFakeTimers();
  const store = new MemoryStore();
  const save = vi.spyOn(store, 'save');
  const persistence = new RoomPersistence(store, Date.now);
  persistence.scheduleSave(rec);
  vi.advanceTimersByTime(200);
  rec.paused = true;
  persistence.scheduleSave(rec);
  vi.advanceTimersByTime(99);
  expect(save).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(store.loadAll()[0].paused).toBe(true);
  persistence.scheduleSave(rec);
  persistence.flush(rec);
  expect(save).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(300);
  expect(save).toHaveBeenCalledTimes(2);
});

it('保存失败记录错误而不抛出，后续仍可安排保存', () => {
  const rec = record();
  vi.useFakeTimers();
  const store = new MemoryStore();
  const save = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('磁盘不可用'); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const persistence = new RoomPersistence(store, Date.now);
  persistence.scheduleSave(rec);
  expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  expect(error).toHaveBeenCalledWith(`房间 ${rec.id} 保存失败：`, '磁盘不可用');
  persistence.scheduleSave(rec);
  vi.advanceTimersByTime(300);
  expect(save).toHaveBeenCalledTimes(2);
  expect(store.loadAll()[0].id).toBe(rec.id);
});

it('审计编号从已有条数接续，记录受控时间并按房间隔离', () => {
  const rec = record(), other = { ...rec, id: 'other' };
  const store = new MemoryStore();
  const entry: Omit<AuditEntry, 'id' | 'at'> = { seat: 1, model: 'test', decisionId: 'decision', projectionVersion: 1, ok: true };
  store.appendAudit(rec.id, { ...entry, id: 1, at: 1 });
  store.appendAudit(rec.id, { ...entry, id: 2, at: 2 });
  const persistence = new RoomPersistence(store, () => 42);
  persistence.writeAudit(rec, entry);
  persistence.writeAudit(other, entry);
  persistence.writeAudit(rec, entry);
  expect(persistence.audit(rec.id).map(({ id, at }) => [id, at])).toEqual([[1, 1], [2, 2], [3, 42], [4, 42]]);
  expect(persistence.audit(other.id).map(({ id, at }) => [id, at])).toEqual([[1, 42]]);
});

it('思考流在 80ms 内合并，结束立即通知并取消待发通知，不改变行动时限', () => {
  const rec = record(true);
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const scheduled = vi.fn();
  const views = new RoomViewService(Date.now, { seatView: () => { throw new Error('unused'); }, setupErrors: () => [], scheduleSave: scheduled });
  const notify = vi.fn();
  const close = views.subscribe(rec, { role: 'host' }, notify);
  const deadlines = structuredClone(rec.deadlines);
  rec.thoughts = [{ seat: 1, decisionId: 'test', at: Date.now(), thinking: '一', reply: '', live: true }];
  views.publishThoughts(rec, false);
  expect(notify).toHaveBeenCalledTimes(1);
  rec.thoughts[0].thinking += '二';
  views.publishThoughts(rec, false);
  vi.advanceTimersByTime(79);
  expect(notify).toHaveBeenCalledTimes(1);
  rec.thoughts[0].thinking += '三';
  views.publishThoughts(rec, false);
  vi.advanceTimersByTime(1);
  expect(notify).toHaveBeenCalledTimes(2);
  rec.thoughts[0].thinking += '四';
  views.publishThoughts(rec, false);
  rec.thoughts[0].live = false;
  views.publishThoughts(rec, true);
  expect(notify).toHaveBeenCalledTimes(3);
  expect(scheduled).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(80);
  expect(notify).toHaveBeenCalledTimes(3);
  expect(scheduled).toHaveBeenCalledTimes(3);
  expect(rec.deadlines).toEqual(deadlines);
  close();
  views.dispose(rec);
});

it('包入口、manager 和服务导出同一个 ApiFailure 构造器', () => {
  expect(PackageFailure).toBe(ManagerFailure);
  expect(ManagerFailure).toBe(ServiceFailure);
  const failure = new ServiceFailure(409, 'CONFLICT', '冲突');
  expect(failure).toBeInstanceOf(PackageFailure);
  expect(failure).toMatchObject({ status: 409, code: 'CONFLICT', message: '冲突' });
});

it('在途行动的思考通知不取消请求或重置截止时间，完成后立即公布结束', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const requests: { req: DecideRequest; resolve: (result: DecideResult) => void }[] = [];
  const adapter: Adapter = { decide: (req) => req.toolChoice === 'auto' ? mockAdapter.decide(req) : new Promise((resolve) => requests.push({ req, resolve })) };
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, now: Date.now, adapters: { mock: adapter } });
  const { roomId, hostToken } = manager.createRoom();
  try {
    manager.updateSetup(roomId, hostToken, { aiPacingMs: 0 });
    manager.start(roomId, hostToken);
    for (let i = 0; i < 100 && !requests.length; i++) await Promise.resolve();
    const current = requests.find(({ req }) => req.toolChoice !== 'auto' && req.projection?.task)!;
    expect(current).toBeDefined();
    const { req } = current;
    const token = manager.getSetup(roomId, hostToken).tokens.seats[req.seat - 1].token;
    const deadline = manager.view(roomId, token).projection!.task!.deadline;
    expect(deadline).toBeDefined();
    const notify = vi.fn();
    const close = manager.subscribe(roomId, hostToken, notify);
    req.onDelta!({ thinking: '第一段' });
    req.onDelta!({ thinking: '第二段' });
    vi.advanceTimersByTime(40);
    expect(req.signal!.aborted).toBe(false);
    expect(manager.view(roomId, token).projection!.task!.deadline).toBe(deadline);
    current.resolve({ ok: true, call: mockDecision(req.projection!, req.projection!.task!.tools), toolCallIds: [], latencyMs: 1 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const thought = manager.view(roomId, hostToken).projection!.thoughts?.find((t) => t.seat === req.seat && t.decisionId === req.projection!.task!.decisionId);
    expect(thought).toMatchObject({ thinking: '第一段第二段', live: false });
    expect(notify).toHaveBeenCalled();
    close();
    manager.control(roomId, hostToken, 'pause');
    await manager.whenIdle(roomId);
  } finally { manager.dispose(); }
});

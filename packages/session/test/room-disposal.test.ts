import { expect, it, vi } from 'vitest';
import type { Adapter } from '@werewolf/llm';
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

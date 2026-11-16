import { expect, it } from 'vitest';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

it('AI 座位默认使用 Responses，并默认开启服务端网页工具', () => {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    const room = manager.createRoom();
    const seat = manager.getSetup(room.roomId, room.hostToken).seats[0];
    expect(seat.apiProtocol).toBe('responses');
    expect(seat.serverWebTools).toEqual({ search: true, extractor: true });
  } finally {
    manager.dispose();
  }
});

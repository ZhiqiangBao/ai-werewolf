import { buildRules, createGame, submit, waitingSeats } from '@werewolf/engine';
import { makeRand, randomCall } from '../../engine/test/random';
import { MemoryStore, RoomManager, SecretBox, type RoomRecord } from '../src/index';

/** Deterministic engine game plus synthetic, deliberately enlarged seat histories. */
export function fixture(): RoomRecord {
  const store = new MemoryStore();
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  manager.createRoom(); manager.dispose();
  const room = store.loadAll()[0];
  const rules = buildRules('standard12');
  let { state, events } = createGame({ id: 'synthetic', rules, seed: 'event-store-001' });
  const all = [...events]; const actions: RoomRecord['actions'] = []; const rand = makeRand(8041);
  while (!state.result && actions.length < 2000) {
    const seat = waitingSeats(state)[0];
    const call = randomCall(rand, state.pending!.tools[seat]);
    let input = { seat, call }; let result = submit(state, input);
    if (result.error) { input = { seat, call: { tool: '', args: {} }, auto: true } as typeof input; result = submit(state, input); }
    if (result.error) throw new Error('synthetic action failed');
    state = result.state; all.push(...result.events); actions.push(input);
  }
  if (!state.result) throw new Error('synthetic game did not finish');
  Object.assign(room, { id: 'synthetic', createdAt: 1, hostToken: 'host', spectatorToken: 'spectator',
    seatTokens: Array.from({ length: 12 }, (_, i) => `seat-${i + 1}`), status: 'ended', paused: false,
    rules, seed: 'event-store-001', state, events: all, actions, deadlines: {}, heardSeq: all.length,
    threads: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, seen: all.length, formatVersion: 2 as const,
      messages: Array.from({ length: 200 }, (_, j) => ({ role: 'user' as const, content: `synthetic-${i}-${j}:` + '甲乙丙丁'.repeat(64) })) })) });
  return room;
}

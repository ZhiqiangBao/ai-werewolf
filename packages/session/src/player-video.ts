import { buildVideoScript, type GodProjection, type RoomBrief, type Seat } from '@werewolf/protocol';
import { projectSeat } from '@werewolf/engine';
import type { RoomRecord } from './store';

/** Export only the selected seat's historical audience; end-of-game review is omniscient. */
export function buildPlayerVideo(record: RoomRecord, roomId: string, seat: Seat) {
  if (!record.state || record.status !== 'ended') throw Error('玩家视频仅支持已结束的对局');
  if (!Number.isInteger(seat) || !record.state.players.some((p) => p.seat === seat)) throw Error('无效的玩家座位');
  const projection = projectSeat(record.state, record.events, seat);
  const me = projection.me!;
  const events = projection.events.filter((e) => e.type !== 'review').map((e, i) => ({ ...e, seq: i + 1 }));
  // Build the existing script from a deliberately reduced projection, never from projectGod.
  const reduced = { ...projection, viewer: { kind: 'god' }, events, ruleCard: undefined,
    god: { seed: '', pending: null, roles: projection.seats.map((s) => ({ seat: s.seat,
      role: s.seat === seat ? me.role : 'unknown', roleName: s.seat === seat ? me.roleName : '身份未知',
      factionName: s.seat === seat ? me.factionName : '', alive: s.alive })) } } as unknown as GodProjection;
  const room: RoomBrief = { roomId, viewer: 'host', status: record.status, paused: record.paused,
    presetName: projection.presetName, seats: record.seats.map((s) => ({ seat: s.seat, name: s.name, controller: s.controller })) };
  const script = buildVideoScript(reduced, room);
  return { ...script, perspective: 'player' as const, playerSeat: seat, ruleCard: undefined,
    events: script.events.map((event) => ({ ...event, audience: event.audience === 'public' ? 'public' as const : [seat] })) };
}

import type { GameEvent, GodSeatInfo, Projection, SeatInfo } from '@werewolf/protocol';

export interface VisibleIdentity {
  role?: string;
  name?: string;
  tone?: 'wolf' | 'villager';
  source?: 'self' | 'god' | 'teammate' | 'inspection' | 'public';
}

/** Only authority-scoped knowledge can reveal another seat; never read its actual hidden role. */
export function seatIdentity(p: Pick<Projection, 'viewer' | 'me' | 'events'>, seat: SeatInfo, roles?: GodSeatInfo[]): VisibleIdentity {
  if (p.viewer.kind === 'god') {
    const identity = roles?.find((r) => r.seat === seat.seat);
    return identity ? { role: identity.role, name: identity.roleName, source: 'god' } : {};
  }
  if (p.viewer.kind === 'seat' && p.me?.seat === p.viewer.seat && p.me.seat === seat.seat) return { role: p.me.role, name: p.me.roleName, source: 'self' };
  const announced = p.events.some((e) => e.audience === 'public' && (
    (e.type === 'hunter.shot' && e.payload.shooter === seat.seat && seat.revealedRole === 'hunter') ||
    (e.type === 'hunter.decline' && e.payload.seat === seat.seat && seat.revealedRole === 'hunter') ||
    (e.type === 'explode' && e.payload.seat === seat.seat) ||
    (e.type === 'idiot.flip' && e.payload.seat === seat.seat && seat.revealedRole === 'idiot') ||
    (e.type === 'review' && Array.isArray(e.payload.roles) && e.payload.roles.some((r) => r && r.seat === seat.seat && r.role === seat.revealedRole))
  ));
  if (announced && seat.revealedRole && seat.revealedRoleName) return { role: seat.revealedRole, name: seat.revealedRoleName, source: 'public' };
  if (p.viewer.kind !== 'seat' || p.me?.seat !== p.viewer.seat) return {};
  const known = p.me.knownIdentities?.findLast((k) => k.seat === seat.seat);
  if (known?.kind === 'role') return { role: known.role, name: known.roleName, source: known.source };
  if (known?.kind === 'alignment') return { name: known.alignment === 'wolf' ? '狼人' : '好人', tone: known.alignment === 'wolf' ? 'wolf' : 'villager', source: known.source };
  // Compatibility with a running older server: use only its already-private knowledge.
  if (p.me.teammates?.includes(seat.seat)) return { name: '狼人', tone: 'wolf', source: 'teammate' };
  const mine = p.me.seat;
  if (p.me.role === 'seer') {
    const check = p.events.findLast((e) => e.type === 'seer.result' && Array.isArray(e.audience) && e.audience.includes(mine) && e.payload.target === seat.seat);
    if (check?.payload.result === 'good' || check?.payload.result === 'wolf') {
      return { name: check.payload.result === 'wolf' ? '狼人' : '好人', tone: check.payload.result === 'wolf' ? 'wolf' : 'villager', source: 'inspection' };
    }
  }
  return {};
}

/** Angles follow the actual tabletop ellipse; larger gaps at the sides fit portrait cards. */
export function seatPosition(index: number, count: number): { cos: number; sin: number; mobileX: number; mobileY: number } {
  const desktop = [-80, -55, -22, 22, 55, 80, 100, 125, 158, 202, 235, 260];
  const phone = [-74, -36, -12, 12, 36, 74, 106, 144, 168, 192, 216, 254];
  const degrees = count === 12 ? desktop[index] : -90 + 360 * (index + .5) / Math.max(1, count);
  const mobileNine = [-74, -32, 10, 50, 90, 130, 170, 212, 254];
  const mobileDegrees = count === 12 ? phone[index] : count === 9 ? mobileNine[index] : -70 + 360 * index / Math.max(1, count);
  const angle = degrees * Math.PI / 180, mobile = mobileDegrees * Math.PI / 180;
  return { cos: Math.cos(angle), sin: Math.sin(angle), mobileX: 50 + (count === 9 ? 40 : 42) * Math.cos(mobile), mobileY: 50 + (count === 12 ? 41 : 40) * Math.sin(mobile) };
}

export interface PublicElection {
  phase: 'idle' | 'running' | 'postponed' | 'closed';
  candidates: Set<number>;
  withdrawn: Set<number>;
}

const seatNumbers = (value: unknown): number[] => Array.isArray(value) ? value.filter((s): s is number => Number.isInteger(s) && s > 0) : [];

/** Only announced events may drive shared seat badges, including in the host view. */
export function publicElection(events: GameEvent[]): PublicElection {
  const state: PublicElection = { phase: 'idle', candidates: new Set(), withdrawn: new Set() };
  for (const e of events) {
    if (e.audience !== 'public') continue;
    if (e.type === 'sheriff.start') {
      state.phase = 'running'; state.candidates.clear(); state.withdrawn.clear();
    } else if (e.type === 'sheriff.signup' || e.type === 'sheriff.resume') {
      state.phase = 'running'; state.candidates = new Set(seatNumbers(e.payload.candidates));
      if (e.type === 'sheriff.resume') {
        state.withdrawn = new Set(Array.isArray(e.payload.withdrawn) ? e.payload.withdrawn as number[] : []);
      }
    } else if (e.type === 'sheriff.withdraw' && Number.isInteger(e.payload.seat)) {
      state.withdrawn.add(e.payload.seat as number);
    } else if (e.type === 'sheriff.postponed') state.phase = 'postponed';
    else if (['sheriff.elected', 'sheriff.none', 'sheriff.lost', 'game.end'].includes(e.type)) state.phase = 'closed';
    else if (e.type === 'vote.result' && e.payload.kind === 'sheriff') {
      if (e.payload.outcome === 'elected' || e.payload.outcome === 'lost') state.phase = 'closed';
      else if (e.payload.outcome === 'pk') state.candidates = new Set(seatNumbers(e.payload.seats));
    }
  }
  return state;
}

/** An active public actor may be handling the badge or choosing the speaking order. */
export function publicActivity(p: Pick<Projection, 'status' | 'phase' | 'stage'>, seat: SeatInfo): 'speech' | 'action' | null {
  if (!seat.active || p.status === 'ended' || p.phase === 'night') return null;
  return /(?:发言|遗言)中$/.test(p.stage) ? 'speech' : 'action';
}

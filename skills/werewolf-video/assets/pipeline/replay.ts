import type { Fact, Script } from './project';
export interface ReplayState { day: number; phase: string; alive: Set<number>; sheriff: number | null; candidates: Set<number>; withdrawn: Set<number>; election: boolean; lastVote?: Fact; recent: Fact[]; result: any }
export function replay(script: Script, seq: number): ReplayState {
  const state: ReplayState = { day: 0, phase: 'setup', alive: new Set(script.cast.map((s) => s.seat)), sheriff: null,
    candidates: new Set(), withdrawn: new Set(), election: false, recent: [], result: null };
  for (const e of script.events) {
    if (e.sourceSeq > seq) break;
    state.day = e.day; state.phase = e.phase;
    const p = e.data;
    if (e.type === 'sheriff.start') { state.election = true; state.candidates.clear(); state.withdrawn.clear(); }
    if (e.type === 'sheriff.signup' || e.type === 'sheriff.resume') { state.election = true; state.candidates = new Set(p.candidates ?? []); }
    if (e.type === 'sheriff.withdraw') state.withdrawn.add(p.seat);
    if (['sheriff.none', 'sheriff.lost'].includes(e.type)) { state.election = false; state.sheriff = null; }
    if (e.type === 'sheriff.postponed') state.election = false;
    if (e.type === 'vote.result') {
      state.lastVote = e;
      if (p.kind === 'sheriff' && p.outcome === 'elected') { state.sheriff = p.seat; state.election = false; }
      if (p.kind === 'exile' && p.outcome === 'exile') state.alive.delete(p.seat);
    }
    if (['exile', 'explode', 'wolf.explode'].includes(e.type)) state.alive.delete(p.seat);
    if (['hunter.shot', 'shot'].includes(e.type)) state.alive.delete(p.target);
    if (e.type === 'night.resolution') for (const d of p.deaths ?? []) state.alive.delete(typeof d === 'number' ? d : d.seat);
    if (e.type === 'dawn') for (const seat of p.deaths ?? []) state.alive.delete(seat);
    if (e.type === 'badge.transfer') state.sheriff = p.to;
    if (['badge.tear', 'badge.lost'].includes(e.type)) state.sheriff = null;
    if (e.type === 'game.end') { state.result = p.result; state.election = false; }
    if (!['speech', 'wolf.chat', 'night.resolution', 'sheriff.order', 'speech.order', 'review', 'game.decided'].includes(e.type)) state.recent.push(e);
  }
  return state;
}

import type { GameEvent, GodProjection, Projection, Seat, SeatInfo, Viewer } from '@werewolf/protocol';
import { Ctx } from './context';
import { getRole, interruptsIn } from './registry';
import { buildRuleCard } from './rulecard';
import { categoryName, factionName } from './text';
import type { GameState } from './types';

const visibleTo = (seat: Seat) => (e: GameEvent) =>
  e.audience === 'public' || (Array.isArray(e.audience) && e.audience.includes(seat));

/** 按视角重新编号：保留全局序号会让人从序号空档数出隐藏事件的条数。 */
const renumber = (events: GameEvent[]) => events.map((e, i) => ({ ...e, seq: i + 1 }));

function seatsInfo(state: GameState): SeatInfo[] {
  const showRoles = !!state.result && state.result.reveal !== false;
  return state.players.map((p) => {
    const info: SeatInfo = { seat: p.seat, name: p.name, alive: p.alive, sheriff: state.sheriff === p.seat };
    if (p.revealed || showRoles) {
      info.revealedRole = p.role;
      info.revealedRoleName = getRole(p.role).name;
    }
    if (state.pending?.publicActor === p.seat) info.active = true;
    return info;
  });
}

function base(state: GameState, events: GameEvent[], viewer: Viewer): Projection {
  return {
    viewer,
    gameId: state.id,
    version: viewer.kind === 'god' ? state.seq : events.length,
    status: state.result ? 'ended' : 'running',
    day: state.day,
    phase: state.phase,
    stage: state.pending?.publicStage ?? state.stage,
    presetName: state.rules.presetName,
    ruleCard: buildRuleCard(state.rules),
    seats: seatsInfo(state),
    events,
    task: null,
    interrupts: [],
    ...(state.result ? { result: state.result } : {}),
  };
}

/** 身份附录：座位号、身份、该身份的私密记录、当前合法工具。只读取该座位有权知道的信息。 */
export function buildAppendix(state: GameState, seat: Seat): string {
  const ctx = new Ctx(state);
  const p = ctx.player(seat);
  const mod = ctx.roleOf(seat);
  const lines = [
    `你是 ${seat}号${p.name === `${seat}号` ? '' : `「${p.name}」`}，身份：${mod.name}（${factionName(mod.faction)} · ${categoryName(mod.category)}）。`,
    `技能：${mod.summary}`,
    ...(mod.appendix?.(ctx, seat) ?? []),
  ];
  if (state.sheriff === seat) lines.push('你是警长：放逐投票记 1.5 票，白天由你选择发言方向并最后发言。');
  if (!p.alive) lines.push('你已出局。除了法官单独询问的出局职责（遗言、开枪、警徽），你只接收公开信息。');
  return lines.join('\n');
}

export function projectSeat(state: GameState, events: GameEvent[], seat: Seat): Projection {
  const ctx = new Ctx(state);
  const p = ctx.player(seat);
  const mod = ctx.roleOf(seat);
  const proj = base(state, renumber(events.filter(visibleTo(seat))), { kind: 'seat', seat });
  const teammates =
    mod.wolfTeam && ctx.opt<boolean>('wolf.knowTeammates') ? ctx.wolfTeam(false).filter((x) => x !== seat) : undefined;
  proj.me = {
    seat,
    name: p.name,
    role: p.role,
    roleName: mod.name,
    faction: mod.faction,
    factionName: factionName(mod.faction),
    alive: p.alive,
    ...(teammates ? { teammates } : {}),
    knownIdentities: [
      ...(teammates ?? []).map((teammate) => ({ seat: teammate, kind: 'alignment' as const, alignment: 'wolf' as const, source: 'teammate' as const })),
      ...(mod.knowledge?.(ctx, seat) ?? []),
    ],
    appendix: buildAppendix(state, seat),
  };
  const d = state.pending;
  if (d && d.actors.includes(seat)) {
    proj.task = {
      decisionId: d.id,
      title: d.title,
      prompt: d.prompts[seat],
      tools: d.tools[seat],
      simultaneous: d.simultaneous,
      submitted: !!d.submissions[seat],
      ...(d.acks[seat] ? { submittedText: d.acks[seat] } : {}),
    };
  }
  if (!state.result) {
    const taskTools = new Set(proj.task && !proj.task.submitted ? proj.task.tools.map((t) => t.name) : []);
    proj.interrupts = interruptsIn(state.rules)
      .filter((i) => !taskTools.has(i.tool) && i.available(ctx, seat))
      .map((i) => i.spec(ctx, seat));
  }
  return proj;
}

export function projectSpectator(state: GameState, events: GameEvent[]): Projection {
  return base(state, renumber(events.filter((e) => e.audience === 'public')), { kind: 'spectator' });
}

export function projectGod(state: GameState, events: GameEvent[]): GodProjection {
  const proj = base(state, events, { kind: 'god' }) as GodProjection;
  const d = state.pending;
  proj.god = {
    seed: state.seed,
    roles: state.players.map((p) => {
      const mod = getRole(p.role);
      return { seat: p.seat, role: p.role, roleName: mod.name, factionName: factionName(mod.faction), alive: p.alive };
    }),
    pending: d
      ? {
          decisionId: d.id,
          title: d.title,
          actors: d.actors.map((s) => ({ seat: s, submitted: !!d.submissions[s], tools: d.tools[s].map((t) => t.name) })),
        }
      : null,
  };
  return proj;
}

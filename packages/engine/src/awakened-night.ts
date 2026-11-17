import { gameText } from '@werewolf/protocol';
import type { NightActionKind, NightActionRound, Seat, ToolCall, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from './context';
import { roleData } from './role-data';
import type { Step } from './types';
import { seatLabel } from './text';
import { seatParam } from './tools';
import { wolfKillFallbackTarget, wolfKillTargets } from './roles/werewolf';

const action = (name: string, title: string, description: string, seats?: Seat[], locale: string | undefined = 'zh-CN'): ToolSpec => ({
  name, title, description, params: seats ? [seatParam('targetSeat', gameText(locale, '目标玩家'), seats)] : [],
});

export const awakenedKillTool = (seats: Seat[], locale: string | undefined = 'zh-CN') => action('awakened_kill', gameText(locale, '提交继承狼刀'), gameText(locale, '对 targetSeat 提交继承狼刀。填写目标座位号，例如 {"targetSeat":3}。'), seats, locale);
export const awakenedEmptyKillTool = (locale: string | undefined = 'zh-CN') => action('awakened_empty_kill', gameText(locale, '继承狼刀空刀'), gameText(locale, '继承狼刀选择空刀。无参数，填写 {}。'), undefined, locale);

export function awakenedActionRound(ctx: Ctx, seat: Seat, actionKind: NightActionKind, targetSeatId: number | null): NightActionRound | undefined {
  if (ctx.rules.awakenedNightVersion !== 3 || ctx.player(seat).role !== 'awakened_wolf') return undefined;
  const roundKind = actionKind === 'kill' ? 'wolf' : 'awakened';
  return {
    roundKind,
    roundId: `night-${ctx.state.day}-${roundKind === 'wolf' ? 'wolf' : 'awakened'}`,
    actionKind,
    actorSeatId: seat,
    targetSeatId,
  };
}

/** 已继承刀权，且除自己以外没有存活的狼阵营玩家。 */
export function awakenedKnifeSeats(ctx: Ctx): Seat[] {
  return ctx.seatsOf('awakened_wolf').filter((seat) => {
    if (roleData(ctx.player(seat), 'awakened_wolf').awakened.knifeFromNight === null) return false;
    return !ctx.alive().some((other) => other !== seat && ctx.roleOf(other).faction === 'wolf');
  });
}

export function askAwakenedKnife(ctx: Ctx, step: Step): void {
  const version = ctx.rules.awakenedNightVersion;
  const actors = (version === 3 ? awakenedKnifeSeats(ctx) : ctx.seatsOf('awakened_wolf'))
    .filter((seat) => roleData(ctx.player(seat), 'awakened_wolf').awakened.knifeFromNight !== null);
  if (!actors.length) return;
  ctx.ask({
    step, actors, tools: (seat) => {
      const unified = version === 2 || version === 3;
      const targets = unified ? wolfKillTargets(ctx, seat)
        : ctx.alive().filter((other) => ctx.opt<boolean>('wolf.allowTeammateTarget') || ctx.roleOf(other).faction !== 'wolf');
      return [awakenedKillTool(targets, ctx.rules.locale), ...(ctx.opt<boolean>('wolf.allowEmpty') ? [awakenedEmptyKillTool(ctx.rules.locale)] : [])];
    },
    prompt: () => gameText(ctx.rules.locale, '你已继承普通狼刀，请独立提交今晚刀口。'),
    title: gameText(ctx.rules.locale, '第{0}夜 · 继承狼刀', ctx.state.day),
    publicStage: gameText(ctx.rules.locale, '夜晚'),
  });
}

export function decideAwakenedKnife(ctx: Ctx, subs: Record<string, ToolCall>): void {
  for (const [raw, call] of Object.entries(subs)) {
    const seat = Number(raw);
    const target = call.tool === 'awakened_empty_kill' ? null : call.args.targetSeat as Seat;
    const night = ctx.state.night!;
    night.knife = target;
    if (target !== null) night.attacks.push({ target, kind: 'wolf', by: [seat] });
    ctx.priv(
      [seat],
      'awakened.knife',
      target === null ? gameText(ctx.rules.locale, '你今晚的继承狼刀为空刀。') : gameText(ctx.rules.locale, '你的继承狼刀选择了{0}。', seatLabel(target, ctx.rules.locale)),
      { target },
      awakenedActionRound(ctx, seat, 'kill', target),
    );
    night.lines.push(gameText(ctx.rules.locale, '觉醒隐狼（{0}）继承狼刀：{1}', seatLabel(seat, ctx.rules.locale), target === null ? gameText(ctx.rules.locale, '空刀') : seatLabel(target, ctx.rules.locale)));
  }
}

export function fallbackAwakenedKnife(ctx: Ctx, seat: Seat): ToolCall {
  const targetSeat = wolfKillFallbackTarget(ctx, seat);
  return targetSeat === null ? { tool: 'awakened_empty_kill', args: {} } : { tool: 'awakened_kill', args: { targetSeat } };
}

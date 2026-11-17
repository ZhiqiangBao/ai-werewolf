import { gameText } from '@werewolf/protocol';
import type { NightActionRound, Seat, ToolSpec } from '@werewolf/protocol';
import { abilityState, merchantAbilities, registerAbility } from './abilities';
import type { AbilityDefinition, GiftSkill } from './abilities';
import type { Ctx } from './context';
import { roleData } from './role-data';
import { inspectAlignment } from './roles/seer';
import { seatLabel, seatList } from './text';
import { seatParam } from './tools';

const skills = {
  seer: { name: '查验', tool: 'lucky_inspect', event: 'lucky.inspect',
    detail: '查验一名其他存活玩家的阵营。结果只反馈给你。' },
  poison: { name: '毒药', tool: 'lucky_poison', event: 'lucky.poison',
    detail: '对一名其他存活玩家使用幸运儿毒药。' },
  guard: { name: '守护', tool: 'lucky_guard', event: 'lucky.guard',
    detail: '守护一名存活玩家（可选自己），抵挡当夜的狼刀。' },
} as const;

export const giftSkillName = (locale: string | undefined, skill: GiftSkill): string => gameText(locale, skills[skill].name);

/** 只取当前席位在指定夜次实际使用的两种守护，排除空守或跳过。 */
export function guardedSeats(ctx: Ctx, seat: Seat, night: number): Seat[] {
  const player = ctx.player(seat);
  const own = player.role === 'guard' ? roleData(player, 'guard').log ?? [] : [];
  const lucky = (player.abilities ?? []).flatMap((ability) => {
    if (ability.definition !== 'lucky_guard') return [];
    const used = abilityState(ability, 'lucky_guard').used;
    return used ? [used] : [];
  });
  return [...new Set([...own, ...lucky].flatMap((entry) =>
    entry.night === night && entry.target !== null ? [entry.target] : []))];
}

/** 幸运儿守护在本夜不能重复本席的守护，也须遵守跨夜限制。 */
export function luckyGuardBanned(ctx: Ctx, seat: Seat, night: number): Seat[] {
  return [...new Set([...guardedSeats(ctx, seat, night),
    ...(ctx.opt<boolean>('guard.noConsecutive') ? guardedSeats(ctx, seat, night - 1) : [])])];
}

function luckyTargets(ctx: Ctx, seat: Seat, skill: GiftSkill): Seat[] {
  const player = ctx.player(seat);
  const night = ctx.state.day;
  switch (skill) {
    case 'seer': {
      const checks = player.role === 'seer' ? roleData(player, 'seer').checks : [];
      return ctx.alive().filter((t) => t !== seat && !checks.some((check) => check.night === night && check.target === t));
    }
    case 'poison': {
      const poisoned = (ctx.state.night?.attacks ?? []).filter((attack) => attack.kind === 'poison' && attack.by?.includes(seat));
      return ctx.alive().filter((t) => t !== seat && !poisoned.some((attack) => attack.target === t));
    }
    case 'guard': {
      const barred = new Set(luckyGuardBanned(ctx, seat, night));
      return ctx.alive().filter((t) => !barred.has(t));
    }
  }
}

function luckyTools(skill: GiftSkill, targets: Seat[], locale?: string): ToolSpec[] {
  const { tool, name, detail } = skills[skill];
  const skip: ToolSpec = {
    name: 'lucky_skip', title: gameText(locale, '本夜保留幸运儿技能'),
    description: gameText(locale, '本夜暂不使用幸运儿技能，保留至后续夜晚。无参数，填写 {}。'), params: [],
  };
  if (!targets.length) return [skip];
  return [{
    name: tool, title: gameText(locale, '使用幸运儿{0}', gameText(locale, name)),
    description: gameText(locale, detail) + ' ' + gameText(locale, 'targetSeat 填目标座位号，例如 {"targetSeat":3}。'),
    params: [seatParam('targetSeat', gameText(locale, '技能目标'), targets)],
  }, skip];
}

function luckyAbility(skill: GiftSkill): AbilityDefinition {
  const id = merchantAbilities[skill];
  return {
    id, version: 1, initialState: () => ({ used: null }),
    catalog: ({ seats, rules }) => luckyTools(skill, seats, rules.locale),
    tools: (ctx, seat, instance) => abilityState(instance, id).used ? [] : luckyTools(skill, luckyTargets(ctx, seat, skill), ctx.rules.locale),
    decisionText(ctx) {
      const locale = ctx.rules.locale;
      return {
        title: gameText(locale, '第{0}夜 · 幸运儿{1}', ctx.state.day, giftSkillName(locale, skill)),
        prompt: gameText(locale, '你可以使用获赐的{0}，也可以跳过并保留次数。{1}', giftSkillName(locale, skill), gameText(locale, skills[skill].detail)),
      };
    },
    apply(ctx, seat, instance, call) {
      const locale = ctx.rules.locale;
      const night = ctx.state.night!;
      const skip = call.tool === 'lucky_skip';
      const target = skip ? null : call.args.targetSeat as Seat;
      const round: NightActionRound = {
        roundKind: 'lucky', roundId: `night-${night.n}-lucky-${seat}`,
        actionKind: skip ? 'skip' : 'skill', actorSeatId: seat, targetSeatId: target,
      };
      const name = giftSkillName(locale, skill);
      if (target === null) {
        ctx.priv([seat], 'lucky.skip', gameText(locale, '你保留了幸运儿{0}。', name), { skill }, round);
        night.lines.push(gameText(locale, '幸运儿（{0}）保留{1}', seatLabel(seat, locale), name));
        return;
      }
      const used = { night: night.n, target };
      const label = seatLabel(target, locale);
      if (id === 'lucky_seer') {
        const result = inspectAlignment(ctx, target);
        abilityState(instance, id).used = { ...used, result };
        const alignment = gameText(locale, result === 'wolf' ? '狼人' : '好人');
        ctx.priv([seat], skills[skill].event, gameText(locale, '幸运儿查验结果：{0}是{1}。', label, alignment), { target, result }, round);
        night.lines.push(gameText(locale, '幸运儿（{0}）查验 {1}：{2}', seatLabel(seat, locale), label, alignment));
        return;
      }
      abilityState(instance, id).used = used;
      if (id === 'lucky_poison') night.attacks.push({ target, kind: 'poison', by: [seat] });
      else night.protections.push({ target, kind: 'guard', blocks: ['wolf'], by: seat });
      ctx.priv([seat], skills[skill].event, gameText(locale, '你对{0}使用了幸运儿{1}。', label, name), { target }, round);
      night.lines.push(gameText(locale, '幸运儿（{0}）对{1}使用{2}', seatLabel(seat, locale), label, name));
    },
    fallback: () => ({ tool: 'lucky_skip', args: {} }),
    knowledge(_ctx, _seat, instance) {
      const used = id === 'lucky_seer' ? abilityState(instance, id).used : null;
      return used ? [{ seat: used.target, kind: 'alignment', alignment: used.result, source: 'inspection' }] : [];
    },
    appendix(ctx, seat, instance) {
      const locale = ctx.rules.locale;
      const name = giftSkillName(locale, skill);
      const used = abilityState(instance, id).used;
      if (!used) return [gameText(locale, '你获赐了一次{0}，可从第{1}夜起在幸运儿阶段使用。{2}', name, instance.activeFromNight, gameText(locale, skills[skill].detail))];
      const lines = [gameText(locale, '你的幸运儿{0}已于第{1}夜对{2}使用。', name, used.night, seatLabel(used.target, locale))];
      const check = id === 'lucky_seer' ? abilityState(instance, id).used : null;
      if (check) lines.push(gameText(locale, '查验结果：{0}是{1}。', seatLabel(check.target, locale), gameText(locale, check.result === 'wolf' ? '狼人' : '好人')));
      return lines;
    },
  };
}

export function registerLuckyAbilities(): void {
  for (const skill of ['seer', 'poison', 'guard'] as const) registerAbility(luckyAbility(skill));
}

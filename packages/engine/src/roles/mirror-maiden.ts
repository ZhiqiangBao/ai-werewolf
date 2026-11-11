import { roleData } from '../role-data';
import { gameText } from '@werewolf/protocol';
import type { RoleModule } from '../types';
import { err } from '../tools';
import { inspectRole, inspectionAppendix, inspectionKnowledge, inspectionTargets, mirrorTool, roleChecks, INSPECTION_PRIVACY_RULE } from './inspection';

export const mirrorMaiden: RoleModule = {
  copiedAbility: 'mirror',
  id: 'mirror_maiden', name: '魔镜少女', faction: 'good', category: 'god', maxPerGame: 1,
  summary: '每晚查验一名其他存活玩家的具体身份，不能重复查验。',
  nightPhase: { id: 'mirror_maiden', order: 35 },
  tools: ({ seats, rules }) => [mirrorTool(seats, rules.locale, rules.inspectionVersion === 2)],
  setup(ctx, seats) { for (const seat of seats) roleData(ctx.player(seat), 'mirror_maiden').roleChecks = []; },
  ruleCard(rules) {
    const privacy = gameText(rules.locale, INSPECTION_PRIVACY_RULE);
    if (rules.inspectionVersion === 2) return [gameText(rules.locale, '魔镜少女：每晚可以查验一名其他存活玩家的具体身份，也可以空验；不能重复查验同一玩家。{0}没有未查验目标时跳过。', privacy) + (rules.roles.includes('awakened_wolf') ? gameText(rules.locale, '觉醒隐狼未模仿时显示觉醒隐狼；模仿后立即显示模仿身份，真实阵营仍为狼人。') : '')];
    return [(rules.roles.includes('awakened_wolf')
      ? gameText(rules.locale, "魔镜少女：每晚查验一名其他存活玩家的具体身份，不能重复查验同一玩家。{0}觉醒隐狼未模仿时显示觉醒隐狼；模仿后立即显示模仿身份，真实阵营仍为狼人。没有未查验目标时跳过。", privacy)
      : gameText(rules.locale, "魔镜少女：每晚查验一名其他存活玩家的具体身份，不能重复查验同一玩家。{0}没有未查验目标时跳过。", privacy))];
  },
  knowledge: inspectionKnowledge,
  appendix: (ctx, seat) => [inspectionAppendix(ctx, seat)],
  steps: {
    'night:mirror_maiden': {
      run(ctx, step) {
        const actors = ctx.seatsOf('mirror_maiden').filter((s) => inspectionTargets(ctx, s).length);
        if (!actors.length) return;
        ctx.ask({
          step, actors, tools: (seat) => [mirrorTool(inspectionTargets(ctx, seat), ctx.rules.locale, ctx.rules.inspectionVersion === 2)],
          prompt: () => gameText(ctx.rules.locale, "请选择本夜查验目标。"),
          title: gameText(ctx.rules.locale, "第{0}夜 · 魔镜查验", ctx.state.day), publicStage: gameText(ctx.rules.locale, "夜晚"),
        });
      },
      validate(ctx, _step, seat, call) {
        if (call.args.targetSeat === seat) return err('TARGET_SELF_FORBIDDEN', gameText(ctx.rules.locale, "不能查验自己"));
        if (roleChecks(ctx, seat).some((c) => c.target === call.args.targetSeat)) return err('MIRROR_REPEAT', gameText(ctx.rules.locale, "魔镜查验不能重复选择同一玩家"));
        return null;
      },
      decide(ctx, _step, subs) {
        for (const [seat, call] of Object.entries(subs)) inspectRole(ctx, Number(seat), call.args.targetSeat as number | null);
      },
      fallback: (ctx) => ({ tool: 'mirror_inspect', args: { targetSeat: null } }),
    },
  },
};

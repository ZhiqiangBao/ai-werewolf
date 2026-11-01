import type { RoleModule } from '../types';
import { err } from '../tools';
import { inspectRole, inspectionAppendix, inspectionKnowledge, inspectionTargets, mirrorTool, roleChecks, INSPECTION_PRIVACY_RULE } from './inspection';

export const mirrorMaiden: RoleModule = {
  id: 'mirror_maiden', name: '魔镜少女', faction: 'good', category: 'god', maxPerGame: 1,
  summary: '每晚查验一名其他存活玩家的具体身份，不能重复查验。觉醒隐狼模仿后显示模仿身份。',
  nightPhase: { id: 'mirror_maiden', order: 35 },
  tools: ({ seats }) => [mirrorTool(seats)],
  setup(ctx, seats) { for (const seat of seats) ctx.player(seat).data.roleChecks = []; },
  ruleCard: () => [`魔镜少女：每晚查验一名其他存活玩家的具体身份，不能重复查验同一玩家。${INSPECTION_PRIVACY_RULE}觉醒隐狼未模仿时显示觉醒隐狼；模仿后立即显示模仿身份，真实阵营仍为狼人。没有未查验目标时跳过。`],
  knowledge: inspectionKnowledge,
  appendix: (ctx, seat) => [inspectionAppendix(ctx, seat)],
  steps: {
    'night:mirror_maiden': {
      run(ctx, step) {
        const actors = ctx.seatsOf('mirror_maiden').filter((s) => inspectionTargets(ctx, s).length);
        if (!actors.length) return;
        ctx.ask({
          step, actors, tools: (seat) => [mirrorTool(inspectionTargets(ctx, seat))],
          prompt: () => '请选择一名其他存活且从未查验过的玩家，查验其具体身份。模仿后的觉醒隐狼会显示模仿身份。',
          title: `第${ctx.state.day}夜 · 魔镜查验`, publicStage: '夜晚',
        });
      },
      validate(ctx, _step, seat, call) {
        if (call.args.targetSeat === seat) return err('TARGET_SELF_FORBIDDEN', '不能查验自己');
        if (roleChecks(ctx, seat).some((c) => c.target === call.args.targetSeat)) return err('MIRROR_REPEAT', '魔镜查验不能重复选择同一玩家');
        return null;
      },
      decide(ctx, _step, subs) {
        for (const [seat, call] of Object.entries(subs)) inspectRole(ctx, Number(seat), call.args.targetSeat as number | null);
      },
      fallback: () => ({ tool: 'mirror_inspect', args: { targetSeat: null } }),
    },
  },
};

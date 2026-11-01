import type { Seat, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { getRole } from '../registry';
import { seatLabel } from '../text';
import { err, seatParam } from '../tools';
import type { RoleModule } from '../types';
import { hunter } from './hunter';
import { inspectRole, inspectionAppendix, inspectionKnowledge, inspectionTargets, mirrorTool, roleChecks } from './inspection';

type Skill =
  | { kind: 'none' | 'mirror' | 'hunter' }
  | { kind: 'poison'; available: boolean }
  | { kind: 'guard'; last: Seat | null }
  | { kind: 'wolf'; claw: boolean };

/** 真身份不变；模仿身份、技能资源、启用时间分别保存。 */
interface Learned {
  target: Seat; role: string; learnedNight: number; activeFromNight: number; active: boolean; skill: Skill;
}
interface AwakenedState { learned: Learned | null; knifeFromNight: number | null }
const data = (ctx: Ctx, seat: Seat): AwakenedState => ctx.player(seat).data.awakened;
const holders = (ctx: Ctx) => ctx.seatsOf('awakened_wolf');
const action = (name: string, title: string, description: string, seats?: Seat[]): ToolSpec => ({
  name, title, description, params: seats ? [seatParam('targetSeat', '目标玩家', seats)] : [],
});
const skipSkill = () => action('awakened_skip_skill', '本夜不用模仿技能', '本夜不发动模仿技能；毒药和额外爪击保留，守卫视为空守并解除连续守护限制。填写 {}。');
const killTool = (seats: Seat[]) => action('awakened_kill', '提交继承狼刀', '仅法官告知已继承刀权并询问落刀时可用。targetSeat 为今晚要刀的存活玩家真实整数座位号，例：{"targetSeat":3}；不透露其他狼队友。', seats);
const emptyKill = () => action('awakened_empty_kill', '继承狼刀空刀', '本夜继承的普通狼刀不击杀任何人。填写 {}，不影响另一次模仿技能。');
const poisonTool = (seats: Seat[]) => action('awakened_poison', '使用模仿毒药', '仅模仿女巫技能已启用且毒药尚在时可用。消耗自己独立的一瓶毒药，没有解药。targetSeat 为其他存活玩家真实整数座位号，例：{"targetSeat":3}。', seats);
const guardTool = (seats: Seat[]) => action('awakened_guard', '使用增强守护', '仅模仿守卫技能已启用时可用。targetSeat 为存活玩家真实整数座位号，例：{"targetSeat":3}。可自守，不能连续两晚守同一人；同时抵挡普通狼刀、额外爪击和毒药，不保护白天。', seats);
const clawTool = (seats: Seat[]) => action('awakened_claw', '使用一次额外爪击', '仅模仿狼人技能已启用、已继承刀权且一次性爪击尚在时可用。targetSeat 为存活玩家真实整数座位号，例：{"targetSeat":3}。消耗爪击；按狼刀结算，可被守护挡住，与普通刀分开提交。', seats);
const mimicTool = (seats: Seat[]) => action('awakened_mimic', '模仿一名玩家', '整局只能成功模仿一次。targetSeat 为其他存活玩家真实整数座位号，例：{"targetSeat":3}。本人立即获知目标真实身份；此后具体身份查验对你返回该模仿身份，你的真实身份和阵营不变。当夜结束才获得独立技能，夜间主动技能从下一夜可用，不与普通狼人互认。', seats);
const waitTool = () => action('awakened_wait', '本夜暂不模仿', '本夜不模仿，保留整局唯一模仿机会。以后夜晚可再决定。填写 {}。');

function skillFor(role: string): Skill {
  if (role === 'mirror_maiden') return { kind: 'mirror' };
  if (role === 'witch') return { kind: 'poison', available: true };
  if (role === 'guard') return { kind: 'guard', last: null };
  if (role === 'hunter') return { kind: 'hunter' };
  if (role === 'werewolf') return { kind: 'wolf', claw: true };
  return { kind: 'none' };
}

export const awakenedWolf: RoleModule = {
  id: 'awakened_wolf', name: '觉醒隐狼', faction: 'wolf', category: 'wolf', maxPerGame: 1,
  inspectAs: 'good', wolfTeam: false, canExplode: false,
  summary: '不与小狼互认、不能自爆。整局模仿一次，立即改变具体身份查验表现，当夜结束获得技能；其余狼人全灭后下一夜继承刀权。',
  nightPhases: [
    { id: 'awakened_mimic', order: 5, name: '觉醒隐狼模仿' },
    { id: 'awakened_knife', order: 25, name: '觉醒隐狼继承狼刀' },
    { id: 'awakened_skill', order: 45, name: '觉醒隐狼模仿技能' },
  ],
  tools: ({ seats, rules }) => [
    mimicTool(seats), waitTool(), killTool(seats), ...(rules.values['wolf.allowEmpty'] ? [emptyKill()] : []),
    mirrorTool(seats), poisonTool(seats), guardTool(seats), clawTool(seats), skipSkill(),
    ...(hunter.tools?.({ seat: 0, seats, rules }) ?? []),
  ],
  setup(ctx, seats) {
    for (const seat of seats) {
      ctx.player(seat).data.awakened = { learned: null, knifeFromNight: null } satisfies AwakenedState;
      ctx.player(seat).data.roleChecks = [];
      ctx.priv([seat], 'awakened.identity', '你是觉醒隐狼，真实阵营始终为狼人。你与其他狼人互不知晓身份，不参与他们的密谈，也不能自爆。');
    }
  },
  inspectRole: (ctx, seat) => data(ctx, seat).learned?.role ?? 'awakened_wolf',
  knowledge: inspectionKnowledge,
  appendix(ctx, seat) {
    const d = data(ctx, seat);
    const l = d.learned;
    return [
      '你始终属于狼人阵营，但不参与普通狼队密谈、不能自爆，其他狼人身份不会因继承刀权而告诉你。',
      l ? `你模仿了 ${seatLabel(l.target)}（${getRole(l.role).name}）。查验表现已改变。${l.active ? '复制技能已获得' : '当夜结束后才获得技能'}，夜间主动技能从第${l.activeFromNight}夜可用。` : '你尚未模仿。从第1夜起，每晚轮到模仿阶段时均可选择本夜模仿或暂不模仿；整局只能成功模仿一次。',
      ...(l?.skill.kind === 'poison' ? [`模仿毒药：${l.skill.available ? '尚有一瓶' : '已用完'}；没有解药。`] : []),
      ...(l?.skill.kind === 'guard' ? [`上次增强守护：${l.skill.last === null ? '空守或尚未行动' : seatLabel(l.skill.last)}。`] : []),
      ...(l?.skill.kind === 'wolf' ? [`额外爪击：${l.skill.claw ? '尚未使用，须继承刀权后才可发动' : '已用完'}。`] : []),
      d.knifeFromNight === null ? '尚未继承狼刀。' : `已从第${d.knifeFromNight}夜起继承普通狼刀，每夜独立落刀。`,
      inspectionAppendix(ctx, seat),
    ];
  },
  ruleCard: () => [
    '觉醒隐狼：真实身份和胜负归属始终为狼人；与普通狼人互不知晓身份，不参加密谈，不能自爆。从第1夜起，每晚模仿阶段均可选择模仿一名其他存活玩家或暂不模仿，整局只能成功模仿一次。模仿立即获知目标真实身份，并改变自身的具体身份查验表现；目标不会收到通知。普通阵营查验始终显示好人。',
    '模仿技能在学习当夜结束时获得，夜间主动技能从下一夜起可用；模仿猎人者可在学习夜天亮出局时开枪，死因含毒药不可开枪，开枪仅公开猎人表现，终局才公开真身份。',
    '模仿魔镜少女：独立查验具体身份，自己不能重复查验。模仿女巫：独立的一瓶毒药，无解药，不继承目标已消耗的库存。模仿守卫：独立守护记录，可自守、不可连守，同时抵挡狼刀和毒药；不抵挡白天放逐和猎枪，同守同救的狼刀仍按本局规则结算。模仿平民：不获得主动技能。',
    '其余狼人全部出局后，觉醒隐狼从下一夜继承普通狼刀，不获得队友资料。模仿狼人还获得一次性额外爪击，须技能启用且继承刀权后才能使用，可保留；按狼刀结算，可被守护或解药挡住。继承狼刀和模仿技能是两个独立决策。',
  ],
  nightStart(ctx) {
    for (const seat of holders(ctx)) {
      const d = data(ctx, seat);
      if (d.knifeFromNight === null && !ctx.alive().some((s) => s !== seat && ctx.roleOf(s).faction === 'wolf')) {
        d.knifeFromNight = ctx.state.day;
        ctx.priv([seat], 'awakened.inherit', '其余狼人已经全部出局，你从今晚开始继承普通狼刀。', { night: ctx.state.day });
      }
    }
  },
  afterNight(ctx) {
    for (const seat of holders(ctx)) {
      const l = data(ctx, seat).learned;
      if (!l || l.active) continue;
      l.active = true;
      ctx.priv([seat], 'awakened.activated', `学习夜已结束，你已获得${getRole(l.role).name}的模仿技能。夜间主动技能从第${l.activeFromNight}夜起可用。`, { activeFromNight: l.activeFromNight });
    }
  },
  onDeath(ctx, death) {
    const l = data(ctx, death.seat).learned;
    return l?.active && l.skill.kind === 'hunter' ? hunter.onDeath?.(ctx, death) ?? [] : [];
  },
  steps: {
    'night:awakened_mimic': {
      run(ctx, step) {
        const actors = holders(ctx).filter((s) => !data(ctx, s).learned && ctx.alive().some((x) => x !== s));
        if (!actors.length) return;
        ctx.ask({ step, actors, tools: (seat) => [mimicTool(ctx.alive().filter((s) => s !== seat)), waitTool()],
          prompt: () => '选择一名其他存活玩家模仿，或本夜暂不模仿。模仿身份立即生效，技能在当夜结束后获得。',
          title: `第${ctx.state.day}夜 · 模仿`, publicStage: '夜晚' });
      },
      validate(ctx, _step, seat, call) {
        if (data(ctx, seat).learned) return err('MIMIC_USED', '你已经模仿过，不能再次模仿');
        const target = call.args.targetSeat;
        if (call.tool === 'awakened_mimic' && typeof target === 'number' && target >= 1 && target <= ctx.playerCount) {
          if (target === seat) return err('TARGET_SELF_FORBIDDEN', '不能模仿自己');
          if (!ctx.isAlive(target)) return err('TARGET_DEAD', '不能模仿已经出局的玩家');
        }
        return null;
      },
      decide(ctx, _step, subs) {
        for (const [s, call] of Object.entries(subs)) {
          const seat = Number(s);
          if (call.tool === 'awakened_wait') { ctx.priv([seat], 'awakened.wait', '本夜暂不模仿，保留模仿机会。'); continue; }
          const target = call.args.targetSeat as Seat;
          const role = ctx.player(target).role;
          data(ctx, seat).learned = { target, role, learnedNight: ctx.state.day, activeFromNight: ctx.state.day + 1, active: false, skill: skillFor(role) };
          ctx.priv([seat], 'awakened.mimic', `你模仿了${seatLabel(target)}，目标真实身份为${getRole(role).name}。你的查验表现已改变，技能在当夜结束后获得。`, { target, role, activeFromNight: ctx.state.day + 1 });
          ctx.state.night?.lines.push(`觉醒隐狼（${seatLabel(seat)}）模仿 ${seatLabel(target)}（${getRole(role).name}）`);
        }
      },
      fallback: () => ({ tool: 'awakened_wait', args: {} }),
    },
    'night:awakened_knife': {
      run(ctx, step) {
        const actors = holders(ctx).filter((s) => data(ctx, s).knifeFromNight !== null);
        if (!actors.length) return;
        ctx.ask({ step, actors, tools: (seat) => {
          const targets = ctx.alive().filter((s) => ctx.opt<boolean>('wolf.allowTeammateTarget') || ctx.roleOf(s).faction !== 'wolf');
          return [killTool(targets), ...(ctx.opt<boolean>('wolf.allowEmpty') ? [emptyKill()] : [])];
        }, prompt: () => '你已继承普通狼刀，请独立提交今晚刀口。', title: `第${ctx.state.day}夜 · 继承狼刀`, publicStage: '夜晚' });
      },
      decide(ctx, _step, subs) {
        for (const [s, call] of Object.entries(subs)) {
          const seat = Number(s), target = call.tool === 'awakened_empty_kill' ? null : call.args.targetSeat as Seat;
          const n = ctx.state.night!;
          n.knife = target;
          if (target !== null) n.attacks.push({ target, kind: 'wolf', by: [seat] });
          ctx.priv([seat], 'awakened.knife', target === null ? '你今晚的继承狼刀为空刀。' : `你的继承狼刀选择了${seatLabel(target)}。`, { target });
          n.lines.push(`觉醒隐狼（${seatLabel(seat)}）继承狼刀：${target === null ? '空刀' : seatLabel(target)}`);
        }
      },
      fallback: () => ({ tool: 'awakened_empty_kill', args: {} }),
    },
    'night:awakened_skill': {
      run(ctx, step) {
        for (const seat of holders(ctx)) {
          const d = data(ctx, seat), l = d.learned;
          if (!l?.active || ctx.state.day < l.activeFromNight) continue;
          const skill = l.skill;
          let tools: ToolSpec[] = [];
          if (skill.kind === 'mirror' && inspectionTargets(ctx, seat).length) tools = [mirrorTool(inspectionTargets(ctx, seat))];
          if (skill.kind === 'poison' && skill.available) tools = [poisonTool(ctx.alive().filter((s) => s !== seat)), skipSkill()];
          if (skill.kind === 'guard') tools = [guardTool(ctx.alive().filter((s) => s !== skill.last)), skipSkill()];
          if (skill.kind === 'wolf' && skill.claw && d.knifeFromNight !== null) {
            tools = [clawTool(ctx.alive().filter((s) => ctx.opt<boolean>('wolf.allowTeammateTarget') || ctx.roleOf(s).faction !== 'wolf')), skipSkill()];
          }
          if (!tools.length) continue;
          ctx.ask({ step, actors: [seat], tools: () => tools, prompt: () => '你的模仿技能已经启用，请从本轮合法工具中选择。继承狼刀是另一独立决策。',
            title: `第${ctx.state.day}夜 · 模仿技能`, publicStage: '夜晚' });
        }
      },
      validate(ctx, _step, seat, call) {
        if (call.tool === 'mirror_inspect' && roleChecks(ctx, seat).some((c) => c.target === call.args.targetSeat)) return err('MIRROR_REPEAT', '魔镜查验不能重复选择同一玩家');
        return null;
      },
      decide(ctx, _step, subs) {
        for (const [s, call] of Object.entries(subs)) {
          const seat = Number(s), skill = data(ctx, seat).learned!.skill;
          const n = ctx.state.night!, target = call.args.targetSeat as Seat;
          if (call.tool === 'mirror_inspect') { inspectRole(ctx, seat, target ?? null); continue; }
          if (call.tool === 'awakened_skip_skill') {
            if (skill.kind === 'guard') skill.last = null;
            ctx.priv([seat], 'awakened.skip', '你本夜未使用模仿技能。');
            continue;
          }
          if (skill.kind === 'poison') { skill.available = false; n.attacks.push({ target, kind: 'poison', by: [seat] }); }
          if (skill.kind === 'guard') { skill.last = target; n.protections.push({ target, kind: 'awakened_guard', blocks: ['wolf', 'poison'], by: seat }); }
          if (skill.kind === 'wolf') { skill.claw = false; n.attacks.push({ target, kind: 'wolf', by: [seat] }); }
          ctx.priv([seat], 'awakened.skill', `你对${seatLabel(target)}使用了${call.tool === 'awakened_poison' ? '模仿毒药' : call.tool === 'awakened_guard' ? '增强守护' : '额外爪击'}。`, { tool: call.tool, target });
          n.lines.push(`觉醒隐狼（${seatLabel(seat)}）${call.tool}：${seatLabel(target)}`);
        }
      },
      fallback(ctx, _step, seat) {
        return data(ctx, seat).learned?.skill.kind === 'mirror'
          ? { tool: 'mirror_inspect', args: { targetSeat: null } } : { tool: 'awakened_skip_skill', args: {} };
      },
    },
  },
};

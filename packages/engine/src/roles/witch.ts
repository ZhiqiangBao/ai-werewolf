import type { ParamSpec, Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel } from '../text';
import { err, seatParam } from '../tools';
import type { RoleModule } from '../types';

interface Potions {
  antidote: boolean;
  poison: boolean;
}

const potions = (ctx: Ctx, seat: Seat) => ctx.player(seat).data as Potions;

function selfSaveAllowed(ctx: Ctx): boolean {
  const rule = ctx.opt<string>('witch.selfSave');
  return rule === 'always' || (rule === 'first_night' && ctx.state.day === 1);
}

function knifeOf(ctx: Ctx): Seat | null {
  return ctx.state.night?.knife ?? null;
}

function paramsFor(ctx: Ctx, seat: Seat): ParamSpec[] {
  const p = potions(ctx, seat);
  const knife = knifeOf(ctx);
  const params: ParamSpec[] = [];
  if (p.antidote && knife !== null && (knife !== seat || selfSaveAllowed(ctx))) {
    params.push({ kind: 'boolean', name: 'save', label: `对 ${seatLabel(knife)} 使用解药`, trueLabel: '救', falseLabel: '不救' });
  }
  if (p.poison) {
    params.push(seatParam('poisonTarget', '毒药目标', ctx.alive().filter((x) => x !== seat), '不用毒药'));
  }
  return params;
}

function promptFor(ctx: Ctx, seat: Seat): string {
  const p = potions(ctx, seat);
  const knife = knifeOf(ctx);
  const parts: string[] = [];
  if (p.antidote) {
    parts.push(knife !== null ? `狼人今晚选择刀 ${seatLabel(knife)}。` : '狼人今晚没有落刀。');
    if (knife === seat && !selfSaveAllowed(ctx)) parts.push('本局规则不允许你自救。');
  }
  parts.push(`你现在持有：${[p.antidote ? '解药' : '', p.poison ? '毒药' : ''].filter(Boolean).join('、')}。`);
  if (p.antidote && p.poison && !ctx.opt<boolean>('witch.bothPotionsSameNight')) parts.push('同一晚不能既救又毒。');
  return parts.join('');
}

export const witch: RoleModule = {
  id: 'witch',
  name: '女巫',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '有一瓶解药和一瓶毒药。解药还在的夜晚，法官会告诉你当晚刀口。',
  nightPhase: { id: 'witch', order: 40 },
  options: [
    {
      key: 'witch.selfSave',
      group: '女巫',
      label: '女巫自救',
      type: 'choice',
      choices: [
        { value: 'never', label: '不能自救' },
        { value: 'first_night', label: '仅第 1 夜可以自救' },
        { value: 'always', label: '任何夜晚都可以自救' },
      ],
      default: 'never',
      editable: true,
    },
    { key: 'witch.bothPotionsSameNight', group: '女巫', label: '同一晚可以既救又毒', type: 'boolean', default: false, editable: false },
  ],

  ruleCard(rules) {
    const v = rules.values;
    const self =
      v['witch.selfSave'] === 'always' ? '可以自救' : v['witch.selfSave'] === 'first_night' ? '仅第 1 夜可以自救' : '不能自救';
    const knife = rules.roles.includes('guard') ? '狼人选择的目标，不含守卫结果' : '狼人选择的目标';
    return [
      `女巫：有解药和毒药各一瓶。只有解药还在时，法官才告诉她当晚刀口（${knife}；空刀则告知没有落刀）；解药用掉后不再得知刀口。` +
        `解药只能救当晚刀口，${self}。${v['witch.bothPotionsSameNight'] ? '同一晚可以既救又毒。' : '同一晚不能既救又毒。'}` +
        '毒药可以毒任何其他存活玩家（包括当晚刀口），不能毒自己。两瓶药都用完后女巫夜里不再行动。',
    ];
  },

  setup(ctx, seats) {
    for (const s of seats) Object.assign(ctx.player(s).data, { antidote: true, poison: true });
  },

  appendix(ctx, seat) {
    const p = potions(ctx, seat);
    const lines = [`药品：解药${p.antidote ? '未使用' : '已使用'}，毒药${p.poison ? '未使用' : '已使用'}。`];
    if (!p.antidote) lines.push('解药已用，之后法官不再告诉你刀口。');
    return lines;
  },

  steps: {
    'night:witch': {
      run(ctx, step) {
        const witches = ctx.seatsOf('witch').filter((w) => potions(ctx, w).antidote || potions(ctx, w).poison);
        if (!witches.length) return;
        const knife = knifeOf(ctx);
        for (const w of witches) {
          if (!potions(ctx, w).antidote) continue;
          ctx.priv([w], 'witch.knife', knife !== null ? `狼人今晚选择刀 ${seatLabel(knife)}。` : '狼人今晚没有落刀。', {
            knife,
          });
        }
        const actors = witches.filter((w) => paramsFor(ctx, w).length > 0);
        if (!actors.length) return;
        ctx.ask({
          step,
          actors,
          tools: (seat) => [
            {
              name: 'witch_act',
              title: '用药',
              description: '一次提交本晚的用药决定，救和毒都在这里选。',
              params: paramsFor(ctx, seat),
            },
          ],
          prompt: (seat) => promptFor(ctx, seat),
          title: `第${ctx.state.day}夜 · 女巫`,
          publicStage: '夜晚',
        });
      },
      validate(ctx, _step, seat, call) {
        const p = potions(ctx, seat);
        const knife = knifeOf(ctx);
        const save = call.args.save === true;
        const poisonTarget = call.args.poisonTarget;
        if (save) {
          if (!p.antidote) return err('POTION_USED', '解药已经用过');
          if (knife === null) return err('INVALID_ARGUMENT', '今晚没有刀口，不能使用解药');
          if (knife === seat && !selfSaveAllowed(ctx)) return err('CANNOT_SELF_SAVE', '本场规则不允许自救');
        }
        if (poisonTarget !== null && poisonTarget !== undefined) {
          if (!p.poison) return err('POTION_USED', '毒药已经用过');
          if (poisonTarget === seat) return err('TARGET_SELF_FORBIDDEN', '不能对自己使用毒药');
        }
        if (save && poisonTarget !== null && poisonTarget !== undefined && !ctx.opt<boolean>('witch.bothPotionsSameNight')) {
          return err('SAME_NIGHT_BOTH_POTIONS', '同一晚不能既救又毒');
        }
        return null;
      },
      decide(ctx, _step, subs) {
        const night = ctx.state.night;
        if (!night) throw new Error('女巫行动缺少夜晚状态');
        const knife = knifeOf(ctx);
        for (const [key, call] of Object.entries(subs)) {
          const seat = Number(key);
          const p = potions(ctx, seat);
          const save = call.args.save === true && knife !== null;
          const target = (call.args.poisonTarget as Seat | null | undefined) ?? null;
          const done: string[] = [];
          if (save && knife !== null) {
            night.protections.push({ target: knife, kind: 'antidote', blocks: ['wolf'], by: seat });
            p.antidote = false;
            ctx.priv([seat], 'witch.save', `你对 ${seatLabel(knife)} 使用了解药。`, { target: knife });
            done.push(`救 ${seatLabel(knife)}`);
          }
          if (target !== null) {
            night.attacks.push({ target, kind: 'poison', by: [seat] });
            p.poison = false;
            ctx.priv([seat], 'witch.poison', `你对 ${seatLabel(target)} 使用了毒药。`, { target });
            done.push(`毒 ${seatLabel(target)}`);
          }
          if (!done.length) ctx.priv([seat], 'witch.idle', '你今晚没有用药。', {});
          night.lines.push(`女巫（${seatLabel(seat)}）${done.length ? done.join('、') : '未用药'}`);
        }
      },
      fallback: () => ({ tool: 'witch_act', args: { save: false, poisonTarget: null } }),
    },
  },
};

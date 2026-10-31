import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel, seatList } from '../text';
import { seatParam, textParam } from '../tools';
import type { RoleModule, Step } from '../types';

type Pick = [Seat, Seat | null];

const pickText = (picks: Pick[]) =>
  picks.map(([w, t]) => `${seatLabel(w)}→${t === null ? '空刀' : seatLabel(t)}`).join('，');

function killTargets(ctx: Ctx): Seat[] {
  const allowTeam = ctx.opt<boolean>('wolf.allowTeammateTarget');
  return ctx.alive().filter((x) => allowTeam || !ctx.isWolfTeam(x));
}

export const werewolf: RoleModule = {
  id: 'werewolf',
  tools: ({ seats, rules }) => wolfTools(seats, rules.values),
  name: '狼人',
  faction: 'wolf',
  category: 'wolf',
  maxPerGame: 8,
  summary: '夜里与狼队友密谈后落刀；白天可以自爆。',
  inspectAs: 'wolf',
  wolfTeam: true,
  canExplode: true,
  nightPhase: { id: 'werewolf', order: 20 },
  options: [
    { key: 'wolf.knowTeammates', group: '狼人', label: '狼人互知队友', type: 'boolean', default: true, editable: false },
    { key: 'wolf.allowEmpty', group: '狼人', label: '可以空刀', type: 'boolean', default: true, editable: false },
    { key: 'wolf.allowTeammateTarget', group: '狼人', label: '可以自刀（刀狼队友或自己）', type: 'boolean', default: true, editable: true },
    { key: 'wolf.discussRounds', group: '狼人', label: '落刀前密谈轮数', type: 'number', default: 1, editable: false },
    {
      key: 'wolf.killRounds',
      group: '狼人',
      label: '落刀未过半时',
      type: 'choice',
      choices: [
        { value: 2, label: '公开各狼选择后重投一次，仍然并列则取座位号较小的目标' },
        { value: 1, label: '并列时取座位号较小的目标' },
      ],
      default: 2,
      editable: true,
      hint: '空刀不计票。只有所有狼人都空刀，当晚才是空刀。2 人刀同一座位、另外 2 人空刀，刀口成立。',
    },
  ],

  ruleCard(rules) {
    const v = rules.values;
    const lines = [
      `狼人：${v['wolf.knowTeammates'] ? '互知队友' : '不知道队友'}。每晚先按座位号各密谈一句，再同时提交刀口。` +
        `${v['wolf.allowEmpty'] ? '可以空刀，空刀不计票。只有所有存活狼人都空刀，当晚才没有刀口。' : ''}${v['wolf.allowTeammateTarget'] ? '可以刀狼队友或自己。' : '不能刀狼队友。'}` +
        '有人落刀时，得票最多的座位成为刀口' +
        (Number(v['wolf.killRounds']) > 1
          ? '；得票并列时公开各狼的选择并重投一次，仍然并列则座位号较小的目标成为刀口。'
          : '；得票并列时，座位号较小的目标成为刀口。') +
        '只剩一名狼人时，他的提交直接生效。',
    ];
    return lines;
  },

  appendix(ctx, seat) {
    if (!ctx.opt<boolean>('wolf.knowTeammates')) return [];
    const team = ctx.wolfTeam(false);
    return [`狼队成员：${seatList(team)}（含你自己）。目前存活：${seatList(team.filter((x) => ctx.isAlive(x))) || '无'}。`];
  },

  setup(ctx) {
    if (!ctx.opt<boolean>('wolf.knowTeammates')) return;
    const team = ctx.wolfTeam(false);
    ctx.priv(team, 'wolf.team', `狼队成员：${seatList(team)}。`, { wolves: team });
  },

  steps: {
    'night:werewolf': {
      run(ctx) {
        const wolves = ctx.wolfTeam();
        if (!wolves.length) return;
        const steps: Step[] = [];
        if (wolves.length > 1) {
          const rounds = ctx.opt<number>('wolf.discussRounds');
          for (let r = 1; r <= rounds; r++) for (const w of wolves) steps.push({ type: 'wolf.discuss', seat: w, round: r });
        }
        steps.push({ type: 'wolf.kill', round: 1 });
        ctx.pushFront(...steps);
      },
    },

    'wolf.discuss': {
      run(ctx, step) {
        const seat = step.seat as Seat;
        if (!ctx.isAlive(seat)) return;
        ctx.ask({
          step,
          actors: [seat],
          tools: () => [
            {
              name: 'wolf_discuss',
              title: '狼人密谈',
              description: '和狼队友商量今晚的刀口，只有当前存活的狼队友能看到。',
              params: [textParam('content', '密谈内容', 1)],
            },
          ],
          prompt: () => '轮到你在狼队频道发言，商量今晚刀谁、白天怎么打。',
          title: `第${ctx.state.day}夜 · 狼人密谈`,
          publicStage: '夜晚',
        });
      },
      decide(ctx, step, subs) {
        const seat = step.seat as Seat;
        const content = String(subs[seat].args.content);
        ctx.priv(ctx.wolfTeam(), 'wolf.chat', `${seatLabel(seat)}（狼队密谈）：${content}`, { seat, content });
      },
      fallback: () => ({ tool: 'wolf_discuss', args: { content: '过。' } }),
    },

    'wolf.kill': {
      run(ctx, step) {
        const wolves = ctx.wolfTeam();
        if (!wolves.length) return;
        const targets = killTargets(ctx);
        const allowEmpty = ctx.opt<boolean>('wolf.allowEmpty');
        const prev = step.previous as Pick[] | undefined;
        ctx.ask({
          step,
          actors: wolves,
          simultaneous: true,
          tools: () => [
            {
              name: 'wolf_kill',
              title: '落刀',
              description: '提交今晚的刀口。所有存活狼人各提交一次，提交期间互相看不到。',
              params: [seatParam('target', '刀口', targets, allowEmpty ? '空刀' : undefined)],
            },
          ],
          prompt: () =>
            (prev ? `上一轮刀口并列（${pickText(prev)}），请重新选择。` : '') +
            (ctx.rules.toolsetVersion === 2 && !allowEmpty ? '请提交刀口。本局不能选择空刀，得票最多的合法目标成为刀口。' : '请提交刀口。空刀不计票。只有所有狼人都空刀，今晚才是空刀；否则得票最多的座位成为刀口。'),
          title: `第${ctx.state.day}夜 · 落刀`,
          publicStage: '夜晚',
        });
      },
      ack: (_c, _s, _seat, call) =>
        call.args.target === null ? '你选择了空刀。' : `你选择刀 ${seatLabel(call.args.target as Seat)}。`,
      validate(ctx, _step, _seat, call) {
        const t = call.args.target;
        if (typeof t === 'number' && ctx.playerCount >= t && t >= 1 && ctx.isAlive(t) && ctx.isWolfTeam(t) && !ctx.opt<boolean>('wolf.allowTeammateTarget')) {
          return { code: 'INVALID_ARGUMENT', reason: '本局规则不允许刀狼队友' };
        }
        return null;
      },
      decide(ctx, step, subs) {
        const night = ctx.state.night;
        if (!night) throw new Error('落刀缺少夜晚状态');
        const wolves = Object.keys(subs).map(Number).sort((a, b) => a - b);
        const picks: Pick[] = wolves.map((w) => [w, (subs[w].args.target as Seat | null) ?? null]);
        const counts = new Map<number, number>();
        for (const [, t] of picks) if (t !== null) counts.set(t, (counts.get(t) ?? 0) + 1);
        const round = step.round as number;
        let knife: Seat | null = null;
        let tied = false;
        if (counts.size === 0) {
          knife = null;
        } else {
          const top = Math.max(...counts.values());
          const leaders = [...counts.keys()].filter((seat) => counts.get(seat) === top);
          if (leaders.length > 1 && round < ctx.opt<number>('wolf.killRounds')) {
            ctx.priv(wolves, 'wolf.kill.split', `第${round}轮刀口并列（${pickText(picks)}），请重新选择。`, { picks });
            ctx.pushFront({ type: 'wolf.kill', round: round + 1, previous: picks });
            return;
          }
          tied = leaders.length > 1;
          knife = tied ? Math.min(...leaders) : leaders[0];
        }
        night.knife = knife;
        if (knife !== null) night.attacks.push({ target: knife, kind: 'wolf', by: wolves });
        const outcome =
          knife === null
            ? '所有狼人都空刀，今晚空刀'
            : tied
              ? `刀口并列，取座位号较小的目标。今晚刀口：${seatLabel(knife)}`
              : `今晚刀口：${seatLabel(knife)}`;
        ctx.priv(wolves, 'wolf.kill.result', `${outcome}（${pickText(picks)}）。`, { picks, knife });
        night.lines.push(`狼人（${seatList(wolves)}）${knife === null ? '空刀' : `刀 ${seatLabel(knife)}`}`);
      },
      fallback: () => ({ tool: 'wolf_kill', args: { target: null } }),
    },
  },
};

function wolfTools(seats: Seat[], v: RuleSet['values']): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'wolf_discuss',
      title: '狼人密谈',
      description: '狼人夜间密谈、且轮到你发言时使用。content 是非空字符串，只有当前存活的狼队友能看到。例：{"content":"今晚建议刀3号。"}。密谈只传达意见，正式落刀须等待法官再调用 wolf_kill。其他阶段不要调用。',
      params: [textParam('content', '密谈内容', 1)],
    },
    {
      name: 'wolf_kill',
      title: '落刀',
      description: `狼人夜间落刀时使用。target 是今晚的刀口。${v['wolf.allowEmpty'] === true ? '传 null 表示空刀，空刀不计票。' : '本局不能空刀。'}${v['wolf.allowTeammateTarget'] === true ? '可以刀狼队友或自己。' : '不能刀狼队友或自己。'}只能选择存活目标。例：{"target":3} 表示刀3号（须符合本局限制）。所有存活狼人同时提交；按法官公布的合刀规则结算，不在密谈工具里直接落刀。其他阶段不要调用。`,
      params: [seatParam('target', '刀口', seats, v['wolf.allowEmpty'] === true ? '空刀' : undefined)],
    },
  ];
  if (v['explode.enabled'] !== true) return tools;
  tools.push(
    {
      name: 'wolf_explode',
      title: '自爆',
      description: `存活狼人按本局自爆窗口使用。${v['explode.window'] === 'interrupt' ? '法官开放发言窗口时可在自己的发言或旁听中打断自爆。' : v['explode.window'] === 'speaker_only' ? '仅轮到自己正常发言时可用，遗言不能用。' : '本局在每段发言前专门询问，请在询问时用 wolf_explode_decision，不直接用本工具。'}立刻出局并公开身份，取消当天剩余流程，后续警徽、遗言与胜负由法官结算。无参数，填写 {}。投票与夜间不能使用。`,
      params: [],
    },
    {
      name: 'wolf_explode_decision',
      title: '是否自爆',
      description: '法官在下一段发言前询问是否自爆时使用。explode 必须是布尔值，true 表示自爆，false 表示不自爆。例：{"explode":false}。多人同时选 true 时由最小座位号执行，其余仍存活。只回答该次询问；其他阶段不要调用。',
      params: [{ kind: 'boolean', name: 'explode', label: '是否自爆', trueLabel: '自爆', falseLabel: '不自爆' }],
    },
  );
  return tools;
}

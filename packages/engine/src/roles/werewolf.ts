import { gameText } from '@werewolf/protocol';
import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel, seatList } from '../text';
import { seatParam, textParam } from '../tools';
import type { RoleModule, Step } from '../types';

type Pick = [Seat, Seat | null];

const pickText = (picks: Pick[], locale: string | undefined = 'zh-CN') =>
  picks.map(([w, t]) => `${seatLabel(w, locale)}→${t === null ? gameText(locale, "空刀") : seatLabel(t, locale)}`).join('，');

function killTargets(ctx: Ctx): Seat[] {
  const allowTeam = ctx.opt<boolean>('wolf.allowTeammateTarget');
  return ctx.alive().filter((x) => allowTeam || !ctx.isWolfTeam(x));
}

export const werewolf: RoleModule = {
  id: 'werewolf',
  tools: ({ seats, rules }) => wolfTools(seats, rules.values, rules.locale),
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
      gameText(rules.locale, "普通狼人：{0}。每晚先按座位号各密谈一句，再同时提交刀口；密谈和落刀结果仅向当夜参与行动的存活普通狼人发送。", v['wolf.knowTeammates'] ? gameText(rules.locale, "互知队友") : gameText(rules.locale, "不知道队友")) +
        `${v['wolf.allowEmpty'] ? gameText(rules.locale, "可以空刀，空刀不计票。只有所有存活狼人都空刀，当晚才没有刀口。") : ''}${v['wolf.allowTeammateTarget'] ? gameText(rules.locale, "可以刀狼队友或自己。") : gameText(rules.locale, "不能刀狼队友。")}` +
        gameText(rules.locale, "有人落刀时，得票最多的座位成为刀口") +
        (Number(v['wolf.killRounds']) > 1
          ? gameText(rules.locale, "；得票并列时仅向参与本轮落刀的普通狼人公布各自选择并重投一次，仍然并列则座位号较小的目标成为刀口。")
          : gameText(rules.locale, "；得票并列时，座位号较小的目标成为刀口。")) +
        gameText(rules.locale, "只剩一名狼人时，他的提交直接生效。"),
    ];
    return lines;
  },

  appendix(ctx, seat) {
    if (!ctx.opt<boolean>('wolf.knowTeammates')) return [];
    const team = ctx.wolfTeam(false);
    return [gameText(ctx.rules.locale, "狼队成员：{0}（含你自己）。目前存活：{1}。", seatList(team, ctx.rules.locale), seatList(team.filter((x) => ctx.isAlive(x)), ctx.rules.locale) || gameText(ctx.rules.locale, "无"))];
  },

  setup(ctx) {
    if (!ctx.opt<boolean>('wolf.knowTeammates')) return;
    const team = ctx.wolfTeam(false);
    ctx.priv(team, 'wolf.team', gameText(ctx.rules.locale, "狼队成员：{0}。", seatList(team, ctx.rules.locale)), { wolves: team });
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
              title: gameText(ctx.rules.locale, "狼人密谈"),
              description: gameText(ctx.rules.locale, "和狼队友商量今晚的刀口，只有当前存活的狼队友能看到。"),
              params: [textParam('content', gameText(ctx.rules.locale, "密谈内容"), 1, undefined)],
            },
          ],
          prompt: () => gameText(ctx.rules.locale, "轮到你在狼队频道发言，商量今晚刀谁、白天怎么打。"),
          title: gameText(ctx.rules.locale, "第{0}夜 · 狼人密谈", ctx.state.day),
          publicStage: gameText(ctx.rules.locale, "夜晚"),
        });
      },
      decide(ctx, step, subs) {
        const seat = step.seat as Seat;
        const content = String(subs[seat].args.content);
        ctx.priv(ctx.wolfTeam(), 'wolf.chat', gameText(ctx.rules.locale, "{0}（狼队密谈）：{1}", seatLabel(seat, ctx.rules.locale), content), { seat, content });
      },
      fallback: (ctx) => ({ tool: 'wolf_discuss', args: { content: gameText(ctx.rules.locale, "过。") } }),
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
              title: gameText(ctx.rules.locale, "落刀"),
              description: gameText(ctx.rules.locale, "提交今晚的刀口。所有存活狼人各提交一次，提交期间互相看不到。"),
              params: [seatParam('target', gameText(ctx.rules.locale, "刀口"), targets, allowEmpty ? gameText(ctx.rules.locale, "空刀") : undefined)],
            },
          ],
          prompt: () =>
            (prev ? gameText(ctx.rules.locale, "上一轮刀口并列（{0}），请重新选择。", pickText(prev, ctx.rules.locale)) : '') +
            (ctx.rules.toolsetVersion === 2 && !allowEmpty ? gameText(ctx.rules.locale, "请提交刀口。本局不能选择空刀，得票最多的合法目标成为刀口。") : gameText(ctx.rules.locale, "请提交刀口。空刀不计票。只有所有狼人都空刀，今晚才是空刀；否则得票最多的座位成为刀口。")),
          title: gameText(ctx.rules.locale, "第{0}夜 · 落刀", ctx.state.day),
          publicStage: gameText(ctx.rules.locale, "夜晚"),
        });
      },
      ack: (_c, _s, _seat, call) =>
        call.args.target === null ? gameText(_c.rules.locale, "你选择了空刀。") : gameText(_c.rules.locale, "你选择刀 {0}。", seatLabel(call.args.target as Seat, _c.rules.locale)),
      validate(ctx, _step, _seat, call) {
        const t = call.args.target;
        if (typeof t === 'number' && ctx.playerCount >= t && t >= 1 && ctx.isAlive(t) && ctx.isWolfTeam(t) && !ctx.opt<boolean>('wolf.allowTeammateTarget')) {
          return { code: 'INVALID_ARGUMENT', reason: gameText(ctx.rules.locale, "本局规则不允许刀狼队友") };
        }
        return null;
      },
      decide(ctx, step, subs) {
        const night = ctx.state.night;
        if (!night) throw new Error(gameText(ctx.rules.locale, "落刀缺少夜晚状态"));
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
            ctx.priv(wolves, 'wolf.kill.split', gameText(ctx.rules.locale, "第{0}轮刀口并列（{1}），请重新选择。", round, pickText(picks, ctx.rules.locale)), { picks });
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
            ? gameText(ctx.rules.locale, "所有狼人都空刀，今晚空刀")
            : tied
              ? gameText(ctx.rules.locale, "刀口并列，取座位号较小的目标。今晚刀口：{0}", seatLabel(knife, ctx.rules.locale))
              : gameText(ctx.rules.locale, "今晚刀口：{0}", seatLabel(knife, ctx.rules.locale));
        ctx.priv(wolves, 'wolf.kill.result', `${outcome}（${pickText(picks, ctx.rules.locale)}）。`, { picks, knife });
        night.lines.push(gameText(ctx.rules.locale, "狼人（{0}）{1}", seatList(wolves, ctx.rules.locale), knife === null ? gameText(ctx.rules.locale, "空刀") : gameText(ctx.rules.locale, "刀 {0}", seatLabel(knife, ctx.rules.locale))));
      },
      fallback: (ctx) => ({ tool: 'wolf_kill', args: { target: null } }),
    },
  },
};

function wolfTools(seats: Seat[], v: RuleSet['values'], locale: string | undefined = 'zh-CN'): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'wolf_discuss',
      title: gameText(locale, "狼人密谈"),
      description: gameText(locale, "狼人夜间密谈、且轮到你发言时使用。content 是非空字符串，只有当前存活的狼队友能看到。例：{\"content\":\"今晚建议刀3号。\"}。密谈只传达意见，正式落刀须等待法官再调用 wolf_kill。其他阶段不要调用。"),
      params: [textParam('content', gameText(locale, "密谈内容"), 1, undefined)],
    },
    {
      name: 'wolf_kill',
      title: gameText(locale, "落刀"),
      description: gameText(locale, "普通狼人夜间落刀时使用。target 是你提交的狼刀目标，最终刀口按合刀规则决定。{0}{1}只能选择存活目标。例：{\"target\":3} 表示提交刀3号（须符合本局限制）。所有参与落刀的存活普通狼人同时提交；按法官公布的合刀规则结算，不在密谈工具里直接落刀。其他阶段不要调用。", v['wolf.allowEmpty'] === true ? gameText(locale, "传 null 表示空刀，空刀不计票。") : gameText(locale, "本局不能空刀。"), v['wolf.allowTeammateTarget'] === true ? gameText(locale, "可以刀狼队友或自己。") : gameText(locale, "不能刀狼队友或自己。")),
      params: [seatParam('target', gameText(locale, "刀口"), seats, v['wolf.allowEmpty'] === true ? gameText(locale, "空刀") : undefined)],
    },
  ];
  if (v['explode.enabled'] !== true) return tools;
  tools.push(
    {
      name: 'wolf_explode',
      title: gameText(locale, "自爆"),
      description: gameText(locale, "存活狼人按本局自爆窗口使用。{0}立刻出局并公开身份，取消当天剩余流程，后续警徽、遗言与胜负由法官结算。无参数，填写 {}。投票与夜间不能使用。", v['explode.window'] === 'interrupt' ? gameText(locale, "法官开放发言窗口时可在自己的发言或旁听中打断自爆。") : v['explode.window'] === 'speaker_only' ? gameText(locale, "仅轮到自己正常发言时可用，遗言不能用。") : gameText(locale, "本局在每段发言前专门询问，请在询问时用 wolf_explode_decision，不直接用本工具。")),
      params: [],
    },
    {
      name: 'wolf_explode_decision',
      title: gameText(locale, "是否自爆"),
      description: gameText(locale, "法官在下一段发言前或延期警长续选投票前询问是否自爆时使用。explode 必须是布尔值，true 表示自爆，false 表示不自爆。例：{\"explode\":false}。多人同时选 true 时由最小座位号执行，其余仍存活。只回答该次询问；其他阶段不要调用。"),
      params: [{ kind: 'boolean', name: 'explode', label: gameText(locale, "是否自爆"), trueLabel: gameText(locale, "自爆"), falseLabel: gameText(locale, "不自爆") }],
    },
  );
  return tools;
}

import type { Seat, ToolSpec } from '@werewolf/protocol';
import { seatParam, textParam } from './tools';
import type { GameState } from './types';

/**
 * 每个座位整局使用的工具。名称、顺序和参数结构只由身份与开局规则决定，不随阶段、存活或药品变化。
 * 当前阶段能不能用，由引擎在提交时判断。
 */
export function seatTools(state: GameState, seat: Seat): ToolSpec[] {
  const player = state.players[seat - 1];
  if (!player) return [];
  const seats = state.players.map((p) => p.seat);
  const v = state.rules.values;
  const tools: ToolSpec[] = [speakTool(), voteTool(seats, v['vote.allowAbstain'] === true, v['vote.allowSelf'] === true)];
  if (v['sheriff.enabled'] === true) tools.push(...sheriffTools(seats, v['vote.allowAbstain'] === true));
  tools.push(...roleTools(player.role, seats, v));
  return tools;
}

function speakTool(): ToolSpec {
  return {
    name: 'speak',
    title: '发言',
    description:
      '轮到你公开发言时使用：警上发言、白天发言、PK 发言或遗言。把要说的话写入 content，内容会公开给所有人。其他阶段不要调用。',
    params: [textParam('content', '发言内容', 1)],
  };
}

function voteTool(seats: Seat[], abstain: boolean, self: boolean): ToolSpec {
  return {
    name: 'vote',
    title: '放逐投票',
    description:
      `放逐投票或 PK 投票时使用。target 是要放逐的座位号。${abstain ? '传 null 表示弃票。' : '本局不能弃票。'}${self ? '可以投自己。' : '不能投自己。'}只能投存活玩家。警长的票记 1.5 票。其他阶段不要调用。`,
    params: [seatParam('target', '放逐目标', seats, abstain ? '弃票' : undefined)],
  };
}

function sheriffTools(seats: Seat[], abstain: boolean): ToolSpec[] {
  return [
    {
      name: 'sheriff_signup',
      title: '上警',
      description: '警长竞选报名时使用。run 为 true 表示上警，false 表示不上警。全部提交后才公开。其他阶段不要调用。',
      params: [{ kind: 'boolean', name: 'run', label: '是否上警', trueLabel: '上警', falseLabel: '不上警' }],
    },
    {
      name: 'sheriff_withdraw',
      title: '退水',
      description: '你的警上发言或竞选 PK 发言时使用，表示退出警长竞选。content 是同时发表的话，可以留空。其他阶段不要调用。',
      params: [textParam('content', '退水时的发言（可留空）', 0)],
    },
    {
      name: 'sheriff_vote',
      title: '警长投票',
      description: `警长投票或警长 PK 投票时使用。target 是候选人座位号。${abstain ? '传 null 表示弃票。' : '本局不能弃票。'}每人 1 票。其他阶段不要调用。`,
      params: [seatParam('target', '投给', seats, abstain ? '弃票' : undefined)],
    },
    {
      name: 'set_speak_direction',
      title: '选择发言方向',
      description:
        '你是警长且法官要求选择白天发言方向时使用。clockwise 是顺时针（号码增大），counterclockwise 是逆时针（号码减小）。其他阶段不要调用。',
      params: [
        {
          kind: 'choice',
          name: 'direction',
          label: '发言方向',
          options: [
            { value: 'clockwise', label: '顺时针（号码增大）' },
            { value: 'counterclockwise', label: '逆时针（号码减小）' },
          ],
        },
      ],
    },
    {
      name: 'badge_dispose',
      title: '处理警徽',
      description: '你是警长并且已经出局、法官要求处理警徽时使用。target 是接收警徽的存活玩家，传 null 表示撕毁警徽。不能交给自己。其他阶段不要调用。',
      params: [seatParam('target', '移交给', seats, '撕毁警徽')],
    },
  ];
}

function roleTools(role: string, seats: Seat[], v: GameState['rules']['values']): ToolSpec[] {
  switch (role) {
    case 'werewolf':
      return wolfTools(seats, v);
    case 'seer':
      return [seerTool(seats)];
    case 'witch':
      return [witchTool(seats, v)];
    case 'guard':
      return [guardTool(seats, v)];
    case 'hunter':
      return [hunterTool(seats)];
    default:
      return [];
  }
}

function wolfTools(seats: Seat[], v: GameState['rules']['values']): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'wolf_discuss',
      title: '狼人密谈',
      description: '狼人夜间密谈、且轮到你发言时使用。content 只有当前存活的狼队友能看到。其他阶段不要调用。',
      params: [textParam('content', '密谈内容', 1)],
    },
    {
      name: 'wolf_kill',
      title: '落刀',
      description: `狼人夜间落刀时使用。target 是今晚的刀口。${v['wolf.allowEmpty'] === true ? '传 null 表示空刀，空刀不计票。' : '本局不能空刀。'}${v['wolf.allowTeammateTarget'] === true ? '可以刀狼队友或自己。' : '不能刀狼队友或自己。'}所有存活狼人同时提交。其他阶段不要调用。`,
      params: [seatParam('target', '刀口', seats, v['wolf.allowEmpty'] === true ? '空刀' : undefined)],
    },
  ];
  if (v['explode.enabled'] !== true) return tools;
  tools.push(
    {
      name: 'wolf_explode',
      title: '自爆',
      description: '存活狼人在白天发言阶段使用。立刻自爆出局并公开狼人身份，当天剩余发言、竞选和投票取消，然后发表遗言并进入黑夜。没有参数。其他阶段不要调用。',
      params: [],
    },
    {
      name: 'wolf_explode_decision',
      title: '是否自爆',
      description: '法官在下一段发言前询问是否自爆时使用。explode 为 true 表示自爆，false 表示不自爆。其他阶段不要调用。',
      params: [{ kind: 'boolean', name: 'explode', label: '是否自爆', trueLabel: '自爆', falseLabel: '不自爆' }],
    },
  );
  return tools;
}

function seerTool(seats: Seat[]): ToolSpec {
  return {
    name: 'seer_inspect',
    title: '查验',
    description: '预言家夜间查验时使用。target 是一名其他存活玩家，不能查自己。结果只区分好人或狼人，只有你能看到。其他阶段不要调用。',
    params: [seatParam('target', '查验目标', seats)],
  };
}

function witchTool(seats: Seat[], v: GameState['rules']['values']): ToolSpec {
  const self = v['witch.selfSave'] === 'always' ? '可以自救。' : v['witch.selfSave'] === 'first_night' ? '仅第 1 夜可以自救。' : '不能自救。';
  const both = v['witch.bothPotionsSameNight'] === true ? '同一晚可以既救又毒。' : '同一晚不能既救又毒。';
  return {
    name: 'witch_act',
    title: '用药',
    description: `女巫夜间用药时使用。save 为 true 表示用尚未用过的解药救当晚刀口，false 表示不救。解药只能救当晚刀口，${self}poisonTarget 是毒药目标，null 表示不用毒；不能毒自己，不能毒已经用完的药。${both}其他阶段不要调用。`,
    params: [
      { kind: 'boolean', name: 'save', label: '使用解药', trueLabel: '救', falseLabel: '不救' },
      seatParam('poisonTarget', '毒药目标', seats, '不用毒药'),
    ],
  };
}

function guardTool(seats: Seat[], v: GameState['rules']['values']): ToolSpec {
  return {
    name: 'guard_protect',
    title: '守护',
    description: `守卫夜间守护时使用。target 是今晚守护的存活玩家，null 表示空守。${v['guard.allowSelf'] === true ? '可以守护自己。' : '不能守护自己。'}${v['guard.noConsecutive'] === true ? '不能连续两晚守护同一人。' : ''}守护只挡狼刀。其他阶段不要调用。`,
    params: [seatParam('target', '守护目标', seats, '空守')],
  };
}

function hunterTool(seats: Seat[]): ToolSpec {
  return {
    name: 'hunter_shoot',
    title: '开枪',
    description: '猎人出局且法官允许开枪时使用。target 是要带走的存活玩家，null 表示放弃开枪。开枪会公开猎人身份。不能射自己。其他阶段不要调用。',
    params: [seatParam('target', '开枪目标', seats, '放弃开枪')],
  };
}

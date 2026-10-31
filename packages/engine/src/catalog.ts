import type { Seat, ToolSpec } from '@werewolf/protocol';
import { seatParam, textParam } from './tools';
import { getRole } from './registry';
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
  const tools: ToolSpec[] = [speakTool(), voteTool(seats, v['vote.allowAbstain'] === true, v['vote.allowSelf'] === true, Number(v['vote.normalWeight']), Number(v['vote.sheriffWeight']))];
  if (v['sheriff.enabled'] === true) tools.push(...sheriffTools(seats, v['vote.allowAbstain'] === true, Number(v['vote.normalWeight'])));
  tools.push(...(getRole(player.role).tools?.({ seats, seat, rules: state.rules }) ?? []));
  if (new Set(tools.map((t) => t.name)).size !== tools.length) throw new Error(`身份 ${player.role} 的工具名称重复`);
  return tools;
}

function speakTool(): ToolSpec {
  return {
    name: 'speak',
    title: '发言',
    description:
      '轮到你公开发言时使用：警上发言、白天发言、PK 发言或遗言。把要说的话写入 content，content 必须是非空字符串，内容会公开给所有人；例：{"content":"我认为3号可疑。"}。一次提交即结束本段发言。其他阶段不要调用。',
    params: [textParam('content', '发言内容', 1)],
  };
}

function voteTool(seats: Seat[], abstain: boolean, self: boolean, normal: number, sheriff: number): ToolSpec {
  return {
    name: 'vote',
    title: '放逐投票',
    description:
      `放逐投票或 PK 投票时使用。target 是要放逐的座位号。${abstain ? '传 null 表示弃票。' : '本局不能弃票。'}${self ? '可以投自己。' : '不能投自己。'}只能投存活玩家。普通票记 ${normal} 票，警长票记 ${sheriff} 票。PK 时只可投法官列出的 PK 目标。例：{"target":3}，表示投3号；以当前合法目标为准。其他阶段不要调用。`,
    params: [seatParam('target', '放逐目标', seats, abstain ? '弃票' : undefined)],
  };
}

function sheriffTools(seats: Seat[], abstain: boolean, normal: number): ToolSpec[] {
  return [
    {
      name: 'sheriff_signup',
      title: '上警',
      description: '警长竞选报名时使用。run 为 true 表示上警，false 表示不上警。例：{"run":true}。run 必须是布尔值。全部提交后才公开。其他阶段不要调用。',
      params: [{ kind: 'boolean', name: 'run', label: '是否上警', trueLabel: '上警', falseLabel: '不上警' }],
    },
    {
      name: 'sheriff_withdraw',
      title: '退水',
      description: '仅轮到你的普通警上竞选发言时使用，表示退出警长竞选并结束本段发言。竞选 PK 不提供退水。content 是同时公开的话，必须是字符串，可为空；例：{"content":"我退水。"}。一次只交此工具，无需另调 speak。其他阶段不要调用。',
      params: [textParam('content', '退水时的发言（可留空）', 0)],
    },
    {
      name: 'sheriff_vote',
      title: '警长投票',
      description: `警长投票或警长 PK 投票时使用。target 是候选人座位号。${abstain ? '传 null 表示弃票。' : '本局不能弃票。'}每人 ${normal} 票。只允许法官当前通知有投票权的玩家提交，目标以候选名单为准。例：{"target":3} 表示选3号当警长，不能用 vote 代替。其他阶段不要调用。`,
      params: [seatParam('target', '投给', seats, abstain ? '弃票' : undefined)],
    },
    {
      name: 'set_speak_direction',
      title: '选择发言方向',
      description:
        '你是警长且法官要求选择白天发言方向时使用。clockwise 是顺时针（号码增大），counterclockwise 是逆时针（号码减小），到末座后循环。例：{"direction":"clockwise"}。只填枚举英文值，警长在最后发言，具体首位由法官排定。其他阶段不要调用。',
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
      description: '你是警长且已出局、法官要求处理警徽时使用。target 填最终选定接收者的真实座位号，必须存活且不能是自己；不分阵营。例：最终决定交给3号，就提交 {"target":3}（目标以当前可移交名单为准）；决定撕毁，就提交 {"target":null}。提交前核对 target 与本次最终决定一致。只执行参数中的目标，不按思考文字执行。其他阶段不要调用。',
      params: [seatParam('target', '移交给', seats, '撕毁警徽')],
    },
  ];
}

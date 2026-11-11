import { gameText, localizeTool } from '@werewolf/protocol';
import type { Seat, ToolSpec } from '@werewolf/protocol';
import { expandActionTools } from '@werewolf/protocol';
import { seatParam, textParam } from './tools';
import { getRole } from './registry';
import type { GameState } from './types';
import { getAbility } from './abilities';

/**
 * 每个座位整局使用的工具。名称、顺序和参数结构只由身份与开局规则决定，不随阶段、存活或药品变化。
 * 当前阶段能不能用，由引擎在提交时判断。
 */
export function seatTools(state: GameState, seat: Seat): ToolSpec[] {
  const player = state.players[seat - 1];
  if (!player) return [];
  const seats = state.players.map((p) => p.seat);
  const v = state.rules.values;
  const tools: ToolSpec[] = [speakTool(state.rules.locale), voteTool(seats, v['vote.allowAbstain'] === true, state.rules.locale)];
  if (v['sheriff.enabled'] === true) tools.push(...sheriffTools(seats, v['vote.allowAbstain'] === true, (state.rules.electionVersion ?? 1) >= 3, state.rules.locale));
  tools.push(...(getRole(player.role).tools?.({ seats, seat, rules: state.rules }) ?? []));
  for (const id of getRole(player.role).abilityCatalog ?? []) {
    for (const tool of getAbility(id).catalog?.({ seats, seat, rules: state.rules }) ?? []) {
      const existing = tools.find((t) => t.name === tool.name);
      if (existing && JSON.stringify(existing) !== JSON.stringify(tool)) throw new Error(`能力工具定义冲突：${tool.name}`);
      if (!existing) tools.push(tool);
    }
  }
  if (new Set(tools.map((t) => t.name)).size !== tools.length) throw new Error(gameText(state.rules.locale, "身份 {0} 的工具名称重复", player.role));
  return expandActionTools(tools, state.rules).map((tool) => localizeTool(tool, state.rules.locale));
}

function speakTool(locale: string | undefined = 'zh-CN'): ToolSpec {
  return {
    name: 'speak',
    title: gameText(locale, "发言"),
    description:
      gameText(locale, "公开发言并结束本段发言。content 为非空发言内容；例：{\"content\":\"我认为3号可疑。\"}。"),
    params: [textParam('content', gameText(locale, "发言内容"), 1, undefined)],
  };
}

function voteTool(seats: Seat[], abstain: boolean, locale: string | undefined = 'zh-CN'): ToolSpec {
  return {
    name: 'vote',
    title: gameText(locale, "放逐投票"),
    description:
      gameText(locale, "投票放逐目标。target 为目标座位号，{0}例：{\"target\":3}。", abstain ? gameText(locale, "null 表示弃票；") : gameText(locale, "请填写座位号；")),
    params: [seatParam('target', gameText(locale, "放逐目标"), seats, abstain ? gameText(locale, "弃票") : undefined)],
  };
}

function sheriffTools(seats: Seat[], abstain: boolean, lateWithdrawal: boolean, locale: string | undefined = 'zh-CN'): ToolSpec[] {
  return [
    {
      name: 'sheriff_signup',
      title: gameText(locale, "上警"),
      description: gameText(locale, "提交警长竞选报名选择。run 为布尔值，true 表示上警，false 表示不上警；例：{\"run\":true}。"),
      params: [{ kind: 'boolean', name: 'run', label: gameText(locale, "是否上警"), trueLabel: gameText(locale, "上警"), falseLabel: gameText(locale, "不上警") }],
    },
    {
      name: 'sheriff_withdraw',
      title: gameText(locale, "退水"),
      description: gameText(locale, "退出警长竞选。content 填退水发言或空字符串；例：{\"content\":\"\"}。"),
      params: [textParam('content', gameText(locale, "退水时的发言（可留空）"), 0, undefined)],
    },
    ...(lateWithdrawal ? [{
      name: 'sheriff_stay', title: gameText(locale, "继续竞选"),
      description: gameText(locale, "确认继续参加警长竞选。无参数，填写 {}。"),
      params: [],
    }] : []),
    {
      name: 'sheriff_vote',
      title: gameText(locale, "警长投票"),
      description: gameText(locale, "投票选择警长候选人。target 为候选人座位号，{0}例：{\"target\":3}。", abstain ? gameText(locale, "null 表示弃票；") : gameText(locale, "请填写座位号；")),
      params: [seatParam('target', gameText(locale, "投给"), seats, abstain ? gameText(locale, "弃票") : undefined)],
    },
    {
      name: 'set_speak_direction',
      title: gameText(locale, "选择发言方向"),
      description:
        gameText(locale, "选择发言方向。direction 填 clockwise（顺时针）或 counterclockwise（逆时针）；例：{\"direction\":\"clockwise\"}。"),
      params: [
        {
          kind: 'choice',
          name: 'direction',
          label: gameText(locale, "发言方向"),
          options: [
            { value: 'clockwise', label: gameText(locale, "顺时针（号码增大）") },
            { value: 'counterclockwise', label: gameText(locale, "逆时针（号码减小）") },
          ],
        },
      ],
    },
    {
      name: 'badge_dispose',
      title: gameText(locale, "处理警徽"),
      description: gameText(locale, "移交或撕毁警徽。target 为接收者座位号，null 表示撕毁；例：{\"target\":3} 或 {\"target\":null}。"),
      params: [seatParam('target', gameText(locale, "移交给"), seats, gameText(locale, "撕毁警徽"))],
    },
  ];
}

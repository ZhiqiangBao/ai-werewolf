import type { ParamSpec, Seat, ToolCall, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from './context';
import type { RuleError } from './types';

export const err = (code: string, reason: string): RuleError => ({ code, reason });

export const seatParam = (
  name: string,
  label: string,
  options: Seat[],
  nullLabel?: string,
): ParamSpec => ({
  kind: 'seat',
  name,
  label,
  options: [...options].sort((a, b) => a - b),
  ...(nullLabel ? { nullable: true, nullLabel } : {}),
});

export const textParam = (name: string, label: string, minLength: number, maxLength: number): ParamSpec => ({
  kind: 'text',
  name,
  label,
  minLength,
  maxLength,
});

export const SPEECH_LIMIT = 400;

export const speakTool = (what: string): ToolSpec => ({
  name: 'speak',
  title: '发言',
  description: `${what}。内容会公开给所有人，1–${SPEECH_LIMIT} 字。`,
  params: [textParam('content', '发言内容', 1, SPEECH_LIMIT)],
});

export const explodeTool: ToolSpec = {
  name: 'wolf_explode',
  title: '自爆',
  description: '立刻自爆出局并公开狼人身份。当天剩余发言、竞选和投票取消，发表遗言后直接进入黑夜。',
  params: [],
};

/** 通用参数校验。身份或步骤自己的 validate 先执行，用来给出更具体的错误码。 */
export function validateArgs(ctx: Ctx, spec: ToolSpec, args: Record<string, unknown>, seat: Seat): RuleError | null {
  for (const p of spec.params) {
    const v = args[p.name];
    switch (p.kind) {
      case 'seat': {
        if (v === null || v === undefined) {
          if (p.nullable) break;
          return err('INVALID_ARGUMENT', `缺少参数「${p.label}」`);
        }
        if (typeof v !== 'number' || !Number.isInteger(v)) return err('INVALID_ARGUMENT', `「${p.label}」必须是座位号`);
        if (v < 1 || v > ctx.playerCount) return err('TARGET_NOT_IN_GAME', `没有 ${v} 号座位`);
        if (!p.options.includes(v)) {
          if (!ctx.isAlive(v)) return err('TARGET_DEAD', `${v}号已经出局`);
          if (v === seat) return err('TARGET_SELF_FORBIDDEN', '这个行动不能选择自己');
          return err('INVALID_ARGUMENT', `${v}号不是「${p.label}」的可选目标`);
        }
        break;
      }
      case 'seats': {
        if (!Array.isArray(v)) return err('INVALID_ARGUMENT', `「${p.label}」必须是座位号列表`);
        if (v.length < p.min || v.length > p.max) return err('INVALID_ARGUMENT', `「${p.label}」需要选择 ${p.min}–${p.max} 个座位`);
        if (new Set(v).size !== v.length) return err('INVALID_ARGUMENT', `「${p.label}」不能重复`);
        for (const x of v) if (!p.options.includes(x as number)) return err('INVALID_ARGUMENT', `${x}号不是可选目标`);
        break;
      }
      case 'boolean':
        if (v !== undefined && typeof v !== 'boolean') return err('INVALID_ARGUMENT', `「${p.label}」必须是 true 或 false`);
        break;
      case 'text': {
        if (typeof v !== 'string') {
          if (p.minLength === 0 && (v === undefined || v === null)) break;
          return err('INVALID_ARGUMENT', `缺少参数「${p.label}」`);
        }
        const len = [...v.trim()].length;
        if (len < p.minLength) return err('INVALID_ARGUMENT', `「${p.label}」不能为空`);
        if (len > p.maxLength) return err('INVALID_ARGUMENT', `「${p.label}」不能超过 ${p.maxLength} 字（当前 ${len} 字）`);
        break;
      }
      case 'choice':
        if (!p.options.some((o) => o.value === v)) {
          return err('INVALID_ARGUMENT', `「${p.label}」只能是：${p.options.map((o) => o.value).join(' / ')}`);
        }
        break;
    }
  }
  return null;
}

/** 补齐缺省值：布尔默认 false，可空座位默认 null，文本去掉首尾空白。只保留声明过的参数。 */
export function normalizeCall(spec: ToolSpec, call: ToolCall): ToolCall {
  const args: Record<string, unknown> = {};
  for (const p of spec.params) {
    const v = call.args?.[p.name];
    switch (p.kind) {
      case 'boolean':
        args[p.name] = v === true;
        break;
      case 'seat':
        args[p.name] = v === undefined ? null : v;
        break;
      case 'text':
        args[p.name] = typeof v === 'string' ? v.trim() : '';
        break;
      default:
        args[p.name] = v;
    }
  }
  return { tool: call.tool, args };
}

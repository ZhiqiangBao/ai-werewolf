import type { BooleanParam, ChoiceParam, ParamSpec, Seat, SeatParam, SeatsParam, TextParam, ToolCall, ToolSpec } from '@werewolf/protocol';
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

export const textParam = (name: string, label: string, minLength: number, maxLength?: number): ParamSpec => ({
  kind: 'text',
  name,
  label,
  minLength,
  ...(maxLength === undefined ? {} : { maxLength }),
});

export const speakTool = (what: string): ToolSpec => ({
  name: 'speak',
  title: '发言',
  description: `${what}。内容会公开给所有人。`,
  params: [textParam('content', '发言内容', 1)],
});

export const explodeTool: ToolSpec = {
  name: 'wolf_explode',
  title: '自爆',
  description: '立刻自爆出局并公开狼人身份。当天剩余发言、竞选和投票取消，发表遗言后直接进入黑夜。',
  params: [],
};

const FULLWIDTH_DIGITS = /[０-９]/g;

/** 把模型常返回的字符串收成整数。收不成时原样返回，交给后面的规则校验拒绝。 */
function coerceSeat(p: SeatParam, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : v;
  if (typeof v !== 'string') return v;
  const raw = v
    .trim()
    .replace(FULLWIDTH_DIGITS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (p.nullable && (raw === '' || /^(null|none|nil)$/i.test(raw) || raw === p.nullLabel)) return null;
  const matched = raw.match(/^(?:座位|玩家)?\s*(\d+)\s*(?:号位|号玩家|号)?$/);
  if (!matched) return v;
  return Number(matched[1]);
}

function coerceSeats(p: SeatsParam, v: unknown): unknown {
  const items = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v
          .split(/[、,，\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      : null;
  if (!items) return v;
  const probe: SeatParam = { kind: 'seat', name: p.name, label: p.label, options: p.options };
  return items.map((item) => coerceSeat(probe, item));
}

function coerceBoolean(p: BooleanParam, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v !== 'string') return v;
  const raw = v.trim();
  const low = raw.toLowerCase();
  if (low === 'true' || low === 'yes' || raw === '是' || raw === p.trueLabel) return true;
  if (low === 'false' || low === 'no' || raw === '否' || raw === p.falseLabel) return false;
  return v;
}

function coerceChoice(p: ChoiceParam, v: unknown): unknown {
  const raw = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
  if (raw === null) return v;
  const hit = p.options.find((o) => o.value === raw || o.label === raw);
  return hit ? hit.value : v;
}

function coerceText(p: TextParam, v: unknown): unknown {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (p.minLength === 0 && (v === undefined || v === null)) return '';
  return v;
}

/** 按工具声明收参数：座位号、布尔、选项和文本都收成校验和结算用的类型。只保留声明过的参数。 */
export function normalizeCall(spec: ToolSpec, call: ToolCall): ToolCall {
  const args: Record<string, unknown> = {};
  for (const p of spec.params) {
    const v = call.args?.[p.name];
    switch (p.kind) {
      case 'seat':
        args[p.name] = coerceSeat(p, v);
        break;
      case 'seats':
        args[p.name] = coerceSeats(p, v);
        break;
      case 'boolean':
        args[p.name] = coerceBoolean(p, v);
        break;
      case 'choice':
        args[p.name] = coerceChoice(p, v);
        break;
      case 'text':
        args[p.name] = coerceText(p, v);
        break;
    }
  }
  return { tool: call.tool, args };
}

/** 通用参数校验。调用前先 normalizeCall，身份或步骤自己的 validate 再给出更具体的错误码。 */
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
        for (const x of v) {
          if (typeof x !== 'number' || !Number.isInteger(x)) return err('INVALID_ARGUMENT', `「${p.label}」必须是座位号`);
          if (!p.options.includes(x)) return err('INVALID_ARGUMENT', `${x}号不是可选目标`);
        }
        break;
      }
      case 'boolean':
        if (typeof v !== 'boolean') return err('INVALID_ARGUMENT', `「${p.label}」必须是 true 或 false`);
        break;
      case 'text': {
        if (typeof v !== 'string') return err('INVALID_ARGUMENT', `缺少参数「${p.label}」`);
        const len = [...v].length;
        if (len < p.minLength) return err('INVALID_ARGUMENT', `「${p.label}」不能为空`);
        if (p.maxLength !== undefined && len > p.maxLength) {
          return err('INVALID_ARGUMENT', `「${p.label}」不能超过 ${p.maxLength} 字（当前 ${len} 字）`);
        }
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

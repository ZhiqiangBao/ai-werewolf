import { gameText } from './locale';
import type { ParamSpec, RuleSet, ToolCall, ToolSpec } from './index';

function operation(base: ToolSpec, name: string, title: string, description: string, constants: Record<string, unknown>, mappings: Record<string, string> = {}, locale: string | undefined = 'zh-CN'): ToolSpec {
  const params: ParamSpec[] = Object.entries(mappings).map(([name, source]) => {
    const param = base.params.find((p) => p.name === source);
    if (!param) throw new Error(gameText(locale, "动作 {0} 缺少来源参数 {1}", name, source));
    if (param.kind === 'seat') { const { nullable: _null, nullLabel: _label, ...rest } = param; return { ...rest, name }; }
    return { ...param, name };
  });
  return { name, title, description, params, operation: { tool: base.name, constants, parameters: mappings } };
}

/** 一个模型工具表示一个明确动作。阶段和资源只裁剪本轮菜单，不改整局固定目录。 */
export function expandActionTools(tools: ToolSpec[], rules: RuleSet): ToolSpec[] {
  if (rules.toolsetVersion !== 2) return tools;
  const out = tools.flatMap((tool): ToolSpec[] => {
    if (tool.operation) return [tool];
    if (tool.name === 'witch_act') {
      const canSave = tool.params.some((p) => p.name === 'save');
      const canSelectSave = tool.params.some((p) => p.kind === 'seat' && p.name === 'saveTarget' && p.options.length > 0);
      const noSave = canSelectSave ? { saveTarget: null } : { save: false };
      const poison = tool.params.find((p) => p.name === 'poisonTarget');
      const canPoison = poison?.kind === 'seat' && poison.options.length > 0;
      return [
        ...(canSave ? [operation(tool, 'witch_save', gameText(rules.locale, "使用解药救刀口"), gameText(rules.locale, "使用解药救当晚刀口。无参数，填写 {}。"), { save: true, poisonTarget: null }, undefined, rules.locale)] : []),
        ...(canSelectSave ? [operation(tool, 'witch_save', gameText(rules.locale, "使用解药"), gameText(rules.locale, "对 targetSeat 使用解药。填写目标座位号，例如 {\"targetSeat\":3}。"), { poisonTarget: null }, { targetSeat: 'saveTarget' }, rules.locale)] : []),
        ...(canPoison ? [operation(tool, 'witch_poison', gameText(rules.locale, "使用毒药"), gameText(rules.locale, "对 targetSeat 使用毒药。填写目标座位号，例如 {\"targetSeat\":3}。"), noSave, { targetSeat: 'poisonTarget' }, rules.locale)] : []),
        operation(tool, 'witch_skip', gameText(rules.locale, "本夜不用药"), gameText(rules.locale, "本夜不用解药和毒药。无参数，填写 {}。"), { ...noSave, poisonTarget: null }, undefined, rules.locale),
        ...(canSave && canPoison && rules.values['witch.bothPotionsSameNight'] === true ? [operation(tool, 'witch_save_and_poison', gameText(rules.locale, "同时救刀口并用毒药"), gameText(rules.locale, "使用解药救当晚刀口，并对 targetSeat 使用毒药。填写毒药目标座位号，例如 {\"targetSeat\":3}。"), { save: true }, { targetSeat: 'poisonTarget' }, rules.locale)] : []),
        ...(canSelectSave && canPoison && rules.values['witch.bothPotionsSameNight'] === true ? [operation(tool, 'witch_save_and_poison', gameText(rules.locale, "同时使用解药和毒药"), gameText(rules.locale, "对 saveTargetSeat 使用解药，对 targetSeat 使用毒药。填写目标座位号，例如 {\"saveTargetSeat\":3,\"targetSeat\":4}。"), {}, { saveTargetSeat: 'saveTarget', targetSeat: 'poisonTarget' }, rules.locale)] : []),
      ];
    }
    if (tool.name === 'sheriff_signup') return [
      operation(tool, 'sheriff_signup', gameText(rules.locale, "上警参选"), gameText(rules.locale, "报名竞选警长。无参数，填写 {}。"), { run: true }, undefined, rules.locale),
      operation(tool, 'sheriff_stay_off', gameText(rules.locale, "不上警"), gameText(rules.locale, "不报名竞选警长。无参数，填写 {}。"), { run: false }, undefined, rules.locale),
    ];
    if (tool.name === 'wolf_explode_decision') return [
      operation(tool, 'wolf_explode', gameText(rules.locale, "立即自爆"), gameText(rules.locale, "自爆并公开狼人身份。无参数，填写 {}。"), { explode: true }, undefined, rules.locale),
      operation(tool, 'wolf_decline_explode', gameText(rules.locale, "本次不自爆"), gameText(rules.locale, "本次不自爆。无参数，填写 {}。"), { explode: false }, undefined, rules.locale),
    ];
    if (tool.name === 'wolf_explode') return [{ ...tool, description: gameText(rules.locale, "自爆并公开狼人身份。无参数，填写 {}。") }];
    if (tool.name === 'mirror_inspect') {
      const target = tool.params.find((p) => p.name === 'targetSeat');
      if (!target || target.kind !== 'seat' || !target.nullable) return [tool];
      return [operation(tool, 'mirror_inspect', tool.title, tool.description, {}, { targetSeat: 'targetSeat' }, rules.locale),
        operation(tool, 'mirror_skip', gameText(rules.locale, '本夜不查验'), gameText(rules.locale, '本夜不查验。无参数，填写 {}。'), { targetSeat: null }, undefined, rules.locale)];
    }
    const targets: Record<string, [string, string, string, string, string, string]> = {
      vote: ['vote', gameText(rules.locale, "投票放逐"), 'targetSeat', 'vote_abstain', gameText(rules.locale, "放逐弃票"), gameText(rules.locale, "投票选择放逐目标")],
      sheriff_vote: ['sheriff_vote', gameText(rules.locale, "投票选警长"), 'candidateSeat', 'sheriff_abstain', gameText(rules.locale, "警长竞选弃票"), gameText(rules.locale, "投票选择警长候选人")],
      badge_dispose: ['badge_transfer', gameText(rules.locale, "移交警徽"), 'recipientSeat', 'badge_tear', gameText(rules.locale, "撕毁警徽"), gameText(rules.locale, "将警徽移交给目标")],
      guard_protect: ['guard_protect', gameText(rules.locale, "守护玩家"), 'targetSeat', 'guard_skip', gameText(rules.locale, "本夜空守"), gameText(rules.locale, "守护指定目标")],
      hunter_shoot: ['hunter_shoot', gameText(rules.locale, "开枪带走玩家"), 'targetSeat', 'hunter_hold_fire', gameText(rules.locale, "放弃开枪"), gameText(rules.locale, "开枪带走目标")],
      wolf_kill: ['wolf_kill', gameText(rules.locale, "提交狼刀目标"), 'targetSeat', 'wolf_empty_kill', gameText(rules.locale, "提交空刀"), gameText(rules.locale, "提交今晚的狼刀目标")],
      seer_inspect: ['seer_inspect', gameText(rules.locale, "查验阵营"), 'targetSeat', 'seer_skip', gameText(rules.locale, '本夜不查验'), gameText(rules.locale, "查验目标的阵营")],
    };
    const kind = targets[tool.name];
    if (!kind) return [tool];
    const p = tool.params.find((p) => p.name === 'target');
    if (!p || p.kind !== 'seat') throw new Error(gameText(rules.locale, "{0} 缺少座位参数", tool.name));
    const [name, title, field, skip, skipTitle, effect] = kind;
    const skipEffect: Record<string, string> = {
      vote: gameText(rules.locale, "本轮放逐投票弃票。"),
      sheriff_vote: gameText(rules.locale, "本轮警长竞选投票弃票。"),
      badge_dispose: gameText(rules.locale, "撕毁警徽。"),
      guard_protect: gameText(rules.locale, "今晚不守护。"),
      hunter_shoot: gameText(rules.locale, "放弃本次开枪。"),
      wolf_kill: gameText(rules.locale, "提交空刀。"),
      seer_inspect: gameText(rules.locale, '本夜不查验。'),
    };
    return [
      ...(p.options.length ? [operation(tool, name, title, gameText(rules.locale, "{0}。{1} 填目标座位号，例如 {2}。", effect, field, JSON.stringify({ [field]: 3 })), {}, { [field]: 'target' }, rules.locale)] : []),
      ...(p.nullable && skip ? [operation(tool, skip, skipTitle, gameText(rules.locale, "{0}无参数，填写 {}。", skipEffect[tool.name]), { target: null }, undefined, rules.locale)] : []),
    ];
  });
  // 直接自爆与「是否自爆」询问共用同一个明确的正向工具。模型可见 Schema 一致。
  return out.filter((tool, i) => {
    const previous = out.find((other, index) => index < i && other.name === tool.name);
    if (!previous) return true;
    if (tool.name === 'wolf_explode' && !previous.operation && tool.operation?.tool === 'wolf_explode_decision') return false;
    throw new Error(gameText(rules.locale, "动作工具名称重复：{0}", tool.name));
  });
}

/** 仅按声明的动作和参数转换，不读取思考，也不替模型修正目标。 */
export function canonicalAction(spec: ToolSpec, call: ToolCall): ToolCall {
  if (!spec.operation) return call;
  return { tool: spec.operation.tool, args: { ...spec.operation.constants, ...Object.fromEntries(Object.entries(spec.operation.parameters).map(([name, source]) => [source, call.args[name]])) } };
}

/** 模拟玩家复用既有策略；这层不用于任何真实模型请求。 */
export function simulationTools(tools: ToolSpec[]): ToolSpec[] {
  const groups = new Map<string, ToolSpec>();
  for (const tool of tools) {
    if (!tool.operation) { groups.set(tool.name, tool); continue; }
    const op = tool.operation;
    const base = groups.get(op.tool) ?? { name: op.tool, title: tool.title, description: tool.description, params: [] };
    for (const p of tool.params) {
      const name = op.parameters[p.name] ?? p.name;
      const existing = base.params.find((q) => q.name === name);
      if (!existing) base.params.push({ ...p, name });
      else if (existing.kind === 'seat' && p.kind === 'seat') existing.options = [...new Set([...existing.options, ...p.options])];
    }
    for (const [name, value] of Object.entries(op.constants)) {
      if (value === true && !base.params.some((p) => p.name === name)) base.params.push({ kind: 'boolean', name, label: name });
      if (value === null) {
        let p = base.params.find((p) => p.name === name);
        if (!p) { p = { kind: 'seat', name, label: name, options: [] }; base.params.push(p); }
        if (p.kind === 'seat') { p.nullable = true; p.nullLabel = tool.title; }
      }
    }
    groups.set(op.tool, base);
  }
  return [...groups.values()];
}

export function exposeAction(call: ToolCall, tools: ToolSpec[], locale: string | undefined = 'zh-CN'): ToolCall {
  for (const spec of tools) {
    if (!spec.operation) { if (spec.name === call.tool) return call; continue; }
    const op = spec.operation;
    if (op.tool !== call.tool || !Object.entries(op.constants).every(([k, value]) => (call.args[k] ?? (value === false ? false : null)) === value)) continue;
    const args = Object.fromEntries(Object.entries(op.parameters).map(([name, source]) => [name, call.args[source]]));
    if (spec.params.some((p) => p.kind === 'seat' && (typeof args[p.name] !== 'number' || !p.options.includes(args[p.name] as number)))) continue;
    return { tool: spec.name, args };
  }
  throw new Error(gameText(locale, "模拟行动 {0} 无法映射到本轮工具", call.tool));
}

/** 最新法官消息列出实际可调用工具及本轮参数，而不是泛泛地说“可以用工具”。 */
export function actionMenu(tools: ToolSpec[], locale: string | undefined = 'zh-CN'): string {
  if (!tools.length) return '';
  return gameText(locale, "本轮只能从以下工具中选择一个调用：\n") + tools.map((tool) => {
    const params = tool.params.map((p) => p.kind === 'seat' ? gameText(locale, (tool.name === 'witch_poison' && p.name === 'targetSeat') || (tool.name === 'witch_act' && p.name === 'poisonTarget') ? "{0}=整数座位号；本轮可选择的毒药目标：{1}{2}" : "{0}=整数座位号；可选：{1}{2}", p.name, p.options.join('、'), p.nullable ? `；null=${p.nullLabel}` : '') : p.kind === 'boolean' ? `${p.name}：true=${p.trueLabel ?? gameText(locale, "是")}，false=${p.falseLabel ?? gameText(locale, "否")}` : p.kind === 'choice' ? `${p.name}：${p.options.map((o) => `${o.value}=${o.label}`).join('；')}` : p.kind === 'text' ? gameText(locale, "{0}=字符串{1}", p.name, p.minLength ? gameText(locale, "，不能为空") : gameText(locale, "，可以留空")) : gameText(locale, "{0}=座位号数组", p.name)).join('；');
    const saveTarget = tool.params.find((p) => p.kind === 'seat' && p.name === 'saveTarget');
    const legacyWitch = tool.name === 'witch_act'
      ? gameText(locale, "{0}不用药：{1}。毒药只在决定毒人时填写目标，不要把救人目标填进 poisonTarget。",
        saveTarget?.kind === 'seat' ? gameText(locale, "只用解药：{0}；", JSON.stringify(Object.fromEntries(tool.params.map((p) => [p.name, p.name === 'saveTarget' ? saveTarget.options[0] : null]))))
          : tool.params.some((p) => p.name === 'save') ? gameText(locale, "只救刀口：{0}；", JSON.stringify(Object.fromEntries(tool.params.map((p) => [p.name, p.name === 'save' ? true : null])))) : '',
        JSON.stringify(Object.fromEntries(tool.params.map((p) => [p.name, p.name === 'save' ? false : null]))))
      : '';
    return `- ${tool.name}：${tool.title}。${params || gameText(locale, "无参数，填写 {}。")}${legacyWitch}`;
  }).join('\n');
}

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
        ...(canSave ? [operation(tool, 'witch_save', gameText(rules.locale, "使用解药救刀口"), gameText(rules.locale, "对法官告知的当夜刀口使用解药；目标由法官确定，不需要填写座位号。只消耗解药，不使用毒药，最终效果按夜间规则结算。仅在法官本轮列为可用时调用，填写 {}。"), { save: true, poisonTarget: null }, undefined, rules.locale)] : []),
        ...(canSelectSave ? [operation(tool, 'witch_save', gameText(rules.locale, "使用解药"), gameText(rules.locale, "targetSeat 填本轮法官列出的一个受袭玩家座位号。只消耗解药，不使用毒药。"), { poisonTarget: null }, { targetSeat: 'saveTarget' }, rules.locale)] : []),
        ...(canPoison ? [operation(tool, 'witch_poison', gameText(rules.locale, "使用毒药"), gameText(rules.locale, "对目标玩家使用毒药。targetSeat 填其他存活玩家的整数座位号；这是毒人，不是救人。只消耗毒药，不使用解药，最终效果按夜间规则结算。例：{\"targetSeat\":3}；目标以本轮法官菜单为准。"), noSave, { targetSeat: 'poisonTarget' }, rules.locale)] : []),
        operation(tool, 'witch_skip', gameText(rules.locale, "本夜不用药"), gameText(rules.locale, "明确选择今晚既不用解药，也不用毒药，保留剩余药品。没有参数，填写 {}。"), { ...noSave, poisonTarget: null }, undefined, rules.locale),
        ...(canSave && canPoison && rules.values['witch.bothPotionsSameNight'] === true ? [operation(tool, 'witch_save_and_poison', gameText(rules.locale, "同时救刀口并用毒药"), gameText(rules.locale, "仅本局允许同夜双药且两瓶药可用时调用：解药救法官告知的刀口，同时对 targetSeat 使用毒药。一次消耗两瓶药。例：{\"targetSeat\":3}；目标以本轮法官菜单为准。"), { save: true }, { targetSeat: 'poisonTarget' }, rules.locale)] : []),
        ...(canSelectSave && canPoison && rules.values['witch.bothPotionsSameNight'] === true ? [operation(tool, 'witch_save_and_poison', gameText(rules.locale, "同时使用解药和毒药"), gameText(rules.locale, "saveTargetSeat 填本轮法官列出的一个受袭玩家座位号，targetSeat 填毒药目标。一次消耗两瓶药。"), {}, { saveTargetSeat: 'saveTarget', targetSeat: 'poisonTarget' }, rules.locale)] : []),
      ];
    }
    if (tool.name === 'sheriff_signup') return [
      operation(tool, 'sheriff_signup', gameText(rules.locale, "上警参选"), gameText(rules.locale, "明确选择报名竞选警长。仅法官询问是否上警时使用。没有参数，填写 {}。"), { run: true }, undefined, rules.locale),
      operation(tool, 'sheriff_stay_off', gameText(rules.locale, "不上警"), gameText(rules.locale, "明确选择不参加本次警长竞选。没有参数，填写 {}。已经上警后的退水由另一个轮次的 sheriff_withdraw 处理。"), { run: false }, undefined, rules.locale),
    ];
    if (tool.name === 'wolf_explode_decision') return [
      operation(tool, 'wolf_explode', gameText(rules.locale, "立即自爆"), gameText(rules.locale, "明确选择立即自爆出局，公开狼人身份并触发当天后续结算。仅本轮法官允许时使用。没有参数，填写 {}。"), { explode: true }, undefined, rules.locale),
      operation(tool, 'wolf_decline_explode', gameText(rules.locale, "本次不自爆"), gameText(rules.locale, "明确选择不在这次询问中自爆，保留身份并继续正常流程。没有参数，填写 {}。"), { explode: false }, undefined, rules.locale),
    ];
    if (tool.name === 'wolf_explode') return [{ ...tool, description: gameText(rules.locale, "明确选择立即自爆出局，公开狼人身份并触发当天后续结算。仅本轮法官允许时使用。没有参数，填写 {}。") }];
    const targets: Record<string, [string, string, string, string, string, string]> = {
      vote: ['vote', gameText(rules.locale, "投票放逐"), 'targetSeat', 'vote_abstain', gameText(rules.locale, "放逐弃票"), gameText(rules.locale, "放逐一名玩家；PK 时必须选本轮 PK 名单中的目标")],
      sheriff_vote: ['sheriff_vote', gameText(rules.locale, "投票选警长"), 'candidateSeat', 'sheriff_abstain', gameText(rules.locale, "警长竞选弃票"), gameText(rules.locale, "从本轮候选人中选出警长")],
      badge_dispose: ['badge_transfer', gameText(rules.locale, "移交警徽"), 'recipientSeat', 'badge_tear', gameText(rules.locale, "撕毁警徽"), gameText(rules.locale, "将警徽交给一名其他存活玩家，不分阵营")],
      guard_protect: ['guard_protect', gameText(rules.locale, "守护玩家"), 'targetSeat', 'guard_skip', gameText(rules.locale, "本夜空守"), gameText(rules.locale, "选择本夜守护的存活玩家，保护效果按夜间规则结算；自守和连续守护限制见本轮提示")],
      hunter_shoot: ['hunter_shoot', gameText(rules.locale, "开枪带走玩家"), 'targetSeat', 'hunter_hold_fire', gameText(rules.locale, "放弃开枪"), gameText(rules.locale, "开枪带走一名其他存活玩家并公开猎人身份")],
      wolf_kill: ['wolf_kill', gameText(rules.locale, "提交狼刀目标"), 'targetSeat', 'wolf_empty_kill', gameText(rules.locale, "提交空刀"), gameText(rules.locale, "提交一名存活玩家作为今晚狼刀目标；是否可以自刀以本局规则为准")],
      seer_inspect: ['seer_inspect', gameText(rules.locale, "查验阵营"), 'targetSeat', '', '', gameText(rules.locale, "查验一名其他存活玩家，返回好人或狼人的查验结果，不返回具体身份；结果仅自己可见，可以重复查验")],
    };
    const kind = targets[tool.name];
    if (!kind) return [tool];
    const p = tool.params.find((p) => p.name === 'target');
    if (!p || p.kind !== 'seat') throw new Error(gameText(rules.locale, "{0} 缺少座位参数", tool.name));
    const [name, title, field, skip, skipTitle, effect] = kind;
    const skipEffect: Record<string, string> = {
      vote: gameText(rules.locale, "本轮放逐投票弃票，不给任何玩家增加票数。"),
      sheriff_vote: gameText(rules.locale, "本轮警长竞选投票弃票，不给任何候选人增加票数。"),
      badge_dispose: gameText(rules.locale, "撕毁警徽，不移交给任何人；本局之后不再产生警长。"),
      guard_protect: gameText(rules.locale, "今晚不守护任何玩家；下一晚不再受本晚目标的连续守护限制。"),
      hunter_shoot: gameText(rules.locale, "放弃本次开枪，不带走任何玩家；是否公开身份按本局规则结算。"),
      wolf_kill: gameText(rules.locale, "只将你自己的落刀提交为空刀，不给任何目标增加票数。其他狼人提交的有效目标仍可能成为当夜刀口；只有全部狼人空刀时整夜才空刀。"),
    };
    return [
      ...(p.options.length ? [operation(tool, name, title, gameText(rules.locale, "{0}。{1} 必须是最终选定玩家的真实整数座位号，不是候选列表下标，也不接受 null。例：{2}；实际目标以本轮法官菜单为准。仅本轮允许时使用。", effect, field, JSON.stringify({ [field]: 3 })), {}, { [field]: 'target' }, rules.locale)] : []),
      ...(p.nullable && skip ? [operation(tool, skip, skipTitle, gameText(rules.locale, "{0}没有参数，填写 {}。仅本轮法官允许时使用。", skipEffect[tool.name]), { target: null }, undefined, rules.locale)] : []),
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

import { gameText } from '@werewolf/protocol';
import type { RuleSet } from '@werewolf/protocol';
import { getRole, modulesIn } from './registry';
import type { RoleModule } from './types';

const CATEGORY_ORDER: Record<string, number> = { wolf: 0, villager: 1, god: 2 };

function composition(rules: RuleSet): string {
  const counts = new Map<string, number>();
  for (const r of rules.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, n]) => ({ mod: getRole(id), n }))
    .sort((a, b) => (CATEGORY_ORDER[a.mod.category] ?? 9) - (CATEGORY_ORDER[b.mod.category] ?? 9))
    .map(({ mod, n }) => (n > 1 ? `${gameText(rules.locale, mod.name)} ×${n}` : gameText(rules.locale, mod.name)))
    .join('、');
}

/** 公共规则卡：所有座位收到完全相同的文字，只由规则对象和身份模块生成。 */
export function buildRuleCard(rules: RuleSet): string {
  const v = rules.values;
  const mods = modulesIn(rules);
  const phaseOwner = new Map<string, RoleModule>();
  const phaseNames = new Map<string, string>();
  for (const m of mods) {
    if (m.nightPhase) { phaseOwner.set(m.nightPhase.id, m); phaseNames.set(m.nightPhase.id, gameText(rules.locale, m.name)); }
    for (const phase of m.nightPhases ?? []) { phaseOwner.set(phase.id, m); phaseNames.set(phase.id, gameText(rules.locale, phase.name)); }
  }
  const gods = mods.filter((m) => m.category === 'god').map((m) => gameText(rules.locale, m.name));
  const hasHunter = mods.some((m) => m.id === 'hunter');
  const canExplode = mods.some((m) => m.canExplode) && v['explode.enabled'] === true;
  const sheriff = v['sheriff.enabled'] === true;
  const resumeOrder = (rules.electionVersion ?? 1) >= 2
    ? gameText(rules.locale, "先确认是否再次自爆，再保留原报名、退水与投票轮次直接续投，不重新上警或竞选发言；警徽落地或狼人自爆后，才通报昨夜出局情况并处理出局职责。尚未公布的夜间受害者仍按当前警上资格参与，不提前排除。")
    : gameText(rules.locale, "先公布昨夜情况和处理出局职责，再保留原报名、退水与投票轮次直接续投，不重新上警或竞选发言。");
  const L: string[] = [];

  L.push(gameText(rules.locale, "【本局规则 · {0}】", rules.presetName));
  L.push(gameText(rules.locale, "一、配置与胜负"));
  L.push(gameText(rules.locale, "· 本局 {0} 人：{1}。配置公开，每个座位的身份随机发放、不公开。", rules.playerCount, composition(rules)));
  L.push(gameText(rules.locale, "· 阵营决定胜负，身份决定技能；好人包括平民和神职。查验表现、发言声称及警徽不改变真实身份或阵营。"));
  L.push(gameText(rules.locale, "· 已公布出局者不再参加常规行动或夜间技能，但仍须按法官许可处理遗言、死亡触发技能和警徽等职责。首夜出局在公布前的竞选资格按下文执行。"));
  L.push(
    v.winCondition === 'side'
      ? gameText(rules.locale, "· 好人阵营：所有狼人阵营成员出局即获胜。狼人阵营：所有平民出局，或所有神职（{0}）出局即获胜（屠边）。", gods.join('、'))
      : gameText(rules.locale, "· 好人阵营：所有狼人阵营成员出局即获胜。狼人阵营：所有好人出局即获胜（屠城）。"),
  );
  L.push(gameText(rules.locale, "· 先处理同批次出局技能及其引发的死亡连锁，再判定胜负；若双方获胜条件同时满足，优先判定好人阵营获胜。"));

  L.push(gameText(rules.locale, "二、夜晚"));
  L.push(gameText(rules.locale, "· 第 N 夜在第 N 天之前；夜间的「今晚」指本夜，第 N 天的「昨夜」指第 N 夜、「今晚」指第 N+1 夜。"));
  L.push(
    gameText(rules.locale, "· 夜间行动顺序：{0}。没有可行动者时跳过。", rules.nightOrder.map((id) => phaseNames.get(id) ?? id).join(' → ')),
  );
  L.push(gameText(rules.locale, "· 各阶段依次提交行动，全部夜间行动完成后统一结算攻击和保护；狼刀或毒药不会在行动阶段即时取消目标当夜尚未完成的行动。"));
  for (const mod of new Set(rules.nightOrder.map((id) => phaseOwner.get(id)))) {
    for (const line of mod?.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }
  L.push(gameText(rules.locale, "· 法官通报夜间出局名单或平安夜；通报前情况尚未公布，不代表平安。通报不公开死因或身份，规则要求公开时除外。"));

  const dayRoles = mods.filter((m) => !m.nightPhase && !m.nightPhases?.length && m.ruleCard);
  if (dayRoles.length) {
    L.push(gameText(rules.locale, "三、其他身份"));
    for (const m of dayRoles) for (const line of m.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }

  L.push(dayRoles.length ? gameText(rules.locale, "四、白天") : gameText(rules.locale, "三、白天"));
  if (sheriff) {
    const timing =
      v['sheriff.timing'] === 'before_announcement'
        ? gameText(rules.locale, "第 1 天先竞选，再公布昨夜出局；夜间出局者公布前仍可参与竞选，其资格不代表已确认存活。")
        : gameText(rules.locale, "第 1 天先公布昨夜出局、完成首夜遗言，再竞选警长。");
    const voters = v['sheriff.withdrawnCanVote']
      ? gameText(rules.locale, "未上警的玩家和退水的玩家投票")
      : gameText(rules.locale, "只有未上警的玩家投票（上过警的玩家包括退水者都不能投）");
    const explodeRule = !canExplode
      ? ''
      : v['sheriff.explodeInElection'] === 'postpone_vote'
        ? gameText(rules.locale, "首次竞选自爆后先公布昨夜情况、处理猎枪等出局职责，再由自爆者和有遗言资格的夜间出局者遗言，随后入夜。竞选延期至次日，{0}续投前存活狼人可再次选择自爆，再爆则警徽流失。已公布出局或退水者不能参选，原警下资格不重置；平票按 PK 规则处理。", resumeOrder)
      : v['sheriff.explodeInElection'] === 'postpone'
        ? gameText(rules.locale, "竞选尚未产生警长时有狼人自爆，竞选推迟到下一个白天（候选人不变）；再有自爆则警徽流失。")
        : gameText(rules.locale, "竞选尚未产生警长时有狼人自爆，警徽流失，本局没有警长。");
    L.push(
      gameText(rules.locale, "· 警长竞选：{0}存活玩家同时选择是否上警；无人上警或全员上警则本局没有警长，只有一名候选人时直接当选。", timing) +
        gameText(rules.locale, "候选人从随机起点、按随机方向依次竞选发言，发言时可以退水。") +
        (rules.electionVersion === 3 ? gameText(rules.locale, "普通竞选发言期间可在他人发言时退水，但不能插话或打断。发言结束后未退水者同时最终确认去留，确认不可修改、超时默认继续；确认完公布退水并投票。PK 和投票时不能退水。") : ''),
    );
    L.push(gameText(rules.locale, "· 警长投票：{0}，每人 1 票", voters) +
      gameText(rules.locale, "{0}；平票者 PK 发言后，除仍在平票台上的玩家外，其余存活玩家再投一次，再平则本局没有警长。", v['vote.allowAbstain'] ? gameText(rules.locale, "，可以弃票") : ''));
    if (explodeRule) L.push(gameText(rules.locale, "· 竞选自爆：{0}", explodeRule));
    L.push(gameText(rules.locale, "· 警徽：警长是竞选职务，任何阵营均可竞选，不代表阵营；放逐票记 1.5 票，选择白天发言方向并最后发言，可归票。出局时本人向存活玩家移交或撕毁警徽；移交不转移技能或私密记录。"));
  }
  const anchor =
    v['speech.anchor'] === 'knife_first' ? gameText(rules.locale, "狼刀出局者（刀口未出局时为其他出局者）") : gameText(rules.locale, "一名出局者（多人出局时随机取一名）");
  L.push(gameText(rules.locale, "· 每个白天的普通发言都在昨夜情况通报之后。") + (v['sheriff.explodeInElection'] === 'postpone_vote' ? (rules.electionVersion ?? 1) >= 2 ? gameText(rules.locale, "延期续选的警上环节优先于通报：先确认自爆并续投，警徽落地或自爆后再公布夜间出局。") : gameText(rules.locale, "延期直接续投警长时，也先通报昨夜情况再续投。") : ''));
  L.push(
    gameText(rules.locale, "· 发言顺序：{0}", sheriff ? gameText(rules.locale, "有警长时由警长选择顺时针（号码增大）或逆时针，从警长下一位存活玩家开始，警长最后发言。没有警长时，") : '') +
      gameText(rules.locale, "昨夜有人出局则从{0}的下一位开始；昨夜平安则由法官随机指定起点。无警长时，方向由法官随机决定并公布。", anchor),
  );
  L.push(
    gameText(rules.locale, "· 放逐投票：存活玩家同时投票，票齐后公开谁投了谁{0}{1}，超时未投记为弃票。", v['vote.allowSelf'] ? gameText(rules.locale, "，可以投自己") : gameText(rules.locale, "，不能投自己"), v['vote.allowAbstain'] ? gameText(rules.locale, "，可以弃票") : '') +
      gameText(rules.locale, "得票最高者出局；平票者 PK 发言，其余玩家在平票者中再投一次（PK 台上的玩家不能投票），再平则当天无人出局。"),
  );
  if (canExplode) {
    const window =
      v['explode.window'] === 'interrupt'
        ? gameText(rules.locale, "普通狼人可以在竞选发言、白天发言、PK 发言及非自爆结算的遗言期间随时自爆；自爆结算产生的遗言不开放再次自爆。")
        : v['explode.window'] === 'between_speeches'
          ? gameText(rules.locale, "每段发言（含竞选、PK 及非自爆结算的遗言）开始之前，存活普通狼人可以选择自爆；多人同时选择时由座位号最小者自爆，自爆结算产生的遗言不再询问自爆。")
          : gameText(rules.locale, "普通狼人只能在轮到自己发言（竞选、白天、PK 发言，不含遗言）时选择自爆。");
    L.push(
      gameText(rules.locale, "· 自爆：{0}投票进行中不能自爆。自爆者立刻出局并公开狼人身份；若是警长，先由他自己选择移交或撕毁警徽，再发表遗言。", window) +
        gameText(rules.locale, "当天剩余的发言、竞选和投票取消，随后进入黑夜。"),
    );
  }
  const has = (k: string) => (v[`lastWords.${k}`] ? gameText(rules.locale, "有") : gameText(rules.locale, "没有"));
  const words = [
    gameText(rules.locale, "第 1 夜出局{0}遗言", has('firstNight')),
    gameText(rules.locale, "第 2 夜起夜里出局{0}遗言", has('laterNight')),
    gameText(rules.locale, "被放逐{0}遗言", has('exile')),
  ];
  if (canExplode) words.push(gameText(rules.locale, "自爆{0}遗言", has('explode')));
  if (hasHunter) {
    words.push(
      gameText(rules.locale, "被猎人带走的人：猎人第 1 夜出局时{0}遗言，猎人第 2 夜起在夜里出局时{1}遗言，猎人被放逐时{2}遗言", has('shotAfterFirstNight'), has('shotAfterLaterNight'), has('shotAfterVote')),
    );
  }
  const explosionWords = v['sheriff.explodeInElection'] === 'postpone_vote' ? gameText(rules.locale, "警上自爆与尚未公布的夜间死亡合并处理时，自爆者先遗言，其余按座位号从小到大。") : '';
  L.push(gameText(rules.locale, "· 遗言：{0}。多人遗言按座位号从小到大。{1}胜负已分后不再发表遗言。", words.join('；'), explosionWords));

  L.push(dayRoles.length ? gameText(rules.locale, "五、其他") : gameText(rules.locale, "四、其他"));
  L.push(gameText(rules.locale, "· 发言里声称的身份，法官不证实也不否认。"));
  L.push(gameText(rules.locale, "· 游戏结束后复盘，公开每个座位的身份和每晚的行动。"));
  return L.join('\n');
}

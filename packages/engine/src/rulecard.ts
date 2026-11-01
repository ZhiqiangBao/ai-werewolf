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
    .map(({ mod, n }) => (n > 1 ? `${mod.name} ×${n}` : mod.name))
    .join('、');
}

/** 公共规则卡：所有座位收到完全相同的文字，只由规则对象和身份模块生成。 */
export function buildRuleCard(rules: RuleSet): string {
  const v = rules.values;
  const mods = modulesIn(rules);
  const phaseOwner = new Map<string, RoleModule>();
  const phaseNames = new Map<string, string>();
  for (const m of mods) {
    if (m.nightPhase) { phaseOwner.set(m.nightPhase.id, m); phaseNames.set(m.nightPhase.id, m.name); }
    for (const phase of m.nightPhases ?? []) { phaseOwner.set(phase.id, m); phaseNames.set(phase.id, phase.name); }
  }
  const gods = mods.filter((m) => m.category === 'god').map((m) => m.name);
  const hasHunter = mods.some((m) => m.id === 'hunter');
  const canExplode = mods.some((m) => m.canExplode) && v['explode.enabled'] === true;
  const sheriff = v['sheriff.enabled'] === true;
  const resumeOrder = (rules.electionVersion ?? 1) >= 2
    ? '先确认是否再次自爆，再保留原报名、退水与投票轮次直接续投，不重新上警或竞选发言；警徽落地或狼人自爆后，才通报昨夜出局情况并处理出局职责。尚未公布的夜间受害者仍按当前警上资格参与，不提前排除。'
    : '先公布昨夜情况和处理出局职责，再保留原报名、退水与投票轮次直接续投，不重新上警或竞选发言。';
  const L: string[] = [];

  L.push(`【本局规则 · ${rules.presetName}】`);
  L.push('一、配置与胜负');
  L.push(`· 本局 ${rules.playerCount} 人：${composition(rules)}。配置公开，每个座位的身份随机发放、不公开。`);
  L.push('· 阵营决定胜负归属，角色身份决定技能。「好人」包括平民和神职，「平民」是其中一种身份；查验表现、发言声称或是否持有警徽不改变真实身份和阵营。');
  L.push(
    v.winCondition === 'side'
      ? `· 好人阵营：所有狼人阵营成员出局即获胜。狼人阵营：所有平民出局，或所有神职（${gods.join('、')}）出局即获胜（屠边）。`
      : '· 好人阵营：所有狼人阵营成员出局即获胜。狼人阵营：所有好人出局即获胜（屠城）。',
  );
  L.push('· 先处理同批次出局技能及其引发的死亡连锁，再判定胜负；若双方获胜条件同时满足，优先判定好人阵营获胜。');

  L.push('二、夜晚');
  L.push('· 对局时间顺序：第1夜（第一晚）→ 第1天（第一个白天）→ 第2夜 → 第2天 → ……，直至对局结束；先过第N夜，再进入第N天。夜间说「本夜／今晚」指正在进行的这一夜；第N天说「昨夜」指第N夜，说「今晚／下一夜」指第N+1夜。');
  L.push(
    `· 夜间行动顺序：${rules.nightOrder.map((id) => phaseNames.get(id) ?? id).join(' → ')}。没有可行动者时跳过。`,
  );
  L.push('· 各阶段依次提交行动，全部夜间行动完成后统一结算攻击和保护；狼刀或毒药不会在行动阶段即时取消目标当夜尚未完成的行动。');
  for (const mod of new Set(rules.nightOrder.map((id) => phaseOwner.get(id)))) {
    for (const line of mod?.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }
  L.push('· 夜间出局情况由法官明确通报：有人出局时报出局名单，无人出局时明确宣布「昨夜平安，无人出局」。在法官公开通报前，夜间出局情况为「尚未公布」，未通报不代表平安夜。此通报不公布死因或身份；自爆或技能要求公开身份的情形按相应条款处理。');

  const dayRoles = mods.filter((m) => !m.nightPhase && !m.nightPhases?.length && m.ruleCard);
  if (dayRoles.length) {
    L.push('三、其他身份');
    for (const m of dayRoles) for (const line of m.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }

  L.push(dayRoles.length ? '四、白天' : '三、白天');
  if (sheriff) {
    const timing =
      v['sheriff.timing'] === 'before_announcement'
        ? '第 1 天天亮后先竞选警长，再公布昨夜出局；昨夜出局的人在公布之前照常参与竞选。公布前能够上警、发言或投票，只表示有当前阶段的参与资格，不表示该玩家已经确认存活。'
        : '第 1 天先公布昨夜出局、完成首夜遗言，再竞选警长。';
    const voters = v['sheriff.withdrawnCanVote']
      ? '未上警的玩家和退水的玩家投票'
      : '只有未上警的玩家投票（上过警的玩家包括退水者都不能投）';
    const explodeRule = !canExplode
      ? ''
      : v['sheriff.explodeInElection'] === 'postpone_vote'
        ? `首次竞选自爆后先公布尚未公布的昨夜情况，处理猎枪等出局职责，再由自爆者及按规则有遗言的夜间出局者发表遗言，随后入夜。竞选延期到下一白天，${resumeOrder}续投前存活狼人可确认是否再次自爆，再爆则警徽流失。已经公布出局或已经退水的候选人不能参选，原警下资格不因延期重置；平票仍按 PK 规则处理。`
      : v['sheriff.explodeInElection'] === 'postpone'
        ? '竞选尚未产生警长时有狼人自爆，竞选推迟到下一个白天（候选人不变）；再有自爆则警徽流失。'
        : '竞选尚未产生警长时有狼人自爆，警徽流失，本局没有警长。';
    L.push(
      `· 警长竞选：${timing}存活玩家同时选择是否上警；无人上警或全员上警则本局没有警长，只有一名候选人时直接当选。` +
        `候选人从随机起点、按随机方向依次竞选发言，发言时可以退水。` +
        (rules.electionVersion === 3 ? '普通竞选发言期间，候选人也可在其他人发言时退水，但不能附带发言或打断该段发言。全部竞选发言结束后，尚未退水者同时最终确认继续竞选或退水，确认后不能修改；全部确认后公布退水并开始投票，超时默认继续竞选。竞选 PK 和投票开始后不能退水。' : '') +
        `${voters}，每人 1 票` +
        `${v['vote.allowAbstain'] ? '，可以弃票' : ''}；平票者 PK 发言后，除仍在平票台上的玩家外，其余存活玩家再投一次，再平则本局没有警长。${explodeRule}`,
    );
    L.push('· 警徽：警长是附加职务，放逐票记 1.5 票；白天由警长选择发言方向并最后发言（可以归票）。警长出局时由本人把警徽移交给一名存活玩家，或撕毁警徽。移交只转移警长职务，不转移角色技能或私密记录。');
  }
  const anchor =
    v['speech.anchor'] === 'knife_first' ? '狼刀出局者（刀口未出局时为其他出局者）' : '一名出局者（多人出局时随机取一名）';
  L.push('· 每个白天的普通发言都在昨夜情况通报之后。' + (v['sheriff.explodeInElection'] === 'postpone_vote' ? (rules.electionVersion ?? 1) >= 2 ? '延期续选的警上环节优先于通报：先确认自爆并续投，警徽落地或自爆后再公布夜间出局。' : '延期直接续投警长时，也先通报昨夜情况再续投。' : ''));
  L.push(
    `· 发言顺序：${sheriff ? '有警长时由警长选择顺时针（号码增大）或逆时针，从警长下一位存活玩家开始，警长最后发言。没有警长时，' : ''}` +
      `昨夜有人出局则从${anchor}的下一位开始；昨夜平安则由法官随机指定起点。无警长时，方向由法官随机决定并公布。`,
  );
  L.push(
    `· 放逐投票：存活玩家同时投票，票齐后公开谁投了谁${v['vote.allowSelf'] ? '，可以投自己' : '，不能投自己'}${v['vote.allowAbstain'] ? '，可以弃票' : ''}，超时未投记为弃票。` +
      '得票最高者出局；平票者 PK 发言，其余玩家在平票者中再投一次（PK 台上的玩家不能投票），再平则当天无人出局。',
  );
  if (canExplode) {
    const window =
      v['explode.window'] === 'interrupt'
        ? '普通狼人可以在竞选发言、白天发言、PK 发言及非自爆结算的遗言期间随时自爆；自爆结算产生的遗言不开放再次自爆。'
        : v['explode.window'] === 'between_speeches'
          ? '每段发言（含竞选、PK 及非自爆结算的遗言）开始之前，存活普通狼人可以选择自爆；多人同时选择时由座位号最小者自爆，自爆结算产生的遗言不再询问自爆。'
          : '普通狼人只能在轮到自己发言（竞选、白天、PK 发言，不含遗言）时选择自爆。';
    L.push(
      `· 自爆：${window}投票进行中不能自爆。自爆者立刻出局并公开狼人身份；若是警长，先由他自己选择移交或撕毁警徽，再发表遗言。` +
        '当天剩余的发言、竞选和投票取消，随后进入黑夜。',
    );
  }
  const has = (k: string) => (v[`lastWords.${k}`] ? '有' : '没有');
  const words = [
    `第 1 夜出局${has('firstNight')}遗言`,
    `第 2 夜起夜里出局${has('laterNight')}遗言`,
    `被放逐${has('exile')}遗言`,
  ];
  if (canExplode) words.push(`自爆${has('explode')}遗言`);
  if (hasHunter) {
    words.push(
      `被猎人带走的人：猎人第 1 夜出局时${has('shotAfterFirstNight')}遗言，猎人第 2 夜起在夜里出局时${has('shotAfterLaterNight')}遗言，猎人被放逐时${has('shotAfterVote')}遗言`,
    );
  }
  const explosionWords = v['sheriff.explodeInElection'] === 'postpone_vote' ? '警上自爆与尚未公布的夜间死亡合并处理时，自爆者先遗言，其余按座位号从小到大。' : '';
  L.push(`· 遗言：${words.join('；')}。多人遗言按座位号从小到大。${explosionWords}胜负已分后不再发表遗言。`);

  L.push(dayRoles.length ? '五、其他' : '四、其他');
  L.push('· 发言里声称的身份，法官不证实也不否认。');
  L.push('· 游戏结束后复盘，公开每个座位的身份和每晚的行动。');
  return L.join('\n');
}

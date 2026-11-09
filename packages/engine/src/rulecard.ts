import { baseGameLanguage, gameText, isEnglishGameLocale } from '@werewolf/protocol';
import type { RuleSet } from '@werewolf/protocol';
import { getRole, modulesIn } from './registry';
import type { RoleModule } from './types';

const CATEGORY_ORDER: Record<string, number> = { wolf: 0, villager: 1, god: 2 };

function naturalList(items: readonly string[], locale: string | undefined, conjunction = 'and'): string {
  if (!isEnglishGameLocale(locale)) return items.join('、');
  if (items.length < 2) return items[0] ?? '';
  const first = items[0] ?? '';
  const last = items[items.length - 1] ?? '';
  return items.length === 2 ? `${first} ${conjunction} ${last}` : `${items.slice(0, -1).join(', ')}, ${conjunction} ${last}`;
}

function composition(rules: RuleSet): string {
  const counts = new Map<string, number>();
  for (const r of rules.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  const names = [...counts.entries()]
    .map(([id, n]) => ({ mod: getRole(id), n }))
    .sort((a, b) => (CATEGORY_ORDER[a.mod.category] ?? 9) - (CATEGORY_ORDER[b.mod.category] ?? 9))
    .map(({ mod, n }) => (n > 1 ? `${gameText(rules.locale, mod.name)} ×${n}` : gameText(rules.locale, mod.name)));
  return naturalList(names, rules.locale);
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
  const hunterShotVersion = rules.hunterShotVersion;
  const isUnifiedAwakenedNight = rules.awakenedNightVersion === 2;
  const canExplode = mods.some((m) => m.canExplode) && v['explode.enabled'] === true;
  const sheriff = v['sheriff.enabled'] === true;
  const electionExplosionPolicy = v['sheriff.explodeInElection'];
  const electionNightCanMerge = sheriff && canExplode && electionExplosionPolicy === 'postpone_vote' &&
    (v['sheriff.timing'] === 'before_announcement' || (rules.electionVersion ?? 1) >= 2);
  const electionNightStaysSeparate = sheriff && canExplode && electionExplosionPolicy !== 'postpone_vote' &&
    v['sheriff.timing'] === 'before_announcement';
  const has = (id: string) => rules.roles.includes(id);
  const nightOrderNames = rules.nightOrder.map((id) => {
    if (isUnifiedAwakenedNight && id === 'awakened_mimic') return gameText(rules.locale, "觉醒隐狼模仿或发动已学技能");
    return phaseNames.get(id) ?? (id === 'werewolf' ? gameText(rules.locale, "狼人") : id);
  });
  const canHunterBeShot = hasHunter && has('awakened_wolf') && hunterShotVersion === 2 && rules.deathResolutionVersion === 2;
  const causes: string[] = [];
  const attackBlockers = [
    ...(has('guard') ? [gameText(rules.locale, "守卫的保护")] : []),
    ...(has('awakened_wolf') && has('guard') ? [gameText(rules.locale, "模仿守卫的保护")] : []),
    ...(has('witch') ? [gameText(rules.locale, "女巫的解药")] : []),
  ];
  const hasWolfAttack = has('werewolf') || has('awakened_wolf');
  if (hasWolfAttack) causes.push(attackBlockers.length
    ? gameText(rules.locale, "狼人选择攻击玩家，且攻击未被{0}阻止时，该玩家出局。", naturalList(attackBlockers, rules.locale, 'or'))
    : gameText(rules.locale, "狼人选择攻击玩家时，该玩家出局。"));
  if (has('witch')) causes.push(has('awakened_wolf')
    ? gameText(rules.locale, has('guard')
      ? "女巫或模仿女巫使用毒药，且毒药未被本局可用的防护挡住时，目标出局。"
      : "女巫或模仿女巫使用毒药时，目标出局。")
    : gameText(rules.locale, "女巫使用毒药时，目标出局。"));
  causes.push(gameText(rules.locale, "白天放逐投票确定并由法官确认的玩家出局。"));
  if (canExplode) causes.push(gameText(rules.locale, "狼人按本局允许的时机自爆后立即出局。"));
  const hasGuardAndSaveOut = has('guard') && has('witch') && v['resolve.guardAndSaveKills'] === true;
  const guardAndSaveActorsText = has('awakened_wolf') && has('guard')
    ? gameText(rules.locale, "守卫或模仿守卫")
    : gameText(rules.locale, "守卫");
  const canHunterCauseShot = hasHunter && (
    (hasWolfAttack && v['hunter.shootOnKnife'] === true) ||
    v['hunter.shootOnVote'] === true ||
    (has('witch') && v['hunter.shootOnPoison'] === true) ||
    (hasGuardAndSaveOut && v['hunter.shootOnGuardAndSave'] === true) ||
    canHunterBeShot
  );
  if (canHunterCauseShot) causes.push(gameText(rules.locale, "猎人获准并实际开枪后，被击中的玩家出局。"));
  const sentenceSeparator = isEnglishGameLocale(rules.locale) ? ' ' : '';
  const resumeOrder = (rules.electionVersion ?? 1) >= 2
    ? gameText(rules.locale, rules.deathResolutionVersion === 2
      ? "先确认是否有狼人再次自爆，再按原报名、退出竞选情况和投票轮次直接续投，不重新报名或发言；警长选举结束或被自爆中断后，才通报昨夜出局结算情况并判定胜负，胜负未分才处理出局技能。夜间将出局的玩家仍保留当时的竞选资格，不提前排除。"
      : "先确认是否有狼人再次自爆，再按原报名、退出竞选情况和投票轮次直接续投，不重新报名或发言；警长选举结束或被自爆中断后，才通报昨夜出局结算情况并处理出局职责。夜间将出局的玩家仍保留当时的竞选资格，不提前排除。")
    : gameText(rules.locale, rules.deathResolutionVersion === 2
      ? "先通报昨夜出局结算情况并判定胜负，胜负未分才处理出局技能，再按原报名、退出竞选情况和投票轮次直接续投，不重新报名或发言。"
      : "先通报昨夜出局结算情况并处理出局职责，再按原报名、退出竞选情况和投票轮次直接续投，不重新报名或发言。");
  const L: string[] = [];

  L.push(gameText(rules.locale, "【本局规则 · {0}】", rules.presetName));
  L.push(gameText(rules.locale, "## 身份与阵营"));
  L.push(gameText(rules.locale, "· 本局 {0} 人：{1}。配置公开，每个座位的身份随机发放、不公开。", rules.playerCount, composition(rules)));
  if (gods.length) L.push(gameText(rules.locale, "· 神职指平民和狼人以外的特殊身份；本局神职包括{0}。", naturalList(gods, rules.locale)));
  else L.push(gameText(rules.locale, "· 本局没有神职身份。"));
  L.push(gameText(rules.locale, "· 你的目标是帮助自己真实身份所属的阵营获胜。平民和神职属于好人阵营，狼人属于狼人阵营。发言声称和查验表现都不改变真实身份或所属阵营。"));

  L.push(gameText(rules.locale, "## 出局"));
  L.push(gameText(rules.locale, "· 出局是指法官确认一名玩家不再参加白天讨论、投票和夜间行动；尚未出局的玩家称为存活玩家。获准的出局职责按下文处理。"));
  L.push(gameText(rules.locale, "· 本局可能造成出局的情况："));
  for (const cause of causes) L.push(`  - ${cause}`);
  if (hasGuardAndSaveOut) L.push(gameText(rules.locale, "  - {0}当晚守护，且女巫同时救治同一名狼人攻击目标时（同守同救），该玩家仍会出局。", guardAndSaveActorsText));
  if (has('idiot')) L.push(gameText(rules.locale, "· 白痴例外：首次被放逐时翻牌并留在场上；之后再次被放逐才出局。"));
  L.push(gameText(rules.locale, "· 夜间行动全部结束后，法官统一计算攻击、守护和用药结果。被狼人选为攻击目标不等于已经出局。通常在法官通报昨夜出局结算情况时确认夜间出局；公布出局名单，无人出局则宣布平安夜。通报不公开出局原因或身份，规则要求公开时除外。"));
  if (electionNightCanMerge) L.push(gameText(rules.locale, "· 若警长竞选自爆时昨夜出局结算情况尚未通报，法官先通报夜间出局，再将这些出局与自爆一并纳入同一次胜负判定。"));
  if (electionNightStaysSeparate) L.push(gameText(rules.locale, "· 若警长竞选自爆时昨夜出局结算情况尚未通报，先单独结算自爆者；仅对局仍继续时才另行通报并结算夜间出局。"));
  L.push(gameText(rules.locale, "· 出局不等于所在阵营失败；玩家最终以真实身份所属阵营的胜负作为自己的胜负。"));

  L.push(gameText(rules.locale, "## 胜负与结算"));
  L.push(
    v.winCondition === 'side'
      ? gameText(rules.locale, "· 好人阵营：所有狼人阵营成员出局即获胜。狼人阵营：所有平民出局，或所有神职（{0}）出局即获胜（屠边）。", naturalList(gods, rules.locale, 'or'))
      : gameText(rules.locale, "· 好人阵营：所有狼人阵营成员出局即获胜。狼人阵营：所有好人出局即获胜（屠城）。"),
  );
   L.push(gameText(rules.locale, rules.deathResolutionVersion === 2
     ? sheriff
       ? "· 每次确认新的出局后，先判定胜负；同一时点确认多人出局时，先让这些出局一并生效，再统一判定胜负。胜负已分则立即结束，不再处理出局技能、警徽或遗言；胜负未分才处理符合条件的出局技能。若技能造成新的出局，先判定胜负，胜负未分再继续结算；仍未分才处理警徽，最后由有遗言资格者发表遗言。双方同时满足胜利条件时，好人优先。"
       : "· 每次确认新的出局后，先判定胜负；同一时点确认多人出局时，先让这些出局一并生效，再统一判定胜负。胜负已分则立即结束，不再处理出局技能或遗言；胜负未分才处理符合条件的出局技能。若技能造成新的出局，先判定胜负，胜负未分再继续结算；最后由有遗言资格者发表遗言。双方同时满足胜利条件时，好人优先。"
     : "· 胜负结算：先处理本次出局触发的技能及其引发的后续出局，再判定胜负；双方同时满足胜利条件时，好人优先。"));

  L.push(gameText(rules.locale, "## 夜晚与身份技能"));
  L.push(gameText(rules.locale, "· 第 N 夜在第 N 天之前；夜间的「今晚」指本夜，第 N 天的「昨夜」指第 N 夜、「今晚」指第 N+1 夜。"));
  L.push(
    gameText(rules.locale, "· 夜间行动顺序：{0}。某身份没有可以行动的玩家时，法官不再询问该身份。", nightOrderNames.join(' → ')),
  );
  if (hasWolfAttack) L.push(gameText(rules.locale, "· 狼人的攻击不会取消目标当夜尚未完成的行动。"));
  if (has('witch')) L.push(gameText(rules.locale, has('awakened_wolf')
    ? "· 女巫或模仿女巫的毒药不会取消目标当夜尚未完成的行动。"
    : "· 女巫的毒药不会取消目标当夜尚未完成的行动。"));
  for (const mod of new Set(rules.nightOrder.map((id) => phaseOwner.get(id)))) {
    for (const line of mod?.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }
  const dayRoles = mods.filter((m) => !m.nightPhase && !m.nightPhases?.length && m.ruleCard);
  if (dayRoles.length || has('villager')) {
    L.push(gameText(rules.locale, "· 其他身份技能"));
    if (has('villager')) L.push(gameText(rules.locale, "· 平民：没有夜间技能。"));
    for (const m of dayRoles) for (const line of m.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }

  if (sheriff) {
    L.push(gameText(rules.locale, "## 警长竞选"));
    const timing =
      v['sheriff.timing'] === 'before_announcement'
        ? gameText(rules.locale, "第 1 天先竞选，再通报昨夜出局结算情况；夜间将出局的玩家公布前仍可按当时资格参与竞选，其资格不代表已确认存活。")
        : gameText(rules.locale, "第 1 天先通报昨夜出局结算情况、完成首夜遗言，再竞选警长。");
    const voters = v['sheriff.withdrawnCanVote']
      ? gameText(rules.locale, "未报名竞选的玩家和退出竞选的玩家投票")
      : gameText(rules.locale, "只有未报名竞选的玩家投票（报名竞选过的玩家包括退出竞选者都不能投）");
    const explodeRule = !canExplode || !sheriff
      ? ''
      : v['sheriff.explodeInElection'] === 'postpone_vote'
        ? v['sheriff.timing'] === 'before_announcement'
          ? gameText(rules.locale, rules.deathResolutionVersion === 2
              ? "首次竞选自爆后先公布昨夜出局结算情况并判定胜负；胜负未分才继续处理猎枪等出局职责；再由有遗言资格的自爆者和夜间出局者按本局规则遗言并入夜。若对局仍未结束，竞选才延期至次日，{0}续投前存活狼人可再次选择自爆；再次自爆后本局不再选出警长。已公布出局或退出竞选者不能参选；原本没有报名的玩家仍保留投票资格；平票按规则处理。"
              : "首次竞选自爆后先公布昨夜出局结算情况、处理猎枪等出局职责；胜负未分时，由有遗言资格的自爆者和夜间出局者按本局规则遗言，随后入夜。竞选延期至次日，{0}续投前存活狼人可再次选择自爆；再次自爆后本局不再选出警长。已公布出局或退出竞选者不能参选；原本没有报名的玩家仍保留投票资格；平票按规则处理。", resumeOrder)
          : gameText(rules.locale, rules.deathResolutionVersion === 2
              ? "首次竞选自爆后判定自爆造成出局后的胜负；胜负未分才处理猎枪等出局职责，再由符合本局遗言资格的自爆者按规则遗言并入夜。若对局仍未结束，竞选才延期至次日，{0}续投前存活狼人可再次选择自爆；再次自爆后本局不再选出警长。已公布出局或退出竞选者不能参选；原本没有报名的玩家仍保留投票资格；平票按规则处理。"
              : "首次竞选自爆后处理猎枪等出局职责；胜负未分时，由符合本局遗言资格的自爆者按规则遗言并入夜。竞选延期至次日，{0}续投前存活狼人可再次选择自爆；再次自爆后本局不再选出警长。已公布出局或退出竞选者不能参选；原本没有报名的玩家仍保留投票资格；平票按规则处理。", resumeOrder)
      : v['sheriff.explodeInElection'] === 'postpone'
         ? gameText(rules.locale, "竞选尚未选出警长时有狼人自爆，竞选推迟到下一个白天；续选时保留未退出且仍存活的原候选人，候选人多于一名时重新进行竞选发言。若再次自爆，本局不再选出警长。")
        : gameText(rules.locale, "竞选尚未选出警长时有狼人自爆，本局不再选出警长。");
    L.push(
      gameText(rules.locale, "· 警长竞选：{0}有竞选资格的玩家同时选择是否报名竞选；无人报名或全员报名则本局没有警长，只有一名候选人时直接当选。", timing) +
        sentenceSeparator +
        gameText(rules.locale, "候选人从随机起点、按随机方向依次竞选发言；候选人可以退出竞选。") +
        (rules.electionVersion === 3 ? sentenceSeparator + gameText(rules.locale, "普通竞选发言期间可在他人发言时退出竞选，但不能插话或打断。发言结束后未退出者同时最终确认去留，确认不可修改、超时默认继续；确认完公布退出者并投票。平票候选人的补充发言和投票时不能退出竞选。") : ''),
    );
     L.push(gameText(rules.locale, "· 警长投票：{0}。符合资格的投票人同时秘密提交，每人 1 票，票齐后公开谁投给谁{1}。最高票并列时，并列候选人依次补充发言，之后除并列候选人外的其他存活玩家再投一次。再次平票、没有可投票的玩家或没有有效票时，本局没有警长。", voters, v['vote.allowAbstain'] ? gameText(rules.locale, "，可以弃票") : ''));
    if (explodeRule) L.push(gameText(rules.locale, "· 竞选自爆：{0}", explodeRule));
  }
  L.push(gameText(rules.locale, sheriff ? "## 警徽、白天发言与放逐" : "## 白天发言与放逐"));
  if (sheriff) L.push(gameText(rules.locale, "· 警徽：警长是竞选职务，任何阵营均可竞选，不代表阵营。放逐首轮和放逐平票后的再次投票中，警长有效票均计 1.5 票，其他玩家的有效票各计 1 票；如果警长是放逐平票后参与补充发言的并列玩家之一，则不能参加该轮投票。出局后由警长本人向存活玩家移交或撕毁警徽；移交不转移身份技能或私密记录。"));
  L.push(gameText(rules.locale, "· 每个白天的普通讨论都在昨夜出局结算情况通报并完成相应结算后开始。") + (sheriff && canExplode && v['sheriff.explodeInElection'] === 'postpone_vote' ? sentenceSeparator + ((rules.electionVersion ?? 1) >= 2 ? gameText(rules.locale, "延期续选时，警长选举优先于通报：先确认是否自爆并续投；选举结束或被自爆中断后，再通报昨夜出局结算情况。") : gameText(rules.locale, "延期后直接继续警长选举时，也先通报昨夜出局结算情况再续投。")) : ''));
  const anchor = v['speech.anchor'] === 'knife_first'
    ? gameText(rules.locale, "法官先检查狼人选择的攻击目标：若该目标昨夜出局，就以该目标为发言依据；若该目标没有出局，就从其他昨夜出局玩家中选择座位号最小者作为发言依据")
    : gameText(rules.locale, "法官从昨夜出局玩家中随机选择一人作为发言依据");
  if (sheriff) L.push(gameText(rules.locale, "· 有警长时的白天发言顺序：警长选择顺时针（座位号增大）或逆时针（座位号减小）；从警长座位之后沿所选方向遇到的第一名存活玩家开始，存活玩家依次发言，警长最后发言。"));
  L.push(gameText(rules.locale, "· 没有警长时的白天发言顺序：法官随机选择并公布顺时针或逆时针方向。昨夜有人出局时，{0}；法官沿所选方向从发言依据座位之后寻找第一名存活玩家作为起点。昨夜无人出局时，法官从存活玩家中随机选择起点。", anchor));
  L.push(gameText(rules.locale, "· 白天普通讨论按照法官公布的顺序逐席进行。玩家在本阶段完成一次公开发言后，本阶段的发言资格即告结束，直至本阶段结束不得再次发言；其他玩家后续发言、讨论继续或收到新的旁听信息，均不会恢复该资格。平票后的补充发言、警长竞选发言和遗言由法官另行开启，只有法官明确宣布进入相应阶段并指定可发言者时，才取得该阶段的发言资格。"));
  L.push(gameText(rules.locale, "· 放逐投票：存活玩家同时秘密投票，票齐后公开谁投了谁{0}{1}，超时未投记为弃票。", v['vote.allowSelf'] ? gameText(rules.locale, "，可以投自己") : gameText(rules.locale, "，不能投自己"), v['vote.allowAbstain'] ? gameText(rules.locale, "，可以弃票") : ''));
  L.push(gameText(rules.locale, has('idiot')
    ? "· 放逐结果：最高票玩家被放逐并出局；如果最高票玩家是白痴，按上文白痴例外处理。"
    : "· 放逐结果：最高票玩家被放逐并出局。"));
  L.push(gameText(rules.locale, "· 最高票并列时，并列玩家依次补充发言，其他存活玩家在并列玩家中再投一次（正在补充发言的玩家不能投票）；再次平票、没有可投票的玩家或没有有效票时，当天无人因这次放逐投票出局。"));
  if (canExplode) {
    const electionCanPostpone = sheriff && (v['sheriff.explodeInElection'] === 'postpone_vote' || v['sheriff.explodeInElection'] === 'postpone');
    L.push(gameText(rules.locale, electionCanPostpone ? "## 自爆与延期竞选" : "## 自爆"));
    const badgeOnExplosion = sheriff ? gameText(rules.locale, "若自爆者是警长，先由本人选择移交或撕毁警徽；") : '';
    const window =
      v['explode.window'] === 'interrupt'
        ? gameText(rules.locale, sheriff
          ? "普通狼人可以在竞选发言、白天发言、平票后的补充发言及非自爆结算的遗言期间随时自爆；自爆结算产生的遗言不开放再次自爆。"
          : "普通狼人可以在白天发言、平票后的补充发言及非自爆结算的遗言期间随时自爆；自爆结算产生的遗言不开放再次自爆。")
        : v['explode.window'] === 'between_speeches'
          ? gameText(rules.locale, sheriff
            ? "每段发言（含竞选、平票后的补充发言及非自爆结算的遗言）开始之前，存活普通狼人可以选择自爆；多人同时选择时由座位号最小者自爆，自爆结算产生的遗言不再询问自爆。"
            : "每段白天发言（含平票后的补充发言及非自爆结算的遗言）开始之前，存活普通狼人可以选择自爆；多人同时选择时由座位号最小者自爆，自爆结算产生的遗言不再询问自爆。")
          : gameText(rules.locale, sheriff
            ? "普通狼人只能在轮到自己发言（竞选、白天、平票后的补充发言，不含遗言）时选择自爆。"
            : "普通狼人只能在轮到自己白天发言或平票后的补充发言时选择自爆。");
    L.push(
      gameText(rules.locale, rules.deathResolutionVersion === 2
        ? "· 自爆：{0}投票进行中不能自爆。自爆者立刻出局并公开狼人身份；胜负判定优先。当天剩余的发言、竞选和投票取消。仅胜负未分时才继续处理后续事项：{1}有遗言资格者再按本局规则发表遗言，之后进入黑夜。"
        : "· 自爆：{0}投票进行中不能自爆。自爆者立刻出局并公开狼人身份；{1}由符合本局遗言资格且胜负未分的玩家发表遗言。", window, badgeOnExplosion) +
        (rules.deathResolutionVersion === 2 ? '' : sentenceSeparator + gameText(rules.locale, "当天剩余的发言、竞选和投票取消；若对局仍继续，随后进入黑夜。")),
    );
  }
  const hasLastWords = (k: string) => (v[`lastWords.${k}`] ? gameText(rules.locale, "有") : gameText(rules.locale, "没有"));
  const words = [
    gameText(rules.locale, "第 1 夜出局{0}遗言", hasLastWords('firstNight')),
    gameText(rules.locale, "第 2 夜起夜里出局{0}遗言", hasLastWords('laterNight')),
    gameText(rules.locale, "被放逐{0}遗言", hasLastWords('exile')),
  ];
  if (canExplode) words.push(gameText(rules.locale, "自爆{0}遗言", hasLastWords('explode')));
  if (hasHunter) {
    words.push(
      gameText(rules.locale, "被猎人带走的人：猎人第 1 夜出局时{0}遗言，猎人第 2 夜起在夜里出局时{1}遗言，猎人被放逐时{2}遗言", hasLastWords('shotAfterFirstNight'), hasLastWords('shotAfterLaterNight'), hasLastWords('shotAfterVote')),
    );
  }
  L.push(gameText(rules.locale, "## 遗言与复盘"));
  const explosionWords = electionNightCanMerge
    ? gameText(rules.locale, "警长竞选中自爆与尚未通报的昨夜出局结算情况合并处理时，自爆者先遗言，其余有资格者按座位号从小到大。")
    : '';
  const baseLocale = baseGameLanguage(rules.locale).id;
  const lastWordsSeparator = isEnglishGameLocale(rules.locale) ? '; ' : baseLocale === 'ja' ? '、' : '；';
  L.push(gameText(rules.locale, "· 遗言：{0}。多人遗言按座位号从小到大。{1}胜负已分后不再发表遗言。", words.join(lastWordsSeparator), explosionWords));

  L.push(gameText(rules.locale, "· 发言里声称的身份，法官不证实也不否认。"));
  L.push(gameText(rules.locale, "· 游戏结束后复盘，公开每个座位的身份和每晚的行动。"));
  return L.join('\n');
}

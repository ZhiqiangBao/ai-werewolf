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
  for (const m of mods) if (m.nightPhase) phaseOwner.set(m.nightPhase.id, m);
  const gods = mods.filter((m) => m.category === 'god').map((m) => m.name);
  const hasHunter = mods.some((m) => m.id === 'hunter');
  const canExplode = mods.some((m) => m.canExplode) && v['explode.enabled'] === true;
  const sheriff = v['sheriff.enabled'] === true;
  const L: string[] = [];

  L.push(`【本局规则 · ${rules.presetName}】`);
  L.push('一、配置与胜负');
  L.push(`· 本局 ${rules.playerCount} 人：${composition(rules)}。配置公开，每个座位的身份随机发放、不公开。`);
  L.push(
    v.winCondition === 'side'
      ? `· 好人阵营：所有狼人出局即获胜。狼人阵营：所有平民出局，或所有神职（${gods.join('、')}）出局即获胜（屠边）。`
      : '· 好人阵营：所有狼人出局即获胜。狼人阵营：所有好人出局即获胜（屠城）。',
  );

  L.push('二、夜晚');
  L.push(
    `· 先夜后日。夜间顺序：${rules.nightOrder.map((id) => phaseOwner.get(id)?.name ?? id).join(' → ')}。该身份已无人存活时跳过。`,
  );
  for (const id of rules.nightOrder) {
    for (const line of phaseOwner.get(id)?.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }
  L.push('· 天亮只公布出局名单，不公布死因；出局不公布身份。');

  const dayRoles = mods.filter((m) => !m.nightPhase && m.ruleCard);
  if (dayRoles.length) {
    L.push('三、其他身份');
    for (const m of dayRoles) for (const line of m.ruleCard?.(rules) ?? []) L.push(`· ${line}`);
  }

  L.push(dayRoles.length ? '四、白天' : '三、白天');
  if (sheriff) {
    const timing =
      v['sheriff.timing'] === 'before_announcement'
        ? '第 1 天天亮后先竞选警长，再公布昨夜出局；昨夜出局的人在公布之前照常参与竞选。'
        : '第 1 天先公布昨夜出局、完成首夜遗言，再竞选警长。';
    const voters = v['sheriff.withdrawnCanVote']
      ? '未上警的玩家和退水的玩家投票'
      : '只有未上警的玩家投票（上过警的玩家包括退水者都不能投）';
    const explodeRule = !canExplode
      ? ''
      : v['sheriff.explodeInElection'] === 'postpone'
        ? '竞选尚未产生警长时有狼人自爆，竞选推迟到下一个白天（候选人不变）；再有自爆则警徽流失。'
        : '竞选尚未产生警长时有狼人自爆，警徽流失，本局没有警长。';
    L.push(
      `· 警长竞选：${timing}存活玩家同时选择是否上警；无人上警或全员上警则本局没有警长，只有一名候选人时直接当选。` +
        `候选人从随机起点、按随机方向依次竞选发言，发言时可以退水。${voters}，每人 1 票` +
        `${v['vote.allowAbstain'] ? '，可以弃票' : ''}；平票者 PK 发言后再投一次，再平则本局没有警长。${explodeRule}`,
    );
    L.push('· 警徽：警长的放逐票记 1.5 票；白天由警长选择发言方向并最后发言（可以归票）。警长出局时由本人把警徽移交给一名存活玩家，或撕毁警徽。');
  }
  const anchor =
    v['speech.anchor'] === 'knife_first' ? '狼刀出局者（刀口未出局时为其他出局者）' : '一名出局者（多人出局时随机取一名）';
  L.push(
    `· 发言顺序：${sheriff ? '有警长时由警长选择顺时针（号码增大）或逆时针，从警长下一位存活玩家开始，警长最后发言。没有警长时，' : ''}` +
      `昨夜有人出局则从${anchor}的下一位开始；昨夜平安则由法官随机指定起点。方向由法官随机决定并公布。`,
  );
  L.push(
    `· 放逐投票：存活玩家同时投票，票齐后公开谁投了谁${v['vote.allowSelf'] ? '，可以投自己' : '，不能投自己'}${v['vote.allowAbstain'] ? '，可以弃票' : ''}，超时未投记为弃票。` +
      '得票最高者出局；平票者 PK 发言，其余玩家在平票者中再投一次（PK 台上的玩家不能投票），再平则当天无人出局。',
  );
  if (canExplode) {
    const window =
      v['explode.window'] === 'interrupt'
        ? '狼人可以在任何发言阶段（竞选发言、自由发言、PK 发言、遗言）随时自爆。'
        : v['explode.window'] === 'between_speeches'
          ? '每段发言（含竞选、PK、遗言）开始之前，存活狼人可以选择自爆；多人同时选择时由座位号最小者自爆。'
          : '狼人只能在轮到自己发言（竞选、自由、PK 发言）时选择自爆。';
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
  L.push(`· 遗言：${words.join('；')}。多人遗言按座位号从小到大。`);

  L.push(dayRoles.length ? '五、其他' : '四、其他');
  L.push('· 发言里声称的身份，法官不证实也不否认。');
  L.push('· 游戏结束后复盘，公开每个座位的身份和每晚的行动。');
  return L.join('\n');
}

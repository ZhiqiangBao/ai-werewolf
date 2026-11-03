/** 画面文案注册表；只处理程序标签，不改写对局事实、原话或配音。 */
export interface VideoLanguage { id: string; fallback?: string; messages: Readonly<Record<string, string>> }
/** ISO 639-2/T language tag for the recorded audio. */
export function videoAudioLanguage(locale?: string): string {
  try { return ({ zh: 'zho', en: 'eng', ja: 'jpn' } as Record<string, string>)[new Intl.Locale(locale ?? 'zh-CN').language] ?? 'und'; }
  catch { return 'und'; }
}
const packs = new Map<string, VideoLanguage>();
export function registerVideoLanguage(pack: VideoLanguage): void {
  if (Intl.getCanonicalLocales(pack.id)[0] !== pack.id || packs.has(pack.id) || (pack.fallback && !packs.has(pack.fallback))) throw Error(`Invalid video language: ${pack.id}`);
  const slots = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, value] of Object.entries(pack.messages)) if (typeof value !== 'string' || slots(key) !== slots(value)) throw Error(`Invalid video translation: ${key}`);
  packs.set(pack.id, Object.freeze({ ...pack, messages: Object.freeze(Object.assign(Object.create(null), pack.messages)) }));
}
export function videoLocale(source?: string, override = process.env.VIDEO_LOCALE): string {
  const locale = override || source || 'zh-CN';
  if (!packs.has(locale)) throw Error(`Unsupported video language: ${locale}`);
  return locale;
}
export function videoText(locale: string, key: string, ...values: unknown[]): string {
  let pack = packs.get(locale);
  if (!pack) throw Error(`Unsupported video language: ${locale}`);
  let value: string | undefined;
  while (pack) { value = Object.hasOwn(pack.messages, key) ? pack.messages[key] : undefined; if (value !== undefined || !pack.fallback) break; pack = packs.get(pack.fallback); }
  return (value ?? key).replace(/\{(\d+)\}/g, (match, n: string) => Number(n) < values.length ? String(values[Number(n)]) : match);
}
export function videoChapter(locale: string, day: number, phase: string, fallback: string): string {
  return day > 0 && (phase === 'day' || phase === 'night') ? videoText(locale, phase === 'day' ? '第{0}天' : '第{0}夜', day) : fallback;
}
const roles: Record<string, string> = { werewolf: '狼人', seer: '预言家', witch: '女巫', guard: '守卫', hunter: '猎人', villager: '平民', idiot: '白痴', awakened_wolf: '觉醒隐狼', mirror_maiden: '魔镜少女' };
export function videoRole(locale: string, role: string, fallback: string): string { return Object.hasOwn(roles, role) ? videoText(locale, roles[role]) : fallback; }
registerVideoLanguage({ id: 'zh-CN', messages: { '查验结果：狼人': '狼人', '查验结果：好人': '好人' } });
registerVideoLanguage({ id: 'en', fallback: 'zh-CN', messages: {
  '身份未知':'Unknown', '{0}号玩家视角':'Seat {0} view', '本人身份 · 自动循环滚动':'Your role · scrolling', '本人身份默认简介（zh-CN）':'Default role summary (zh-CN)', '存活 {0} 人':'Alive {0}', '开枪目标':'Shot target',
  '第{0}天':'Day {0}', '第{0}夜':'Night {0}', '狼人':'Werewolf', '预言家':'Seer', '女巫':'Witch', '守卫':'Guard', '猎人':'Hunter', '平民':'Villager', '白痴':'Idiot', '觉醒隐狼':'Awakened Hidden Wolf', '魔镜少女':'Mirror Maiden',
  '放逐':'Exile', '毒药':'Poison', '狼刀':'Wolf', '猎枪':'Shot', '自爆':'Reveal', '同守同救':'Clash', '夜晚':'Night', '其他':'Other',
  '退水':'Withdrew', '上警':'Candidate', '发言中':'Speaking', '守护目标':'Guarded', '查验目标':'Inspected', '使用解药':'Saved', '使用毒药':'Poisoned', '狼刀目标':'Wolf target', '警长投票':'Sheriff vote', '放逐投票':'Exile vote', '{0}号':'Seat {0}', '{0} 票':'{0} votes',
  '终局 · {0}获胜':'Final · {0} wins', '胜利阵营':'Winning team', '{0}号 · {1}':'Seat {0} · {1}', '上帝解说':'Commentator', '法官播报':'Judge', '对局已结束':'Match ended', '系统托管 · 非模型自主发言':'Automatic action · not model speech', '行动转述 · 依据对局记录':'Action summary · match record', '狼队密谈 · 上帝观众可见':'Wolf chat · god view', '正在发言':'Speaking', '请投票 · 结果尚未公布':'Vote · result pending', '对局进行中':'Match in progress',
  '月影议事厅':'Moonshadow Hall', '上帝视角 · 非连续节选样品':'God view · selected sample', '上帝视角 · 完整对局':'God view · full match', '本局技能卡':'Match abilities', '全部身份 · 自动循环滚动':'All roles · scrolling', '来自本局规则 · 连续滚动不随发言重置':'Match rules · continuous scroll', '存活 {0} 人     狼人 {1}     好人 {2}':'Alive {0}   Wolves {1}   Good {2}', '对局 {0}  ·  {1}人物':'Match {0} · {1}', 'AI 配音 · 画面修改样品':'AI voice · sample', 'AI 配音 · 对局实录':'AI voice · match record',
  '系统托管':'Auto', '行动转述':'Summary', '狼队密谈':'Wolf chat', '全知视角':'God view', '法官':'Judge', '流程主持':'Moderator', '{0} · {1}人':'{0} · {1} players', '警徽与警长':'Sheriff and badge', '规则正文原语言：{0}':'Rule text language: {0}', '默认身份简介（zh-CN）：':'Default role summary (zh-CN): ',
  '日式校园':'Campus', '童话绘本':'Storybook', '中式古风':'Classical Chinese', '剑与魔法':'Fantasy', '现代都市':'Urban', '未来科技':'Futuristic'
} });
registerVideoLanguage({ id: 'ja', fallback: 'zh-CN', messages: {
  '身份未知':'不明', '{0}号玩家视角':'{0}番視点', '本人身份 · 自动循环滚动':'自分の役職 · 自動スクロール', '本人身份默认简介（zh-CN）':'既定の役職説明（zh-CN）', '存活 {0} 人':'生存 {0}人', '开枪目标':'射撃対象',
  '第{0}天':'{0}日目', '第{0}夜':'{0}夜目', '狼人':'人狼', '预言家':'占い師', '女巫':'魔女', '守卫':'騎士', '猎人':'猟師', '平民':'村人', '白痴':'愚者', '觉醒隐狼':'覚醒隠狼', '魔镜少女':'鏡の少女',
  '放逐':'追放', '毒药':'毒', '狼刀':'襲撃', '猎枪':'射撃', '自爆':'自白', '同守同救':'護衛＋薬', '夜晚':'夜間', '其他':'その他',
  '退水':'辞退', '上警':'立候補', '发言中':'発言中', '守护目标':'守護対象', '查验目标':'占い対象', '使用解药':'救済', '使用毒药':'毒使用', '狼刀目标':'襲撃対象', '警长投票':'警長投票', '放逐投票':'追放投票', '{0}号':'{0}番', '{0} 票':'{0}票',
  '终局 · {0}获胜':'終局 · {0}の勝利', '胜利阵营':'勝利陣営', '{0}号 · {1}':'{0}番 · {1}', '上帝解说':'全知解説', '法官播报':'司会', '对局已结束':'対局終了', '系统托管 · 非模型自主发言':'自動行動 · モデルの発言ではありません', '行动转述 · 依据对局记录':'行動要約 · 対局記録より', '狼队密谈 · 上帝观众可见':'人狼の密談 · 全知視点', '正在发言':'発言中', '请投票 · 结果尚未公布':'投票中 · 結果未発表', '对局进行中':'対局中',
  '月影议事厅':'月影議事堂', '上帝视角 · 非连续节选样品':'全知視点 · 抜粋サンプル', '上帝视角 · 完整对局':'全知視点 · 全対局', '本局技能卡':'対局の能力カード', '全部身份 · 自动循环滚动':'全役職 · 自動スクロール', '来自本局规则 · 连续滚动不随发言重置':'対局ルール · 連続スクロール', '存活 {0} 人     狼人 {1}     好人 {2}':'生存 {0}人   人狼 {1}   善良 {2}', '对局 {0}  ·  {1}人物':'対局 {0} · {1}', 'AI 配音 · 画面修改样品':'AI音声 · サンプル', 'AI 配音 · 对局实录':'AI音声 · 対局記録',
  '系统托管':'自動', '行动转述':'行動要約', '狼队密谈':'人狼の密談', '全知视角':'全知視点', '法官':'司会', '流程主持':'進行役', '{0} · {1}人':'{0} · {1}人', '警徽与警长':'警徽と警長', '规则正文原语言：{0}':'ルール本文の原語：{0}', '默认身份简介（zh-CN）：':'既定の役職説明（zh-CN）：',
  '日式校园':'学園', '童话绘本':'絵本', '中式古风':'中国古風', '剑与魔法':'ファンタジー', '现代都市':'現代都市', '未来科技':'未来'
} });

// 视频主持衔接基于结构化事实，不翻译事件原文或玩家发言。
const hostingTranslations: readonly (readonly [string, string, string])[] = [
  ['第{0}夜，天黑请闭眼。','Night {0}. Night falls; everyone, close your eyes.','第{0}夜です。夜になりました。皆さん、目を閉じてください。'],
  ['第{0}天，天亮了，所有玩家请睁眼。','Day {0}. Dawn breaks; everyone, open your eyes.','第{0}日です。朝になりました。皆さん、目を開けてください。'],
  ['守卫请睁眼，请选择今晚守护的玩家，也可以空守。','Guard, open your eyes. Choose someone to protect tonight, or protect nobody.','騎士は目を開け、今夜護衛する人を選んでください。護衛しないこともできます。'],
  ['今晚空守。','I protect nobody tonight.','今夜は護衛しません。'], ['我守护{0}号。','I protect seat {0}.','{0}番を護衛します。'],
  ['确认空守。守卫请闭眼。','No protection confirmed. Guard, close your eyes.','護衛なしを確認しました。騎士は目を閉じてください。'],
  ['确认守护{0}号。守卫请闭眼。','Protection of seat {0} confirmed. Guard, close your eyes.','{0}番の護衛を確認しました。騎士は目を閉じてください。'],
  ['狼人请睁眼，确认同伴。请商量今晚的击杀目标。','Werewolves, open your eyes and identify your teammates. Discuss tonight’s target.','人狼は目を開け、仲間を確認し、今夜の襲撃先を話し合ってください。'],
  ['狼人请睁眼。','Werewolves, open your eyes.','人狼は目を開けてください。'], ['狼人请确认今晚的击杀目标。','Werewolves, confirm tonight’s target.','人狼は今夜の襲撃先を確認してください。'],
  ['确认刀口{0}号。狼人请闭眼。','Attack on seat {0} confirmed. Werewolves, close your eyes.','{0}番への襲撃を確認しました。人狼は目を閉じてください。'],
  ['确认今晚空刀。狼人请闭眼。','No attack confirmed. Werewolves, close your eyes.','今夜は襲撃なしと確認しました。人狼は目を閉じてください。'],
  ['预言家请睁眼，请选择今晚要查验的一名玩家。','Seer, open your eyes and choose a player to inspect tonight.','占い師は目を開け、今夜占う人を選んでください。'],
  ['本夜不查验。','I will not inspect anyone tonight.','今夜は占いません。'], ['我查验{0}号。','I inspect seat {0}.','{0}番を占います。'],
  ['本夜没有查验。预言家请闭眼。','No inspection tonight. Seer, close your eyes.','今夜の占いはありません。占い師は目を閉じてください。'],
  ['你查验的{0}号是{1}。预言家请闭眼。','Seat {0}, whom you inspected, is {1}. Seer, close your eyes.','占った{0}番は{1}です。占い師は目を閉じてください。'],
  ['查验结果：狼人','a werewolf','人狼'], ['查验结果：好人','good','善良'],
  ['女巫请睁眼。今晚被狼人袭击的是{0}号，是否使用解药？你也可以选择使用毒药，或不用药。','Witch, open your eyes. Seat {0} was attacked tonight. Will you use the antidote? You may instead use poison or neither potion.','魔女は目を開けてください。今夜襲撃されたのは{0}番です。解毒薬を使いますか。毒を使うか、何も使わないこともできます。'],
  ['女巫请睁眼。今晚没有刀口？你也可以选择使用毒药，或不用药。','Witch, open your eyes. There was no attack tonight. You may use poison or neither potion.','魔女は目を開けてください。今夜の襲撃はありません。毒を使うか、何も使わないことができます。'],
  ['女巫请睁眼，请决定今晚是否使用剩余药剂。','Witch, open your eyes and decide whether to use a remaining potion tonight.','魔女は目を開け、今夜残っている薬を使うか決めてください。'],
  ['我用解药救{0}号。','I use the antidote on seat {0}.','{0}番に解毒薬を使います。'], ['我用毒药毒{0}号。','I poison seat {0}.','{0}番に毒を使います。'], ['今晚不用药。','I use no potion tonight.','今夜は薬を使いません。'],
  ['确认对{0}号使用解药。女巫请闭眼。','Antidote on seat {0} confirmed. Witch, close your eyes.','{0}番への解毒薬を確認しました。魔女は目を閉じてください。'],
  ['确认对{0}号使用毒药。女巫请闭眼。','Poison on seat {0} confirmed. Witch, close your eyes.','{0}番への毒を確認しました。魔女は目を閉じてください。'],
  ['确认不用药。女巫请闭眼。','No potion confirmed. Witch, close your eyes.','薬を使わないことを確認しました。魔女は目を閉じてください。'],
  ['现在开始警长竞选，有意竞选警长的玩家请上警。','The Sheriff election begins. Players wishing to run, please register.','警長選挙を始めます。立候補する人は登録してください。'],
  ['上警的玩家有{0}。','The candidates are {0}.','立候補者は{0}です。'],
  ['警上发言从{0}号开始，{1}依次发言。','Campaign speeches start with seat {0} and proceed {1}.','選挙演説は{0}番から{1}に進みます。'],
  ['顺时针','clockwise','時計回り'], ['逆时针','counterclockwise','反時計回り'],
  ['请{0}号警长选择发言方向。','Sheriff in seat {0}, choose the speaking direction.','警長の{0}番は発言方向を選んでください。'],
  ['我选{0}，从{1}号开始。','I choose {0}, starting with seat {1}.','{0}を選び、{1}番から始めます。'],
  ['从{0}号开始，{1}依次发言。','Speaking begins with seat {0} and proceeds {1}.','{0}番から{1}に発言します。'],
  ['{0}号警长最后发言。','The Sheriff in seat {0} speaks last.','警長の{0}番が最後に発言します。'],
  ['PK发言结束。','Runoff speeches are over. ','決選発言は終了しました。'], ['发言结束。','Speeches are over. ','発言は終了しました。'],
  ['现在进行警长投票，请有投票资格的玩家投给支持的候选人。三、二、一，请投票。','Now the Sheriff ballot begins. Eligible voters, choose a candidate. Three, two, one, vote.','警長投票を行います。投票資格のある人は支持する候補者に投票してください。3、2、1、投票してください。'],
  ['现在进行放逐投票，请有投票资格的存活玩家选择放逐目标。三、二、一，请投票。','Now the exile ballot begins. Eligible living players, choose a target. Three, two, one, vote.','追放投票を行います。投票資格のある生存者は追放先を選んでください。3、2、1、投票してください。'],
  ['投票结果：{0}。','Vote results: {0}. ','投票結果：{0}。'], ['{0}号{1}票','seat {0}: {1} votes','{0}番{1}票'], ['没有有效票','no valid votes','有効票なし'], ['{0}弃票。','{0} abstained. ','{0}は棄権しました。'],
  ['，',', ','、'], ['、',', ','、'],
];
for (const [index, id] of [[1, 'en'], [2, 'ja']] as const) {
  const pack = packs.get(id)!;
  const messages = Object.assign(Object.create(null), pack.messages);
  const slots = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const row of hostingTranslations) {
    if (slots(row[0]) !== slots(row[index])) throw Error(`Invalid video translation: ${row[0]}`);
    messages[row[0]] = row[index];
  }
  packs.set(id, Object.freeze({ ...pack, messages: Object.freeze(messages) }));
}

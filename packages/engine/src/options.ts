import type { OptionDef } from './types';

const bool = (key: string, group: string, label: string, def: boolean, editable = false, hint?: string): OptionDef => ({
  key,
  group,
  label,
  type: 'boolean',
  default: def,
  editable,
  ...(hint ? { hint } : {}),
});

/** 核心流程的规则选项。身份相关的选项由各身份模块自己声明。 */
export const CORE_OPTIONS: OptionDef[] = [
  {
    key: 'winCondition',
    group: '胜负',
    label: '胜负条件',
    type: 'choice',
    choices: [
      { value: 'side', label: '屠边：杀光平民或杀光神职' },
      { value: 'city', label: '屠城：杀光所有好人' },
    ],
    default: 'side',
    editable: true,
  },
  bool('sheriff.enabled', '警长', '竞选警长', true, true),
  {
    key: 'sheriff.timing',
    group: '警长',
    label: '第 1 天竞选时机',
    type: 'choice',
    choices: [
      { value: 'before_announcement', label: '天亮先竞选，再公布昨夜出局' },
      { value: 'after_last_words', label: '先公布出局和首夜遗言，再竞选' },
    ],
    default: 'before_announcement',
    editable: true,
    hint: '常见玩法是先竞选：首夜出局者在公布前仍可上警、投票。',
  },
  bool('sheriff.withdrawnCanVote', '警长', '退水的玩家可以投票', false, true, '常见玩法：上过警的玩家（含退水）都不能投票。'),
  {
    key: 'sheriff.explodeInElection',
    group: '警长',
    label: '竞选未产生警长时有狼人自爆',
    type: 'choice',
    choices: [
      { value: 'lost', label: '警徽流失，本局不再竞选' },
      { value: 'postpone', label: '竞选推迟到下一个白天，再爆则警徽流失' },
    ],
    default: 'lost',
    editable: true,
  },
  { key: 'vote.normalWeight', group: '投票', label: '普通票内部权重', type: 'number', default: 2, editable: false },
  { key: 'vote.sheriffWeight', group: '投票', label: '警长票内部权重', type: 'number', default: 3, editable: false },
  bool('vote.allowAbstain', '投票', '可以主动弃票', true, true),
  bool('vote.allowSelf', '投票', '可以投自己', true, true),
  bool('explode.enabled', '自爆', '狼人可以自爆', true),
  {
    key: 'explode.window',
    group: '自爆',
    label: '自爆时机',
    type: 'choice',
    choices: [
      { value: 'interrupt', label: '发言阶段随时可以自爆（不打断流程询问）' },
      { value: 'between_speeches', label: '每段发言前询问所有存活狼人' },
      { value: 'speaker_only', label: '只能在自己发言时自爆' },
    ],
    default: 'interrupt',
    editable: true,
    hint: '「每段发言前询问」会让每段发言前都等待所有狼人表态，模型调用量成倍增加。',
  },
  {
    key: 'speech.anchor',
    group: '发言',
    label: '无警长且昨夜多人出局时的发言起点',
    type: 'choice',
    choices: [
      { value: 'random_dead', label: '随机取一名出局者的下一位' },
      { value: 'knife_first', label: '狼刀出局者的下一位' },
    ],
    default: 'random_dead',
    editable: true,
    hint: '按刀口定起点会让全场推断出谁是被刀、谁是被毒。',
  },
  bool('lastWords.firstNight', '遗言', '第 1 夜出局有遗言', true),
  bool('lastWords.laterNight', '遗言', '第 2 夜起夜里出局有遗言', false),
  bool('lastWords.exile', '遗言', '被放逐有遗言', true),
  bool('lastWords.explode', '遗言', '自爆有遗言', true),
  bool('lastWords.shotAfterFirstNight', '遗言', '第 1 夜猎人开枪带走的人有遗言', true),
  bool('lastWords.shotAfterLaterNight', '遗言', '第 2 夜起猎人夜里开枪带走的人有遗言', false),
  bool('lastWords.shotAfterVote', '遗言', '猎人被放逐后开枪带走的人有遗言', true),
  { key: 'limits.maxDays', group: '运营', label: '流局上限（白天数，不写入规则卡）', type: 'number', default: 15, editable: false },
];

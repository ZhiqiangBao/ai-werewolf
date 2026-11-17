import { expect, it } from 'vitest';
import { ownLine } from '../src/agent';

it.each([
  ['merchant_gift_inspect', 3, '已提交向 3号 赠予查验。', 'Submitted a gift of inspection to Player 3.', '3番への占いの贈与を送信しました。'],
  ['merchant_gift_poison', 3, '已提交向 3号 赠予毒药。', 'Submitted a gift of poison to Player 3.', '3番への毒の贈与を送信しました。'],
  ['merchant_gift_guard', 3, '已提交向 3号 赠予守护。', 'Submitted a gift of protection to Player 3.', '3番への護衛の贈与を送信しました。'],
  ['merchant_wait', null, '已提交等待，保留交易机会。', 'Submitted a wait, keeping the gift available.', '待機を送信し、贈与の機会を残しました。'],
  ['lucky_inspect', 3, '已提交对 3号 使用幸运儿查验。', 'Submitted a Lucky inspection of Player 3.', '3番への幸運者の占いを送信しました。'],
  ['lucky_poison', 3, '已提交对 3号 使用幸运儿毒药。', 'Submitted Lucky poison for Player 3.', '3番への幸運者の毒の使用を送信しました。'],
  ['lucky_guard', 3, '已提交对 3号 使用幸运儿守护。', 'Submitted Lucky protection for Player 3.', '3番への幸運者の護衛を送信しました。'],
  ['lucky_skip', null, '已提交保留幸运儿技能。', 'Submitted a choice to keep the Lucky ability.', '幸運者の能力を温存する選択を送信しました。'],
  ['wolf_king_shoot', 3, '已提交对 3号 开枪。', 'Submitted a shot at Player 3.', '3番への発砲を送信しました。'],
  ['wolf_king_hold_fire', null, '已提交放弃开枪。', 'Submitted the choice not to shoot.', '発砲しない選択を送信しました。'],
] as const)('%s 在三种对局语言中确认实际提交的行动', (tool, target, zh, en, ja) => {
  const args = target === null ? {} : { targetSeat: target };
  expect(['zh-CN', 'en', 'ja'].map((locale) => ownLine(tool, args, locale))).toEqual([zh, en, ja]);
});

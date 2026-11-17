import { describe, expect, it } from 'vitest';
import { ownLine } from '../src/agent';

describe.each([
  ['zh-CN', ['已提交向 3号 赠予查验。', '已提交向 3号 赠予毒药。', '已提交向 3号 赠予守护。', '已提交等待，保留交易机会。', '已提交对 3号 使用幸运儿查验。', '已提交对 3号 使用幸运儿毒药。', '已提交对 3号 使用幸运儿守护。', '已提交保留幸运儿技能。', '已提交对 3号 开枪。', '已提交放弃开枪。']],
  ['en-US', ['Submitted a gift of inspection to Player 3.', 'Submitted a gift of poison to Player 3.', 'Submitted a gift of protection to Player 3.', 'Submitted a wait, keeping the gift available.', 'Submitted a Lucky inspection of Player 3.', 'Submitted Lucky poison for Player 3.', 'Submitted Lucky protection for Player 3.', 'Submitted a choice to keep the Lucky ability.', 'Submitted a shot at Player 3.', 'Submitted the choice not to shoot.']],
  ['ja-JP', ['3番への占いの贈与を送信しました。', '3番への毒の贈与を送信しました。', '3番への護衛の贈与を送信しました。', '待機を送信し、贈与の機会を残しました。', '3番への幸運者の占いを送信しました。', '3番への幸運者の毒の使用を送信しました。', '3番への幸運者の護衛を送信しました。', '幸運者の能力を温存する選択を送信しました。', '3番への発砲を送信しました。', '発砲しない選択を送信しました。']],
])('商人、幸运儿和狼王的 %s 行动回执', (locale, expected) => {
  it('只确认所提交的选择', () => {
    const tools = ['merchant_gift_inspect', 'merchant_gift_poison', 'merchant_gift_guard', 'merchant_wait',
      'lucky_inspect', 'lucky_poison', 'lucky_guard', 'lucky_skip', 'wolf_king_shoot', 'wolf_king_hold_fire'];
    expect(tools.map((tool) => ownLine(tool, { targetSeat: 3 }, locale))).toEqual(expected);
  });
});


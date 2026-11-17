import { describe, expect, it } from 'vitest';
import { videoPerspectiveLabel, verticalVideoTitle } from '../../../scripts/video/video-perspective';

const cast = [
  { seat: 1, name: 'A', role: 'seer', roleName: '预言家', factionName: '', voiceKey: 'seat-1' },
  { seat: 2, name: 'B', role: 'werewolf', roleName: '狼人', factionName: '', voiceKey: 'seat-2' },
];
describe('vertical view labels', () => {
  it('labels god and public views without an excerpt badge', () => {
    expect(verticalVideoTitle({ perspective: 'god', cast, uiLocale: 'en' })).toBe('AI Werewolf · God view');
    expect(videoPerspectiveLabel({ perspective: 'public', cast, uiLocale: 'en' })).toBe('Public view');
  });
  it('uses only the selected player seat and its visible identity', () => {
    expect(videoPerspectiveLabel({ perspective: 'player', playerSeat: 1, cast, uiLocale: 'en' })).toBe('Seat 1 view · Seer');
    const hidden = [{ ...cast[0], role: 'unknown', roleName: '未知' }, cast[1]];
    expect(videoPerspectiveLabel({ perspective: 'player', playerSeat: 1, cast: hidden, uiLocale: 'en' })).toBe('Seat 1 view');
    expect(() => videoPerspectiveLabel({ perspective: 'player', playerSeat: 3, cast, uiLocale: 'en' })).toThrow();
  });
  it('uses the UI language independently of the original room text', () => {
    expect(videoPerspectiveLabel({ perspective: 'player', playerSeat: 1, cast, uiLocale: 'ja' })).toBe('1番視点 · 占い師');
    expect(videoPerspectiveLabel({ perspective: 'player', playerSeat: 1, cast, uiLocale: 'zh-CN' })).toBe('1号玩家视角 · 预言家');
  });
});

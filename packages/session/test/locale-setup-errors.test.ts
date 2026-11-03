import { describe, expect, it } from 'vitest';
import { apiErrorText, defaultGameTiming, LocalizedError, parseGameTiming } from '@werewolf/protocol';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';
import { ApiFailure } from '../src/room-failure';

describe('配置界面错误语言', () => {
  it('根据界面语言展示准备状态错误，不改变房间对局语言', () => {
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom({ locale: 'zh-CN' });
      manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, controller: 'human' }] });
      const english = manager.getSetup(roomId, hostToken, 'en');
      expect(english.locale).toBe('zh-CN');
      expect(english.validationErrors).toContain('Player 1: waiting for a human to join and confirm readiness');
      const japanese = manager.getSetup(roomId, hostToken, 'ja');
      expect(japanese.validationErrors).toContain('1番：人間プレイヤーの参加と準備完了を待っています');
      expect(manager.getSetup(roomId, hostToken).validationErrors).toContain('1号：等待真人进入座位并确认准备');
    } finally { manager.dispose(); }
  });
  it('配置错误保留原错误码及文本，另提供可翻译模板与参数', () => {
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom();
      let caught: unknown;
      try { manager.updateSetup(roomId, hostToken, { presetId: 'missing-preset' }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ApiFailure);
      expect(caught).toMatchObject({ code: 'BAD_REQUEST', message: '没有这个版型：missing-preset', localization: { key: '没有这个版型：{0}', values: ['missing-preset'] } });
    } finally { manager.dispose(); }
  });
  it.each([
    [null, '无效的节奏与时限设置', 'Invalid pacing and time limits', '進行間隔と制限時間の設定が無効です'],
    [{}, '缺少行动类型的时间设置', 'Time settings are missing for an action type', '行動種別の時間設定がありません'],
    [{ ...defaultGameTiming(), speech: { limitSec: 0, intervalMs: 0 } }, '行动时限为 1–3600 秒，推进间隔为 0–60000 毫秒', 'Action limits must be 1–3600 seconds and advance intervals 0–60000 milliseconds', '行動制限時間は 1〜3600 秒、進行間隔は 0〜60000 ミリ秒にしてください'],
  ])('时间配置错误保留明确模板并可翻译', (timing, key, english, japanese) => {
    let source: unknown;
    try { parseGameTiming(timing); } catch (error) { source = error; }
    expect(source).toBeInstanceOf(LocalizedError);
    expect(source).toMatchObject({ message: key, localization: { key, values: [] } });
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom();
      let caught: any;
      try { manager.updateSetup(roomId, hostToken, { timing: timing as any }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ApiFailure);
      expect(caught).toMatchObject({ code: 'BAD_REQUEST', message: key, localization: { key, values: [] } });
      expect(apiErrorText('en', caught.code, caught.localization)).toBe(english);
      expect(apiErrorText('ja', caught.code, caught.localization)).toBe(japanese);
      expect(manager.getSetup(roomId, hostToken).timing).toEqual(defaultGameTiming());
    } finally { manager.dispose(); }
  });
  it('非法协议的结构化错误跨会话层保留', () => {
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom();
      let caught: any;
      try { manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, apiProtocol: 'invalid' as any }] }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ApiFailure);
      expect(caught).toMatchObject({ code: 'BAD_REQUEST', message: '无效的接口协议', localization: { key: '无效的接口协议', values: [] } });
      expect(apiErrorText('en', caught.code, caught.localization)).not.toMatch(/[\u3400-\u9fff]/);
      expect(apiErrorText('ja', caught.code, caught.localization)).not.toBe(caught.message);
      expect(manager.getSetup(roomId, hostToken).seats[0].apiProtocol).toBe('chat_completions');
    } finally { manager.dispose(); }
  });
  it('开局错误细节按界面语言返回，旧文本保留房间语言', () => {
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom({ locale: 'zh-CN' });
      manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, controller: 'human' }, { seat: 2, controller: 'human' }] });
      for (const [locale, detail] of [
        ['en', 'Player 1: waiting for a human to join and confirm readiness；Player 2: waiting for a human to join and confirm readiness'],
        ['ja', '1番：人間プレイヤーの参加と準備完了を待っています；2番：人間プレイヤーの参加と準備完了を待っています'],
        [undefined, '1号：等待真人进入座位并确认准备；2号：等待真人进入座位并确认准备'],
      ] as const) {
        let caught: any;
        try { manager.start(roomId, hostToken, locale); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(ApiFailure);
        expect(caught).toMatchObject({ code: 'INVALID_SETUP', message: '1号：等待真人进入座位并确认准备；2号：等待真人进入座位并确认准备', localization: { key: '房间配置尚未准备好：{0}', values: [detail] } });
        expect(apiErrorText(locale, caught.code, caught.localization)).toContain(detail);
        expect(manager.getSetup(roomId, hostToken).locale).toBe('zh-CN');
      }
    } finally { manager.dispose(); }
  });
});

import { describe, expect, it } from 'vitest';
import { gameText, registerGameLanguage } from '@werewolf/protocol';
import { allPresets, buildRules, buildRuleCard, createGame, projectSeat, submit, waitingSeats } from '../src/index';
import { makeRand, randomCall } from './random';

describe('对局语言', () => {
  it('缺省保持中文，注册语言可继承模板且不会替换参数里的玩家原话', () => {
    expect(buildRules('standard12').locale).toBe('zh-CN');
    registerGameLanguage({ id: 'en-GB', label: 'English UK', languageName: 'British English', speechLang: 'en-GB', ttsLanguageHints: ['en'], fallback: 'en', messages: { 发言: 'Speak (UK)' } });
    expect(gameText('en-GB', '发言')).toBe('Speak (UK)');
    expect(gameText('en', 'toString')).toBe('toString');
    expect(gameText('en-GB', '{0}号', 3)).toBe('Player 3');
    expect(gameText('en', '法官：{0}{1}', '原话{1}', 'end')).toBe('Moderator: 原话{1}end');
    expect(() => buildRules('standard12', {}, { locale: 'unsupported' })).toThrow('Unsupported');
    expect(() => registerGameLanguage({ id: 'fr', label: 'Français', languageName: 'French', speechLang: 'fr-FR', ttsLanguageHints: ['fr'], fallback: 'en', messages: { '{0}号': 'Player' } })).toThrow('placeholders');
  });

  for (const preset of allPresets()) {
    it(`${preset.id} 的英语局覆盖规则、身份、动态问话和终局，日语使用同一规则分支`, () => {
      const english = buildRules(preset.id, {}, { locale: 'en' });
      const japanese = buildRules(preset.id, {}, { locale: 'ja' });
      expect(buildRuleCard(english)).not.toMatch(/[\u4e00-\u9fff]/);
      expect(buildRuleCard(japanese)).toContain('勝利');
      const rand = makeRand(518);
      let { state, events } = createGame({ id: 'locale', rules: english, seed: 'locale', names: english.roles.map((_, i) => `Name${i + 1}`) });
      let steps = 0;
      while (!state.result && steps++ < 2000) {
        const seat = waitingSeats(state)[0];
        const p = projectSeat(state, events, seat);
        expect(p.ruleCard + p.me!.appendix + p.task!.title + p.task!.prompt + JSON.stringify(p.task!.tools)).not.toMatch(/[\u4e00-\u9fff]/);
        const outcome = submit(state, { seat, call: randomCall(rand, state.pending!.tools[seat]) });
        const next = outcome.error ? submit(state, { seat, call: { tool: '', args: {} }, auto: true }) : outcome;
        state = next.state;
        events.push(...next.events);
        for (const event of next.events) {
          if (event.type !== 'speech' && event.type !== 'wolf.chat') expect(event.text, event.type).not.toMatch(/[\u4e00-\u9fff]/);
        }
      }
      expect(state.result).not.toBeNull();
    });
  }
});

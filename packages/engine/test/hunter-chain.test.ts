import { describe, expect, it } from 'vitest';
import { isGameLocale, registerGameLanguage } from '@werewolf/protocol';
import { buildRules, createGame, Ctx, findAbility, projectSeat, projectSpectator, replay, submit, validateRules } from '../src/index';
import { canHunterShoot, hunter, hunterAllowedCauseNames, hunterPoisonIsExcluded } from '../src/roles/hunter';
import { TestGame } from './harness';

const deal = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];

function mirror(shotVersion: 1 | 2 | 'missing' = 2, deathVersion: 1 | 2 = 2, values: Record<string, unknown> = {}): TestGame {
  const g = new TestGame({ preset: 'mirror12', deal, values: { 'sheriff.enabled': false, ...values }, deathResolutionVersion: deathVersion });
  if (shotVersion === 'missing') delete g.options.rules.hunterShotVersion;
  else g.options.rules.hunterShotVersion = shotVersion;
  const initial = createGame(g.options);
  g.state = initial.state;
  g.events = initial.events;
  g.actions = [];
  g.ok(4, 'awakened_mimic', { targetSeat: 7 });
  return g;
}

const copiedGun = (g: TestGame) => findAbility(new Ctx(g.state), 4, 'mimic:4');

describe('版本化猎枪连锁', () => {
  it('新局显式启用连枪；构建旧出局顺序时默认旧猎枪触发，并拒绝不受支持的组合', () => {
    expect(buildRules('mirror12').hunterShotVersion).toBe(2);
    expect(buildRules('mirror12', {}, { deathResolutionVersion: 1 }).hunterShotVersion).toBe(1);
    const rules = buildRules('mirror12');
    expect(validateRules({ ...rules, hunterShotVersion: 3 as 2 })).toContain('猎枪触发版本只支持 1 或 2');
    expect(validateRules({ ...rules, deathResolutionVersion: 1 })).toContain('猎枪触发版本 2 要求出局结算版本 2');
    delete rules.deathResolutionVersion;
    expect(validateRules(rules)).toContain('猎枪触发版本 2 要求出局结算版本 2');
    delete rules.hunterShotVersion;
    delete rules.electionExplosionVersion;
    expect(validateRules(rules)).toEqual([]);
  });

  it.each([[7, 4], [4, 7]] as const)('枪手%d被刀后射击%d，目标可继续向其他存活玩家开枪', (first, second) => {
    const g = mirror();
    g.night({ kill: first });
    expect(g.pending?.actors).toEqual([first]);
    g.ok(first, 'hunter_shoot', { target: second });
    expect(g.state.result).toBeNull();
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(g.pending?.actors).toEqual([second]);
    expect(g.state.deaths.find(d => d.seat === second)).toMatchObject({ via: 'shot', causes: ['shot'] });
    expect(g.act(second, 'hunter_shoot', { target: first })).toBeDefined();
    expect(g.pending?.actors).toEqual([second]);
    g.ok(second, 'hunter_shoot', { target: 9 });
    expect(g.state.players[8].alive).toBe(false);
    expect(g.events.filter(e => e.type === 'hunter.shot').map(e => e.payload.shooter)).toEqual([first, second]);
    expect(copiedGun(g).state.spent).toBe(true);
    expect(g.state.result).toBeNull();
    expect(g.pending?.step.kind).toBe('lastwords');
    expect(new Set(g.state.deaths.map(d => d.batch)).size).toBe(1);
  });

  it('复制猎人被枪击后可放弃，既不公开真实身份也不重复给枪', () => {
    const g = mirror();
    g.night({ kill: 7 });
    g.ok(7, 'hunter_shoot', { target: 4 });
    expect(projectSpectator(g.state, g.events).seats[3].revealedRole).toBeUndefined();
    const decisionId = g.pending!.id;
    g.ok(4, 'hunter_shoot', { target: null });
    expect(copiedGun(g).state.spent).toBe(true);
    expect(g.events.filter(e => e.type === 'hunter.shot')).toHaveLength(1);
    expect(projectSpectator(g.state, g.events).seats[3].revealedRole).toBeUndefined();
    expect(submit(g.state, { seat: 4, decisionId, call: { tool: 'hunter_shoot', args: { target: 9 } } }).error?.code).toBe('STALE_DECISION');
  });

  it('复制猎人实际连枪仅公开猎人表现，保留真实狼身份', () => {
    const g = mirror();
    g.night({ kill: 7 });
    g.ok(7, 'hunter_shoot', { target: 4 });
    g.ok(4, 'hunter_shoot', { target: 9 });
    expect(g.state.players[3].role).toBe('awakened_wolf');
    expect(projectSpectator(g.state, g.events).seats[3].revealedRole).toBe('hunter');
  });

  it.each(['good', 'wolf'] as const)('首枪已导致%s胜利时，不生成目标的下一枪', winner => {
    const g = mirror();
    if (winner === 'wolf') g.removeSeats(5, 6, 8);
    g.night({ kill: winner === 'good' ? 7 : 4 });
    if (winner === 'good') g.removeSeats(1, 2, 3);
    const first = winner === 'good' ? 7 : 4;
    const second = winner === 'good' ? 4 : 7;
    g.ok(first, 'hunter_shoot', { target: second });
    expect(g.state.result?.winner).toBe(winner);
    expect(g.pending).toBeNull();
    expect(g.events.filter(e => e.type === 'hunter.shot')).toHaveLength(1);
    expect(g.events.some(e => e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
    if (winner === 'good') expect(copiedGun(g).state.spent).toBe(false);
  });

  it('含毒限制与已经消耗的复制枪不会被新触发原因绕过', () => {
    const poisoned = mirror();
    poisoned.night({ kill: 4, poison: 4 });
    expect(poisoned.hasTool('hunter_shoot')).toBe(false);
    expect(copiedGun(poisoned).state.spent).toBe(false);
    const g = mirror();
    g.night({ kill: 7 });
    copiedGun(g).state.spent = true; // 独立资源回归：恢复快照中的已消耗实例。
    g.ok(7, 'hunter_shoot', { target: 4 });
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.events.filter(e => e.type === 'hunter.shot')).toHaveLength(1);
    expect(canHunterShoot(g.state.rules, { seat: 4, day: 1, via: 'shot', causes: ['shot', 'poison'], batch: 1, lastWords: false, hooked: false })).toBe(false);
  });

  it.each([1, 'missing'] as const)('旧猎枪版本%s保留双向不连枪，并精确重放旧行动', version => {
    for (const [first, second] of [[7, 4], [4, 7]] as const) {
      const g = mirror(version);
      g.night({ kill: first });
      g.ok(first, 'hunter_shoot', { target: second });
      expect(g.state.result).toBeNull();
      expect(g.hasTool('hunter_shoot')).toBe(false);
      expect(g.events.filter(e => e.type === 'hunter.shot')).toHaveLength(1);
      expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
      expect(g.state.rules.hunterShotVersion).toBe(version === 'missing' ? undefined : version);
    }
  });

  it('版本1出局顺序保持旧猎枪规则，缺省字段的快照恢复不自动升级', () => {
    const g = mirror('missing', 1);
    g.night({ kill: 7 });
    const restored = JSON.parse(JSON.stringify(g.state));
    const input = { seat: 7, call: { tool: 'hunter_shoot', args: { target: 4 } } };
    const result = submit(restored, input);
    expect(result.error).toBeUndefined();
    expect(result.state.pending?.step.kind).toBe('lastwords');
    expect(Object.hasOwn(result.state.rules, 'hunterShotVersion')).toBe(false);
    g.ok(7, 'hunter_shoot', { target: 4 });
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });

  it('新连枪版本在存档中保留，第二枪可从序列化快照恢复并精确重放', () => {
    const g = mirror();
    g.night({ kill: 7 });
    g.ok(7, 'hunter_shoot', { target: 4 });
    const saved = JSON.parse(JSON.stringify(g.state));
    expect(saved.rules.hunterShotVersion).toBe(2);
    const input = { seat: 4, call: { tool: 'hunter_shoot', args: { target: 9 } } };
    const loaded = submit(saved, input);
    g.ok(4, 'hunter_shoot', { target: 9 });
    expect(JSON.stringify(loaded.state)).toBe(JSON.stringify(g.state));
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });

  it('原因清单只在实际有两种枪来源的新版镜隐局列出猎枪，单枪版型不引入无关原因', () => {
    expect(hunterAllowedCauseNames(buildRules('mirror12'))).toContain('猎枪造成的出局');
    for (const preset of ['standard12', 'idiot12']) expect(hunterAllowedCauseNames(buildRules(preset))).not.toContain('猎枪造成的出局');
    expect(hunterAllowedCauseNames(buildRules('mirror12', {}, { hunterShotVersion: 1 }))).not.toContain('猎枪造成的出局');
  });

  it('自定义镜隐无女巫或无守卫时，不把无法模仿取得的药品或守护列为出局原因', () => {
    const noWitch = deal.map(role => role === 'witch' ? 'villager' : role);
    const noGuard = deal.map(role => role === 'guard' ? 'villager' : role);
    const withoutWitch = buildRules('mirror12', { 'hunter.shootOnPoison': true }, { roles: noWitch, allowFixed: true });
    expect(hunterAllowedCauseNames(withoutWitch)).not.toContain('出局原因含毒药');
    expect(hunterAllowedCauseNames(withoutWitch)).not.toContain('守卫守护和女巫解药同时作用于狼人攻击目标造成的出局');
    expect(hunterAllowedCauseNames(withoutWitch)).toContain('猎枪造成的出局');
    expect(hunterPoisonIsExcluded(buildRules('mirror12', {}, { roles: noWitch }))).toBe(false);
    const withoutGuard = buildRules('mirror12', { 'hunter.shootOnPoison': true }, { roles: noGuard, allowFixed: true });
    expect(hunterAllowedCauseNames(withoutGuard)).not.toContain('守卫守护和女巫解药同时作用于狼人攻击目标造成的出局');
    expect(hunterAllowedCauseNames(withoutGuard)).toContain('出局原因含毒药');
    expect(hunterAllowedCauseNames(withoutGuard)).toContain('猎枪造成的出局');
    expect(hunterAllowedCauseNames(buildRules('mirror12'))).toContain('守卫或模仿守卫的保护与女巫解药同时作用于狼人攻击目标造成的出局');
    expect(hunterPoisonIsExcluded(buildRules('mirror12'))).toBe(true);
  });

  it('英文方言沿注册回退链使用英文猎人列表分隔及私密说明句间空格', () => {
    if (!isGameLocale('en-GB')) registerGameLanguage({ id: 'en-GB', label: 'British English', languageName: 'British English', speechLang: 'en-GB', ttsLanguageHints: ['en'], fallback: 'en', messages: {} });
    const render = (locale: string) => {
      const rules = buildRules('standard12', {}, { locale });
      const { state, events } = createGame({ id: 'dialect-hunter', seed: 'fixed', rules });
      const seat = state.players.find(player => player.role === 'hunter')!.seat;
      return { card: hunter.ruleCard!(rules).join('\n'), appendix: projectSeat(state, events, seat).me!.appendix };
    };
    const english = render('en');
    const dialect = render('en-GB');
    expect(dialect).toEqual(english);
    expect(dialect.card).not.toContain('、');
    expect(dialect.card).not.toMatch(/[\u4e00-\u9fff]/);
    expect(dialect.card).not.toMatch(/\.[A-Z]/);
    expect(dialect.appendix).not.toMatch(/\.[A-Z]/);
  });

  const wordProfiles = [
    { 'lastWords.shotAfterFirstNight': false, 'lastWords.shotAfterLaterNight': false, 'lastWords.shotAfterVote': true },
    { 'lastWords.shotAfterFirstNight': true, 'lastWords.shotAfterLaterNight': true, 'lastWords.shotAfterVote': false },
  ];
  for (const version of [2, 1, 'missing'] as const) {
    for (const scene of ['first-night', 'later-night', 'exile'] as const) {
      for (const [first, second] of [[7, 4], [4, 7]] as const) {
        it.each(wordProfiles)(`版本${version} ${scene} 枪手${first}→${second}保留遗言来源/日期、快照与重放：%j`, profile => {
          const g = mirror(version, 2, profile);
          if (scene !== 'first-night') {
            g.night();
            if (scene === 'later-night') g.toNight();
          }
          if (scene === 'exile') {
            g.toVote();
            g.vote(Object.fromEntries(g.waiting().map(seat => [seat, first])));
          } else g.night({ kill: first });
          const origin = scene === 'exile' ? 'exile' : 'night';
          const day = scene === 'later-night' ? 2 : 1;
          const expectedWords = profile[scene === 'exile' ? 'lastWords.shotAfterVote' : scene === 'first-night' ? 'lastWords.shotAfterFirstNight' : 'lastWords.shotAfterLaterNight'];
          expect(g.pending?.actors).toEqual([first]);
          g.ok(first, 'hunter_shoot', { target: second });
          expect(g.state.result).toBeNull();
          expect(g.state.deaths.find(d => d.seat === second)).toMatchObject({ day, via: 'shot', shooterVia: origin, lastWords: expectedWords });
          const saved = JSON.parse(JSON.stringify(g.state));
          if (version !== 2) {
            expect(g.hasTool('hunter_shoot')).toBe(false);
            expect(saved.rules.hunterShotVersion).toBe(version === 'missing' ? undefined : version);
          } else {
            expect(g.pending?.actors).toEqual([second]);
            const restored = submit(saved, { seat: second, call: { tool: 'hunter_shoot', args: { target: 9 } } });
            expect(restored.error).toBeUndefined();
            g.ok(second, 'hunter_shoot', { target: 9 });
            expect(g.state.deaths.find(d => d.seat === 9)).toMatchObject({ day, via: 'shot', shooterVia: origin, lastWords: expectedWords });
            expect(JSON.stringify(restored.state)).toBe(JSON.stringify(g.state));
          }
          expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
        });
      }
    }
  }
});

import { describe, expect, it } from 'vitest';
import { gameRecordEvents } from '@werewolf/protocol';
import { buildRules, buildRuleCard, replay, submit } from '../src/index';
import { DEAL12, DEAL9, TestGame, lastPublic } from './harness';

const noSheriff = { 'sheriff.enabled': false };
const nightSecrets = /^(wolf|guard|seer|witch)\./;

function expectReplay(game: TestGame): void {
  expect(replay(game.options, game.actions)).toEqual({ state: game.state, events: game.events });
}

describe('核心对局流程', () => {
  it('从首夜合刀、守护和查验推进到次夜毒人，药品确认只发给女巫', () => {
    const game = new TestGame({ deal: DEAL12, toolsetVersion: 2, values: noSheriff });
    game.ok(8, 'guard_protect', { targetSeat: 10 });
    game.untilTool('wolf_discuss');
    game.ok(game.waiting()[0], 'wolf_discuss', { content: '首轮先分两组提议。' });
    game.untilTool('wolf_kill');
    game.ok(1, 'wolf_kill', { targetSeat: 9 });
    expect(game.view(1).task).toMatchObject({ submitted: true, submittedText: expect.stringContaining('9号') });
    expect(game.view(2).task).not.toHaveProperty('submittedText');
    game.ok(2, 'wolf_kill', { targetSeat: 9 });
    for (const seat of [3, 4]) game.ok(seat, 'wolf_kill', { targetSeat: 10 });
    expect(game.view(2).events.findLast((event) => event.type === 'wolf.kill.split')).toMatchObject({ audience: [1, 2, 3, 4] });
    for (const seat of game.waiting()) game.ok(seat, 'wolf_kill', { targetSeat: 9 });
    game.ok(5, 'seer_inspect', { targetSeat: 1 });
    expect(game.view(6).events.findLast((event) => event.type === 'witch.knife')).toMatchObject({ audience: [6], payload: { knife: 9 } });
    expect(game.act(6, 'witch_save', { poisonTarget: 7 })?.code).toBe('INVALID_ARGUMENT');
    expect(game.state.players[5].data).toMatchObject({ antidote: true, poison: true });
    game.ok(6, 'witch_save');
    expect(game.view(6).events.filter((event) => ['witch.save', 'witch.no_poison'].includes(event.type))).toMatchObject([
      { type: 'witch.save', text: '你对 9号 使用了解药。', audience: [6], payload: { target: 9 } },
      { type: 'witch.no_poison', text: '你今晚没有使用毒药。', audience: [6], payload: {} },
    ]);
    expect(gameRecordEvents(game.view(6).events, 'en').find((event) => event.type === 'witch.no_poison')?.text)
      .toBe('Witch (Player 6) did not use poison tonight.');
    expect(game.view(5).me?.knownIdentities).toEqual([{ seat: 1, kind: 'alignment', alignment: 'wolf', source: 'inspection' }]);
    expect(game.view(8).events.findLast((event) => event.type === 'guard.protect')).toMatchObject({ audience: [8], payload: { target: 10 } });
    expect(lastPublic(game, 'dawn')?.payload).toEqual({ deaths: [] });

    game.toNight();
    const guardTarget = game.toolsOf(8).find((tool) => tool.name === 'guard_protect')?.params[0];
    expect(guardTarget).toMatchObject({ kind: 'seat', options: expect.arrayContaining([9]) });
    expect(guardTarget?.kind === 'seat' && guardTarget.options.includes(10)).toBe(false);
    expect(game.act(8, 'guard_protect', { targetSeat: 10 })?.code).toBe('INVALID_ARGUMENT');
    game.ok(8, 'guard_skip');
    game.untilTool('wolf_kill');
    for (const seat of game.waiting()) game.ok(seat, 'wolf_kill', { targetSeat: 7 });
    game.untilTool('witch_poison');
    const witch = game.view(6);
    expect(witch.task?.tools.map((tool) => tool.name)).toEqual(['witch_poison', 'witch_skip']);
    expect(witch.task?.prompt).not.toMatch(/刀|7号/);
    expect(witch.events.filter((event) => event.day === 2 && event.type === 'witch.knife')).toEqual([]);
    expect(game.act(6, 'witch_save')?.code).toBe('TOOL_NOT_LEGAL');
    game.ok(6, 'witch_poison', { targetSeat: 7 });
    expect(game.view(6).events.filter((event) => ['witch.no_save', 'witch.poison'].includes(event.type))).toMatchObject([
      { type: 'witch.no_save', text: '你今晚没有使用解药。', audience: [6], payload: {} },
      { type: 'witch.poison', text: '你对 7号 使用了毒药。', audience: [6], payload: { target: 7 } },
    ]);
    expect(gameRecordEvents(game.view(6).events, 'ja').find((event) => event.type === 'witch.no_save')?.text)
      .toBe('魔女（6番）は今夜解毒薬を使わなかった。');
    expect(game.view(8).events.findLast((event) => event.type === 'guard.skip')).toMatchObject({ audience: [8], payload: {} });
    expect(game.view(5).events.findLast((event) => event.type === 'seer.skip')).toMatchObject({ audience: [5], payload: {} });
    for (const view of [game.view(9), game.spectator()]) {
      expect(view.events.filter((event) => nightSecrets.test(event.type) || event.type === 'action.rejected')).toEqual([]);
      expect(view.events.map((event) => event.seq)).toEqual(view.events.map((_, index) => index + 1));
    }
    expect(game.view(5).events.filter((event) => /^(wolf|guard|witch)\./.test(event.type))).toEqual([]);
    expect(lastPublic(game, 'dawn')?.payload).toEqual({ deaths: [7] });
    expect(game.state.deaths.find((death) => death.seat === 7)?.causes).toEqual(['wolf', 'poison']);
    expect(game.hasTool('hunter_shoot')).toBe(false);

    game.toNight();
    game.ok(8, 'guard_protect', { targetSeat: 10 });
    game.untilTool('wolf_kill');
    for (const seat of game.waiting()) game.ok(seat, 'wolf_kill', { targetSeat: 10 });
    game.until((g) => g.state.phase === 'day');
    expect(lastPublic(game, 'dawn')).toMatchObject({ day: 3, payload: { deaths: [] } });
    expectReplay(game);
  });

  it('竞选出的警长用加权票打破放逐 PK，逐狼出局后才向旁观者揭晓身份', () => {
    const game = new TestGame({ deal: DEAL9, electionVersion: 3 });
    game.night();
    game.untilTool('sheriff_signup');
    for (const seat of game.waiting()) game.ok(seat, 'sheriff_signup', { run: [8, 9].includes(seat) });
    game.untilTool('sheriff_vote');
    for (const seat of game.waiting()) game.ok(seat, 'sheriff_vote', { target: 8 });
    expect(game.state.sheriff).toBe(8);

    game.toVote();
    game.ok(5, 'vote', { target: 1 });
    expect(game.view(5).task).toMatchObject({ submitted: true, submittedText: '你投给了 1号。' });
    expect(game.view(6).task).not.toHaveProperty('submittedText');
    expect(lastPublic(game, 'vote.result')?.payload.kind).not.toBe('exile');
    game.vote({ 6: 1, 2: 4, 3: 4 });
    expect(lastPublic(game, 'vote.result')?.payload).toMatchObject({ outcome: 'pk', seats: [1, 4] });
    game.toVote();
    expect(game.waiting()).not.toContain(1);
    expect(game.waiting()).not.toContain(4);
    expect(game.toolsOf(8)[0].params[0]).toMatchObject({ options: [1, 4] });
    game.vote({ 5: 1, 8: 1, 2: 4, 3: 4 });
    expect(lastPublic(game, 'vote.result')?.payload.rows).toEqual([
      { target: 1, weight: 2.5, voters: [5, 8] },
      { target: 4, weight: 2, voters: [2, 3] },
    ]);
    expect(lastPublic(game, 'exile')?.payload).toMatchObject({ seat: 1 });
    expect(game.spectator().seats.every((seat) => seat.revealedRole === undefined)).toBe(true);

    for (const wolf of [2, 3]) {
      game.toNight();
      game.night();
      game.toVote();
      game.vote({ 8: wolf });
    }
    const ended = game.spectator();
    expect(ended.result?.winner).toBe('good');
    expect(ended.seats.map((seat) => seat.revealedRole)).toEqual(DEAL9);
    expect(ended.events.some((event) => event.type === 'review')).toBe(true);
    expect(game.view(1).events.filter((event) => event.type === 'wolf.chat' && event.day > 1)).toEqual([]);
    expectReplay(game);
  });

  it('觉醒隐狼继承狼刀后同夜攻击两人，女巫从存档恢复也只能选择一个受袭目标', () => {
    const deal = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
    const game = new TestGame({ preset: 'mirror12', deal, awakenedNightVersion: 2, values: noSheriff });
    game.ok(4, 'awakened_mimic', { targetSeat: 1 });
    expect(game.hasTool('awakened_claw')).toBe(false);
    game.night({ kill: 1, poison: 2 });
    game.toVote();
    game.vote({ 5: 3 });
    game.toNight();
    expect(game.waiting()).toEqual([4]);
    expect(game.view(4).events.findLast((event) => event.type === 'awakened.inherit')).toMatchObject({ day: 2, audience: [4] });
    game.ok(4, 'awakened_claw', { targetSeat: 9 });
    game.untilTool('awakened_kill');
    game.ok(4, 'awakened_kill', { targetSeat: 10 });
    game.untilTool('witch_act');
    const targets = game.view(6).events.findLast((event) => event.type === 'witch.targets');
    expect(targets).toMatchObject({ audience: [6], payload: { targets: [9, 10] } });
    expect(targets?.payload).not.toHaveProperty('knife');
    expect(game.view(9).events.some((event) => event.type === 'witch.targets')).toBe(false);
    expect(game.spectator().events.some((event) => event.type === 'witch.targets')).toBe(false);
    const skipped = submit(JSON.parse(JSON.stringify(game.state)), { seat: 6, call: { tool: 'witch_act', args: { saveTarget: null, poisonTarget: null } } });
    expect(skipped.events.find((event) => event.type === 'witch.no_save')).toMatchObject({ text: '你今晚没有使用解药。', audience: [6], payload: {} });
    expect(game.act(6, 'witch_act', { saveTarget: 11 })?.code).toBe('INVALID_ARGUMENT');

    const input = { seat: 6, call: { tool: 'witch_act', args: { saveTarget: 9 } } };
    const restored = submit(JSON.parse(JSON.stringify(game.state)), input);
    const before = game.events.length;
    game.ok(input.seat, input.call.tool, input.call.args);
    expect(restored).toEqual({ state: game.state, events: game.events.slice(before) });
    expect(game.alive()).toContain(9);
    expect(game.state.deaths.filter((death) => death.day === 2).map(({ seat, causes }) => ({ seat, causes }))).toEqual([{ seat: 10, causes: ['wolf'] }]);
    expect(game.view(6).events.findLast((event) => event.type === 'witch.save')?.payload).toEqual({ target: 9 });
    expectReplay(game);
  });

  it('同一局面下新规则在最后神职出局时立即判胜，缺省版本的旧存档仍可开枪反胜', () => {
    const deal = ['werewolf', 'hunter', 'villager', 'villager'];
    const game = new TestGame({ deal, values: noSheriff });
    game.untilTool('wolf_kill');
    const legacy = JSON.parse(JSON.stringify(game.state)) as typeof game.state;
    delete legacy.rules.deathResolutionVersion;
    delete legacy.rules.electionExplosionVersion;
    const knife = { seat: 1, call: { tool: 'wolf_kill', args: { target: 2 } } };

    game.ok(knife.seat, knife.call.tool, knife.call.args);
    expect(game.state.result?.winner).toBe('wolf');
    expect(game.view(2).task).toBeNull();
    expect(lastPublic(game, 'hunter.shot')).toBeUndefined();

    const resumed = submit(legacy, knife);
    expect(resumed.error).toBeUndefined();
    expect(resumed.state.result).toBeNull();
    expect(resumed.state.pending?.actors).toEqual([2]);
    expect(resumed.state.pending?.tools[2].map((tool) => tool.name)).toContain('hunter_shoot');
    const shot = submit(resumed.state, { seat: 2, call: { tool: 'hunter_shoot', args: { target: 1 } } });
    expect(shot.error).toBeUndefined();
    expect(shot.state.rules.deathResolutionVersion).toBeUndefined();
    expect(shot.state.result?.winner).toBe('good');
    expect(shot.events.find((event) => event.type === 'hunter.shot')).toMatchObject({ audience: 'public', payload: { shooter: 2, target: 1 } });
    expectReplay(game);
  });

  it('警上自爆先结算首夜猎枪与遗言，再延期到次日按原候选资格续选', () => {
    const game = new TestGame({ deal: DEAL12, electionVersion: 3 });
    game.night({ kill: 7 });
    game.untilTool('sheriff_signup');
    for (const seat of game.waiting()) game.ok(seat, 'sheriff_signup', { run: [1, 10, 11].includes(seat) });
    game.until((g) => g.pending?.step.kind === 'campaign');
    game.ok(1, 'wolf_explode');
    expect(lastPublic(game, 'dawn')?.payload).toEqual({ deaths: [7] });
    expect(lastPublic(game, 'sheriff.postponed')).toBeUndefined();
    expect(game.view(7).me?.canStop).toBe(false);
    game.ok(7, 'hunter_shoot', { target: 9 });
    for (const seat of [1, 7, 9]) {
      expect(game.pending?.step.kind).toBe('lastwords');
      expect(game.waiting()).toEqual([seat]);
      game.ok(seat, 'speak', { content: '这是我的遗言。' });
    }
    expect(game.view(7).me?.canStop).toBe(true);
    expect(game.events.filter((event) => event.type === 'sheriff.postponed')).toHaveLength(1);
    expect(game.state.day).toBe(2);

    game.night({ kill: 12 });
    expect(lastPublic(game, 'sheriff.resume')?.payload).toMatchObject({ mode: 'vote', candidates: [10, 11] });
    expect(lastPublic(game, 'dawn')?.day).toBe(1);
    for (const seat of game.waiting()) game.ok(seat, 'wolf_explode_decision', { explode: false });
    expect(game.hasTool('sheriff_vote')).toBe(true);
    expect(game.waiting()).toContain(12);
    for (const seat of game.waiting()) game.ok(seat, 'sheriff_vote', { target: 10 });
    expect(game.state.sheriff).toBe(10);
    expect(lastPublic(game, 'dawn')).toMatchObject({ day: 2, payload: { deaths: [12] } });
    expect(lastPublic(game, 'vote.result')!.seq).toBeLessThan(lastPublic(game, 'dawn')!.seq);
    expectReplay(game);
  });

  it('报名期间拒绝自爆，报名之前的遗言自爆则延期后重新报名', () => {
    const defaults = buildRules('standard12');
    expect(defaults).toMatchObject({ electionVersion: 4, inspectionVersion: 2 });
    expect(buildRuleCard(defaults)).toContain('警长报名期间不能自爆');
    expect(buildRuleCard(defaults)).toContain('也可以空验');
    const game = new TestGame({ deal: DEAL12, electionVersion: 4, values: { 'sheriff.timing': 'after_last_words' } });
    game.night({ kill: 12 });
    expect(game.pending?.step.kind).toBe('lastwords');
    expect(game.view(1).interrupts.map((tool) => tool.name)).toContain('wolf_explode');
    game.ok(1, 'wolf_explode');
    game.until((g) => g.state.day === 2 && g.state.phase === 'night');
    expect(lastPublic(game, 'sheriff.postponed')?.text).toContain('重新报名');
    game.night();
    game.untilTool('sheriff_signup');
    expect(game.view(2).interrupts.map((tool) => tool.name)).not.toContain('wolf_explode');
    expect(game.act(2, 'wolf_explode')?.code).toBe('TOOL_NOT_LEGAL');
    expect(game.state.election.status).toBe('running');
    expectReplay(game);
  });

  it('新版查验可主动空验，旧版仍拒绝空验；模仿魔镜也可空验', () => {
    const game = new TestGame({ deal: DEAL12, toolsetVersion: 2, values: noSheriff });
    game.untilTool('seer_skip');
    expect(game.toolsOf(5).map((tool) => tool.name)).toContain('seer_inspect');
    game.ok(5, 'seer_skip');
    expect(game.view(5).events.findLast((event) => event.type === 'seer.skip')).toBeDefined();
    expect(game.view(5).me?.knownIdentities).toEqual([]);
    expectReplay(game);

    const old = new TestGame({ deal: DEAL12, toolsetVersion: 1, inspectionVersion: 1, values: noSheriff });
    delete old.state.rules.inspectionVersion;
    old.untilTool('seer_inspect');
    expect(old.act(5, 'seer_inspect', { target: null })?.code).toBe('INVALID_ARGUMENT');
    old.auto(5);
    expect(old.view(5).events.findLast((event) => event.type === 'seer.skip')).toBeDefined();

    const deal = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
    const mirror = new TestGame({ preset: 'mirror12', deal, toolsetVersion: 2, values: noSheriff });
    mirror.ok(4, 'awakened_mimic', { targetSeat: 5 });
    mirror.untilTool('mirror_skip');
    expect(mirror.waiting()).toContain(5);
    mirror.ok(5, 'mirror_skip');
    expect(mirror.view(5).events.findLast((event) => event.type === 'mirror.skip')).toBeDefined();
    mirror.toNight();
    mirror.until((g) => g.waiting().includes(4) && g.hasTool('mirror_skip'));
    mirror.ok(4, 'mirror_skip');
    expect(mirror.view(4).events.findLast((event) => event.type === 'mirror.skip')).toBeDefined();
    expectReplay(mirror);

    const exhausted = new TestGame({ preset: 'mirror12', deal, toolsetVersion: 2, values: noSheriff });
    exhausted.untilTool('wolf_kill');
    exhausted.state.players[4].data.roleChecks = exhausted.alive().filter((seat) => seat !== 5).map((target) => ({ night: 0, target, role: 'villager' }));
    exhausted.untilTool('witch_skip');
    expect(exhausted.view(5).events.some((event) => event.type === 'mirror.result' || event.type === 'mirror.skip')).toBe(false);
  });

});

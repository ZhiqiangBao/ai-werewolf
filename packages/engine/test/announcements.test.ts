import { describe, expect, it } from 'vitest';
import { DEAL12, TestGame } from './harness';

describe('法官的行动问话和一次播报', () => {
  it('每次问话都有记录、决策编号和正确受众；刀口与上警不重复问', () => {
    const g = new TestGame({ deal: DEAL12 });
    const checked = new Set<string>();
    const required = ['night:guard', 'wolf.discuss', 'wolf.kill', 'night:seer', 'night:witch', 'sheriff.signup', 'sheriff.vote', 'day.discussion', 'exile.vote', 'hunter.shoot', 'badge.duty'];
    for (let i = 0; i < 250 && !g.state.result; i++) {
      const d = g.pending!;
      const questions = g.events.filter((e) => e.payload.decisionId === d.id);
      expect(questions.length, d.step.type).toBeGreaterThan(0);
      expect(d.openedAtSeq).toBe(g.events.at(-1)?.seq);
      for (const seat of d.actors) {
        const own = questions.filter((e) => e.audience === 'public' || (e.audience as number[]).includes(seat));
        expect(own).toHaveLength(1);
        expect(own[0].payload.prompt ?? own[0].text).toContain(d.prompts[seat]);
      }
      checked.add(d.step.type);
      if (required.every((step) => checked.has(step))) break;
      const actor = g.waiting()[0];
      if (g.hasTool('sheriff_signup')) g.ok(actor, 'sheriff_signup', { run: [9, 10].includes(actor) });
      else if (g.hasTool('sheriff_vote')) g.ok(actor, 'sheriff_vote', { target: 9 });
      else if (g.hasTool('wolf_kill')) g.ok(actor, 'wolf_kill', { target: 7 });
      else if (g.hasTool('seer_inspect')) g.ok(actor, 'seer_inspect', { target: 1 });
      else if (g.hasTool('vote')) g.ok(actor, 'vote', { target: 9 });
      else if (g.hasTool('hunter_shoot')) g.ok(actor, 'hunter_shoot', { target: 12 });
      else g.auto(actor);
    }
    for (const step of required) {
      expect(checked.has(step), step).toBe(true);
    }
  });

  it('放逐的票型、平票 PK、再次平票和出局各只有一次播报', () => {
    const g = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
    g.night({ kill: null });
    g.toVote();
    let start = g.events.length;
    g.vote({ 1: 9, 2: 10 });
    let spoken = g.events.slice(start).filter((e) => e.audience === 'public' && !e.payload.announced);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].payload.outcome).toBe('pk');
    expect(spoken[0].text).toContain('9号、10号平票');
    g.untilTool('vote');
    start = g.events.length;
    g.vote({ 1: 9, 2: 10 });
    spoken = g.events.slice(start).filter((e) => e.type === 'vote.result' || e.type === 'vote.none');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].payload.outcome).toBe('none');
    g.toNight(); g.night({ kill: null }); g.toVote();
    start = g.events.length;
    g.vote({ 1: 9, 2: 9 });
    spoken = g.events.slice(start).filter((e) => e.audience === 'public' && !e.payload.announced);
    expect(spoken).toHaveLength(1);
    expect(spoken[0].payload.outcome).toBe('exile');
    expect(spoken[0].text).toContain('9号被投票放逐');
    expect(g.state.players[8].alive).toBe(false);
  });
});

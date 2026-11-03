import { describe, expect, it } from 'vitest';
import { DEAL12, TestGame } from './harness';

const noSheriff = { 'sheriff.enabled': false };

describe('本席玩家客户端结束条件', () => {
  it('同批遗言尚未轮到本席时不能提前结束，本席完成后不必等他人', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    expect(g.view(9).me?.canStop).toBe(false);
    g.night({ kill: 9, poison: 10 });
    expect(g.view(9).task?.tools[0].name).toBe('speak');
    expect(g.view(10).task).toBeNull();
    expect(g.view(10).me?.canStop).toBe(false);
    g.ok(9, 'speak', { content: '遗言' });
    expect(g.view(9).me?.canStop).toBe(true);
    expect(g.view(10).me?.canStop).toBe(false);
    g.ok(10, 'speak', { content: '遗言' });
    expect(g.view(10).me?.canStop).toBe(true);
    expect(g.state.result).toBeNull();
    expect(g.spectator().me).toBeUndefined();
  });

  it('猎人警长依次处理开枪、警徽、遗言后才结束，猎枪目标保留自己的职责', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.state.sheriff = 7;
    g.night({ kill: 7 });
    expect(g.view(7).task?.tools[0].name).toBe('hunter_shoot');
    expect(g.view(7).me?.canStop).toBe(false);
    g.ok(7, 'hunter_shoot', { target: 9 });
    expect(g.view(7).task?.tools[0].name).toBe('badge_dispose');
    expect(g.view(7).me?.canStop).toBe(false);
    expect(g.view(9).me?.canStop).toBe(false);
    g.ok(7, 'badge_dispose', { target: 8 });
    expect(g.view(7).task?.tools[0].name).toBe('speak');
    expect(g.view(7).me?.canStop).toBe(false);
    g.ok(7, 'speak', { content: '遗言' });
    expect(g.view(7).me?.canStop).toBe(true);
    expect(g.view(9).me?.canStop).toBe(false);
    g.ok(9, 'speak', { content: '遗言' });
    expect(g.view(9).me?.canStop).toBe(true);
  });

  it('没有遗言的夜间出局在死亡职责结算后结束', () => {
    const g = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'lastWords.firstNight': false } });
    g.night({ kill: 9 });
    expect(g.view(9).task).toBeNull();
    expect(g.view(9).me?.canStop).toBe(true);
    expect(g.view(10).me?.canStop).toBe(false);
  });

  it('旧存档死亡尚未挂接或仍有延迟职责时保持等待', () => {
    const g = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'lastWords.firstNight': false } });
    g.night({ kill: 9 });
    const death = g.state.deaths.find((d) => d.seat === 9)!;
    death.hooked = false;
    expect(g.view(9).me?.canStop).toBe(false);
    death.hooked = true;
    g.state.agenda.push({ type: 'fixture.deferred', dutySeat: 9 });
    expect(g.view(9).me?.canStop).toBe(false);
  });
});

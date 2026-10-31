import { describe, expect, it } from 'vitest';
import { seatTools } from '../src/catalog';
import { DEAL12, TestGame } from './harness';
import { toolToJsonSchema } from '@werewolf/protocol';
import { registerRole } from '../src/registry';

describe('座位工具目录', () => {
  it('注册新身份即可提供固定工具，重复名称/流程不会静默覆盖', () => {
    registerRole({ id: 'catalog_probe', name: '目录测试', faction: 'good', category: 'god', maxPerGame: 1, summary: '测试模块', tools: ({ seats }) => [{ name: 'catalog_probe_act', title: '测试', description: '选择整数座位号。', params: [{ kind: 'seat', name: 'target', label: '目标', options: seats }] }] });
    const g = new TestGame({ deal: DEAL12 });
    const state = structuredClone(g.state); state.players[8].role = 'catalog_probe';
    expect(seatTools(state, 9).at(-1)?.name).toBe('catalog_probe_act');
    expect(seatTools(state, 9).some((t) => t.name === 'seer_inspect')).toBe(false);
    expect(() => registerRole({ id: 'invalid_probe', name: '错误', faction: 'good', category: 'god', maxPerGame: 1, summary: '错误', steps: { 'night:seer': { run() {} } } })).toThrow('重名');
  });

  it('全部15种工具的 JSON 示例符合其参数 Schema；动态行动采用同一份说明', () => {
    const g = new TestGame({ deal: DEAL12 });
    const tools = new Map(g.state.players.flatMap((p) => seatTools(g.state, p.seat)).map((t) => [t.name, t]));
    expect(tools.size).toBe(15);
    for (const tool of tools.values()) {
      const schema = toolToJsonSchema(tool);
      const examples = [...tool.description.matchAll(/\{[^{}]*\}/g)].map((m) => JSON.parse(m[0]));
      expect(examples.length, tool.name).toBeGreaterThan(0);
      for (const example of examples) {
        expect(Object.keys(example).sort(), tool.name).toEqual([...schema.required as string[]].sort());
        for (const p of tool.params) {
          const value = example[p.name];
          if (p.kind === 'seat') expect(value === null ? p.nullable : Number.isInteger(value) && p.options.includes(value), tool.name).toBeTruthy();
          if (p.kind === 'boolean') expect(typeof value, tool.name).toBe('boolean');
          if (p.kind === 'choice') expect(p.options.map((o) => o.value), tool.name).toContain(value);
          if (p.kind === 'text') expect(typeof value, tool.name).toBe('string');
        }
      }
    }
    g.until((game) => !!game.state.result, (_seat, offered) => {
      for (const tool of offered) expect(tool.description).toBe(tools.get(tool.name)?.description);
      return undefined;
    }, 800);
  });

  it('基础工具和身份工具整局固定，参数不随阶段变化', () => {
    const g = new TestGame({ deal: DEAL12 });
    const names = (seat: number) => seatTools(g.state, seat).map((t) => t.name);
    expect(names(1)).toEqual([
      'speak',
      'vote',
      'sheriff_signup',
      'sheriff_withdraw',
      'sheriff_vote',
      'set_speak_direction',
      'badge_dispose',
      'wolf_discuss',
      'wolf_kill',
      'wolf_explode',
      'wolf_explode_decision',
    ]);
    expect(names(5)).toContain('seer_inspect');
    expect(names(5)).not.toContain('wolf_kill');
    expect(names(9)).not.toContain('seer_inspect');

    const speak = seatTools(g.state, 1).find((t) => t.name === 'speak');
    const withdraw = seatTools(g.state, 1).find((t) => t.name === 'sheriff_withdraw');
    expect(speak?.description).not.toMatch(/\d+\s*字/);
    expect(speak?.params[0]).toMatchObject({ kind: 'text', name: 'content' });
    expect(speak?.params[0]).not.toHaveProperty('maxLength');
    expect(withdraw?.params[0]).not.toHaveProperty('maxLength');
    const discuss = seatTools(g.state, 1).find((t) => t.name === 'wolf_discuss');
    expect(discuss?.description).not.toMatch(/\d+\s*字/);
    expect(discuss?.params[0]).not.toHaveProperty('maxLength');

    const witch = seatTools(g.state, 6).find((t) => t.name === 'witch_act');
    expect(witch?.params.map((p) => p.name)).toEqual(['save', 'poisonTarget']);
    const before = JSON.stringify(seatTools(g.state, 6));
    g.until((x) => x.pending?.step.type === 'night:witch');
    expect(JSON.stringify(seatTools(g.state, 6))).toBe(before);
  });
});

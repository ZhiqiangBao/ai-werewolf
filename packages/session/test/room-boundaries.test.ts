import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const services = ['room-lobby', 'room-runtime', 'room-view', 'room-persistence'];

it('业务服务不反向依赖兼容入口，且可达的本地模块没有循环依赖', () => {
  const complete = new Set<string>();
  const visit = (file: string, ancestors: string[]) => {
    expect(ancestors, `循环依赖：${[...ancestors, file].join(' → ')}`).not.toContain(file);
    if (complete.has(file)) return;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const dependency = resolve(dirname(file), `${match[1]}.ts`);
      expect(dependency).not.toBe(resolve(sourceDir, 'manager.ts'));
      expect(dependency).not.toBe(resolve(sourceDir, 'index.ts'));
      visit(dependency, [...ancestors, file]);
    }
    complete.add(file);
  };
  for (const service of services) visit(resolve(sourceDir, `${service}.ts`), []);
});

it('兼容入口不直接执行引擎或模型流程，也不保存调度、连接或保存计时器', () => {
  const source = readFileSync(resolve(sourceDir, 'manager.ts'), 'utf8');
  expect(source).not.toMatch(/from ['"]@werewolf\/(engine|llm)['"]/);
  expect(source).not.toMatch(/\b(setTimeout|setInterval|AbortController|inflight|subscribers|stepBudget|saveTimer|thoughtTimer)\b/);
});

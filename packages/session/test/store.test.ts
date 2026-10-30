import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore, type RoomRecord } from '../src/store';

describe('座位文件', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('每个座位单独存文件，房间文件仍保留公屏事件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-seats-'));
    dirs.push(dir);
    const store = new FileStore(dir);
    const room = {
      id: 'room1',
      events: [{ seq: 1, type: 'speech', text: '1号发言：你好', audience: 'public' }],
      threads: [
        {
          seat: 1,
          seen: 3,
          messages: [
            { role: 'system', content: '规则' },
            { role: 'user', name: '2', content: '第1天2号发言：你好' },
          ],
        },
        { seat: 2, seen: 3, messages: [{ role: 'assistant', content: '你好' }] },
      ],
    } as unknown as RoomRecord;
    store.save(room);
    const main = JSON.parse(readFileSync(join(dir, 'rooms', 'room1.json'), 'utf8')) as RoomRecord;
    expect(main.threads).toBeUndefined();
    expect(main.events).toHaveLength(1);
    const s1 = JSON.parse(readFileSync(join(dir, 'rooms', 'room1', 's1.json'), 'utf8')) as { messages: { content: string }[] };
    expect(s1.messages[1].content).toContain('第1天2号发言');
    expect(store.loadAll()[0].threads?.map((t) => t.seat)).toEqual([1, 2]);

    room.threads = [{ seat: 2, seen: 4, messages: [{ role: 'assistant', content: '留下' }] }];
    store.save(room);
    expect(existsSync(join(dir, 'rooms', 'room1', 's1.json'))).toBe(false);
    expect(store.loadAll()[0].threads?.map((t) => t.seat)).toEqual([2]);
    expect(store.loadAll()[0].events).toHaveLength(1);
  });

  it('旧房间把座位内容嵌在房间文件里时仍能读出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-seats-'));
    dirs.push(dir);
    const store = new FileStore(dir);
    writeFileSync(
      join(dir, 'rooms', 'old.json'),
      JSON.stringify({ id: 'old', events: [{ seq: 1 }], threads: [{ seat: 4, seen: 1, messages: [{ role: 'user', content: '旧的' }] }] }),
    );
    const loaded = store.loadAll().find((r) => r.id === 'old');
    expect(loaded?.threads?.[0].messages[0].content).toBe('旧的');
    expect(loaded?.events).toHaveLength(1);
  });
});

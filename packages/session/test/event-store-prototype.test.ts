import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { RoomViewService } from '../src/room-view';
import { FileStore } from '../src/store';
import { EventStorePrototype, type Patch } from '../scripts/event-store-prototype';
import { fixture } from '../scripts/event-store-fixture';

const dirs: string[] = [];
function directory() { const d = mkdtempSync(resolve('event-store-test-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const views = new RoomViewService(() => 0, { seatView: (s) => ({ ...s, apiKeyMasked: null }), setupErrors: () => [], scheduleSave: () => {} });

it('restores full record, deletions, opaque seat continuation and both existing export structures', () => {
  const initial = fixture(); const dir = directory(); const s = new EventStorePrototype(dir, initial);
  const threads = structuredClone(initial.threads!);
  threads[0].messages.push({ role: 'assistant', content: null, calls: [{ id: 'c', name: 'x', arguments: '{}' }], native: { protocol: 'responses', binding: 'synthetic', items: [{ opaque: 'synthetic' }] } });
  const patch: Patch = { set: { threads, deadlines: { 'decision:1': 123 }, participants: { 1: { joined: true, ready: false } },
    seats: initial.seats.map((v, i) => i ? v : { ...v, apiKeyEnc: 'synthetic-encrypted', apiKeyMask: '***', model: 'synthetic' }), paused: true }, unset: ['heardSeq'] };
  expect(s.commit('full-patch', patch)).toBe('committed');
  const expected = structuredClone(initial); Object.assign(expected, patch.set); delete expected.heardSeq;
  const append: Patch = { actions: [initial.actions[0]], events: [initial.events[0]] };
  s.commit('append', append); expected.actions.push(initial.actions[0]); expected.events.push(initial.events[0]);
  s.checkpoint(); const recovered = new EventStorePrototype(dir).value();
  expect(recovered).toEqual(expected);
  const current = new FileStore(directory()); current.save(expected); const existing = current.loadAll()[0];
  for (const kind of ['god', 'public'] as const) expect(views.exportRecord(recovered, { role: 'host' }, kind)).toEqual(views.exportRecord(existing, { role: 'host' }, kind));
  expect(new EventStorePrototype(dir).commit('full-patch', patch)).toBe('duplicate');
  expect(() => s.commit('full-patch', { set: { paused: false } })).toThrow(/different/);
});

it('repairs only a partial tail, permits subsequent append and fails closed on a complete bad frame', () => {
  const dir = directory(); const s = new EventStorePrototype(dir, fixture());
  s.commit('first', { set: { paused: true } });
  writeFileSync(join(dir, 'snapshot.json.tmp'), '{unfinished');
  appendFileSync(join(dir, 'events.jsonl'), '{partial');
  const repaired = new EventStorePrototype(dir); repaired.commit('second', { set: { paused: false } });
  expect(new EventStorePrototype(dir).value().paused).toBe(false);
  appendFileSync(join(dir, 'events.jsonl'), '{bad}\n');
  expect(() => new EventStorePrototype(dir)).toThrow();
});

it('owns nested set values and appended messages after commit and checkpoint', () => {
  const dir = directory(); const s = new EventStorePrototype(dir, fixture());
  const participants = { 1: { joined: true, ready: false } };
  const messages = [{ role: 'user' as const, content: 'committed' }];
  const patch: Patch = { set: { participants }, messages: { seat: 1, values: messages } };
  s.commit('owned', patch);
  participants[1].ready = true; messages[0].content = 'modified'; messages.push({ role: 'user', content: 'uncommitted' });
  const expected = s.value();
  expect(expected.participants![1].ready).toBe(false);
  expect(expected.threads!.find((thread) => thread.seat === 1)!.messages.at(-1)).toEqual({ role: 'user', content: 'committed' });
  expect(new EventStorePrototype(dir).value()).toEqual(expected);
  s.checkpoint();
  expect(new EventStorePrototype(dir).value()).toEqual(expected);
});

it('rejects a journal copied from another room and a snapshot referring to a different journal', () => {
  const a = directory(), b = directory(), c = directory(); const one = fixture(), two = structuredClone(one); two.id = 'different';
  const sa = new EventStorePrototype(a, one); const sb = new EventStorePrototype(b, two);
  sa.commit('a', { set: { paused: true } }); sa.checkpoint(); sb.commit('b', { set: { paused: false } });
  writeFileSync(join(a, 'events.jsonl'), readFileSync(join(b, 'events.jsonl')));
  expect(() => new EventStorePrototype(a)).toThrow();
  const sc = new EventStorePrototype(c, one); sc.commit('different-entry', { set: { paused: false } });
  writeFileSync(join(a, 'events.jsonl'), readFileSync(join(c, 'events.jsonl')));
  expect(() => new EventStorePrototype(a)).toThrow(/snapshot journal mismatch/);
});

for (const mode of ['before-reply', 'after-reply']) it(`recovers one committed action after child is killed ${mode}`, async () => {
  const dir = directory(); const initial = fixture(); new EventStorePrototype(dir, initial);
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/session/scripts/event-store-child.ts'), dir, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolveReady, reject) => {
    let stderr = ''; child.stderr.on('data', (x) => { stderr += x; });
    child.on('error', reject); child.on('exit', (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
    child.stdout.on('data', (x) => { if (String(x).includes('ready')) resolveReady(); });
  });
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL'); await exited;
  const recovered = new EventStorePrototype(dir);
  expect(recovered.value().paused).toBe(true);
  expect(recovered.value().actions).toHaveLength(initial.actions.length + 1);
  expect(recovered.commit('action-1', { set: { paused: true }, actions: [initial.actions[0]] })).toBe('duplicate');
  expect(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
}, 30000);

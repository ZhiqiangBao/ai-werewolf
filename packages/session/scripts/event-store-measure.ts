/** Offline, synthetic, single-process microbenchmark. Output contains numbers only. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileStore } from '../src/store';
import { RoomViewService } from '../src/room-view';
import { fixture } from './event-store-fixture';
import { EventStorePrototype, type Patch } from './event-store-prototype';

const temp = mkdtempSync(resolve('event-store-measure-'));
const now = () => performance.now();
const samples = (f: () => void, n: number) => Array.from({ length: n }, () => { const t = now(); f(); return now() - t; });
const stats = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return { count: s.length, p50: +s[Math.floor((s.length - 1) * .5)].toFixed(3), p95: +s[Math.floor((s.length - 1) * .95)].toFixed(3), total: +s.reduce((x, y) => x + y, 0).toFixed(3) }; };
function bytes(dir: string): number { return readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? bytes(join(dir, d.name)) : statSync(join(dir, d.name)).size), 0); }
const sumHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
try {
  const initial = fixture(); const baseline = structuredClone(initial);
  const currentDir = join(temp, 'current'); const prototypeDir = join(temp, 'prototype'); mkdirSync(currentDir); mkdirSync(prototypeDir);
  const current = new FileStore(currentDir); const experimental = new EventStorePrototype(prototypeDir, initial);
  current.save(baseline);
  const clone = samples(() => { structuredClone(baseline); }, 40);
  const serialize = samples(() => { const { threads, ...rest } = baseline; JSON.stringify(rest); for (const thread of threads ?? []) JSON.stringify(thread, null, 2); }, 40);
  const writeDir = join(temp, 'write-only'); mkdirSync(writeDir);
  const { threads, ...rest } = baseline;
  const serialized = [['room.json', JSON.stringify(rest)], ...(threads ?? []).map((thread) => [`s${thread.seat}.json`, JSON.stringify(thread, null, 2)])];
  const writeOnly = samples(() => { for (const [name, text] of serialized) { const file = join(writeDir, name); writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); } }, 40);
  const fileSaves: number[] = [], commits: number[] = [], checkpoints: number[] = [];
  for (let i = 0; i < 40; i++) {
    const seat = i % 12 + 1; const message = { role: 'user' as const, content: `synthetic-update-${i}:` + '甲乙丙丁'.repeat(64) };
    const patch: Patch = { messages: { seat, values: [message] } };
    baseline.threads!.find((t) => t.seat === seat)!.messages.push(message);
    let t = now(); current.save(baseline); fileSaves.push(now() - t);
    t = now(); experimental.commit(`update-${i}`, patch); commits.push(now() - t);
    if ((i + 1) % 20 === 0) { t = now(); experimental.checkpoint(); checkpoints.push(now() - t); }
  }
  if (JSON.stringify(baseline) !== JSON.stringify(experimental.value())) throw new Error('prototype differs from source');
  const loadCurrent = samples(() => { const loaded = current.loadAll(); if (loaded.length !== 1) throw new Error('load failed'); }, 15);
  const loadPrototype = samples(() => { new EventStorePrototype(prototypeDir); }, 15);
  const view = new RoomViewService(() => 0, { seatView: (s) => ({ ...s, apiKeyMasked: null }), setupErrors: () => [], scheduleSave: () => {} });
  const viewerResults: Record<string, ReturnType<typeof stats>> = {};
  for (const count of [1, 14, 56]) {
    const unsub = Array.from({ length: count }, (_, i) => view.subscribe(baseline, i % 14 === 0 ? { role: 'host' } : i % 14 === 1 ? { role: 'spectator' } : { role: 'seat', seat: (i % 14) - 1 }, () => {}));
    viewerResults[String(count)] = stats(samples(() => view.notify(baseline), 20));
    for (const stop of unsub) stop();
  }
  const multiRoomDir = join(temp, 'multi'); mkdirSync(multiRoomDir); const multi = new FileStore(multiRoomDir);
  const rooms = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(baseline), id: `synthetic-${i}` }));
  for (const room of rooms) multi.save(room);
  const multiSave = samples(() => { for (const room of rooms) multi.save(room); }, 10);
  const summary = { schemaVersion: 1, timeUtc: new Date().toISOString(), runtime: process.version, platform: process.platform, arch: process.arch,
    fixture: { preset: 'standard12', seed: 'event-store-001', engineActions: initial.actions.length, engineEvents: initial.events.length,
      seats: initial.seats.length, syntheticMessagesPerSeat: 200, messageChars: 256, updates: 40, snapshotEvery: 20 },
    sourceSha256: Object.fromEntries(['packages/session/src/store.ts', 'packages/session/src/room-view.ts', 'packages/session/scripts/event-store-fixture.ts', 'packages/session/scripts/event-store-prototype.ts', 'packages/session/scripts/event-store-measure.ts'].map((p) => [p, sumHash(p)])),
    ms: { clone: stats(clone), stringifyLikeFileStore: stats(serialize), preSerializedWriteRename: stats(writeOnly), currentSave: stats(fileSaves), prototypeCommitFsync: stats(commits), prototypeCheckpointFsync: stats(checkpoints), currentLoadAll: stats(loadCurrent), prototypeRestore: stats(loadPrototype), notifyByViewers: viewerResults, fourRoomsSequentialSave: stats(multiSave) },
    bytes: { current: bytes(join(currentDir, 'rooms')), prototypeSnapshotAndUntrimmedJournal: bytes(prototypeDir), journal: statSync(join(prototypeDir, 'events.jsonl')).size } };
  const target = resolve(process.argv[2] ?? 'docs/评估/ARCH-EVENT-STORE测量.json');
  writeFileSync(target, JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }

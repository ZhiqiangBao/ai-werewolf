import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { RoomManager, MemoryStore, FileStore, SecretBox } from '../packages/session/src/index.ts';
import { mockDecision } from '../packages/llm/src/index.ts';

import { runSequentialFixtures, assertRunningCount, releaseFixture } from './client-server-fixture-lifecycle.mjs';

// Historical V-01 evidence remains at data/diagnostics/p1-20261103/client-server-check.mjs.
// Run from the repository root with: pnpm exec tsx scripts/client-server-check.mjs <new-run-name>
const runName = process.argv[2] ?? 'client-server-sequential';
if (!/^[a-z0-9-]+$/.test(runName)) throw Error('Invalid evidence run name');
const sourcePaths = ['apps/server/src', 'packages/session/src', 'packages/llm/src', 'packages/engine/src', 'packages/protocol/src'];
function assertSourceClean() {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths], { encoding: 'utf8' });
  assert.equal(status, '', 'server source must be clean before and after verification');
}
assertSourceClean();
const sourceServerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const base = path.resolve('data/diagnostics/p1-20261103', runName);
if (fs.existsSync(base)) throw Error('Preserve prior evidence; choose a new run path');
fs.mkdirSync(base, { recursive: true });
const ledger = path.resolve('data/diagnostics/p1-20261103/network-counts.json');
const before = JSON.parse(fs.readFileSync(ledger));
const results = [];
const releaseProofs = [];
let peakRunning = 0;
let clientEnv;

async function cli(dir, args, expected = 0) {
  const run = spawn(process.execPath, [path.join(dir, 'player.mjs'), ...args], { env: clientEnv, cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  run.stdout.on('data', b => output += b); run.stderr.on('data', b => output += b);
  const timer = setTimeout(() => run.kill(), 15000);
  try {
    const [code] = await once(run, 'exit');
    if (expected === null) assert.ok([0, 42, 43].includes(code)); else assert.equal(code, expected, output);
    return output;
  } finally { clearTimeout(timer); }
}

await runSequentialFixtures(['zh-CN', 'en', 'ja'], {
  async create(locale, context) {
    const storage = path.join(base, `runtime-${locale}`);
    context.storage = storage;
    fs.mkdirSync(storage);
    const key = Buffer.alloc(32, 71);
    fs.writeFileSync(path.join(storage, 'secret.key'), key.toString('base64'));
    const memory = new MemoryStore();
    const manager = new RoomManager({ store: memory, secrets: new SecretBox(key), tickMs: 0, sleep: async () => {} });
    context.manager = manager;
    const room = manager.createRoom({ locale });
    const setup = manager.updateSetup(room.roomId, room.hostToken, {
      presetId: 'classic9', aiPacingMs: 0, ruleValues: { 'sheriff.enabled': false },
      seats: Array.from({ length: 9 }, (_, i) => ({ seat: i + 1, controller: 'human' })),
    });
    for (const seat of setup.tokens.seats) manager.participate(room.roomId, seat.token, { ready: true });
    manager.start(room.roomId, room.hostToken);
    await manager.whenIdle(room.roomId);
    const views = () => setup.tokens.seats.map(s => ({ seat: s.seat, token: s.token, view: manager.view(room.roomId, s.token) }));
    let active;
    for (let n = 0; n < 30; n++) {
      active = views().find(s => s.view.projection?.task?.tools.some(t => t.name === 'wolf_discuss') && !s.view.projection.task.submitted);
      if (active) break;
      const turn = views().find(s => s.view.projection?.task && !s.view.projection.task.submitted);
      assert.ok(turn, 'fixture has actionable phase');
      const call = mockDecision(turn.view.projection, turn.view.projection.task.tools);
      assert.equal(manager.act(room.roomId, turn.token, { decisionId: turn.view.projection.task.decisionId, ...call }).ok, true);
      await manager.whenIdle(room.roomId);
    }
    assert.ok(active, 'fixture reaches wolf discussion');
    const marker = `WOLF_PRIVATE_${locale.replaceAll('-', '_')}`;
    assert.equal(manager.act(room.roomId, active.token, {
      decisionId: active.view.projection.task.decisionId, tool: 'wolf_discuss', args: { content: marker },
    }).ok, true);
    const good = views().find(s => s.view.projection?.me?.role === 'villager');
    assert.ok(good);
    assert.equal(JSON.stringify(good.view).includes(marker), false);
    assert.equal(JSON.stringify(manager.view(room.roomId, active.token)).includes(marker), true);
    const running = assertRunningCount(memory.loadAll(), 1);
    assert.equal(running, 1, 'exactly one synthetic fixture is running');
    peakRunning = Math.max(peakRunning, running);
    context.fixture = { locale, ...room, good: { seat: good.seat, token: good.token }, wolf: { seat: active.seat, token: active.token }, marker };
    manager.dispose();
    const disposed = await manager.whenDisposed();
    assert.equal(disposed.durable, true, 'fixture manager disposed');
    context.managerDisposed = true;
    context.manager = undefined;
    const records = memory.loadAll();
    assert.equal(assertRunningCount(records, 1), 1);
    const store = new FileStore(storage);
    for (const rec of records) store.save(rec);
    assert.equal(assertRunningCount(store.loadAll(), 1), 1, 'isolated server storage contains one running room');
  },
  async verify(locale, context) {
    const fixture = context.fixture;
    const pendingPort = net.createServer();
    pendingPort.listen(0, '127.0.0.1'); await once(pendingPort, 'listening');
    const port = pendingPort.address().port;
    await new Promise((resolve, reject) => pendingPort.close(err => err ? reject(err) : resolve()));
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', WEREWOLF_DATA: context.storage, P1_NETWORK_LEDGER: ledger, P1_MODEL_BUDGET: path.resolve('data/diagnostics/p1-20261103/budget.json') };
    env.NODE_OPTIONS = `--import ${pathToFileURL(path.resolve('data/diagnostics/p1-20261103/network-preload.mjs')).href}`;
    clientEnv = env;
    const child = fork(path.resolve('apps/server/src/main.ts'), [], { env, execArgv: ['--import', 'tsx', '--import', pathToFileURL(path.resolve('apps/server/test/signal-fixture.mjs')).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    context.child = child;
    context.exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    context.serverLog = '';
    child.stdout.on('data', b => context.serverLog += b); child.stderr.on('data', b => context.serverLog += b);
    for (let n = 0; n < 100 && !context.serverLog.includes('已启动'); n++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Server exited before ready');
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(context.serverLog.includes('已启动'), 'server ready');
    const dir = path.join(base, fixture.locale);
    fs.mkdirSync(dir);
    execFileSync('python', ['-X', 'utf8', '-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', path.resolve('data/releases/agent-v0.1.0-candidate.zip'), dir], { windowsHide: true });
    const link = token => `http://127.0.0.1:${port}/#/seat/${fixture.roomId}/${token}`;
    const joined = await cli(dir, ['join', link(fixture.good.token)]);
    assert.ok(joined.includes(fixture.locale));
    assert.ok(!joined.includes(fixture.marker));
    for (const command of ['status', 'rules', 'log']) {
      const text = await cli(dir, [command, '--seat', String(fixture.good.seat)]);
      assert.ok(text.includes(fixture.locale));
      assert.ok(!text.includes(fixture.marker));
    }
    const woke = await cli(dir, ['wait', '--seat', String(fixture.good.seat)], null);
    assert.ok(woke.includes(fixture.locale));
    assert.ok(!woke.includes(fixture.marker));
    const wolfJoin = await cli(dir, ['join', link(fixture.wolf.token)]);
    assert.ok(wolfJoin.includes(fixture.locale));
    const wolfLog = await cli(dir, ['log', '--seat', String(fixture.wolf.seat)]);
    assert.ok(wolfLog.includes(fixture.locale));
    assert.ok(wolfLog.includes(fixture.marker));
    const rejected = await cli(dir, ['act', '--seat', String(fixture.wolf.seat), '--tool', 'wolf_discuss', '--args', '{"content":"duplicate"}'], 1);
    assert.ok(rejected.includes('已经提交') || rejected.includes('当前不能'));
    const seatFile = path.join(dir, 'seats', String(fixture.good.seat), 'seat.json');
    const cfg = JSON.parse(fs.readFileSync(seatFile));
    fs.writeFileSync(seatFile, JSON.stringify({ ...cfg, token: fixture.wolf.token }));
    const mismatch = await cli(dir, ['status', '--seat', String(fixture.good.seat)], 1);
    assert.ok(!mismatch.includes(fixture.marker));
    fs.writeFileSync(seatFile, JSON.stringify({ ...cfg, token: 'invalid-fixture-token' }));
    const invalid = await cli(dir, ['log', '--seat', String(fixture.good.seat)], 1);
    assert.ok(!invalid.includes(fixture.marker));
    results.push({ locale, independentZipInstall: true, joinStatusRulesLogWait: true, wolfPrivateVisibleOnlyToWolf: true, duplicateRejected: true, mismatchedSeatRejected: true, invalidCredentialRejected: true });
  },
  async release(locale, context) {
    const proof = await releaseFixture(locale, context, base);
    if (context.manager || context.managerDisposed) assert.equal(proof.managerDisposed, true, 'fixture manager disposed durably');
    if (context.child) assert.equal(proof.serverExited, true, 'fixture server exited');
    if (context.child) assert.equal(proof.leaseReleased, true, 'fixture server lease released');
    if (context.storage && fs.existsSync(context.storage)) assert.equal(proof.storagePreserved, true, 'fixture storage preserved');
    releaseProofs.push({ locale, ...proof });
  },
});
const after = JSON.parse(fs.readFileSync(ledger));
assertSourceClean();
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceServerCommit, 'source commit must not change during verification');
const summary = { sourceServerCommit, serverFilesUnchangedSinceCommit: true, fixtures: 3, peakRunningFixtures: peakRunning, fixtureRunningLimit: 1, results, releaseProofs, playerApiAttempts: after.playerApi - before.playerApi, modelHttpAttempts: after.modelHttp - before.modelHttp, notes: ['Each manager and server is released before the next room starts; frozen room records are preserved.', 'All room data and credentials are synthetic; user data was not served.', 'No production-adapter or real-model inference.', 'This run does not cover an explicit timeout.'] };
fs.writeFileSync(path.join(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));

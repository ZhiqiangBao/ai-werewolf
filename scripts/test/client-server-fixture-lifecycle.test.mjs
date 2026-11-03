import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { assertRunningCount, runSequentialFixtures, releaseFixture, trackFixtureChild } from '../client-server-fixture-lifecycle.mjs';

describe('synthetic fixture lifecycle', () => {
  it('releases each locale before creating the next', async () => {
    const events = []; let live = 0; let peak = 0;
    await runSequentialFixtures(['zh-CN', 'en', 'ja'], {
      async create(locale, ctx) { ctx.locale = locale; events.push(`create:${locale}`); peak = Math.max(peak, ++live); },
      async verify(locale) { assert.equal(live, 1); events.push(`verify:${locale}`); },
      async release(locale, ctx) { assert.equal(ctx.locale, locale); await Promise.resolve(); live--; events.push(`release:${locale}`); },
    });
    assert.equal(peak, 1); assert.equal(live, 0);
    assert.deepEqual(events, ['create:zh-CN', 'verify:zh-CN', 'release:zh-CN', 'create:en', 'verify:en', 'release:en', 'create:ja', 'verify:ja', 'release:ja']);
  });
  for (const failAt of ['create', 'verify']) it(`releases partial fixture on ${failAt} failure and stops`, async () => {
    const events = [];
    await assert.rejects(runSequentialFixtures(['first', 'second'], {
      async create(locale, ctx) { ctx.resource = 'allocated'; events.push(`create:${locale}`); if (failAt === 'create') throw Error('creation failed'); },
      async verify(locale) { events.push(`verify:${locale}`); throw Error('verification failed'); },
      async release(locale, ctx) { assert.equal(ctx.resource, 'allocated'); events.push(`release:${locale}`); },
    }), new RegExp(failAt === 'create' ? 'creation failed' : 'verification failed'));
    assert.equal(events.at(-1), 'release:first'); assert.ok(!events.includes('create:second'));
  });
  it('stops on release failure and preserves both errors', async () => {
    const events = []; let caught;
    try { await runSequentialFixtures(['first', 'second'], {
      async create(locale) { events.push(`create:${locale}`); },
      async verify() { throw Error('verify failed'); }, async release() { throw Error('release failed'); },
    }); } catch (error) { caught = error; }
    assert.ok(caught instanceof AggregateError);
    assert.deepEqual(caught.errors.map(error => error.message), ['verify failed', 'release failed']);
    assert.deepEqual(events, ['create:first']);
  });
  it('checks actual running records and enforces the maximum', () => {
    const records = [{ status: 'running' }, { status: 'setup' }, { status: 'ended' }];
    assert.equal(assertRunningCount(records, 1), 1);
    assert.throws(() => assertRunningCount([...records, { status: 'running' }], 1), /exceeds limit/);
    assert.throws(() => assertRunningCount(records, 3), /at most two/);
  });
  it('preserves frozen records and releases both owners before creating the next fixture', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
    try {
      const proofs = [];
      await runSequentialFixtures(['en', 'ja'], {
        async create(locale, context) {
          if (locale === 'ja') {
            assert.deepEqual(proofs[0], { managerDisposed: true, serverExited: true, leaseReleased: true, storagePreserved: true });
            assert.equal(fs.readFileSync(path.join(base, 'en', 'record.json'), 'utf8'), '{"status":"running"}');
            assert.equal(fs.existsSync(path.join(base, 'en', '.writer-lease')), false);
          }
          context.storage = path.join(base, locale);
          fs.mkdirSync(context.storage);
          fs.writeFileSync(path.join(context.storage, 'record.json'), '{"status":"running"}');
          context.manager = { dispose() {}, async whenDisposed() { return { durable: true }; } };
          context.child = { connected: true, send(_message, callback) { callback(null); }, kill() { assert.fail('should not kill'); } };
          context.exited = Promise.resolve({ code: 0 });
        },
        async verify() {},
        async release(locale, context) { proofs.push(await releaseFixture(locale, context, base)); },
      });
      assert.equal(proofs.length, 2);
      assert.equal(fs.existsSync(path.join(base, 'ja', 'record.json')), true);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
  it('retains storage when lease release is unconfirmed', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
    try {
      const storage = path.join(base, 'runtime'); fs.mkdirSync(storage);
      fs.writeFileSync(path.join(storage, '.writer-lease'), 'synthetic');
      const context = { storage, child: { connected: false }, exited: Promise.resolve({ code: 0 }) };
      await assert.rejects(releaseFixture('en', context, base), AggregateError);
      assert.equal(fs.existsSync(storage), true);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
  for (const failure of ['send throws', 'error without exit', 'send callback error']) {
    it(`still kills, awaits exit and checks the lease after ${failure}`, async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
      try {
        const storage = path.join(base, 'runtime'); fs.mkdirSync(storage);
        // Keep the lease after exit: cleanup must check it even after an IPC failure.
        fs.writeFileSync(path.join(storage, '.writer-lease'), 'synthetic');
        const events = [];
        const original = Error(failure);
        const child = new EventEmitter();
        child.connected = true;
        child.send = (_message, callback) => {
          events.push('send');
          if (failure === 'send throws') throw original;
          if (failure === 'error without exit') child.emit('error', original);
          else queueMicrotask(() => callback(original));
        };
        child.kill = () => {
          events.push('kill');
          setTimeout(() => { events.push('exit'); child.emit('exit', 0, null); }, 1);
          return true;
        };
        await assert.rejects(runSequentialFixtures(['en', 'ja'], {
          async create(locale, context) {
            events.push(`create:${locale}`); context.storage = storage;
            trackFixtureChild(context, child);
          },
          async verify() {},
          async release(locale, context) { await releaseFixture(locale, context, base, 20); },
        }), error => {
          assert.ok(error instanceof AggregateError);
          assert.ok(error.errors.includes(original));
          assert.ok(error.errors.some(cause => cause.message.includes('writer lease released')));
          return true;
        });
        assert.deepEqual(events, ['create:en', 'send', 'kill', 'exit']);
        assert.equal(fs.existsSync(path.join(storage, '.writer-lease')), true);
        assert.equal(fs.existsSync(path.join(base, 'server-en.log')), true);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
  }
  for (const killThrows of [false, true]) {
    it(`fails within the deadline when kill ${killThrows ? 'throws' : 'returns without exit'}`, { timeout: 1000 }, async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
      try {
        const events = [];
        const original = Error('IPC failed'); const killError = Error('kill failed');
        const child = new EventEmitter(); child.connected = true;
        child.send = () => { throw original; };
        child.kill = () => { events.push('kill'); if (killThrows) throw killError; return true; };
        await assert.rejects(runSequentialFixtures(['en', 'ja'], {
          async create(locale, context) {
            events.push(`create:${locale}`); context.storage = base;
            trackFixtureChild(context, child);
          },
          async verify() {},
          async release(locale, context) { await releaseFixture(locale, context, base, 10); },
        }), error => {
          assert.ok(error.errors.includes(original));
          assert.equal(error.errors.includes(killError), killThrows);
          assert.ok(error.errors.some(cause => cause.message.includes('server must exit')));
          return true;
        });
        assert.deepEqual(events, ['create:en', 'kill']);
        assert.equal(fs.existsSync(base), true);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
  }
  for (const callbackArrives of [true, false]) {
    it(`waits after exit for a send callback that ${callbackArrives ? 'fails late' : 'never arrives'}`, { timeout: 1000 }, async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
      try {
        const events = []; const original = Error('late IPC failure');
        const child = new EventEmitter(); child.connected = true;
        child.send = (_message, callback) => {
          events.push('exit'); child.emit('exit', 0, null);
          if (callbackArrives) setTimeout(() => { events.push('callback'); callback(original); }, 1);
        };
        child.kill = () => assert.fail('already exited');
        await assert.rejects(runSequentialFixtures(['en', 'ja'], {
          async create(locale, context) {
            events.push(`create:${locale}`); context.storage = base;
            trackFixtureChild(context, child);
          },
          async verify() {},
          async release(locale, context) { await releaseFixture(locale, context, base, 20); },
        }), error => {
          assert.ok(error instanceof AggregateError);
          if (callbackArrives) assert.ok(error.errors.includes(original));
          else assert.ok(error.errors.some(cause => cause.message.includes('shutdown IPC completion')));
          return true;
        });
        assert.deepEqual(events, callbackArrives ? ['create:en', 'exit', 'callback'] : ['create:en', 'exit']);
        assert.equal(fs.existsSync(base), true);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });
  }
});

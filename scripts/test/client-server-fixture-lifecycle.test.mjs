import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRunningCount, runSequentialFixtures, releaseFixture } from '../client-server-fixture-lifecycle.mjs';

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
          context.child = { connected: true, send() {}, kill() { assert.fail('should not kill'); } };
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
});

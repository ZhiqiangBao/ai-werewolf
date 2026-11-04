import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { assertRunningCount, runSequentialFixtures, releaseFixture, trackFixtureChild } from '../client-server-fixture-lifecycle.mjs';

it('releases a locale before advancing and freezes evidence when the next locale cannot shut down cleanly', { timeout: 2000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
  t.after(() => {
    const target = fs.realpathSync(base), temporary = fs.realpathSync(os.tmpdir());
    if (path.dirname(target) !== temporary || !path.basename(target).startsWith('fixture-test-')) throw new Error('Unexpected fixture path');
    fs.rmSync(target, { recursive: true, force: true });
  });
  const events = [];
  const shutdownError = new Error('shutdown callback failed after exit');
  const firstRecord = JSON.stringify([{ status: 'running' }]);
  const nextRecord = JSON.stringify([{ status: 'running' }, { status: 'running' }]);

  await assert.rejects(runSequentialFixtures(['en', 'ja', 'zh-CN'], {
    async create(locale, context) {
      events.push(`create:${locale}`);
      const healthy = locale === 'en';
      context.storage = path.join(base, locale);
      fs.mkdirSync(context.storage);
      const lease = path.join(context.storage, '.writer-lease');
      fs.writeFileSync(path.join(context.storage, 'records.json'), healthy ? firstRecord : nextRecord);
      fs.writeFileSync(lease, 'synthetic');
      context.serverLog = `server log for ${locale}`;
      context.manager = {
        dispose() { events.push(`dispose:${locale}`); },
        async whenDisposed() { return { durable: true }; },
      };
      const child = new EventEmitter();
      child.connected = true;
      let onShutdown;
      const exit = () => {
        events.push(`exit:${locale}`);
        child.emit('exit', 0, null);
      };
      child.send = (message, callback) => {
        assert.equal(message, 'shutdown');
        onShutdown = callback;
        if (healthy) {
          fs.unlinkSync(lease);
          exit();
          callback(null);
        }
      };
      child.kill = () => {
        assert.equal(healthy, false);
        events.push(`kill:${locale}`);
        exit();
        setImmediate(() => {
          events.push(`callback:${locale}`);
          onShutdown(shutdownError);
        });
        return true;
      };
      trackFixtureChild(context, child);
    },
    async verify(_locale, context) {
      const records = JSON.parse(fs.readFileSync(path.join(context.storage, 'records.json'), 'utf8'));
      assert.equal(assertRunningCount(records, 1), 1);
    },
    async release(locale, context) {
      const proof = await releaseFixture(locale, context, base, 50);
      assert.deepEqual(proof, { managerDisposed: true, serverExited: true, leaseReleased: true, storagePreserved: true });
      events.push(`released:${locale}`);
    },
  }), error => {
    assert.ok(error instanceof AggregateError);
    const [verification, release] = error.errors;
    assert.match(verification.message, /running fixture count 2 exceeds limit 1/);
    assert.ok(release instanceof AggregateError);
    assert.ok(release.errors.includes(shutdownError));
    assert.ok(release.errors.some(cause => /writer lease released/.test(cause.message)));
    return true;
  });

  assert.deepEqual(events, ['create:en', 'dispose:en', 'exit:en', 'released:en', 'create:ja', 'dispose:ja', 'kill:ja', 'exit:ja', 'callback:ja']);
  assert.equal(fs.existsSync(path.join(base, 'en', '.writer-lease')), false);
  assert.equal(fs.readFileSync(path.join(base, 'en', 'records.json'), 'utf8'), firstRecord);
  assert.equal(fs.readFileSync(path.join(base, 'ja', '.writer-lease'), 'utf8'), 'synthetic');
  assert.equal(fs.readFileSync(path.join(base, 'ja', 'records.json'), 'utf8'), nextRecord);
  assert.equal(fs.readFileSync(path.join(base, 'server-ja.log'), 'utf8'), 'server log for ja');
});

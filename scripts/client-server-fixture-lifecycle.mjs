import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Check records owned by the current manager or server; frozen records from released fixtures are not live.
export function assertRunningCount(records, limit = 1) {
  assert.ok(Number.isInteger(limit) && limit >= 0 && limit <= 2, 'fixture limit must be at most two');
  const running = records.filter(record => record.status === 'running').length;
  assert.ok(running <= limit, `running fixture count ${running} exceeds limit ${limit}`);
  return running;
}

// A context exists before creation starts, so partial creation also gets cleaned up.
// Cleanup must complete successfully before the next fixture may be created.
export async function runSequentialFixtures(locales, { create, verify, release }) {
  let live = 0;
  for (const locale of locales) {
    assert.equal(live, 0, 'previous fixture must be released before creating another');
    const context = {};
    live++;
    assert.ok(live <= 1 && live <= 2, 'simultaneously live fixtures exceed limit');
    let failure;
    try {
      await create(locale, context);
      await verify(locale, context);
    } catch (error) { failure = error; }
    try {
      await release(locale, context);
      live--;
      assert.equal(live, 0, 'fixture release must complete');
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], `Fixture ${locale} failed and release failed`);
      throw error;
    }
    if (failure) throw failure;
  }
  assert.equal(live, 0, 'all fixtures must be released');
}

// An unconfirmed server exit or lease release keeps the storage in place and stops the run.
export async function releaseFixture(locale, context, base, timeoutMs = 6000) {
  const errors = [];
  const proof = { managerDisposed: context.managerDisposed === true, serverExited: false, leaseReleased: false, storagePreserved: false };
  if (context.manager) {
    try {
      context.manager.dispose();
      const report = await context.manager.whenDisposed();
      assert.equal(report.durable, true, 'fixture manager cleanup');
      proof.managerDisposed = true;
    } catch (error) { errors.push(error); }
  }
  if (context.child) {
    try {
      const child = context.child;
      if (child.connected) child.send('shutdown');
      const wait = () => new Promise(resolve => { const timer = setTimeout(() => resolve(null), timeoutMs); timer.unref(); });
      let exit = await Promise.race([context.exited, wait()]);
      if (!exit) { child.kill(); exit = await Promise.race([context.exited, wait()]); }
      assert.ok(exit, 'server must exit before fixture storage is released');
      assert.equal(exit.code, 0, 'graceful server exit');
      proof.serverExited = true;
      assert.equal(fs.existsSync(path.join(context.storage, '.writer-lease')), false, 'writer lease released');
      proof.leaseReleased = true;
    } catch (error) { errors.push(error); }
    try { fs.writeFileSync(path.join(base, `server-${locale}.log`), context.serverLog ?? ''); }
    catch (error) { errors.push(error); }
  }
  if (context.storage) proof.storagePreserved = fs.existsSync(context.storage);
  if (errors.length) throw new AggregateError(errors, `Failed to release ${locale} fixture`);
  return proof;
}

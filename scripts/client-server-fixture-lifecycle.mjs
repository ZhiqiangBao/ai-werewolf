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

// An error can describe failed IPC while the process is still alive. Only exit proves termination.
export function trackFixtureChild(context, child) {
  context.child = child;
  context.childErrors = [];
  child.on('error', error => context.childErrors.push(error));
  context.exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForResult(result, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      result,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
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
    const child = context.child;
    // IPC completion may arrive after exit. Never let that late error escape the final report.
    const sent = new Promise(resolve => {
      if (!child.connected) { resolve(true); return; }
      try {
        child.send('shutdown', error => { if (error) errors.push(error); resolve(true); });
      } catch (error) { errors.push(error); resolve(true); }
    });
    try {
      let exit = await waitForResult(context.exited, timeoutMs);
      if (!exit) {
        try { child.kill(); } catch (error) { errors.push(error); }
        exit = await waitForResult(context.exited, timeoutMs);
      }
      assert.ok(exit, 'server must exit before fixture storage is released');
      proof.serverExited = true;
      try { assert.equal(exit.code, 0, 'graceful server exit'); }
      catch (error) { errors.push(error); }
      assert.equal(fs.existsSync(path.join(context.storage, '.writer-lease')), false, 'writer lease released');
      proof.leaseReleased = true;
    } catch (error) { errors.push(error); }
    try { assert.ok(await waitForResult(sent, timeoutMs), 'shutdown IPC completion must be confirmed'); }
    catch (error) { errors.push(error); }
    try { fs.writeFileSync(path.join(base, `server-${locale}.log`), context.serverLog ?? ''); }
    catch (error) { errors.push(error); }
  }
  if (context.storage) proof.storagePreserved = fs.existsSync(context.storage);
  errors.push(...(context.childErrors ?? []));
  if (errors.length) throw new AggregateError([...new Set(errors)], `Failed to release ${locale} fixture`);
  return proof;
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// Offline acceptance only: never starts a server, reserves budget, or reads user rooms/keys.
const root = process.cwd();
// This verifier records a historical audit against its original test sources.
// Run it from the original revision after the test suite has been consolidated.
if (!fs.existsSync(path.join(root, 'packages/session/test/passive-validator.test.ts'))) {
  throw new Error('此历史验证依赖已精简的旧测试；请在历史提交中运行，不能用新流程冒充原审计。');
}
const name = process.argv[2] ?? 'p1-rework-20261103-final';
assert.match(name, /^[a-z0-9-]+$/);
const output = path.join(root, 'data', 'diagnostics', name);
assert.ok(!fs.existsSync(output), 'Preserve prior evidence; choose a new output name');
fs.mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const filePin = file => {
  const absolute = path.resolve(root, file);
  const info = fs.lstatSync(absolute);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Unsafe input: ${file}`);
  const hash = createHash('sha256');
  const fd = fs.openSync(absolute, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return { path: file.replaceAll('\\', '/'), bytes: info.size, sha256: hash.digest('hex') };
};
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const sourceFiles = [
  'packages/session/src/model-library.ts', 'packages/session/src/model-maintenance.ts', 'packages/session/src/model-retirement.ts',
  'packages/session/src/experiments/passive-archive.ts', 'packages/session/src/experiments/passive-budget.ts',
  'packages/session/src/experiments/passive-loopback.ts', 'packages/session/src/experiments/passive-plan.ts',
  'packages/session/src/experiments/passive-revalidation.ts', 'packages/session/src/experiments/passive-validator.ts',
  'packages/session/test/model-maintenance.test.ts', 'packages/session/test/passive-validator.test.ts',
  'packages/session/test/passive-revalidation.test.ts', 'packages/session/test/passive-archive.test.ts',
  'packages/session/test/passive-projections.test.ts', 'packages/session/test/passive-native.test.ts',
  'scripts/model-maintenance.ts', 'scripts/passive-experiment.ts', 'scripts/passive-revalidate.ts',
  'scripts/client-server-check.mjs', 'scripts/client-server-fixture-lifecycle.mjs',
  'scripts/test/client-server-fixture-lifecycle.test.mjs', 'scripts/p1-rework-verify.mjs',
];
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), implementationCommit: git(['rev-parse', 'HEAD']),
  branch: git(['branch', '--show-current']), verifier: 'scripts/p1-rework-verify.mjs',
  environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(),
    typescript: require('typescript/package.json').version, tsx: require('tsx/package.json').version, vitest: require('vitest/package.json').version },
  command: [process.execPath, ...process.argv.slice(1)],
  status: 'failed', steps: [], inputs: [], sources: sourceFiles.map(filePin), outputs: [],
  cost: { newHttpRequests: 0, newModelCalls: 0, newTtsCalls: 0, budgetWrites: 0 },
  limits: ['self-validation, independent external re-audit still required', 'frozen projections are not a new engine replay', 'no full suite, HTTP integration, OBS, or performance matrix'],
};
const temporary = path.join(output, 'tmp'); fs.mkdirSync(temporary);
const env = { ...process.env, TEMP: temporary, TMP: temporary };
function run(step, args, expectedExit = 0) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 ** 2 });
  const stdout = path.join(output, `${step}.stdout.log`), stderr = path.join(output, `${step}.stderr.log`);
  fs.writeFileSync(stdout, result.stdout ?? '', { flag: 'wx' }); fs.writeFileSync(stderr, result.stderr ?? '', { flag: 'wx' });
  report.steps.push({ step, command: [process.execPath, ...args], expectedExit, exit: result.status, error: result.error?.message,
    stdout: filePin(path.relative(root, stdout)), stderr: filePin(path.relative(root, stderr)) });
  assert.ifError(result.error); assert.equal(result.status, expectedExit, `${step}: ${result.stderr}`);
  return result.stdout;
}
try {
  assert.equal(report.branch, 'codex/observability');
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', ...sourceFiles]), '', 'Commit implementation before final verification');
  const testsPath = path.join(output, 'tests.json');
  // Damage gates run before retained inputs are read or accepted.
  run('targeted-tests', ['node_modules/vitest/vitest.mjs', 'run',
    'packages/session/test/model-maintenance.test.ts', 'packages/session/test/passive-validator.test.ts',
    'packages/session/test/passive-revalidation.test.ts', 'packages/session/test/passive-archive.test.ts',
    'packages/session/test/passive-projections.test.ts', 'packages/session/test/passive-native.test.ts',
    '--reporter=json', `--outputFile=${testsPath}`]);
  const tests = JSON.parse(fs.readFileSync(testsPath, 'utf8'));
  assert.equal(tests.numFailedTests, 0); assert.ok(tests.numTotalTests > 0);
  report.tests = { files: tests.testResults.length, total: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests };
  run('fixture-lifecycle', ['--test', '--test-reporter=tap', 'scripts/test/client-server-fixture-lifecycle.test.mjs']);
  run('typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']);
  const scriptConfig = path.join(output, 'scripts-tsconfig.json');
  fs.writeFileSync(scriptConfig, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['scripts/model-maintenance.ts', 'scripts/passive-experiment.ts', 'scripts/passive-revalidate.ts'].map(file => path.join(root, file)) }), { flag: 'wx' });
  run('scripts-typecheck', ['node_modules/typescript/bin/tsc', '-p', scriptConfig, '--noEmit']);
  for (const file of ['scripts/client-server-check.mjs', 'scripts/client-server-fixture-lifecycle.mjs', 'scripts/p1-rework-verify.mjs']) run(`syntax-${path.basename(file, '.mjs')}`, ['--check', file]);

  const historicalIndex = 'docs/P1四项外部审计证据索引.json';
  report.inputs.push(filePin(historicalIndex));
  const audit = JSON.parse(fs.readFileSync(historicalIndex, 'utf8'));
  assert.equal(audit.passiveWindows.length, 34);
  const complete = audit.passiveWindows.filter(window => window.status === 'complete');
  assert.equal(complete.length, 33); assert.equal(audit.passiveWindows.filter(window => window.status === 'failed').length, 1);
  for (const window of audit.passiveWindows) for (const expected of [window.manifest, window.archive]) {
    assert.ok(expected.path.startsWith('data/diagnostics/p1-20261103/passive'));
    const actual = filePin(expected.path); assert.deepEqual(actual, expected, 'Historical evidence changed'); report.inputs.push(actual);
  }
  const budgetPath = 'data/diagnostics/p1-20261103/budget.json';
  const preserved = [budgetPath, 'data/diagnostics/p1-20261103/client-server-check.mjs',
    'data/diagnostics/p1-20261103/client-server/summary.json', 'data/diagnostics/p1-20261103/client-server-final/summary.json'];
  report.inputs.push(...preserved.map(filePin));
  const budgetBefore = filePin(budgetPath);
  const sourceHash = '70c5ae5d4ca3277bb8ebf164a82f11a640b5a210bbed04cc7c38372665a4ea3e';
  const failedSource = 'e1d21a2701b8f0ba0090b6c845282f70da791f1403f4ce822989e7270cbafba7';
  const inputHash = '5ab594b6d9a5d01731f05b32dfda1861ac20cb9e2e56cac0948a26047a9256f8';
  const completeResult = JSON.parse(run('retained-complete', ['--import', 'tsx', 'scripts/passive-revalidate.ts', '--directory', 'data/diagnostics/p1-20261103/passive',
    '--budget', budgetPath, '--source-hash', sourceHash, '--input-hash', inputHash, '--include-index', 'true']));
  assert.equal(completeResult.windows, 33); assert.equal(completeResult.reserved, 1466);
  const failure = JSON.parse(run('retained-failure', ['--import', 'tsx', 'scripts/passive-revalidate.ts',
    '--archive', 'data/diagnostics/p1-20261103/passive-failed-6f626e6/preflight.gz',
    '--manifest', 'data/diagnostics/p1-20261103/passive-failed-6f626e6/preflight.manifest.json', '--budget', budgetPath,
    '--source-hash', failedSource, '--input-hash', inputHash, '--legacy-failed', 'true'], 1));
  assert.equal(failure.result, 'recorded_failure'); assert.equal(failure.planned, 26); assert.equal(failure.ledgerReserved, 12);
  assert.equal(failure.clientStarts, 12); assert.equal(failure.clientEnds, 0); assert.equal(failure.serverStarts, 0); assert.equal(failure.serverEnds, 0);
  const ledger = JSON.parse(fs.readFileSync(budgetPath, 'utf8')); assert.equal(ledger.pActual, 1478);
  assert.deepEqual(filePin(budgetPath), budgetBefore);
  report.retained = { complete: completeResult, failure, budget: { pActual: ledger.pActual, groups: ledger.groups,
    meaning: '1466 complete requests + 12 failed client starts/reservations; failed server received 0' } };
  // Rehash all original inputs and implementation after validation, without modifying them.
  for (const input of report.inputs) assert.deepEqual(filePin(input.path), input);
  for (const source of report.sources) assert.deepEqual(filePin(source.path), source);
  assert.equal(git(['rev-parse', 'HEAD']), report.implementationCommit);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.sourceTreeSha256 = sha(JSON.stringify(report.sources)); report.inputIndexSha256 = sha(JSON.stringify(report.inputs));
  report.outputs = fs.readdirSync(output).filter(file => file !== 'tmp').sort().map(file => filePin(path.relative(root, path.join(output, file))));
  const encoded = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(path.join(output, 'result.json'), encoded, { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, implementationCommit: report.implementationCommit, result: path.relative(root, path.join(output, 'result.json')), sha256: sha(encoded), tests: report.tests, error: report.error }));
}

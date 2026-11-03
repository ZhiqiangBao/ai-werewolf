import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inspectLegacyFailedWindow, readBoundedJson, readBoundedJsonWithHash, validateArchivedWindow } from '../packages/session/src/experiments/passive-revalidation';

// Read-only: explicit pins and the original ledger are required; no server is started.
try {
  const args = process.argv.slice(2);
  const allowed = new Set(['--archive', '--manifest', '--directory', '--budget', '--source-hash', '--input-hash', '--slots', '--legacy-failed', '--include-index']);
  const options: Record<string, string> = Object.create(null);
  if (args.length % 2 !== 0) throw new Error('expected option/value pairs');
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || Object.hasOwn(options, args[i]) || !args[i + 1]) throw new Error('invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  for (const name of ['--budget', '--source-hash', '--input-hash']) if (!options[name]) throw new Error(`missing ${name}`);
  const directory = options['--directory'];
  if (directory ? options['--archive'] || options['--manifest'] || options['--legacy-failed'] : !options['--archive'] || !options['--manifest']) throw new Error('choose a directory or one archive/manifest pair');
  const slots = options['--slots'];
  if (slots !== undefined && slots !== '4' && slots !== '8') throw new Error('invalid slots');
  const legacyFailed = options['--legacy-failed'];
  if (legacyFailed !== undefined && legacyFailed !== 'true') throw new Error('invalid legacy-failed option');
  const withPin = (runName: string) => ({ runName, sourceHash: options['--source-hash'], inputHash: options['--input-hash'], ...(slots ? { slots: Number(slots) as 4 | 8 } : {}) });
  if (options['--include-index'] !== undefined && (options['--include-index'] !== 'true' || !directory)) throw new Error('invalid include-index option');
  if (directory) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory');
    const names = readdirSync(directory); const archives = names.filter(name => name.endsWith('.gz')).sort(); const manifests = names.filter(name => name.endsWith('.manifest.json'));
    if (!archives.length || archives.length !== manifests.length || archives.some(name => !names.includes(`${name.slice(0, -3)}.manifest.json`))) throw new Error('unpaired archives or manifests');
    const index = [];
    for (const name of archives) {
      const runName = name.slice(0, -3); const json = readBoundedJsonWithHash(join(directory, `${runName}.manifest.json`));
      const manifest = await validateArchivedWindow(join(directory, name), json.value, withPin(runName), options['--budget']);
      index.push({ name, manifestSha256: json.sha256, compressedSha256: manifest.compressedSha256, logicalSha256: manifest.sha256, expectedHash: manifest.expectedHash, reserved: manifest.reserved });
    }
    console.log(JSON.stringify({ result: 'verified', sourceHash: options['--source-hash'], inputHash: options['--input-hash'], runtime: { node: process.version, platform: process.platform, arch: process.arch }, windows: index.length, reserved: index.reduce((sum, item) => sum + item.reserved, 0), indexSha256: createHash('sha256').update(JSON.stringify(index)).digest('hex'), ...(options['--include-index'] ? { index } : {}) }));
  } else {
    const archiveName = basename(options['--archive']); const manifestName = basename(options['--manifest']);
    if (!archiveName.endsWith('.gz')) throw new Error('invalid archive name');
    const runName = archiveName.slice(0, -3);
    if (manifestName !== `${runName}.manifest.json`) throw new Error('archive/manifest names mismatch');
    const value = readBoundedJson(options['--manifest']);
    if (legacyFailed) {
      const report = await inspectLegacyFailedWindow(options['--archive'], value, withPin(runName), options['--budget']);
      console.log(JSON.stringify(report));
      process.exitCode = 1;
    } else {
      const manifest = await validateArchivedWindow(options['--archive'], value, withPin(runName), options['--budget']);
      console.log(JSON.stringify({ run: manifest.run, status: manifest.status, reserved: manifest.reserved, result: 'verified' }));
    }
  }
} catch (error) {
  console.error(`passive revalidation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}

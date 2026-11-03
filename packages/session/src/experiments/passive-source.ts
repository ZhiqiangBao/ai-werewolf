import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export type SourceEntry = { path: string; sha256: string; bytes: number };
export function sourceRunId(sourceHash: string, run: string): string {
  if (!/^[a-f0-9]{64}$/.test(sourceHash) || !/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error('invalid source or run');
  return `${sourceHash}/${run}`;
}
export function sourceSnapshot(root: string): { entries: SourceEntry[]; sha256: string } {
  const files: string[] = [];
  const walk = (path: string) => {
    const info = lstatSync(path); if (info.isSymbolicLink()) throw new Error(`source symlink: ${path}`);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
    else if (info.isFile()) files.push(path);
  };
  for (const name of ['packages/protocol/src', 'packages/protocol/package.json', 'packages/engine/src', 'packages/engine/package.json', 'packages/llm/src', 'packages/llm/package.json', 'packages/session/src', 'packages/session/package.json', 'packages/engine/test/harness.ts', 'scripts/passive-experiment.ts', 'package.json', 'tsconfig.json', 'pnpm-lock.yaml', 'docs/P1剩余四项一揽子实施方案.md']) walk(join(root, name));
  for (const name of readdirSync(join(root, 'packages/session/test')).filter(name => /^passive-.*\.test\.ts$/.test(name)).sort()) walk(join(root, 'packages/session/test', name));
  const entries = files.map(path => { const bytes = readFileSync(path); return { path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { entries, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

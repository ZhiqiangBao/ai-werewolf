import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { renderOverheadResources, summarizeOverheadResources, type ResourceMetadata, type ResourcePair } from '../src/observability/synthetic-overhead-resources';

async function main() {
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: tsx packages/session/scripts/observability-resources.ts data/.../overhead-directory');
  const root = await realpath(resolve('data')), directory = await realpath(resolve(argument));
  const rel = relative(root, directory);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
    throw new Error('The input and output directory must be inside data');
  const [rawPairs, rawMetadata] = await Promise.all([
    readFile(resolve(directory, 'pairs.jsonl'), 'utf8'), readFile(resolve(directory, 'summary.json'), 'utf8'),
  ]);
  const pairs = rawPairs.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as ResourcePair);
  const metadata = JSON.parse(rawMetadata) as ResourceMetadata;
  const resources = summarizeOverheadResources(pairs, metadata);
  await writeFile(resolve(directory, 'resource-summary.json'), `${JSON.stringify(resources, null, 2)}\n`, 'utf8');
  await writeFile(resolve(directory, 'resource-report.md'), renderOverheadResources(resources), 'utf8');
  console.log(`Resource report: ${directory}`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Resource report failed'); process.exitCode = 1; });

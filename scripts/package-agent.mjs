import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';

// Deliberately fixed: runtime data and unreviewed additions never enter the archive.
const files = ['.cursor/rules/player.mdc', '.github/copilot-instructions.md', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md', 'README.md', 'player.mjs'].sort();
const [sourceArg, outputArg, version, ...options] = process.argv.slice(2);
if (!sourceArg || !outputArg?.endsWith('.zip') || !/^agent-v\d+\.\d+\.\d+$/.test(version ?? '')) throw Error('Usage: node scripts/package-agent.mjs <source> <output.zip> <agent-vX.Y.Z> [--expected-tree <sha256>] [--server-commit <full-sha>]');
let expectedTree;
const validatedServerCommits = [];
for (let i = 0; i < options.length; i += 2) {
  const [flag, value] = options.slice(i, i + 2);
  if (flag === '--expected-tree' && !expectedTree && /^[a-f0-9]{64}$/i.test(value ?? '')) expectedTree = value.toLowerCase();
  else if (flag === '--server-commit' && /^[a-f0-9]{40}$/i.test(value ?? '')) validatedServerCommits.push(value.toLowerCase());
  else throw Error('Invalid or repeated package option');
}
if (validatedServerCommits.length && !expectedTree) throw Error('Validated releases require the reviewed source tree hash');
const source = resolve(sourceArg), output = resolve(outputArg);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const entries = [];
for (const name of files) {
  const path = resolve(source, name);
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    if ((await lstat(resolve(source, ...parts.slice(0, i)))).isSymbolicLink()) throw Error(`Symlink directory is not allowed: ${name}`);
  }
  if ((await lstat(path)).isSymbolicLink()) throw Error(`Symlink is not allowed: ${name}`);
  const bytes = await readFile(path);
  entries.push({ name, bytes });
}
const fileHashes = entries.map(({ name, bytes }) => ({ path: name, sha256: hash(bytes), size: bytes.length }));
const treeSha256 = hash(Buffer.from(JSON.stringify(fileHashes)));
if (expectedTree && expectedTree !== treeSha256) throw Error('Client source differs from the reviewed tree');
const manifest = { format: 'werewolf-agent-release-v1', version, minimumNode: '22.12', treeSha256, files: fileHashes, validatedServerCommits: [...new Set(validatedServerCommits)].sort() };
entries.push({ name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const { name, bytes } of entries) {
  const filename = Buffer.from(name), crc = crc32(bytes);
  const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(33, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
  local.push(head, filename, bytes); central.push(directory, filename); offset += head.length + filename.length + bytes.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directory, end]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zip);
console.log(JSON.stringify({ version, output, sha256: hash(zip), treeSha256, manifest }));

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, posix, resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const sha = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
const hex = /^[a-f0-9]{64}$/i;
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
type Member = { path: string; bytes: number; sha256: string };
const catalogScript = [
  'import json,sys,zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as z:',
  ' print(json.dumps({"pythonVersion":sys.version.split()[0],"entries":[{"path":i.filename,"bytes":i.file_size} for i in z.infolist()]}))',
].join('\n');
const readScript = [
  'import sys,zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as z:',
  ' with z.open(sys.argv[2]) as f:',
  '  while chunk:=f.read(1024*1024): sys.stdout.buffer.write(chunk)',
].join('\n');
const verifyScript = [
  'import hashlib,json,sys,zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as z:',
  ' index=json.loads(z.read("_obs-archive-index.json"))',
  ' total=0; count=0',
  ' for item in index["files"]:',
  '  h=hashlib.sha256(); n=0',
  '  with z.open(item["path"]) as f:',
  '   while chunk:=f.read(1024*1024): h.update(chunk); n+=len(chunk)',
  '  if n!=item["bytes"] or h.hexdigest()!=item["sha256"].lower(): raise ValueError("Archive member hash mismatch")',
  '  count+=1; total+=n',
  ' print(json.dumps({"verifiedMembers":count,"verifiedBytes":total}))',
].join('\n');

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function members(value: unknown): Map<string, Member> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { files?: unknown }).files)) throw new Error('Invalid archive index');
  const rows = (value as { files: unknown[] }).files, out = new Map<string, Member>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid archive member descriptor');
    const item = raw as Member;
    if (typeof item.path !== 'string' || !item.path.startsWith('synthetic/') || !item.path.endsWith('.jsonl') ||
      item.path.includes('\\') || posix.normalize(item.path) !== item.path || item.path.split('/').includes('..') ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !hex.test(item.sha256) || out.has(item.path))
      throw new Error('Invalid or duplicate archive member descriptor');
    out.set(item.path, { path: item.path, bytes: item.bytes, sha256: item.sha256.toLowerCase() });
  }
  const declared = value as { fileCount?: unknown; uncompressedBytes?: unknown };
  if (declared.fileCount !== out.size || declared.uncompressedBytes !== [...out.values()].reduce((sum, item) => sum + item.bytes, 0))
    throw new Error('Archive index counts do not match its member list');
  return out;
}

/** Optional offline ZIP reader. Python's standard zipfile validates CRC; SHA-256 pins every selected member. No extraction. */
export class ObservationArchive {
  readonly used = new Map<string, Member>();
  private constructor(readonly file: string, readonly python: string, private readonly entries: Map<string, Member>,
    readonly provenance: { archive: string; archiveSha256: string; archiveBytes: number; indexSha256: string;
      embeddedIndexSha256: string; memberCount: number; pythonVersion: string; readerScriptSha256: string; verifierScriptSha256: string }) {}

  static async open(options: { archive: string; index: string; expectedSha256: string; python?: string }): Promise<ObservationArchive> {
    if (!hex.test(options.expectedSha256)) throw new Error('Expected archive SHA-256 is required');
    const archive = resolve(options.archive), indexBytes = await readFile(resolve(options.index));
    const index = JSON.parse(indexBytes.toString('utf8')) as { archiveSha256?: unknown; archiveBytes?: unknown };
    const entries = members(index), size = (await stat(archive)).size, actual = await fileSha256(archive);
    if (actual !== options.expectedSha256.toLowerCase() || typeof index.archiveSha256 !== 'string' ||
      index.archiveSha256.toLowerCase() !== actual || index.archiveBytes !== size)
      throw new Error('Archive SHA-256 or byte count does not match the pinned index');
    const python = options.python ?? 'python';
    const { stdout } = await runFile(python, ['-c', catalogScript, archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const catalog = JSON.parse(stdout) as { pythonVersion: string; entries: { path: string; bytes: number }[] };
    const names = new Set(catalog.entries.map((entry) => entry.path));
    if (names.size !== catalog.entries.length || names.size !== entries.size + 1 || !names.has('_obs-archive-index.json') ||
      catalog.entries.some((entry) => entry.path !== '_obs-archive-index.json' && entries.get(entry.path)?.bytes !== entry.bytes))
      throw new Error('Archive catalog has missing, extra, or duplicate members');
    const { stdout: embedded } = await runFile(python, ['-c', readScript, archive, '_obs-archive-index.json'],
      { encoding: 'buffer', maxBuffer: MAX_MEMBER_BYTES, windowsHide: true });
    const embeddedEntries = members(JSON.parse(embedded.toString('utf8')));
    if (embeddedEntries.size !== entries.size || [...entries].some(([name, entry]) => {
      const original = embeddedEntries.get(name); return !original || original.bytes !== entry.bytes || original.sha256 !== entry.sha256;
    })) throw new Error('External and embedded archive indexes disagree');
    return new ObservationArchive(archive, python, entries, { archive: basename(archive), archiveSha256: actual, archiveBytes: size,
      indexSha256: sha(indexBytes), embeddedIndexSha256: sha(embedded), memberCount: entries.size, pythonVersion: catalog.pythonVersion,
      readerScriptSha256: sha(Buffer.from(readScript)), verifierScriptSha256: sha(Buffer.from(verifyScript)) });
  }

  async read(member: string): Promise<{ bytes: Buffer; provenance: Member }> {
    const entry = this.entries.get(member);
    if (!entry || entry.bytes > MAX_MEMBER_BYTES) throw new Error('Requested member is absent or exceeds the offline reader limit');
    const { stdout } = await runFile(this.python, ['-c', readScript, this.file, member],
      { encoding: 'buffer', maxBuffer: MAX_MEMBER_BYTES + 1, windowsHide: true });
    if (stdout.length !== entry.bytes || sha(stdout) !== entry.sha256) throw new Error('Archive member SHA-256 or length mismatch');
    this.used.set(member, entry);
    return { bytes: stdout, provenance: entry };
  }

  async verifyAll(): Promise<{ verifiedMembers: number; verifiedBytes: number }> {
    const { stdout } = await runFile(this.python, ['-c', verifyScript, this.file], { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
    const result = JSON.parse(stdout) as { verifiedMembers: number; verifiedBytes: number };
    if (result.verifiedMembers !== this.entries.size || result.verifiedBytes !== [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0))
      throw new Error('Full archive verification counts do not match');
    await this.assertUnchanged();
    return result;
  }

  async assertUnchanged(): Promise<void> {
    if ((await stat(this.file)).size !== this.provenance.archiveBytes || await fileSha256(this.file) !== this.provenance.archiveSha256)
      throw new Error('Archive changed during offline verification');
  }
}

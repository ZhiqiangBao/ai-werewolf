import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export type StorageUsage = { logical: number; compressed: number; compact: number; peak: number };
export type ArchiveProof = { logicalBytes: number; compressedBytes: number; sha256: string; compressedSha256: string };
const stop = { logical: 4 * 1024 ** 3 * .9, compressed: 768 * 1024 ** 2 * .9, compact: 128 * 1024 ** 2 * .9, peak: 1.25 * 1024 ** 3 * .9 };

/** Exclusively owned run directory required; never writes an expanded raw file. */
export async function archiveEvidence(path: string, evidence: unknown, usage: StorageUsage, signal?: AbortSignal): Promise<ArchiveProof> {
  if (Object.values(usage).some(n => !Number.isSafeInteger(n) || n < 0) || usage.logical >= stop.logical || usage.compressed >= stop.compressed || usage.compact >= stop.compact || usage.peak >= stop.peak) throw new Error('storage stop threshold');
  const serialized = JSON.stringify(evidence); if (typeof serialized !== 'string') throw new Error('cannot serialize evidence');
  const raw = Buffer.from(serialized, 'utf8');
  const rawHash = createHash('sha256'); const compressedHash = createHash('sha256'); let logicalBytes = 0; let compressedBytes = 0;
  const measureRaw = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    logicalBytes += chunk.length; usage.logical += chunk.length; rawHash.update(chunk);
    callback(usage.logical >= stop.logical ? new Error('logical stop threshold') : null, chunk);
  } });
  const measureCompressed = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    compressedBytes += chunk.length; usage.compressed += chunk.length; usage.peak += chunk.length; compressedHash.update(chunk);
    callback(usage.compressed >= stop.compressed || usage.peak >= stop.peak ? new Error('compressed stop threshold') : null, chunk);
  } });
  function* chunks() { for (let i = 0; i < raw.length; i += 16_384) yield raw.subarray(i, i + 16_384); }
  await pipeline(Readable.from(chunks()), measureRaw, createGzip({ level: 6 }), measureCompressed, createWriteStream(path, { flags: 'wx' }), { signal });
  const sha256 = rawHash.digest('hex'); const compressedSha256 = compressedHash.digest('hex');
  const verify = createHash('sha256'); let verifiedBytes = 0;
  await pipeline(createReadStream(path), createGunzip(), new Writable({ write(chunk: Buffer, _encoding, callback) { verifiedBytes += chunk.length; verify.update(chunk); callback(); } }), { signal });
  if (verifiedBytes !== logicalBytes || verify.digest('hex') !== sha256) throw new Error('archive verification failed');
  return { logicalBytes, compressedBytes, sha256, compressedSha256 };
}

export async function verifyEvidenceArchive(path: string, proof: ArchiveProof, signal?: AbortSignal): Promise<void> {
  const raw = createHash('sha256'); let logicalBytes = 0;
  await pipeline(createReadStream(path), createGunzip(), new Writable({ write(chunk: Buffer, _encoding, callback) { logicalBytes += chunk.length; raw.update(chunk); callback(); } }), { signal });
  const compressed = createHash('sha256'); let compressedBytes = 0;
  await pipeline(createReadStream(path), new Writable({ write(chunk: Buffer, _encoding, callback) { compressedBytes += chunk.length; compressed.update(chunk); callback(); } }), { signal });
  if (logicalBytes !== proof.logicalBytes || compressedBytes !== proof.compressedBytes || raw.digest('hex') !== proof.sha256 || compressed.digest('hex') !== proof.compressedSha256) throw new Error('archive verification failed');
}

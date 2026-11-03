import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { archiveEvidence, verifyEvidenceArchive } from '../src/experiments/passive-archive';
import { nativeItems } from '../src/experiments/passive-loopback';

it('streams compressed evidence, verifies the raw hash and rejects overwriting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passive-archive-')); const file = join(dir, 'evidence.gz');
  try {
    const value = { data: '数据🐺'.repeat(10_000) }; const usage = { logical: 0, compressed: 0, compact: 0, peak: 0 };
    const result = await archiveEvidence(file, value, usage);
    expect(JSON.parse(gunzipSync(readFileSync(file)).toString())).toEqual(value);
    expect(result.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(value))); expect(result.sha256).toHaveLength(64);
    await expect(verifyEvidenceArchive(file, result)).resolves.toBeUndefined();
    await expect(verifyEvidenceArchive(file, { ...result, sha256: '0'.repeat(64) })).rejects.toThrow('verification');
    await expect(archiveEvidence(file, value, usage)).rejects.toThrow();
    await expect(archiveEvidence(join(dir, 'other.gz'), value, { logical: 4 * 1024 ** 3, compressed: 0, compact: 0, peak: 0 })).rejects.toThrow('threshold');
    const abort = new AbortController(); abort.abort();
    await expect(archiveEvidence(join(dir, 'cancelled.gz'), value, { logical: 0, compressed: 0, compact: 0, peak: 0 }, abort.signal)).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each(['chat-completions', 'responses', 'anthropic-messages'] as const)('keeps synthetic %s native items and matching receipt IDs', protocol => {
  const items = nativeItems(protocol, 'call-1'); expect(items.length).toBeGreaterThanOrEqual(2);
  expect(items.slice(-2).join(' ')).toContain('call-1'); expect(items.at(-1)).toContain('call-1');
});

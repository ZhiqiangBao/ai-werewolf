import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('archive is reproducible and excludes runtime and unlisted files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-package-test-'));
  const source = join(dir, 'source');
  const launchFiles = [
    '.agents/plugins/werewolf/mcp_config.json',
    '.agents/plugins/werewolf/plugin.json',
    '.codex/config.toml',
    '.cursor/mcp.json',
    'desktop-mcp.mjs',
    'player.mjs',
  ];
  const excludedFiles = [
    '.agents/plugins/local-secret/mcp_config.json', '.codex/config.local.toml', '.cursor/mcp.local.json',
    'rules/classic9.md', 'rules/idiot12.md', 'rules/mirror12.md', 'rules/standard12.md',
    'seats/1/seat.json', 'notes.md', 'last.txt', 'private.log',
  ];
  const names = [
    ...launchFiles, ...excludedFiles, '.cursor/rules/player.mdc', '.github/copilot-instructions.md',
    '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md', 'README.md',
  ];
  try {
    for (const name of names) { const path = join(source, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `fixture:${name}`); }
    const script = fileURLToPath(new URL('../package-agent.mjs', import.meta.url));
    const a = join(dir, 'a.zip'), b = join(dir, 'b.zip');
    for (const output of [a, b]) execFileSync(process.execPath, [script, source, output, 'agent-v0.1.0']);
    const archive = await readFile(a);
    assert.deepEqual(archive, await readFile(b));
    for (const name of launchFiles) assert.equal(archive.includes(Buffer.from(`fixture:${name}`)), true, name);
    for (const name of excludedFiles) assert.equal(archive.includes(Buffer.from(name)), false, name);
    assert.equal(archive.includes(Buffer.from('manifest.json')), true);
    assert.throws(() => execFileSync(process.execPath, [script, source, join(dir, 'unreviewed.zip'), 'agent-v0.1.0', '--expected-tree', '0'.repeat(64)], { stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, [script, source, join(dir, 'unbound.zip'), 'agent-v0.1.0', '--server-commit', 'a'.repeat(40)], { stdio: 'pipe' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

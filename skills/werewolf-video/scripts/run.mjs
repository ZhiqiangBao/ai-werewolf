import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
const arg = process.argv.slice(2).find((s) => s.startsWith('--project='));
const root = resolve(arg ? arg.slice(10) : process.cwd());
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'ai-werewolf') throw Error('Point --project at the intended ai-werewolf repository');
const runner = join(root, 'scripts/video/workflow.ts'), tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
try { await access(runner); await access(tsx); } catch { throw Error('Missing pipeline/dependencies. See bootstrap.mjs and references/automation.md.'); }
const child = spawn(process.execPath, [tsx, runner, ...process.argv.slice(2).filter((s) => !s.startsWith('--project='))], { cwd: root, windowsHide: true, stdio: 'inherit' });
child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });

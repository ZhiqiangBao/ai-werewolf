import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('repairs English speech using its source language for decimal word timestamps', () => {
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', fileURLToPath(new URL('./fixtures/video-repair-locale-check.ts', import.meta.url))], { stdio: 'pipe' });
});

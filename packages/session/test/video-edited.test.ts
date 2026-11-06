import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('renders checked edited videos and rejects tampering', () => {
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', fileURLToPath(new URL('./fixtures/video-edited-check.ts', import.meta.url))], { stdio: 'pipe', timeout: 120000 });
}, 120000);

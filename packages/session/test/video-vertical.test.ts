import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('renders a reviewed portrait and rejects invalid selections', () => {
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', fileURLToPath(new URL('./fixtures/video-vertical-check.ts', import.meta.url))], { stdio: 'pipe', timeout: 120000 });
}, 120000);

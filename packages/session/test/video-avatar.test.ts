import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('binds avatar themes, limits art references and preserves publication choices', () => {
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', fileURLToPath(new URL('./fixtures/video-avatar-check.ts', import.meta.url))], { stdio: 'pipe' });
});

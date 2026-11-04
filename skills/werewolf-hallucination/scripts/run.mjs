import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let tsx;
try { tsx = createRequire(import.meta.url).resolve('tsx/cli'); } catch { /* dependency message below */ }
if (!tsx) {
  console.error('DEPENDENCIES_MISSING: 请先在游戏仓库根目录按项目指南安装依赖，再重新执行。');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [tsx, join(root, 'packages/session/scripts/hallucination.ts'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  if (result.error) console.error('SCRIPT_START_FAILED: 无法启动本地诊断脚本。');
  process.exitCode = result.status ?? 1;
}

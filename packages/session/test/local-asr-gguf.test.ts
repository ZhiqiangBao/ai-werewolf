import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('keeps GGUF GPU selection and fresh unprompted sessions explicit', async () => {
  const python = process.env.WEREWOLF_ASR_PYTHON || 'python';
  const result = await promisify(execFile)(python, ['scripts/asr/test_gguf.py'], { timeout: 30000 });
  expect(result.stderr).toContain('OK');
}, 35000);

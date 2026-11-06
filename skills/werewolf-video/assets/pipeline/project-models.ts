import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SecretBox } from '../../packages/session/src/secret';
function validEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** 仅从项目加密模型库读取 Qwen Token Plan 凭据，不触碰用户全局 settings。 */
export function projectQwenTokenPlanKey(): string | undefined {
  const directory = resolve(process.env.WEREWOLF_DATA || process.env.VIDEO_DATA_DIR || 'data');
  const file = join(directory, 'models.json');
  if (!existsSync(file)) return;
  try {
    const models = JSON.parse(readFileSync(file, 'utf8')).models;
    if (!Array.isArray(models)) return;
    const secrets = process.env.WEREWOLF_SECRET || existsSync(join(directory, 'secret.key')) ? SecretBox.fromEnvOrFile(directory) : undefined;
    for (const model of models) {
      if (new URL(model.baseUrl).hostname !== 'token-plan.maas.qianwenaiapi.com') continue;
      try {
        const key = validEnvName(model.apiKeyEnv) && model.apiKeyEnc === null ? process.env[model.apiKeyEnv]?.trim() : model.apiKeyEnc && secrets ? secrets.decrypt(model.apiKeyEnc) : undefined;
        if (key?.startsWith('sk-sp-')) return key;
      } catch { /* Preserve the original key file; do not try external credentials. */ }
    }
  } catch { /* Missing or invalid project credentials are reported by the caller. */ }
}

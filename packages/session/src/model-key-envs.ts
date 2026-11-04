import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LocalizedError } from '@werewolf/protocol';
import { validEnvName } from './model-library';

/** 配置由本机人员维护；服务只读变量名，绝不返回变量值。 */
export function modelKeyEnvs(modelsPath?: string): { name: string; available: boolean }[] {
  if (!modelsPath) return [];
  const file = join(dirname(modelsPath), 'model-key-envs.json');
  if (!existsSync(file)) return [];
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => key !== 'variables')) throw Error();
    const variables = (data as { variables?: unknown }).variables;
    if (!Array.isArray(variables) || variables.some((name) => !validEnvName(name)) || new Set(variables).size !== variables.length) throw Error();
    return variables.map((name: string) => ({ name, available: !!process.env[name]?.trim() }));
  } catch {
    throw new LocalizedError('模型密钥变量配置无效，请检查 data/model-key-envs.json；原文件未被修改。');
  }
}

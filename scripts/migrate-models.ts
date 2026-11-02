import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ModelLibrary } from '../packages/session/src/model-library';
import { SecretBox } from '../packages/session/src/secret';

const directory = resolve(process.env.WEREWOLF_DATA || 'data'), file = join(directory, 'models.json');
if (existsSync(file) && !process.env.WEREWOLF_SECRET && !existsSync(join(directory, 'secret.key'))) throw Error('已有加密模型库但主密钥缺失，迁移停止；请恢复原主密钥');
if (existsSync(file)) {
  const backup = join(directory, 'backups'); mkdirSync(backup, { recursive: true });
  copyFileSync(file, join(backup, `models-before-import-${Date.now()}.json`));
}
const library = new ModelLibrary(SecretBox.fromEnvOrFile(directory), file);
const imported = library.importLegacySettings(), models = library.views();
console.log(JSON.stringify({ imported, total: models.length, withKey: models.filter((model) => model.hasKey).length, globalConfigModified: false }));

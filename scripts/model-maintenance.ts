import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDataLease, ModelMaintenance, SecretBox } from '@werewolf/session';
import type { EvidenceScopeBinding, RetirementEvidence } from '../packages/session/src/model-retirement';
import type { ModelAliasEvidence } from '../packages/session/src/model-maintenance';

// 首次迁移时旧服务不持有租约，调用者必须先确认旧服务已停止。
const [operation, modelId, arg3, arg4, arg5, arg6] = process.argv.slice(2).filter((arg) => arg !== '--old-server-stopped');
if (operation === 'scope-id') {
  if (modelId) throw new Error('scope-id 不接受账号、套餐、区域或密钥参数');
  console.log(randomUUID());
  process.exit(0);
}
if (!process.argv.includes('--old-server-stopped')) throw new Error('请先确认旧版服务已停止，并传入 --old-server-stopped');
if (!modelId || !['preview', 'scope', 'record', 'disable', 'archive', 'restore', 'enable', 'preview-merge', 'merge'].includes(operation)) throw new Error('用法：model-maintenance <preview|disable|archive|restore|enable> <modelId> [revision inventoryDigest]；scope <modelId> <revision> <作用域JSON路径>；record <modelId> <revision> <证据JSON路径>；preview-merge <来源ID> <目标ID> [映射JSON]；merge <来源ID> <目标ID> <revision> <inventoryDigest> [映射JSON]；均须传 --old-server-stopped。具体范围使用随机 UUID v4，账号标识须对应账号／套餐组合；不得输入密钥或账号原文／散列。');
const directory = resolve(process.env.WEREWOLF_DATA ?? 'data');
const release = acquireDataLease(directory);
try {
  if (existsSync(join(directory, 'models.json')) && !process.env.WEREWOLF_SECRET && !existsSync(join(directory, 'secret.key'))) throw new Error('已有模型库但主密钥缺失，维护停止');
  const maintenance = new ModelMaintenance(directory, SecretBox.fromEnvOrFile(directory));
  let result: unknown;
  if (operation === 'preview') result = maintenance.preview(modelId);
  else if (operation === 'scope') {
    maintenance.setScope(modelId, JSON.parse(readFileSync(arg4, 'utf8')) as EvidenceScopeBinding, arg3);
    result = maintenance.preview(modelId);
  }
  else if (operation === 'record') {
    maintenance.recordEvidence(modelId, JSON.parse(readFileSync(arg4, 'utf8')) as RetirementEvidence, arg3);
    result = maintenance.preview(modelId);
  } else if (operation === 'preview-merge' || operation === 'merge') {
    const evidenceFile = operation === 'preview-merge' ? arg4 : arg6;
    const evidence = evidenceFile ? JSON.parse(readFileSync(evidenceFile, 'utf8')) as ModelAliasEvidence : undefined;
    result = operation === 'preview-merge' ? maintenance.previewMerge(modelId, arg3, evidence) : maintenance.merge(modelId, arg3, arg4, arg5, evidence);
  } else result = maintenance.apply({ modelId, operation: operation as 'disable' | 'archive' | 'restore' | 'enable', expectedRevision: arg3, expectedInventoryDigest: arg4 });
  console.log(JSON.stringify(result, null, 2));
} finally { release(); }

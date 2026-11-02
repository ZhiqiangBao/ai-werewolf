import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

interface IdentityFile { version: 1; providers: Record<string, string>; models: Record<string, string> }

/** 映射文件只在本机保留；正文、URL 路径和凭证从不成为分享标签。 */
export class ObservationIdentities {
  private readonly data: IdentityFile;
  constructor(private readonly file: string, private readonly alias?: (origin: string) => string | undefined) {
    this.data = { version: 1, providers: {}, models: {} };
    try {
      if (existsSync(file)) {
        const loaded = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile;
        if (loaded.version === 1 && loaded.providers && loaded.models) {
          for (const group of ['providers', 'models'] as const) for (const [key, value] of Object.entries(loaded[group])) {
            if (typeof value === 'string' && /^[pm]-[a-f0-9-]{36}$/.test(value)) this.data[group][key] = value;
          }
        }
      }
    } catch { /* 观测映射损坏不能使业务无法启动。 */ }
  }

  private id(group: 'providers' | 'models', key: string): string {
    const existing = this.data[group][key];
    if (existing) return existing;
    // 多个管理器可持有同一个本机映射；写新键前合并最新文件，不能覆盖其他实例新增的键。
    try {
      const latest = JSON.parse(readFileSync(this.file, 'utf8')) as IdentityFile;
      if (latest.version === 1) for (const name of ['providers', 'models'] as const) {
        for (const [item, value] of Object.entries(latest[name] ?? {})) {
          if (typeof value === 'string' && /^[pm]-[a-f0-9-]{36}$/.test(value)) this.data[name][item] = value;
        }
      }
    } catch { /* 首次运行或不可读时继续使用本进程映射。 */ }
    if (this.data[group][key]) return this.data[group][key];
    const id = `${group === 'providers' ? 'p' : 'm'}-${randomUUID()}`;
    this.data[group][key] = id;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.data));
      renameSync(temporary, this.file);
    } catch { /* 保留本进程 ID；采集不改变游戏的错误处理。 */ }
    return id;
  }

  provider(baseUrl: string): string {
    let origin = 'local-mock';
    try { origin = new URL(baseUrl).origin; } catch { /* 本地无网络模型。 */ }
    const alias = this.alias?.(origin);
    return this.id('providers', alias ? `${origin}|${alias}` : origin);
  }

  model(model: string): string { return this.id('models', model); }
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** AES-256-GCM 加密座位密钥。主密钥来自环境变量 WEREWOLF_SECRET，或首次启动时生成的 data/secret.key。 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('主密钥必须是 32 字节');
    this.key = key;
  }

  static fromEnvOrFile(dataDir: string): SecretBox {
    const env = process.env.WEREWOLF_SECRET;
    if (env) return new SecretBox(createHash('sha256').update(env).digest());
    const file = join(dataDir, 'secret.key');
    if (existsSync(file)) return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
    const key = randomBytes(32);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    return new SecretBox(key);
  }

  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(blob: string): string {
    if (!blob.startsWith('v1.')) throw new Error('无法识别的密文格式');
    const raw = Buffer.from(blob.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export function maskKey(plain: string): string {
  const t = plain.trim();
  return t.length <= 10 ? '••••••' : `${t.slice(0, 3)}••••${t.slice(-4)}`;
}

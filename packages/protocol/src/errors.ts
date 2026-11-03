import { gameText } from './locale';

/** 在验证发生处指定模板，消费方无需解析或匹配错误正文。 */
export interface LocalizedMessage { key: string; values?: readonly unknown[] }
export class LocalizedError extends Error {
  readonly localization: LocalizedMessage;
  constructor(key: string, ...values: unknown[]) {
    super(gameText('zh-CN', key, ...values));
    this.localization = { key, values };
  }
}

const codeMessages: Record<string, string> = {
  BAD_REQUEST: '请求参数无效，请检查配置或输入', NOT_FOUND: '未找到请求的内容',
  UNAUTHORIZED: '缺少有效凭证', FORBIDDEN: '当前凭证没有此操作权限',
  NETWORK: '连不上服务器，请确认服务已启动', HTTP: '请求失败，请稍后重试',
  INTERNAL: '服务器内部错误', TOO_LARGE: '请求体过大',
  MANAGER_DISPOSED: '服务正在关闭，请稍后重新连接',
  MODEL_MAINTENANCE_REQUIRED: '请停止服务后使用本机模型维护命令。',
  MODEL_DISABLED: '模型已停用，请选择其他模型',
  INVALID_SETUP: '房间配置尚未准备好，请检查配置页的提示',
  ALREADY_STARTED: '对局已经开始，不能再修改配置',
  NOT_STARTED: '对局还没有开始', NOT_ENDED: '终局后才能导出公开记录',
  NOT_RUNNING: '对局不在进行中', NOT_HUMAN_SEAT: '这个座位由模型控制',
  NOT_PAUSED: '单步只在暂停时可用', PAUSED: '对局已暂停',
  ACTION_NOT_OPEN: '推进间隔尚未结束，请稍后行动',
  NOT_LISTENING: '服务尚未监听网络端口',
  UNSUPPORTED_ROLE_DATA: '此存档包含当前引擎不支持的私有数据版本；保留原记录，仅可查看历史。',
  SPEECH_UNAVAILABLE: '所选来源朗读失败，请检查服务配置或稍后重试；未切换到其他来源。',
};

/** 无结构化信息的旧错误使用稳定错误码给出本地化建议；不猜测上游错误含义。 */
export function apiErrorText(locale: string | undefined, code: string, localization?: LocalizedMessage): string {
  return localization ? gameText(locale, localization.key, ...(localization.values ?? [])) : gameText(locale, codeMessages[code] ?? codeMessages.HTTP);
}

/** Accept-Language 只影响当前响应；不作为房间语言的缺省来源。 */
export function preferredLanguage(header: string | undefined, registered: readonly string[], fallback = 'zh-CN'): string {
  const requested = (header ?? '').split(',').map((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    const quality = params.find((s) => s.trim().startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    return { tag, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
  }).filter(({ q }) => q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of requested) {
    const exact = registered.find((id) => id.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const base = tag.toLowerCase().split('-')[0];
    const match = registered.find((id) => id.toLowerCase() === base) ?? registered.find((id) => id.toLowerCase().split('-')[0] === base);
    if (match) return match;
  }
  return fallback;
}

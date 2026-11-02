/** 客户端只获得提供方名称，不获得地址、密钥、模型参数或适配器路径。 */
export interface SpeechProviderView { id: string; label: string }
export interface SpeechProvidersView {
  providers: SpeechProviderView[];
  defaultProviderId: string | null;
  error?: string;
}

/** 房主配置的接入协议；名称是显示名，与模型 ID 分开。 */
export type SpeechConnectionKind = 'speech-compatible' | 'qwen' | 'mimo' | 'minimax' | 'http-audio' | 'http-json-audio';
export interface SpeechConnectionDraft {
  name: string;
  url: string;
  kind: SpeechConnectionKind;
  /** 更新时省略或留空表示保留已有密钥。 */
  apiKey?: string;
  model?: string;
  voice?: string;
  /** 自定义 HTTP 接口使用 JSON 请求模板，其中必须包含 {{text}}。 */
  bodyJson?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  audioPath?: string;
  encoding?: 'base64' | 'hex';
  mimeType?: string;
}
/** 仅房主可读取；不包含密钥明文、密文或掩码。 */
export interface SpeechConnectionView extends Omit<SpeechConnectionDraft, 'apiKey'> { id: string; hasKey: boolean }
export interface SpeechSettingsView { connections: SpeechConnectionView[]; builtins: SpeechProviderView[]; error?: string }
export const SPEECH_CONNECTION_TEMPLATES: { kind: SpeechConnectionKind; label: string; url: string; model: string; voice: string }[] = [
  { kind: 'speech-compatible', label: '兼容语音接口', url: '', model: '', voice: '' },
  { kind: 'qwen', label: 'Qwen HTTP', url: 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer', model: 'qwen-audio-3.0-tts-plus', voice: 'qwen-audio-3.0-tts-plus-longshuojizhu' },
  { kind: 'mimo', label: '小米 MiMo', url: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-tts', voice: '苏打' },
  { kind: 'minimax', label: 'MiniMax', url: 'https://api.minimax.cn/v1/t2a_v2', model: 'speech-2.8-hd', voice: 'male-qn-qingse' },
  { kind: 'http-audio', label: '自定义 HTTP · 音频响应', url: '', model: '', voice: '' },
  { kind: 'http-json-audio', label: '自定义 HTTP · JSON 音频', url: '', model: '', voice: '' },
];

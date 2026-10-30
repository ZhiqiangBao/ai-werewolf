import type { Projection, Seat, ToolCall, ToolMode, ToolSpec } from '@werewolf/protocol';

export interface ToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallMessage[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface AdapterConfig {
  baseUrl: string;
  model: string;
  /** 解密后的密钥，只在内存中传给适配器。 */
  apiKey: string | null;
  temperature: number;
  toolMode: ToolMode;
  timeoutSec: number;
}

export interface DecideRequest {
  seat: Seat;
  /** 与该座位网页所用完全相同的投影。连通性测试没有投影。 */
  projection?: Projection;
  messages: ChatMessage[];
  tools: ToolSpec[];
  config: AdapterConfig;
  signal?: AbortSignal;
}

export interface DecideResult {
  ok: boolean;
  call?: ToolCall;
  error?: string;
  /** 超时、请求被取消或接口报错：把错误发回模型也无济于事，不再重试，直接托管。 */
  fatal?: boolean;
  /** 模型这次的回复，重试时连同反馈一起追加到消息末尾。 */
  assistant?: ChatMessage;
  toolCallIds: string[];
  raw?: unknown;
  latencyMs: number;
}

export interface Adapter {
  decide(req: DecideRequest): Promise<DecideResult>;
}

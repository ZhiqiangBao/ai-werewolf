import type { Projection, Seat, ThinkingMode, ToolCall, ToolMode, ToolSpec } from '@werewolf/protocol';

export interface ToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; name?: string }
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
  thinkingMode?: ThinkingMode;
}

export interface DecideRequest {
  seat: Seat;
  /** 与该座位网页所用完全相同的投影。连通性测试没有投影。 */
  projection?: Projection;
  messages: ChatMessage[];
  tools: ToolSpec[];
  config: AdapterConfig;
  /**
   * 缺省 required，和行动轮次一样。
   * auto 只用于「发言已经广播、但还没轮到你」：工具列表仍是原来的那一份，模型可以只回正文。
   */
  toolChoice?: 'required' | 'auto';
  signal?: AbortSignal;
  /** 优先走流式接口，边生成边把思考和正文交出来。 */
  stream?: boolean;
  onDelta?: (delta: { thinking?: string; reply?: string }) => void;
}

export interface DecideResult {
  ok: boolean;
  call?: ToolCall;
  error?: string;
  /** 超时、请求被取消或接口报错：把错误发回模型也无济于事，不再重试，直接托管。 */
  fatal?: boolean;
  failureKind?: 'timeout' | 'cancelled' | 'http' | 'network' | 'invalid_tool';
  /** 模型这次的回复，重试时连同反馈一起追加到消息末尾。 */
  assistant?: ChatMessage;
  toolCallIds: string[];
  raw?: unknown;
  latencyMs: number;
  /** 模型的思考过程。只供显示，调用方不得写进提示词。 */
  thinking?: string;
  /** 工具调用之外的正文。只供显示，调用方不得写进提示词。 */
  reply?: string;
}

export interface Adapter {
  decide(req: DecideRequest): Promise<DecideResult>;
}

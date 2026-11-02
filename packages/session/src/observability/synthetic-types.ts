import type { ApiProtocol } from '@werewolf/protocol';

/** 仅用于独立本机测试进程的控制通道，不写入生产请求或分享报告。 */
export interface SyntheticResponsePlan {
  protocol: ApiProtocol;
  call?: { tool: string; args: Record<string, unknown> };
  stream: boolean;
  headersMs: number;
  firstContentMs: number;
  chunks: number;
  chunkIntervalMs: number;
  status?: number;
  disconnect?: boolean;
  capacity?: number;
  errorKind?: 'unsupported_stream' | 'unsupported_tool_choice' | 'unsupported_json';
  malformed?: boolean;
  hangAfterContent?: boolean;
  jsonMode?: boolean;
  disconnectAfterContent?: boolean;
  noContent?: boolean;
  omitQueue?: boolean;
}

/** 服务进程只输出自己的时段长度；不向客户端暴露跨进程时钟差。 */
export interface SyntheticTruth {
  attemptId: string;
  source: 'synthetic';
  planned: { headersMs: number; firstContentMs: number; chunks: number; chunkIntervalMs: number; status: number; capacity: number | null };
  queueMs: number | null;
  headersMs: number | null;
  firstBodyByteMs: number | null;
  firstStreamContentMs: number | null;
  bodyConsumeMs: number | null;
  elapsedMs: number;
  finished: boolean;
}

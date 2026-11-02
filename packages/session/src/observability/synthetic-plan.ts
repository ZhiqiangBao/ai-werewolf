/** Declarative test plans. Durations are injection parameters, not measurements. */
export const SYNTHETIC_SEEDS = ['obs-standard12-001', 'obs-standard12-002', 'obs-standard12-003'] as const;
export const SYNTHETIC_PROTOCOLS = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export type SyntheticProtocol = typeof SYNTHETIC_PROTOCOLS[number];
export type SyntheticScenarioId = `S${string}`;

export interface SyntheticScenario {
  id: SyntheticScenarioId;
  title: string;
  topology: 'single' | 'shared' | 'separate';
  injection: Readonly<Record<string, string | number | boolean>>;
  protocols: readonly SyntheticProtocol[];
}

const all = SYNTHETIC_PROTOCOLS;
export const SYNTHETIC_SCENARIOS: readonly SyntheticScenario[] = [
  { id: 'S01', title: '正常单桌', topology: 'single', injection: { headersMs: 20, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10 }, protocols: all },
  { id: 'S02', title: '双桌共享端点', topology: 'shared', injection: { headersMs: 20, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10 }, protocols: all },
  { id: 'S03', title: '双桌不同端点', topology: 'separate', injection: { headersMs: 20, secondHeadersMs: 80, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10 }, protocols: all },
  { id: 'S04', title: '慢旁听', topology: 'single', injection: { listenExtraMs: 500 }, protocols: all },
  { id: 'S05', title: '长响应、纯工具流和心跳', topology: 'single', injection: { chunks: 100, chunkIntervalMs: 10, toolOnly: true, heartbeat: true }, protocols: all },
  { id: 'S06', title: '非流式回复', topology: 'single', injection: { stream: false }, protocols: all },
  { id: 'S07', title: 'HTTP 重试及连接失败', topology: 'single', injection: { statuses: '429,500,200', separateNetworkFailure: true }, protocols: all },
  { id: 'S08', title: '工具纠错', topology: 'single', injection: { invalidFirstTool: true }, protocols: all },
  { id: 'S09', title: '兼容回退', topology: 'single', injection: { variants: 'stream,required,json,combined', memory: 'cold,warm' }, protocols: all },
  { id: 'S10', title: '各阶段超时', topology: 'single', injection: { boundaries: 'before_headers,after_content,backoff' }, protocols: all },
  { id: 'S11', title: '取消和迟到结果', topology: 'single', injection: { cases: 'pause,end,decision_changed,dispose,late' }, protocols: all },
  { id: 'S12', title: '本地阻塞', topology: 'single', injection: { clientBlockMs: 200 }, protocols: all },
  { id: 'S13', title: '持久化阻塞', topology: 'single', injection: { stores: 'delayed_memory,file' }, protocols: all },
  { id: 'S14', title: '模拟提供方队列', topology: 'single', injection: { capacity: 1, queuePresence: 'present,absent' }, protocols: all },
  { id: 'S15', title: '异常及采集故障', topology: 'single', injection: { cases: 'disconnect,no_content,parse,config,sink,write' }, protocols: all },
];

export interface SyntheticRunPlan {
  scenario: SyntheticScenarioId;
  protocol: SyntheticProtocol;
  seed: typeof SYNTHETIC_SEEDS[number];
  repetition: number;
  phase: 'warmup' | 'measurement' | 'overhead';
  observation: boolean;
  order?: 'AB' | 'BA';
  pair?: number;
}

/** Full plan only describes intended work. It never asserts any result. */
export function formalSyntheticPlan(): SyntheticRunPlan[] {
  const result: SyntheticRunPlan[] = [];
  for (const scenario of SYNTHETIC_SCENARIOS) for (const protocol of scenario.protocols) {
    if (['S01', 'S02', 'S03'].includes(scenario.id)) {
      result.push({ scenario: scenario.id, protocol, seed: SYNTHETIC_SEEDS[0], repetition: 0, phase: 'warmup', observation: true });
      for (const seed of SYNTHETIC_SEEDS) for (let repetition = 1; repetition <= 3; repetition++)
        result.push({ scenario: scenario.id, protocol, seed, repetition, phase: 'measurement', observation: true });
    } else {
      for (let repetition = 1; repetition <= 3; repetition++)
        result.push({ scenario: scenario.id, protocol, seed: SYNTHETIC_SEEDS[repetition - 1], repetition, phase: 'measurement', observation: true });
    }
  }
  return result;
}

/** Each pair runs both modes in alternating order under the same seed. */
export function overheadSyntheticPlan(): SyntheticRunPlan[] {
  const result: SyntheticRunPlan[] = [];
  for (const scenario of ['S01', 'S02'] as const) for (const protocol of SYNTHETIC_PROTOCOLS) {
    for (let pair = 1; pair <= 30; pair++) {
      const order = pair % 2 ? 'AB' : 'BA';
      for (const observation of order === 'AB' ? [false, true] : [true, false])
        result.push({ scenario, protocol, seed: SYNTHETIC_SEEDS[(pair - 1) % 3], repetition: pair, phase: 'overhead', observation, order, pair });
    }
  }
  return result;
}

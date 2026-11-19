import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const WAIT_MS = 25_000;
const connectionId = { type: 'string', minLength: 1, description: 'Private connectionId returned by join_seat in this chat.' };
const UNKNOWN_ACTION = { status: 'unknown', message: '未收到提交回执。先接收本席更新，核对是否已提交，再决定下一步。' };

function tool(name, description, properties, required = Object.keys(properties)) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const TOOLS = [
  tool('join_seat', 'Join the game using the player seat link provided to this chat. Returns the first authorized update.',
    { link: { type: 'string', minLength: 1 }, seat: { type: 'integer', minimum: 1, maximum: 12 }, name: { type: 'string', minLength: 1 } }, ['link']),
  tool('wait_for_update', 'Receive the next authorized game update. An idle result means there was no update during this wait.',
    { connectionId, afterCursor: { type: 'integer', minimum: 1, description: 'Cursor from the last received update.' } }),
  tool('submit_action', 'Send one game action or speech using the current server menu and the decisionId from that update.',
    { connectionId, decisionId: { type: 'string', minLength: 1 }, tool: { type: 'string', minLength: 1 }, args: { type: 'object' } }),
  tool('leave_seat', 'Release this chat’s local connection when finished or when the user asks to stop.',
    { connectionId }),
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validArgument(property, value) {
  if (property?.type === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (property?.type === 'integer') {
    return Number.isSafeInteger(value) && value >= property.minimum && value <= (property.maximum ?? Number.MAX_SAFE_INTEGER);
  }
  return property?.type === 'object' && isObject(value);
}

function toolArguments(name, args) {
  const spec = TOOLS.find((entry) => entry.name === name);
  if (!spec) throw new Error('未知的席位工具。');
  const { properties, required } = spec.inputSchema;
  if (!isObject(args) || !required.every((key) => Object.hasOwn(args, key))) {
    throw new Error('缺少席位工具的必填参数。');
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key) || !validArgument(properties[key], value)) throw new Error('席位工具参数与声明不符。');
  }
  return args;
}

function seatSnapshot(cfg, view) {
  const { room, projection } = view;
  if (room?.viewer !== 'seat' || room.roomId !== cfg.roomId || room.seat !== cfg.seat ||
      (projection && (projection.viewer?.kind !== 'seat' || projection.viewer.seat !== cfg.seat))) {
    throw new Error('收到的视角与本席不符，请重新核对席位链接。');
  }
  const task = projection?.task ?? null;
  const optionalTools = projection?.interrupts ?? [];
  const ended = room.status === 'ended' || projection?.status === 'ended' ||
    (projection?.me?.canStop === true && (!task || task.submitted) && !optionalTools.length);
  const events = projection?.events ?? [];
  const ruleCard = projection?.ruleCard ?? room.ruleCard ?? '';
  const actionAvailableAt = view.presentation?.actionAvailableAt ?? null;
  const fields = {
    roomId: cfg.roomId,
    seat: cfg.seat,
    locale: projection?.locale ?? room.locale ?? 'zh-CN',
    presetName: projection?.presetName ?? room.presetName,
    roomStatus: room.status,
    paused: !!room.paused,
    day: projection?.day ?? null,
    phase: projection?.phase ?? 'setup',
    stage: projection?.stage ?? room.status,
    identity: projection?.me ?? null,
    seats: projection?.seats ?? room.seats ?? [],
    task,
    optionalActions: optionalTools.length && projection.actionWindowId
      ? { decisionId: projection.actionWindowId, tools: optionalTools } : null,
    actionAvailableAt,
    actionsOpen: !ended && !room.paused && (!actionAvailableAt || actionAvailableAt <= Date.now()) &&
      !!((task && !task.submitted) || optionalTools.length),
    result: projection?.result ?? null,
  };
  return { fields, ruleCard, events, sequence: events.at(-1)?.seq ?? 0, signature: JSON.stringify(fields), ended };
}

function hasUpdate(snapshot, previous) {
  return !previous || snapshot.ended !== previous.ended || snapshot.sequence !== previous.sequence ||
    snapshot.signature !== previous.signature || snapshot.ruleCard !== previous.ruleCard;
}

function deliver(connection, snapshot) {
  const previous = connection.acknowledged;
  const seen = previous && snapshot.sequence >= previous.sequence ? previous.sequence : 0;
  const cursor = (previous?.cursor ?? 0) + 1;
  const update = {
    status: snapshot.ended ? 'ended' : 'update',
    cursor,
    ...snapshot.fields,
    ...(snapshot.ruleCard !== previous?.ruleCard ? { ruleCard: snapshot.ruleCard } : {}),
    events: snapshot.events.filter((event) => event.seq > seen).map((event) => ({
      seq: event.seq, day: event.day, phase: event.phase, type: event.type, text: event.text,
      public: event.audience === 'public',
    })),
  };
  connection.delivered = {
    update,
    cursor,
    sequence: snapshot.sequence,
    signature: snapshot.signature,
    ruleCard: snapshot.ruleCard,
    ended: snapshot.ended,
  };
  return update;
}

function advanceCursor(connection, cursor) {
  if (connection.delivered?.cursor === cursor) {
    const { update, ...acknowledged } = connection.delivered;
    connection.acknowledged = acknowledged;
    connection.delivered = null;
  }
  if (connection.acknowledged?.cursor !== cursor) {
    throw new Error('afterCursor 必须是本连接上一次收到的消息游标。');
  }
}

function networkFailure(error) {
  return error?.code === 'NETWORK' || error?.status >= 500;
}

async function receive(connection, cursor, game, signal) {
  if (connection.waiting) throw new Error('本席已有一个接收请求，请等待其返回。');
  advanceCursor(connection, cursor);
  if (connection.delivered) return connection.delivered.update;
  if (connection.acknowledged.ended) return { status: 'ended', cursor };

  connection.waiting = true;
  const idle = AbortSignal.timeout(WAIT_MS);
  const waitSignal = AbortSignal.any([signal, idle]);
  const { cfg, acknowledged } = connection;
  try {
    while (!waitSignal.aborted) {
      try {
        const snapshot = seatSnapshot(cfg, await game.getView(cfg, waitSignal));
        if (hasUpdate(snapshot, acknowledged)) return deliver(connection, snapshot);
        const opensIn = snapshot.fields.actionAvailableAt ? snapshot.fields.actionAvailableAt - Date.now() : 0;
        const opening = !snapshot.fields.paused && !snapshot.fields.actionsOpen && opensIn > 0 && opensIn <= WAIT_MS
          ? AbortSignal.timeout(opensIn) : undefined;
        const noticeSignal = opening ? AbortSignal.any([waitSignal, opening]) : waitSignal;
        try {
          const notice = await game.waitForNotice(cfg, (view) => hasUpdate(seatSnapshot(cfg, view), acknowledged), noticeSignal);
          if (notice === 'eof') await delay(300, undefined, { signal: waitSignal });
        } catch (error) {
          if (!opening?.aborted || waitSignal.aborted) throw error;
        }
      } catch (error) {
        if (waitSignal.aborted) break;
        if (!networkFailure(error) && !(error instanceof TypeError)) throw error;
        await delay(1_000, undefined, { signal: waitSignal }).catch(() => waitSignal.throwIfAborted());
      }
    }
  } catch (error) {
    if (!waitSignal.aborted) throw error;
  } finally {
    connection.waiting = false;
  }
  signal.throwIfAborted();
  return { status: 'idle', cursor };
}

async function submit(connection, action, game, signal) {
  if (connection.submitting) throw new Error('本席已有一个行动在提交，请先等回执。');
  connection.submitting = true;
  const { cfg } = connection;
  try {
    const snapshot = seatSnapshot(cfg, await game.getView(cfg, signal));
    const { task, optionalActions, paused, actionsOpen, actionAvailableAt } = snapshot.fields;
    const current = (task && !task.submitted && task.decisionId === action.decisionId && task.tools.some((entry) => entry.name === action.tool)) ||
      (optionalActions?.decisionId === action.decisionId && optionalActions.tools.some((entry) => entry.name === action.tool));
    if (snapshot.ended || !current) {
      return { status: 'rejected', code: 'STALE_ACTION', message: '这一步已变化、已提交或工具不在本席菜单中。请先接收最新消息。' };
    }
    if (paused || !actionsOpen) {
      return { status: 'rejected', code: paused ? 'PAUSED' : 'ACTION_NOT_OPEN', actionAvailableAt, message: '当前行动尚未开放。请等待状态更新。' };
    }
    try {
      const result = await game.postAction(cfg, action, signal);
      if (result.ok === false) {
        return { status: 'rejected', code: result.error?.code, message: result.error?.message ?? '服务端未接受该行动。' };
      }
      if (result.ok !== true) return UNKNOWN_ACTION;
      return { status: 'accepted', decisionId: action.decisionId, tool: action.tool };
    } catch (error) {
      signal.throwIfAborted();
      if (networkFailure(error)) return UNKNOWN_ACTION;
      if (error.status) return { status: 'rejected', code: error.code, message: error.message };
      throw error;
    }
  } finally {
    connection.submitting = false;
  }
}

function toolResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

export async function serveDesktopMcp(game) {
  const connections = new Map();
  const requests = new Map();
  const stop = new AbortController();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const onClose = () => {
    stop.abort();
    lines.close();
  };
  lines.once('close', onClose);
  process.stdout.on('error', onClose);
  const send = (message) => {
    if (!stop.signal.aborted) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  };

  async function callTool(params, requestSignal) {
    try {
      const args = toolArguments(params?.name, params?.arguments);
      if (params.name === 'join_seat') {
        const { cfg, view } = await game.joinSeat(args, requestSignal);
        requestSignal.throwIfAborted();
        const id = randomUUID();
        const connection = { cfg, stop: new AbortController(), acknowledged: null, delivered: null, waiting: false, submitting: false };
        const update = deliver(connection, seatSnapshot(cfg, view));
        connections.set(id, connection);
        return toolResult({ connectionId: id, update });
      }

      const connection = connections.get(args.connectionId);
      if (!connection) throw new Error('本地连接已失效。请用本会话自己的席位链接重新入座。');
      const signal = AbortSignal.any([requestSignal, connection.stop.signal]);
      if (params.name === 'wait_for_update') return toolResult(await receive(connection, args.afterCursor, game, signal));
      if (params.name === 'submit_action') {
        const { decisionId, tool, args: actionArgs } = args;
        return toolResult(await submit(connection, { decisionId, tool, args: actionArgs }, game, signal));
      }
      connections.delete(args.connectionId);
      connection.stop.abort();
      return toolResult({ status: 'left', roomId: connection.cfg.roomId, seat: connection.cfg.seat });
    } catch (error) {
      requestSignal.throwIfAborted();
      return toolResult({ status: 'error', message: error.message }, true);
    }
  }

  try {
    for await (const line of lines) {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'Invalid JSON' } });
        continue;
      }
      if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        send({ id: null, error: { code: -32600, message: 'Invalid request' } });
        continue;
      }
      const { id, method, params } = request;
      if (id === undefined) {
        if (method === 'notifications/cancelled') requests.get(params?.requestId)?.controller.abort();
        continue;
      }
      if (method === 'initialize') {
        const protocolVersion = PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'werewolf-seat', version: '0.1.3' } } });
      } else if (method === 'ping') {
        send({ id, result: {} });
      } else if (method === 'tools/list') {
        send({ id, result: { tools: TOOLS } });
      } else if (method === 'tools/call' && !requests.has(id)) {
        const controller = new AbortController();
        const signal = AbortSignal.any([stop.signal, controller.signal]);
        const done = callTool(params, signal).then((result) => {
          if (!signal.aborted) send({ id, result });
        }).catch(() => {
          if (!signal.aborted) send({ id, error: { code: -32603, message: 'Seat tool failed' } });
        }).finally(() => requests.delete(id));
        requests.set(id, { controller, done });
      } else {
        const error = method === 'tools/call'
          ? { code: -32600, message: 'Request ID already in use' }
          : { code: -32601, message: 'Method not found' };
        send({ id, error });
      }
    }
  } finally {
    onClose();
    await Promise.allSettled([...requests.values()].map(({ done }) => done));
    process.stdout.off('error', onClose);
  }
}

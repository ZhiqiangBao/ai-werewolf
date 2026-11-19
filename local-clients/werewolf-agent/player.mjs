#!/usr/bin/env node
/**
 * 真人座位客户端。只使用该座位的凭证，不读取其他座位目录。
 *
 *   node player.mjs join "<真人座位链接>"
 *   node player.mjs wait --seat 3
 *   node player.mjs act --seat 3 --file seats/3/act.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const MAX_SEAT = 12;
const MAX_WAIT_MS = 60_000;
let commandSignal;

function commandLifetime(milliseconds) {
  const controller = new AbortController();
  const owner = process.ppid;
  const stop = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => [name, () => stop(name)]));
  for (const [name, handler] of handlers) process.once(name, handler);
  const onDisconnect = () => stop('owner-exited');
  process.once('disconnect', onDisconnect);
  const ownerTimer = setInterval(() => {
    if (owner <= 1) return;
    try { process.kill(owner, 0); }
    catch (error) { if (error?.code === 'ESRCH') stop('owner-exited'); }
  }, 250);
  const deadline = setTimeout(() => stop('timeout'), milliseconds);
  return {
    signal: controller.signal,
    close() {
      clearInterval(ownerTimer);
      clearTimeout(deadline);
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      process.removeListener('disconnect', onDisconnect);
      stop('closed');
    },
  };
}

function waitDuration(args) {
  if (args['max-wait-ms'] === undefined) return MAX_WAIT_MS;
  const value = Number(args['max-wait-ms']);
  if (typeof args['max-wait-ms'] !== 'string' || !Number.isInteger(value) || value < 100 || value > MAX_WAIT_MS) {
    die('--max-wait-ms 必须是 100 到 60000 的整数');
  }
  return value;
}

function die(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function seatNumber(value, flag = '--seat') {
  const seat = Number(value);
  if (!Number.isInteger(seat) || seat < 1 || seat > MAX_SEAT) die(`${flag} 必须是 1 到 ${MAX_SEAT} 的座位号`);
  return seat;
}

function seatDir(seat) {
  return join(root, 'seats', String(seat));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function loadConfig(seat) {
  const path = join(seatDir(seat), 'seat.json');
  if (!existsSync(path)) die(`座位 ${seat} 还没有链接。请先运行：node player.mjs join "<该座位的真人链接>"`);
  const cfg = readJson(path);
  if (!cfg.server || !cfg.roomId || !cfg.token || cfg.seat !== seat) die(`座位 ${seat} 的 seat.json 无效，请重新 join`);
  return cfg;
}

function loadState(seat) {
  const path = join(seatDir(seat), 'state.json');
  if (!existsSync(path)) return { seenSeq: 0, signature: '', roomId: '' };
  return readJson(path);
}

function saveState(seat, state) {
  writeJson(join(seatDir(seat), 'state.json'), state);
}

/** 从用户粘贴的真人座位链接取出服务器、房间号和凭证。 */
export function parseSeatLink(input) {
  let raw = String(input ?? '').trim();
  let previous;
  do {
    previous = raw;
    raw = raw.replace(/^[<「"'“]+/u, '').replace(/[>」"'”。．.，,；;]+$/u, '').trim();
  } while (raw !== previous);
  if (!raw) throw new Error('缺少真人座位链接');
  if (/[#/](?:host|watch)\//.test(raw)) throw new Error('这是房主或观战链接，不能用来入座。请改用 #/seat/房间号/座位凭证');
  let server = 'http://127.0.0.1:5173';
  let hash = raw;
  try {
    const url = new URL(raw);
    server = url.origin;
    hash = url.hash || raw;
  } catch {
    /* 允许只粘贴 #/seat/房间/凭证 */
  }
  const match = hash.match(/[#/]seat\/([^/?#\s]+)\/([^/?#\s]+)/) ?? raw.match(/(?:^|\/)seat\/([^/?#\s]+)\/([^/?#\s]+)/);
  if (!match) throw new Error('这不是真人座位链接。应类似 http://127.0.0.1:5173/#/seat/房间号/座位凭证');
  return { server, roomId: decodeURIComponent(match[1]), token: decodeURIComponent(match[2]) };
}

async function call(cfg, method, path, body, signal = commandSignal) {
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${cfg.server}/api/v1/rooms/${encodeURIComponent(cfg.roomId)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const failure = new Error(`连不上 ${cfg.server}：${error instanceof Error ? error.message : error}`);
    failure.code = 'NETWORK';
    throw failure;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(data.message || `请求失败（${response.status}）`);
    failure.code = data.code ?? 'HTTP';
    failure.status = response.status;
    throw failure;
  }
  if (cfg.seat > 0 && ((method === 'GET' && path === '/view') || (method === 'POST' && path === '/participate')) &&
      (data.room?.viewer !== 'seat' || data.room?.seat !== cfg.seat)) {
    throw new Error('座位凭证与本地席位不一致，请重新核对链接。');
  }
  return data;
}

function formatEvent(event) {
  const content = event.payload?.content;
  let text = event.text ?? '';
  if (typeof content === 'string' && content && text.endsWith(content)) {
    text = `${text.slice(0, text.length - content.length)}「${content}」`;
  }
  const when = event.day ? `第${event.day}${event.phase === 'night' ? '夜' : '天'}` : '开局';
  const scope = event.audience === 'public' ? '' : '【非公开事件】';
  return `[${when}] ${scope}${text}`;
}

function formatParam(param) {
  if (param.kind === 'seat') {
    const empty = param.nullable ? `，null 表示${param.nullLabel ?? '不选'}` : '';
    return `${param.name}=座位号，可选 ${param.options.join('、') || '无'}${empty}`;
  }
  if (param.kind === 'seats') return `${param.name}=座位号数组，${param.min} 到 ${param.max} 个`;
  if (param.kind === 'boolean') return `${param.name}=true 表示${param.trueLabel ?? '是'}，false 表示${param.falseLabel ?? '否'}`;
  if (param.kind === 'choice') return `${param.name}=${param.options.map((option) => `${option.value}（${option.label}）`).join('、')}`;
  if (param.kind === 'text') {
    const bounds = [param.minLength > 0 ? '不能为空' : '可为空'];
    if (param.maxLength) bounds.push(`最长 ${param.maxLength} 字`);
    return `${param.name}=文本，${bounds.join('，')}`;
  }
  return param.name;
}

function formatTool(tool) {
  const params = tool.params.length ? tool.params.map(formatParam).join('；') : '无参数，args 为 {}';
  return `- ${tool.name}（${tool.title}）：${params}\n  ${tool.description}`;
}

function projectionOf(view) {
  return view.projection ?? null;
}

export function resolveLocale(view) {
  const locale = view.projection?.locale ?? view.room?.locale ?? 'zh-CN';
  if (!['zh-CN', 'en', 'ja'].includes(locale)) throw new Error(`不支持的对局语言标识：${String(locale)}`);
  return locale;
}

export function renderWakeContext(view) {
  const locale = resolveLocale(view);
  return {
    'zh-CN': '对局语言：zh-CN。公开发言和狼人密谈使用中文；工具名、参数键、decisionId 和规则标识保持原样。',
    en: 'Game language: en. Use English for public speech and wolf chat; keep tool names, argument keys, decisionId and rule identifiers unchanged.',
    ja: 'ゲーム言語: ja。公開発言と人狼の会話は日本語で行い、ツール名、引数のキー、decisionId、ルール識別子は変更しないでください。',
  }[locale];
}

function signatureOf(view) {
  const room = view.room;
  const projection = projectionOf(view);
  const task = projection?.task;
  const interrupts = (projection?.interrupts ?? []).map((tool) => tool.name).join(',');
  return [
    resolveLocale(view),
    room.status,
    room.paused ? 'paused' : '',
    room.presetName,
    projection?.stage ?? '',
    projection?.result?.winner ?? '',
    projection?.me?.canStop ?? '',
    projection?.actionWindowId ?? '',
    task ? `${task.decisionId}:${task.submitted}:${task.deadline ?? ''}:${task.tools.map((tool) => tool.name).join(',')}` : '',
    interrupts,
    view.presentation?.actionAvailableAt ?? '',
  ].join('|');
}

function writeRules(seat, text) {
  writeFileSync(join(seatDir(seat), 'live-rules.md'), !text || text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function noteRoom(seat, roomId, presetName) {
  const path = join(seatDir(seat), 'notes.md');
  const marker = `新的一局：${presetName}，房间 ${roomId}`;
  if (!existsSync(path)) {
    writeFileSync(path, `# ${seat} 号笔记\n\n${marker}\n\n身份：\n阵营：\n当前判断：\n\n`, 'utf8');
    return;
  }
  const prev = readFileSync(path, 'utf8');
  if (!prev.includes(roomId)) {
    writeFileSync(path, `${prev.trimEnd()}\n\n---\n${marker}。上面的笔记属于以前的房间。\n\n身份：\n阵营：\n当前判断：\n\n`, 'utf8');
  }
}

function formatRoster(projection) {
  if (!projection?.seats?.length) return '';
  return projection.seats.map((seat) => {
    const tags = [];
    if (!seat.alive) tags.push('出局');
    if (seat.sheriff) tags.push('警长');
    if (seat.active) tags.push('正在行动');
    if (seat.revealedRoleName) tags.push(seat.revealedRoleName);
    return tags.length ? `${seat.seat}号（${tags.join('，')}）` : `${seat.seat}号`;
  }).join('、');
}

function formatKnowledge(me) {
  if (!me?.knownIdentities?.length) return '';
  return me.knownIdentities.map((item) => (
    item.kind === 'role'
      ? `${item.seat}号表现为${item.roleName}`
      : `${item.seat}号阵营表现为${item.alignment === 'wolf' ? '狼人' : '好人'}`
  )).join('；');
}

function finish(seat, code, lines, state, terminalMessage = '对局已结束。停止等待。') {
  lines.push('');
  if (code === 42) lines.push('这一步还没提交。从本次列出的工具里选一个提交，任务工具和随时可用工具不要同时交。提交成功后再把等待放回后台。');
  else if (code === 43) lines.push('这一步没有必须提交的任务。只有决定使用「随时可用」工具时才提交那一个；否则直接把等待放回后台。');
  else lines.push(terminalMessage);
  if (code !== 0) lines.push(`下一步：node player.mjs wait --seat ${seat}`);
  lines.push(`退出码：${code}`);
  const text = `${lines.join('\n')}\n`;
  writeFileSync(join(seatDir(seat), 'last.txt'), text, 'utf8');
  saveState(seat, state);
  return new Promise((resolve) => {
    process.stdout.write(text, () => {
      process.exitCode = code;
      resolve();
    });
  });
}

function participantName(input) {
  const name = input === undefined ? undefined : typeof input === 'string' ? input.trim() : '';
  if (name !== undefined && ([...name].length < 1 || [...name].length > 12)) die('昵称须为 1–12 个字符');
  return name;
}

async function checkInvite(link, expectedSeat, server, signal) {
  const parsed = parseSeatLink(link);
  if (server) parsed.server = String(server).replace(/\/$/, '');
  const probe = { ...parsed, seat: 0 };
  const view = await call(probe, 'GET', '/view', undefined, signal);
  if (view.room?.viewer !== 'seat' || !view.room.seat) die('这个凭证不是座位凭证');
  const seat = seatNumber(view.room.seat);
  if (expectedSeat !== undefined && seatNumber(expectedSeat) !== seat) {
    die(`这条链接是 ${seat} 号，不是 ${expectedSeat} 号。请重新核对席位链接。`);
  }
  return { cfg: { ...parsed, seat }, view };
}

async function participate(cfg, view, name, signal) {
  const requests = view.room.status === 'setup' ? [{}, { ...(name === undefined ? {} : { name }), ready: true }] : [{}];
  for (const body of requests) {
    try {
      await call(cfg, 'POST', '/participate', body, signal);
    } catch (error) {
      if (error.code !== 'ALREADY_STARTED') throw error;
    }
  }
  return call(cfg, 'GET', '/view', undefined, signal);
}

async function cmdJoin(args) {
  const name = participantName(args.name);
  const { cfg, view } = await checkInvite(args.link ?? args._[1], args.seat, args.server);
  const { seat, roomId } = cfg;
  mkdirSync(seatDir(seat), { recursive: true });
  const previous = existsSync(join(seatDir(seat), 'seat.json')) ? readJson(join(seatDir(seat), 'seat.json')) : null;
  writeJson(join(seatDir(seat), 'seat.json'), cfg);
  if (!previous || previous.roomId !== roomId) saveState(seat, { seenSeq: 0, signature: '', roomId });
  noteRoom(seat, roomId, view.room.presetName);
  const fresh = await participate(cfg, view, name);
  writeRules(seat, fresh.projection?.ruleCard ?? fresh.room.ruleCard ?? '');
  const me = fresh.projection?.me;
  console.log([
    renderWakeContext(fresh),
    `已入座：${seat} 号。房间 ${fresh.room.roomId}，状态 ${fresh.room.status}，版型 ${fresh.room.presetName}。`,
    '凭证只写在本座位的 seat.json，不要抄到笔记、发言或其他座位目录。',
    me ? (me.appendix || `你的身份是${me.roleName}，阵营是${me.factionName}。${me.alive ? '你仍在场。' : '你已出局。'}`) : '对局还没开始。已用座位昵称准备，等待房主开局。',
    me?.teammates?.length ? `狼队友座位：${me.teammates.join('、')}。` : '',
    (fresh.projection?.ruleCard ?? fresh.room.ruleCard) ? `服务端本局规则已写入 seats/${seat}/live-rules.md；身份说明由服务端提供，可用 status 查看。` : '服务端尚未提供本局规则卡，继续 wait 等待，不要使用旧局规则。',
    `笔记写在 seats/${seat}/notes.md。不要读取其他 seats 目录。`,
    `现在用后台方式运行：node player.mjs wait --seat ${seat}`,
  ].filter(Boolean).join('\n'));
}

function describeTask(projection, availableAt) {
  const lines = [];
  const task = projection?.task;
  if (availableAt && Date.now() < availableAt) lines.push(`行动尚未开放，约 ${Math.max(0, (availableAt - Date.now()) / 1000).toFixed(1)} 秒后才能提交。`);
  if (task) {
    const left = task.deadline ? Math.max(0, Math.ceil((task.deadline - Date.now()) / 1000)) : null;
    lines.push(`任务：${task.title}${task.submitted ? '（已提交）' : ''}${left !== null && !task.submitted ? `，剩余约 ${left} 秒` : ''}`);
    if (task.prompt) lines.push(task.prompt);
    if (!task.submitted) lines.push(task.tools.map(formatTool).join('\n'));
    else if (task.submittedText) lines.push(task.submittedText);
  }
  const interrupts = projection?.me?.alive ? projection.interrupts ?? [] : [];
  if (interrupts.length) {
    lines.push('随时可用：');
    lines.push(interrupts.map(formatTool).join('\n'));
  }
  return lines;
}

function transient(error) {
  return error?.code === 'NETWORK' || error?.status >= 500;
}

async function loadView(cfg, abort) {
  for (;;) {
    try {
      return await call(cfg, 'GET', '/view');
    } catch (error) {
      if (abort?.signal.aborted) die('等待被中断');
      if (!transient(error)) throw error;
      console.error(`暂时连不上服务器，3 秒后重试：${error.message}`);
      await sleep(3_000, abort?.signal).catch(() => die('等待被中断'));
    }
  }
}

async function cmdWait(args, lifetime) {
  const seat = seatNumber(args.seat);
  const cfg = loadConfig(seat);
  const state = loadState(seat);
  const abort = lifetime;
  let view;
  try { for (;;) {
    if (abort.signal.aborted) throw new Error('aborted');
    view = await loadView(cfg, abort);
    if (view.room.seat !== seat) die(`凭证对应的是 ${view.room.seat} 号，与 --seat ${seat} 不一致`);
    const projection = projectionOf(view);
    writeRules(seat, projection?.ruleCard ?? view.room.ruleCard ?? '');
    const change = diffView(cfg, state, view);
    const ended = view.room.status === 'ended' || projection?.status === 'ended';
    const seatComplete = projection?.me?.canStop === true && (!projection.task || projection.task.submitted) && !(projection.interrupts ?? []).length;
    if (!change.changed && !ended && !seatComplete) {
      try {
        await waitForNotice(cfg, (fresh) => diffView(cfg, state, fresh).changed, abort.signal);
      } catch (error) {
        if (abort.signal.aborted || error?.message === 'aborted') die('等待被中断');
        if (error?.status === 401 || error?.status === 403 || error?.status === 404) throw error;
        await sleep(3_000, abort.signal).catch(() => die('等待被中断'));
      }
      continue;
    }
    const { latest, seen, events, signature } = change;
    const lines = [renderWakeContext(view), `座位 ${seat} 号 · ${view.room.presetName} · ${projection?.stage ?? view.room.status}`];
    const roster = formatRoster(projection);
    if (roster) lines.push(`座位：${roster}`);
    const me = projection?.me;
    if (me) {
      lines.push(me.appendix || `身份：${me.roleName}。阵营：${me.factionName}。${me.alive ? '在场' : '已出局'}。`);
      if (me.teammates?.length) lines.push(`狼队友：${me.teammates.join('、')}。`);
      const knowledge = formatKnowledge(me);
      if (knowledge) lines.push(`已知：${knowledge}。`);
      if (seen === 0) lines.push(`完整规则：seats/${seat}/live-rules.md。笔记：seats/${seat}/notes.md。`);
    }
    if (!projection) lines.push('房主尚未开局。准备状态已在 join 时提交。开局后这次等待会退出并带来身份。');
    if (events.length) {
      lines.push('新消息：');
      lines.push(events.map(formatEvent).join('\n'));
    }
    if (view.room.paused) lines.push('对局已暂停，先不要提交。');
    lines.push(...describeTask(projection, view.presentation?.actionAvailableAt));
    if (projection?.result) lines.push(`结果：${projection.result.winnerName}。${projection.result.reason}`);
    const mustAct = !ended && !view.room.paused && !!projection?.task && !projection.task.submitted;
    return await finish(seat, ended || seatComplete ? 0 : mustAct ? 42 : 43, lines, { seenSeq: latest, signature, roomId: cfg.roomId },
      seatComplete && !ended ? '服务端确认本席没有后续任务。本席参与已结束，停止等待。' : undefined);
  } } catch (error) {
    if (!abort.signal.aborted || abort.signal.reason !== 'timeout') throw error;
    const lines = view ? statusLines(view, seat) : [];
    lines.push('本次等待达到时限，已关闭连接。需要继续参局时再运行 wait。');
    const mustAct = view && !view.room.paused && projectionOf(view)?.task && !projectionOf(view).task.submitted;
    return await finish(seat, mustAct ? 42 : 43, lines, state);
  }
}

export function diffView(cfg, state, view) {
  const projection = projectionOf(view);
  const latest = projection?.events?.at(-1)?.seq ?? 0;
  const seen = state.roomId === cfg.roomId && latest >= state.seenSeq ? state.seenSeq : 0;
  const events = (projection?.events ?? []).filter((event) => event.seq > seen);
  const signature = signatureOf(view);
  return {
    latest, seen, events, signature,
    changed: events.length > 0 || signature !== state.signature || state.roomId !== cfg.roomId,
  };
}

async function waitForNotice(cfg, hasChanged, parent, catchUp = false) {
  parent.throwIfAborted();
  const gate = new AbortController();
  const onParent = () => gate.abort();
  parent.addEventListener('abort', onParent, { once: true });
  const settle = (error) => {
    if (parent.aborted) throw new Error('aborted');
    if (gate.signal.aborted) return 'closed';
    throw error;
  };
  let pushed, polled;
  try {
    const check = async () => hasChanged(await call(cfg, 'GET', '/view', undefined, gate.signal));
    const pushedPromise = readUpdate(cfg, gate.signal, catchUp ? check : undefined).catch(settle);
    const polledPromise = (async () => {
      for (;;) {
        await sleep(8_000, gate.signal);
        if (await check()) return 'poll';
      }
    })().catch(settle);
    pushed = pushedPromise;
    polled = polledPromise;
    return await Promise.race([pushed, polled]);
  } finally {
    parent.removeEventListener('abort', onParent);
    gate.abort();
    await Promise.allSettled([pushed, polled]);
  }
}

async function readUpdate(cfg, signal, check) {
  const response = await fetch(`${cfg.server}/api/v1/rooms/${encodeURIComponent(cfg.roomId)}/stream`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${cfg.token}` },
    signal,
  });
  if (!response.ok || !response.body) {
    const failure = new Error(`推送失败（${response.status}）`);
    failure.status = response.status;
    throw failure;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    if (check && await check()) return 'catch-up';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return 'eof';
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (/^event:\s*update\b/m.test(block)) return 'push';
        split = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function cmdAct(args) {
  const seat = seatNumber(args.seat);
  const cfg = loadConfig(seat);
  let callBody;
  if (args.file) {
    const requested = String(args.file);
    const fromRoot = resolve(root, requested);
    const path = existsSync(fromRoot) ? fromRoot : resolve(requested);
    if (!existsSync(path)) die(`读不到行动文件：${requested}`);
    try {
      callBody = readJson(path);
    } catch {
      die(`行动文件必须是 JSON 对象：${requested}`);
    }
  } else {
    if (!args.tool) die('用 --tool 和 --args，或用 --file 指向 {"tool","args"}');
    try {
      callBody = { tool: String(args.tool), args: args.args ? JSON.parse(String(args.args)) : {} };
    } catch {
      die('--args 必须是 JSON 对象，例如 {"content":"我认为3号可疑。"}');
    }
  }
  if (!callBody || typeof callBody.tool !== 'string' || !callBody.args || typeof callBody.args !== 'object' || Array.isArray(callBody.args)) {
    die('行动须包含 tool 和 args 对象');
  }
  let view = await call(cfg, 'GET', '/view');
  const availableAt = view.presentation?.actionAvailableAt;
  if (availableAt && Date.now() < availableAt) {
    const waitMs = availableAt - Date.now();
    if (waitMs > 90_000) die(`还要约 ${Math.ceil(waitMs / 1000)} 秒才开放提交`);
    await sleep(waitMs, commandSignal);
  }
  view = await call(cfg, 'GET', '/view');
  resolveLocale(view);
  const projection = projectionOf(view);
  if (!projection) die('对局还没开始');
  if (view.room.paused) die('对局已暂停');
  const taskOpen = projection.task && !projection.task.submitted;
  const inTask = !!taskOpen && projection.task.tools.some((tool) => tool.name === callBody.tool);
  const inInterrupt = (projection.interrupts ?? []).some((tool) => tool.name === callBody.tool);
  const decisionId = inTask ? projection.task.decisionId : inInterrupt ? projection.actionWindowId : '';
  if (!decisionId) {
    if (projection.task?.submitted && projection.task.tools.some((tool) => tool.name === callBody.tool)) die('这个任务已经提交过了');
    die(`当前不能使用 ${callBody.tool}。先运行 wait --seat ${seat}，只使用它打印的工具。`);
  }
  try {
    const result = await call(cfg, 'POST', '/act', { decisionId, tool: callBody.tool, args: callBody.args });
    if (!result.ok) die(result.error?.message ?? '法官没有接受这次行动');
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  console.log(`法官已接受 ${callBody.tool}。接着用后台方式运行：node player.mjs wait --seat ${seat}`);
  const fresh = await call(cfg, 'GET', '/view');
  console.log(statusLines(fresh, seat).join('\n'));
}

function statusLines(view, seat) {
  const projection = projectionOf(view);
  const lines = [renderWakeContext(view), `座位 ${seat} 号 · ${view.room.presetName} · ${projection?.stage ?? view.room.status}${view.room.paused ? ' · 已暂停' : ''}`];
  const roster = formatRoster(projection);
  if (roster) lines.push(`座位：${roster}`);
  const me = projection?.me;
  if (me) lines.push(me.appendix || `身份：${me.roleName}。阵营：${me.factionName}。${me.alive ? '在场' : '已出局'}。`);
  if (!projection) lines.push('房主尚未开局。');
  lines.push(...describeTask(projection, view.presentation?.actionAvailableAt));
  if (projection?.result) lines.push(`结果：${projection.result.winnerName}。${projection.result.reason}`);
  lines.push('status 不消耗消息，也不代替 wait。');
  return lines;
}

async function cmdStatus(args) {
  const seat = seatNumber(args.seat);
  const view = await call(loadConfig(seat), 'GET', '/view');
  console.log(statusLines(view, seat).join('\n'));
}

async function cmdRules(args) {
  const seat = seatNumber(args.seat);
  const cfg = loadConfig(seat);
  const view = await call(cfg, 'GET', '/view');
  const text = projectionOf(view)?.ruleCard ?? view.room.ruleCard ?? '';
  writeRules(seat, text);
  if (!text) die('当前还没有规则卡');
  console.log(`${renderWakeContext(view)}\n${text}`);
}

async function cmdLog(args) {
  const seat = seatNumber(args.seat);
  const view = await call(loadConfig(seat), 'GET', '/view');
  const events = projectionOf(view)?.events ?? [];
  console.log([renderWakeContext(view), events.length ? events.map(formatEvent).join('\n') : '还没有你能看到的记录。'].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  let lifetime;
  try {
    if (command === 'mcp') {
      const { serveDesktopMcp } = await import('./desktop-mcp.mjs');
      await serveDesktopMcp({
        async joinSeat({ link, seat, name }, signal) {
          const nickname = participantName(name);
          const { cfg, view } = await checkInvite(link, seat, undefined, signal);
          if (view.room.roomId !== cfg.roomId) die('收到的房间与席位链接不符。');
          return { cfg, view: await participate(cfg, view, nickname, signal) };
        },
        getView: (cfg, signal) => call(cfg, 'GET', '/view', undefined, signal),
        waitForNotice: (cfg, hasChanged, signal) => waitForNotice(cfg, hasChanged, signal, true),
        postAction: (cfg, action, signal) => call(cfg, 'POST', '/act', action, signal),
      });
      return;
    }
    lifetime = commandLifetime(command === 'wait' ? waitDuration(args) : 120_000);
    commandSignal = lifetime.signal;
    if (command === 'join') await cmdJoin(args);
    else if (command === 'wait') await cmdWait(args, lifetime);
    else if (command === 'act') await cmdAct(args);
    else if (command === 'status') await cmdStatus(args);
    else if (command === 'rules') await cmdRules(args);
    else if (command === 'log') await cmdLog(args);
    else {
      console.log(`用法（在 ${root} 执行）
  node player.mjs mcp
  node player.mjs join "<真人座位链接>" [--name 昵称] [--seat <期望座位>]
  node player.mjs wait --seat <1-12> [--max-wait-ms <100-60000>]
  node player.mjs act --seat <1-12> --file seats/<号>/act.json
  node player.mjs act --seat <1-12> --tool <工具名> --args "<JSON>"
  node player.mjs status --seat <1-12>
  node player.mjs rules --seat <1-12>
  node player.mjs log --seat <1-12>`);
      process.exit(command ? 1 : 0);
    }
  } catch (error) {
    if (lifetime?.signal.aborted && lifetime.signal.reason !== 'timeout') {
      console.error(`所属进程已退出或命令被停止（${lifetime.signal.reason}）。本次命令结束，不要自动重新启动。`);
      process.exitCode = 44;
    } else {
      console.error(lifetime?.signal.reason === 'timeout' ? '本次命令达到时限，已关闭连接。先检查当前状态再决定是否重试。' : error instanceof Error ? error.message : String(error));
      process.exitCode = error?.exitCode ?? 1;
    }
  } finally {
    lifetime?.close();
    commandSignal = undefined;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();

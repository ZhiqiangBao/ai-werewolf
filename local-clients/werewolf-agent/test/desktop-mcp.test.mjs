import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

function gameFixture() {
  const scope = new Map([['synthetic-one', 1], ['synthetic-two', 2]]);
  const streams = new Map();
  const actions = [];
  const submitted = new Set();
  let status = 'setup';
  const windows = {
    1: { decisionId: 'speech-window', tool: { name: 'speak', params: [{ kind: 'text', name: 'content' }] } },
    2: { decisionId: 'vote-window', tool: { name: 'vote', params: [{ kind: 'seat', name: 'target', options: [1] }] } },
  };

  function view(seat) {
    const { decisionId, tool } = windows[seat];
    return {
      room: { roomId: 'fixture', viewer: 'seat', seat, status, locale: 'zh-CN', presetName: '测试版型', ruleCard: '本局规则' },
      projection: status === 'setup' ? null : {
        viewer: { kind: 'seat', seat }, status, locale: 'zh-CN', phase: 'day', stage: '讨论', day: 1,
        ruleCard: '本局规则',
        me: { alive: true, appendix: '仅本席身份 ' + seat },
        events: [{ seq: 1, audience: [seat], type: 'identity', text: '仅本席消息 ' + seat }],
        task: { decisionId, title: tool.name, prompt: '提交本席行动', submitted: submitted.has(seat), tools: [tool] },
        interrupts: [],
      },
    };
  }

  const server = createServer(async (req, res) => {
    const seat = scope.get(req.headers.authorization?.replace('Bearer ', ''));
    res.setHeader('Content-Type', 'application/json');
    if (!seat || !req.url.startsWith('/api/v1/rooms/fixture/')) {
      res.statusCode = 403;
      res.end('{"message":"无席位权限"}');
      return;
    }
    if (req.url.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      streams.set(seat, res);
      res.on('close', () => { if (streams.get(seat) === res) streams.delete(seat); });
      server.emit('seat-stream');
      return;
    }
    if (req.url.endsWith('/act')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const action = JSON.parse(raw);
      actions.push({ seat, ...action });
      submitted.add(seat);
      res.end('{"ok":true}');
      return;
    }
    res.end(JSON.stringify(view(seat)));
  });

  return {
    server, streams, actions,
    setStatus(next) {
      status = next;
      for (const response of streams.values()) response.write('event: update\ndata: {}\n\n');
    },
  };
}

function desktopClient(child) {
  let nextId = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method, params = {}) => {
    const id = ++nextId;
    const promise = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise.then((response) => {
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    });
  };
  return {
    request,
    async tool(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      return JSON.parse(result.content[0].text);
    },
  };
}

test('desktop MCP pushes each seat only its own updates and returns speech and actions to the game', { timeout: 10_000 }, async () => {
  const game = gameFixture();
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-desktop-mcp-'));
  let child;
  try {
    for (const name of ['player.mjs', 'desktop-mcp.mjs']) await copyFile(new URL('../' + name, import.meta.url), join(directory, name));
    game.server.listen(0, '127.0.0.1');
    await once(game.server, 'listening');
    child = spawn(process.execPath, [join(directory, 'player.mjs'), 'mcp'], { cwd: directory, windowsHide: true });
    const chat = desktopClient(child);
    const initialized = await chat.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop-fixture', version: '1' } });
    assert.equal(initialized.protocolVersion, '2025-06-18');
    const tools = await chat.request('tools/list');
    assert.deepEqual(tools.tools.map((entry) => entry.name), ['join_seat', 'wait_for_update', 'submit_action', 'leave_seat']);

    const baseLink = 'http://127.0.0.1:' + game.server.address().port + '/#/seat/fixture/';
    const [first, second] = await Promise.all([
      chat.tool('join_seat', { link: baseLink + 'synthetic-one', seat: 1 }),
      chat.tool('join_seat', { link: baseLink + 'synthetic-two', seat: 2 }),
    ]);
    assert.ok(first.connectionId, JSON.stringify(first));
    assert.ok(second.connectionId, JSON.stringify(second));
    assert.notEqual(first.connectionId, second.connectionId);
    assert.deepEqual([first.update.seat, second.update.seat], [1, 2]);
    assert.equal(first.update.ruleCard, '本局规则');
    assert.equal(JSON.stringify([first, second]).includes('synthetic-'), false);
    const guessed = await chat.tool('wait_for_update', { connectionId: '2', afterCursor: 1 });
    assert.equal(guessed.status, 'error');

    const receive = (seat, cursor) => chat.tool('wait_for_update', { connectionId: seat.connectionId, afterCursor: cursor });
    const pending = [receive(first, first.update.cursor), receive(second, second.update.cursor)];
    while (game.streams.size < 2) await once(game.server, 'seat-stream');
    game.setStatus('running');
    const [speech, vote] = await Promise.all(pending);
    assert.equal(speech.identity.appendix, '仅本席身份 1');
    assert.equal(vote.identity.appendix, '仅本席身份 2');
    assert.deepEqual(speech.events.map((event) => event.text), ['仅本席消息 1']);
    assert.deepEqual(vote.events.map((event) => event.text), ['仅本席消息 2']);
    assert.deepEqual(await receive(first, first.update.cursor), speech);

    const submit = (seat, decisionId, tool, args) => chat.tool('submit_action', { connectionId: seat.connectionId, decisionId, tool, args });
    const stale = await submit(first, vote.task.decisionId, 'speak', { content: '错误窗口' });
    assert.equal(stale.code, 'STALE_ACTION');
    assert.equal(game.actions.length, 0);
    const receipts = await Promise.all([
      submit(first, speech.task.decisionId, 'speak', { content: '一号公开发言' }),
      submit(second, vote.task.decisionId, 'vote', { target: 1 }),
    ]);
    assert.deepEqual(receipts.map((entry) => entry.status), ['accepted', 'accepted']);
    assert.deepEqual(game.actions.toSorted((a, b) => a.seat - b.seat), [
      { seat: 1, decisionId: 'speech-window', tool: 'speak', args: { content: '一号公开发言' } },
      { seat: 2, decisionId: 'vote-window', tool: 'vote', args: { target: 1 } },
    ]);

    game.setStatus('ended');
    const final = await Promise.all([receive(first, speech.cursor), receive(second, vote.cursor)]);
    assert.deepEqual(final.map((entry) => entry.status), ['ended', 'ended']);
    for (const seat of [first, second]) assert.equal((await chat.tool('leave_seat', { connectionId: seat.connectionId })).status, 'left');
    assert.deepEqual(await chat.request('ping'), {});
    assert.deepEqual((await readdir(directory)).sort(), ['desktop-mcp.mjs', 'player.mjs']);
  } finally {
    if (child && child.exitCode === null) {
      const closing = once(child, 'close', { signal: AbortSignal.timeout(2_000) });
      child.stdin.end();
      await closing.catch(() => child.kill());
    }
    game.server.closeAllConnections();
    await new Promise((resolve) => game.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

// This script acts only on the isolated review room created for this redesign.
const accessFile = new URL('../../data/ui-review-host/review-access.json', import.meta.url);
const access = JSON.parse(await readFile(accessFile, 'utf8'));
const origin = 'http://127.0.0.1:5175';
const base = origin + '/api/v1/rooms/' + access.roomId;
const tokens = new Map(access.tokens.seats.map((s) => [s.seat, s.token]));
async function request(path, token, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert(response.ok, JSON.stringify(data));
  return data;
}
const host = () => request('/view', access.tokens.host);
const view = (seat) => request('/view', tokens.get(seat));
async function assertViews() {
  const god = (await host()).projection;
  assert.equal(god.viewer.kind, 'god');
  assert.equal(god.god.roles.length, 12);
  for (const [seat, token] of tokens) {
    const data = await request('/view', token), p = data.projection;
    assert.equal(data.room.viewer, 'seat');
    assert.equal(p.viewer.seat, seat);
    assert.equal(p.me.seat, seat);
    assert.equal(p.god, undefined);
    assert(p.events.every((e) => e.audience === 'public' || e.audience.includes(seat)));
    assert((p.thoughts ?? []).every((t) => t.seat === seat));
    assert(p.seats.every((s) => s.revealedRole === undefined));
    if (p.me.role !== 'seer' && p.me.faction !== 'wolf') assert.deepEqual(p.me.knownIdentities, []);
    for (const known of p.me.knownIdentities ?? []) {
      assert.equal(known.kind, 'alignment');
      assert.equal(known.role, undefined);
      assert.equal(known.roleName, undefined);
    }
  }
  const watch = (await request('/view', access.tokens.spectator)).projection;
  assert.equal(watch.me, undefined);
  assert.equal(watch.god, undefined);
  assert(watch.events.every((e) => e.audience === 'public'));
  return god;
}
function argsFor(tool, preferredTarget) {
  return Object.fromEntries(tool.params.map((p) => {
    if (p.kind === 'text') return [p.name, '这是界面与视角测试。本轮先听取其他玩家的发言，再作判断。'];
    if (p.kind === 'boolean') return [p.name, false];
    if (p.kind === 'choice') return [p.name, p.options[0].value];
    if (p.kind === 'seats') return [p.name, p.options.slice(0, p.min)];
    return [p.name, p.options.includes(preferredTarget) ? preferredTarget : p.nullable ? null : p.options[0]];
  }));
}
async function submit(seat, tool, args) {
  const p = (await view(seat)).projection;
  const result = await request('/act', tokens.get(seat), 'POST', { decisionId: p.task.decisionId, tool: tool.name, args });
  assert.equal(result.ok, true, JSON.stringify(result));
}

let god = await assertViews();
const guard = god.god.roles.find((s) => s.role === 'guard').seat;
let actions = 0;
while (god.phase === 'night' && actions < 60) {
  const actors = god.god.pending.actors.filter((a) => !a.submitted);
  assert(actors.length > 0);
  for (const actor of actors) {
    const p = (await view(actor.seat)).projection;
    const tool = p.task.tools.find((t) => /skip|empty_kill|no_kill|no_action|hold|decline_explode/.test(t.name)) ?? p.task.tools.find((t) => t.name !== 'wolf_explode');
    assert(tool);
    await submit(actor.seat, tool, argsFor(tool, tool.name === 'seer_inspect' ? guard : undefined));
    actions++;
  }
  god = (await host()).projection;
}
assert.equal(god.phase, 'day');
const candidates = [1, 3, 4];
if (god.god.pending?.actors.some((a) => a.tools.includes('sheriff_signup'))) {
  for (const actor of god.god.pending.actors.filter((a) => !a.submitted)) {
    const p = (await view(actor.seat)).projection;
    const run = candidates.includes(actor.seat);
    const tool = p.task.tools.find((t) => t.name === (!run && p.task.tools.some((t) => t.name === 'sheriff_stay_off') ? 'sheriff_stay_off' : 'sheriff_signup'));
    await submit(actor.seat, tool, tool.params.some((p) => p.name === 'run') ? { run } : {});
  }
}
god = await assertViews();
const seer = god.god.roles.find((s) => s.role === 'seer').seat;
const wolf = god.god.roles.find((s) => s.role === 'werewolf').seat;
const villager = god.god.roles.find((s) => s.role === 'villager').seat;
const seerView = (await view(seer)).projection;
assert(seerView.me.knownIdentities.some((k) => k.seat === guard && k.alignment === 'good'));
const links = {
  host: origin + '/#/host/' + access.roomId + '/' + access.tokens.host,
  seer: origin + '/#/seat/' + access.roomId + '/' + tokens.get(seer),
  wolf: origin + '/#/seat/' + access.roomId + '/' + tokens.get(wolf),
  villager: origin + '/#/seat/' + access.roomId + '/' + tokens.get(villager),
  watch: origin + '/#/watch/' + access.roomId + '/' + access.tokens.spectator,
};
await writeFile(new URL('../../data/ui-review-host/review-links.json', import.meta.url), JSON.stringify(links, null, 2));
console.log(JSON.stringify({ verifiedViews: 14, nightActions: actions, phase: god.phase, stage: god.stage, links }, null, 2));

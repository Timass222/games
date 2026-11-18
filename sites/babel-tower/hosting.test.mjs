import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from './dist/server/index.js';

const origin = 'https://game.example';
const owner = { 'oai-authenticated-user-id': 'site-owner', 'oai-authenticated-user-email': 'host@example.org' };

function testingRoom() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./drizzle/0000_game_room.sql', import.meta.url), 'utf8'));
  const binding = {
    withSession() { return this; },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bind = (...params) => ({
        async first() { return statement.get(...params) ?? null; },
        async run() { return { meta: statement.run(...params) }; },
      });
      return { bind, ...bind() };
    },
  };
  async function request(path, { method = 'GET', body, token, identity = {} } = {}) {
    const headers = new Headers(identity);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return worker.fetch(new Request(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {
      DB: binding, GAME_HOST_EMAIL: 'host@example.org',
    });
  }
  return { request, close: () => sqlite.close() };
}

test('public lobby, role isolation, shared phase and conflicting deals', async t => {
  const { request, close } = testingRoom();
  t.after(close);
  const open = await request('/');
  assert.match(await open.text(), /data-hosted-site/);
  assert.equal((await request('/hero.webp')).headers.get('Content-Type'), 'image/webp');
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/demo')).status, 403);
  assert.equal((await request('/api/host', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/host', { method: 'POST', identity: { ...owner, 'sec-fetch-site': 'cross-site' } })).status, 403);
  const host = await (await request('/api/host', { method: 'POST', identity: owner })).json();
  assert.equal(host.state.format, '4x3');
  assert.equal((await request('/api/state', { token: host.token })).status, 401);
  const getCodes = async () => (await (await request('/api/demo', { token: host.token, identity: owner })).json()).codes;
  const codes = await getCodes();
  assert.equal(new Set(codes.map(c => c.code)).size, 8);
  assert.equal((await request('/api/join', { method: 'POST', body: { code: '000000000000000000' } })).status, 401);
  const join = async (teamId, role, all = codes) => {
    const code = all.find(entry => entry.teamId === teamId && entry.role === role).code;
    const response = await request('/api/join', { method: 'POST', body: { code } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const old = await join('B', 'leader');
  const reset = await request('/api/reset', { method: 'POST', token: host.token, identity: owner, body: { format: '4x2', expectedPhase: 'vote', expectedRevision: 0 } });
  assert.equal(reset.status, 200);
  const restarted = await reset.json();
  assert.equal(restarted.format, '4x2');
  assert.equal((await request('/api/state', { token: old.token })).status, 401);
  const newCodes = await getCodes();
  assert.equal(newCodes.some(c => codes.some(oldCode => oldCode.code === c.code)), false);
  const [b, j, m] = await Promise.all(['B', 'J', 'M'].map(team => join(team, 'leader', newCodes)));
  const act = (player, body, identity) => request('/api/action', { method: 'POST', token: player.token, body, identity });
  const votes = await Promise.all([b, j, m].map(player => act(player, { type: 'vote', siteId: 'square', expectedPhase: 'vote', expectedCycle: 0 })));
  for (const vote of votes) assert.equal(vote.status, 200);
  const before = await (await request('/api/state', { token: host.token, identity: owner })).json();
  assert.equal(before.votesCast, 3);
  const advance = { type: 'advance', expectedRevision: before.revision, expectedPhase: 'vote', expectedCycle: 0 };
  const raced = await Promise.all([act(host, advance, owner), act(host, advance, owner)]);
  assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
  const [bEnv, jEnv, mEnv] = await Promise.all(['B', 'J', 'M'].map(team => join(team, 'envoy', newCodes)));
  assert.equal(bEnv.state.cycle, 1);
  assert.equal(bEnv.state.phase, 'negotiation');
  assert.equal(bEnv.state.resourcesByTeam, undefined);
  assert.ok(bEnv.state.projects.some(project => project.id === 'S1'));
  assert.ok(!bEnv.state.projects.some(project => project.id === 'M1' || project.id === 'O1'));
  assert.equal((await request('/api/demo', { token: jEnv.token })).status, 403);
  const give = [1, 0, 0];
  const take = [0, 0, 3];
  for (const envoy of [jEnv, mEnv]) assert.equal((await act(envoy, { type: 'offer', to: 'B', give, take })).status, 200);
  const incoming = await (await request('/api/state', { token: bEnv.token })).json();
  assert.equal(incoming.deals.length, 2);
  const acceptances = await Promise.all(incoming.deals.map(deal => act(bEnv, { type: 'accept', dealId: deal.id })));
  assert.deepEqual(acceptances.map(response => response.status).sort(), [200, 400]);
  const waiting = await (await request('/api/state', { token: host.token, identity: owner })).json();
  assert.equal(waiting.resourcesByTeam.B[2], 1);
  assert.equal(waiting.deals.filter(deal => deal.status === 'accepted').length, 1);
  const other = await (await request('/api/state', { token: jEnv.token })).json();
  assert.equal(other.deals.length, 1);
  const planning = await act(host, { type: 'advance', expectedRevision: waiting.revision }, owner);
  assert.equal(planning.status, 200);
  assert.equal((await planning.json()).phase, 'planning');
  assert.equal((await act(jEnv, { type: 'offer', to: 'B', give, take, expectedCycle: 1, expectedPhase: 'negotiation' })).status, 409);
});

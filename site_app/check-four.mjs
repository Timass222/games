import assert from 'node:assert/strict';
import { createGame, GameError, playAction, viewGame } from './game.mjs';

const host = { role: 'host' };
const leader = teamId => ({ role: 'leader', teamId });
const envoy = teamId => ({ role: 'envoy', teamId });
const act = (game, actor, type, payload = {}) => playAction(game, actor, { type, ...payload });
const advance = game => act(game, host, 'advance');
const project = (game, id, actor = host) => viewGame(game, actor).projects.find(card => card.id === id);
const fund = (game, team, projectId) => act(game, leader(team), 'fund', { projectId });

function contribute(game, projectId, contributions) {
  for (const [team, ...amount] of contributions) {
    game = act(game, leader(team), 'pledge', { projectId, amount });
  }
  return game;
}

function agree(game, from, to, give, take, abstainProject) {
  const payload = { to, give, take };
  if (abstainProject) payload.abstainProject = abstainProject;
  game = act(game, envoy(from), 'offer', payload);
  return act(game, envoy(to), 'accept', { dealId: game.deals.at(-1).id });
}

function openUrgent(format, site = 'square') {
  let game = createGame('baseline', format);
  const opening = viewGame(game, host);
  assert.equal(opening.format, format);
  assert.equal(opening.votesRequired, 3);
  assert.deepEqual(opening.teams.map(team => team.id).sort(), ['B', 'J', 'M', 'O']);
  assert.deepEqual(game.score, { B: 0, J: 0, M: 0 });

  game = act(game, leader('B'), 'vote', { siteId: 'square' });
  game = act(game, leader('J'), 'vote', { siteId: 'square' });
  if (site === 'compromise') {
    game = advance(game);
    assert.equal(game.voteRound, 2);
    assert.equal(game.cycle, 0);
    assert.equal(viewGame(game, host).votesCast, 0);
    game = act(game, leader('M'), 'vote', { siteId: 'quarter' });
    game = act(game, leader('O'), 'vote', { siteId: 'quarter' });
  } else {
    game = act(game, leader('M'), 'vote', { siteId: 'square' });
  }
  game = advance(game);
  assert.equal(game.siteId, site);
  assert.equal(game.cycle, 1);
  assert.equal(game.phase, 'negotiation');

  game = advance(game);
  game = contribute(game, 'T1', [['B', 1, 1, 2], ['J', 1, 1, 3]]);
  game = fund(game, 'B', 'S1');
  game = fund(game, 'M', 'M1');
  game = fund(game, 'O', 'O1');

  game = advance(advance(game));
  game = contribute(game, 'T1', [['B', 1, 1, 4], ['J', 1, 1, 1]]);
  game = contribute(game, 'D1', [['J', 0, 0, 1], ['O', 1, 1, 2]]);
  game = fund(game, 'J', 'G03');
  game = fund(game, 'M', 'M1');

  game = advance(game);
  assert.equal(game.cycle, 3);
  assert.equal(game.completed.T1, 2);
  assert.equal(viewGame(game, leader('J')).teams.find(team => team.id === 'J').representation, true);
  assert.equal(game.resources.J[2], 3);
  assert.equal(game.resources.B[2], 5);
  assert.equal(game.resources.M[2], 3);
  assert.equal(project(game, 'T1X')?.available ?? false, site === 'compromise');
  assert.deepEqual(project(game, 'T2').cost, [2, 2, 6]);
  return game;
}

function finishSquare(format, supplier) {
  let game = openUrgent(format);
  assert.equal(project(game, 'G05', leader('B')).visibility, 'public');
  assert.equal(project(game, 'G05', leader('B')).available, false);
  const noDeal = advance(game);
  assert.throws(() => fund(noDeal, 'M', 'G05'), /Не хватает ресурсов/);
  assert.throws(() => fund(noDeal, 'B', 'G05'), /Заказ оформляют торговцы/);
  assert.throws(() => contribute(noDeal, 'G05', [['M', 1, 0, 1]]), GameError);

  const beforeSupply = game.resources[supplier][2];
  const compensation = supplier === 'B' ? [1, 0, 0] : [0, 1, 0];
  const alternative = supplier === 'B' ? 'G07' : 'G06';
  assert.doesNotThrow(() => fund(noDeal, supplier, alternative));
  game = agree(game, 'M', supplier, compensation, [0, 0, 2]);
  game = advance(game);
  assert.equal(game.resources[supplier][2], beforeSupply - 2);
  assert.throws(() => fund(game, supplier, alternative), /Не хватает ресурсов/);
  game = fund(game, 'M', 'G05');
  game = fund(game, supplier === 'B' ? 'J' : 'B', 'G03');
  game = fund(game, 'B', 'S2');
  game = fund(game, 'O', 'O2');
  game = fund(game, 'O', 'G02');

  game = advance(game);
  assert.equal(game.cycle, 4);
  assert.equal(game.completed.G05, 3);
  assert.equal(viewGame(game, envoy('B')).dictionary.length, 3);
  assert.deepEqual(project(game, 'G08').cost, [1, 1, 3]);
  assert.deepEqual(project(game, 'T2').cost, [2, 2, 6]);
  game = advance(game);
  game = fund(game, 'J', 'G08');
  game = fund(game, 'O', 'G08');
  game = contribute(game, 'T2', [['B', 1, 2, 4], ['M', 1, 0, 2]]);
  game = fund(game, 'O', 'G02');

  game = advance(game);
  assert.equal(game.cycle, 5);
  const workBeforeCompensation = game.resources.J[2];
  game = agree(game, 'J', 'B', [0, 0, 1], [0, 0, 0], 'G10');
  const abstentionId = game.deals.at(-1).id;
  assert.equal(viewGame(game, envoy('J')).resources[2], workBeforeCompensation - 1);
  assert.equal(viewGame(game, envoy('M')).deals.some(deal => deal.id === abstentionId), false);
  game = agree(game, 'M', 'B', [1, 0, 1], [0, 1, 0]);
  game = advance(game);
  assert.equal(game.resources.B[2], 6);
  assert.equal(game.resources.J[2], workBeforeCompensation - 1);
  assert.throws(() => fund(game, 'B', 'G10'), /согласились не вкладываться/);
  assert.throws(() => contribute(game, 'G10', [['B', 0, 0, 1]]), /согласились не вкладываться/);
  assert.doesNotThrow(() => contribute(game, 'G10', [['M', 0, 0, 1]]));
  game = fund(game, 'B', 'T2');
  game = contribute(game, 'G11', [['J', 1, 2, 2], ['O', 0, 0, 2]]);
  game = contribute(game, 'D3', [['M', 1, 0, 1], ['O', 1, 1, 2]]);

  game = advance(game);
  assert.equal(game.cycle, 6);
  assert.equal(game.deals.find(deal => deal.id === abstentionId).status, 'fulfilled');
  assert.equal(game.resources.M[2], 2);
  game = advance(game);
  assert.doesNotThrow(() => contribute(game, 'G10', [['B', 0, 0, 1]]));
  game = fund(game, 'J', 'G12');
  game = fund(game, 'B', 'G13');
  game = fund(game, 'M', 'M3');
  game = advance(game);

  assert.equal(game.phase, 'finished');
  assert.equal(game.cycle, 6);
  assert.equal(game.completed.T2, 5);
  assert.equal(game.completed.G10, undefined);
  assert.deepEqual(game.score, { B: 7, J: 3, M: 5 });
  assert.deepEqual(Object.keys(game.marks).sort(), ['J', 'M']);
  assert.ok(Object.values(game.resources).every(resources => resources[2] === 0));
  return game;
}

function finishCompromise() {
  let game = openUrgent('4x3', 'compromise');
  game = advance(game);
  game = contribute(game, 'T1X', [['B', 0, 1, 2], ['J', 1, 1, 2], ['M', 0, 0, 1]]);
  game = advance(game);
  assert.equal(project(game, 'G05').reason, 'Срок истёк');
  assert.equal(project(game, 'G03').reason, 'Срок истёк');
  assert.deepEqual(project(game, 'G08').cost, [2, 1, 3]);
  assert.deepEqual(project(game, 'T2').cost, [2, 3, 6]);
  game = advance(game);
  game = contribute(game, 'T2', [['B', 1, 2, 4], ['M', 1, 1, 2]]);
  assert.deepEqual(project(game, 'T2').cost, [2, 2, 6]);

  const beforeFlood = { ...game.score };
  game = advance(game);
  assert.equal(project(game, 'G08').reason, 'Срок истёк');
  assert.equal(game.score.J, beforeFlood.J - 2);
  assert.equal(game.score.M, beforeFlood.M - 1);
  assert.equal(game.score.B, beforeFlood.B);
  assert.deepEqual(project(game, 'T2').cost, [2, 2, 7]);
  game = advance(game);
  assert.equal(project(game, 'O3', leader('B')), undefined);
  game = fund(game, 'O', 'O3');
  game = advance(game);
  assert.deepEqual(project(game, 'T2').cost, [2, 2, 7]);
  assert.deepEqual(game.score, { B: beforeFlood.B, J: beforeFlood.J - 2, M: beforeFlood.M - 1 });
  game = advance(game);
  game = contribute(game, 'T2', [['B', 1, 1, 4], ['M', 1, 1, 3]]);
  game = advance(game);
  assert.equal(game.completed.T2, 6);
  assert.equal(game.phase, 'finished');
}

function jointResources(format, id, cycle, cost, resource) {
  let game = openUrgent(format);
  while (game.cycle < cycle) game = advance(advance(game));
  game = advance(game);
  for (const team of ['B', 'J', 'M']) game.resources[team] = [10, 10, 10];
  const card = project(game, id);
  assert.deepEqual(card.cost, cost);
  assert.equal(card.fundable, false);
  assert.equal(card.shareable, true);
  assert.throws(() => fund(game, 'B', id), GameError);
  assert.throws(() => contribute(game, id, [['B', ...cost]]), GameError);
  assert.throws(() => contribute(game, id, [['B', cost[0] + 1, cost[1], cost[2]]]), GameError);
  const first = [0, 0, 1];
  const second = [cost[0], cost[1], cost[2] - 1];
  let partial = contribute(game, id, [['B', ...first]]);
  const refunded = advance(partial);
  assert.deepEqual(refunded.resources.B, advance(game).resources.B);
  partial = contribute(partial, id, [['J', 0, 0, 1]]);
  assert.throws(() => contribute(partial, id, [['M', 0, 0, 1]]), GameError);
  game = contribute(game, id, [['B', ...first], ['J', ...second]]);
  assert.equal(project(game, id).progress, 1);
  assert.deepEqual(game.funded[id], [['B', 'J']]);
  assert.equal(game.completed[id], cycle);
  const control = structuredClone(game);
  delete control.completed[id];
  delete control.funded[id];
  let withIncome = game;
  let withoutIncome = control;
  for (let i = 0; i < 2; i++) {
    withIncome = advance(withIncome);
    withoutIncome = advance(withoutIncome);
    for (const team of ['B', 'J']) assert.equal(withIncome.resources[team][resource], withoutIncome.resources[team][resource] + (resource === 2 ? 1 : i + 1));
    assert.equal(withIncome.resources.M[resource], withoutIncome.resources.M[resource]);
    if (i === 0) { withIncome = advance(withIncome); withoutIncome = advance(withoutIncome); }
  }
}

for (const format of ['4x2', '4x3']) {
  jointResources(format, 'G15', 3, [0, 2, 3], 0);
  jointResources(format, 'G09', 4, [1, 1, 3], 2);
}

function separateUnits() {
  let game = openUrgent('4x3');
  game = advance(advance(advance(game)));
  for (const team of ['J', 'M']) game.resources[team] = [10, 10, 10];
  const pledge = (state, team, unit, amount) => act(state, leader(team), 'pledge', { projectId: 'G08', unit, amount });
  const before = structuredClone(game);
  game = pledge(game, 'J', 1, [1, 1, 1]);
  game = pledge(game, 'J', 2, [1, 1, 2]);
  assert.deepEqual(project(game, 'G08', leader('J')).unitStates.map(u => u.pooledByTeam), [[1, 1, 1], [1, 1, 2]]);
  const refunded = advance(game);
  const control = advance(before);
  for (const team of ['J', 'M']) assert.deepEqual(refunded.resources[team], control.resources[team]);
  assert.throws(() => pledge(game, 'M', 0, [0, 0, 1]), GameError);
  assert.throws(() => pledge(game, 'M', 3, [0, 0, 1]), GameError);
  assert.throws(() => pledge(game, 'M', 1, [2, 0, 2]), GameError);
  game = pledge(game, 'M', 2, [1, 0, 1]);
  assert.deepEqual(project(game, 'G08').unitStates.map(u => u.done), [false, true]);
  assert.throws(() => pledge(game, 'M', 2, [0, 0, 1]), GameError);
  game = pledge(game, 'M', 1, [1, 0, 2]);
  assert.equal(game.completed.G08, 4);
  const score = { ...game.score };
  game = advance(game);
  assert.equal(game.score.J, score.J);
  assert.equal(game.score.M, score.M);

  let tower = advance(advance(advance(openUrgent('4x3'))));
  tower.resources.B = [20, 20, 20];
  assert.deepEqual(project(tower, 'T2').unitStates.map(u => u.cost), [[2, 3, 6], [2, 2, 6]]);
  tower = act(tower, leader('B'), 'fund', { projectId: 'T2', unit: 2 });
  assert.deepEqual(project(tower, 'T2').cost, [2, 3, 6]);
  assert.deepEqual(project(tower, 'T2').unitStates.map(u => u.done), [false, true]);

  let legacy = advance(advance(advance(openUrgent('4x3'))));
  legacy.resources.J = [10, 10, 10];
  legacy.pools.G08 = { J: [1, 1, 1] };
  assert.deepEqual(project(legacy, 'G08').pooled, [1, 1, 1]);
  legacy.resources.M = [10, 10, 10];
  legacy = act(legacy, leader('M'), 'pledge', { projectId: 'G08', amount: [1, 0, 2] });
  assert.equal(project(legacy, 'G08').progress, 1);
  assert.deepEqual(project(legacy, 'G08').unitStates.map(u => u.done), [true, false]);
  delete legacy.unitDone.G08;
  assert.deepEqual(project(legacy, 'G08').unitStates.map(u => u.done), [true, false]);
}
separateUnits();

const doubleSeats = finishSquare('4x2', 'B');
const tripleSeats = finishSquare('4x3', 'B');
for (const field of ['resources', 'score', 'completed', 'marks']) {
  assert.deepEqual(doubleSeats[field], tripleSeats[field], field);
}
finishSquare('4x3', 'J');
finishCompromise();
console.log('Four-team formats: votes, both urgent suppliers, compensation, deadline costs and tower recovery passed.');

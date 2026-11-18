import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cards, teams, welfare } from './game-data.mjs';
import { createGame, playAction, viewGame } from './game.mjs';

const host = { role: 'host' };
const leader = teamId => ({ role: 'leader', teamId });
const envoy = teamId => ({ role: 'envoy', teamId });
const numbers = compact => [...compact].map(Number);

const source = readFileSync(new URL('../swarm_work/c2_balance/trace.py', import.meta.url), 'utf8');
const trace = name => {
  const block = source.match(new RegExp(`^${name} = \\{([\\s\\S]*?)^\\}`, 'm'))?.[1];
  assert.ok(block, name);
  return [...block.matchAll(/^\s*(\d+): \('([^']*)', '([^']*)'\),/gm)]
    .map(([, cycle, deals, investments]) => ({ cycle: Number(cycle), deals, investments }));
};

function replay(name, expectedScore, experiment = 'baseline', stopAt = 7) {
  let game = createGame(experiment);
  const act = (actor, type, extra = {}) => { game = playAction(game, actor, { type, ...extra }); };
  if (name === 'SUCCESS') {
    for (const id of welfare.slice(0, 4)) act(leader(id), 'vote', { siteId: 'square' });
  }
  act(host, 'advance');
  if (name !== 'SUCCESS') {
    assert.equal(game.voteRound, 2);
    act(host, 'advance');
    assert.equal(game.siteId, 'compromise');
  } else {
    assert.equal(game.siteId, 'square');
  }
  const rounds = trace(name);
  assert.equal(rounds.length, 6);
  for (const { cycle, deals, investments } of rounds) {
    assert.equal(game.cycle, cycle);
    if (cycle === stopAt) return game;
    for (const transfer of deals.split(' ').filter(Boolean)) {
      const [from, to, ...amount] = transfer;
      act(envoy(from), 'offer', { to, give: numbers(amount.join('')), take: [0, 0, 0] });
      const dealId = game.deals.at(-1).id;
      act(envoy(to), 'accept', { dealId });
      assert.throws(() => playAction(game, envoy(to), { type: 'accept', dealId }));
    }
    act(host, 'advance');
    const spending = experiment === 'dry-yard'
      ? investments.replace('C1:A101,B013 C1:J013,M101', 'C1:A101,B012 C1:J012,M101')
      : experiment === 'stone-repair'
        ? investments.replace('R1:A012,M101', 'R1:A012,M011')
        : investments;
    for (const payment of spending.split(' ').filter(Boolean)) {
      const [projectId, contributions] = payment.split(':');
      const contributors = contributions.split(',');
      if (contributors.length === 1) act(leader(contributors[0][0]), 'fund', { projectId });
      else for (const [id, ...amount] of contributors) {
        act(leader(id), 'pledge', { projectId, amount: numbers(amount.join('')) });
      }
    }
    act(host, 'advance');
  }
  assert.deepEqual(welfare.map(id => game.score[id]), expectedScore);
  assert.equal(game.phase, 'finished');
  assert.equal(game.funded.T2.length, name === 'SUCCESS' ? 2 : 1);
  assert.equal(Object.keys(game.marks).length, 2);
  assert.equal(game.completed.P9, 6);
  assert.equal(viewGame(game, leader('A')).projects.some(project => project.id === 'O3'), false);
  assert.equal(viewGame(game, leader('J')).projects.some(project => project.id === 'O2'), true);
  assert.equal(viewGame(game, leader('M')).projects.some(project => project.id === 'O2'), false);
  assert.equal(viewGame(game, leader('M')).resourcesByTeam, undefined);
  assert.equal(viewGame(game, envoy('B')).dictionary.length, 3);
  assert.ok(Object.values(game.resources).every(resources => resources[2] === 0));
  console.log(`${name}/${experiment}: cycles 0–6, tower, welfare and representation match the reference trace.`);
  return game;
}

const square = replay('SUCCESS', [5, 10, 4, 2, 8]);
const compromise = replay('COMPROMISE', [3, 5, 4, 7, 8]);
const protectedYard = replay('SUCCESS', [5, 10, 4, 2, 8], 'dry-yard');
const stoneRepair = replay('COMPROMISE', [3, 5, 4, 7, 8], 'stone-repair');
const lessStone = replay('SUCCESS', [5, 10, 4, 2, 8], 'less-stone');
assert.equal(protectedYard.completed.C1, 4);
assert.equal(stoneRepair.resources.M[0], compromise.resources.M[0] + 1);
assert.equal(lessStone.resources.B[1], square.resources.B[1] - 6);

let game = createGame();
for (const id of welfare.slice(0, 4)) game = playAction(game, leader(id), { type: 'vote', siteId: 'square' });
game = playAction(game, host, { type: 'advance' });
for (const to of ['K', 'B']) {
  game = playAction(game, envoy('A'), { type: 'offer', to, give: [4, 0, 0], take: [0, 0, 0] });
}
game = playAction(game, envoy('K'), { type: 'accept', dealId: game.deals[0].id });
assert.throws(() => playAction(game, envoy('B'), { type: 'accept', dealId: game.deals[1].id }));
game = playAction(game, host, { type: 'advance' });
game = playAction(game, leader('B'), { type: 'pledge', projectId: 'T1', amount: [1, 0, 1] });
assert.throws(() => playAction(game, leader('K'), { type: 'pledge', projectId: 'T1', amount: [2, 2, 3] }));
const afterPledge = game.resources.B[0];
game = playAction(game, host, { type: 'advance' });
assert.equal(game.resources.B[0], afterPledge + 1 + teams.B.income[0]);
assert.equal(game.funded.T1, undefined);
assert.equal(Object.keys(cards).length, 25);
console.log('Conflicting reservations fail. Excess and unfinished unit funding do not consume materials.');

const after = (state, actor, type, fields = {}) => playAction(state, actor, { type, ...fields });
const latestDeal = state => state.deals.at(-1).id;
const abstention = { to: 'B', give: [1, 0, 0], take: [0, 0, 0], abstainProject: 'P7' };
let negotiation = replay('COMPROMISE', null, 'negotiation', 5);
assert.throws(() => after(negotiation, envoy('J'), 'offer', { ...abstention, abstainProject: 'P9' }));
assert.throws(() => after(negotiation, envoy('J'), 'offer', { ...abstention, take: [1, 0, 0] }));
negotiation = after(negotiation, envoy('J'), 'offer', abstention);
const contractId = latestDeal(negotiation);
assert.equal(viewGame(negotiation, leader('B')).projects.find(p => p.id === 'P7').available, true);
negotiation = after(negotiation, envoy('A'), 'offer', abstention);
const duplicate = latestDeal(negotiation);
const beforeCompensation = [...negotiation.resources.J];
negotiation = after(negotiation, envoy('B'), 'accept', { dealId: contractId });
assert.equal(viewGame(negotiation, envoy('J')).resources[0], beforeCompensation[0] - 1);
assert.equal(viewGame(negotiation, envoy('B')).deals.find(deal => deal.id === contractId).abstainTitle, cards.P7.name);
assert.equal(viewGame(negotiation, envoy('M')).deals.some(deal => deal.id === contractId), false);
assert.throws(() => after(negotiation, envoy('B'), 'accept', { dealId: duplicate }), /уже согласились/);
const builderStock = negotiation.resources.B[0];
negotiation = after(negotiation, host, 'advance');
assert.equal(negotiation.resources.B[0], builderStock + 1);
assert.equal(negotiation.resources.J[0], beforeCompensation[0] - 1);
for (const [type, fields] of [['fund', {}], ['pledge', { amount: [1, 0, 1] }]]) {
  assert.throws(() => after(negotiation, leader('B'), type, { projectId: 'P7', ...fields }), /согласились не вкладываться/);
}
const pledge = (state, team, projectId, amount) => after(state, leader(team), 'pledge', { projectId, amount });
for (const [team, id, amount] of [
  ['A', 'R1', [0, 1, 2]], ['M', 'R1', [1, 0, 1]],
  ['M', 'O4', [0, 0, 1]], ['O', 'O4', [1, 2, 2]],
  ['M', 'P7', [1, 0, 1]], ['O', 'P7', [1, 1, 1]], ['A', 'P7', [0, 0, 1]], ['K', 'P7', [0, 0, 1]],
]) negotiation = pledge(negotiation, team, id, amount);
assert.equal(negotiation.funded.P7.length, 1);
negotiation = after(negotiation, host, 'advance');
assert.equal(negotiation.deals.find(deal => deal.id === contractId).status, 'fulfilled');
assert.equal(negotiation.deals.find(deal => deal.id === duplicate).status, 'expired');
assert.equal(viewGame(negotiation, leader('B')).projects.find(p => p.id === 'P7').available, true);
assert.equal(negotiation.resources.M[2], 2);

const payOrder = (state, team) => after(state, leader(team), 'fund', { projectId: 'P9' });
const noDeal = after(negotiation, host, 'advance');
assert.throws(() => payOrder(noDeal, 'M'), /Не хватает ресурсов/);
assert.throws(() => payOrder(noDeal, 'B'), /Заказ оформляют торговцы/);
assert.throws(() => pledge(noDeal, 'M', 'P9', [1, 0, 1]), /целой единицей/);
const missed = after(noDeal, host, 'advance');
assert.equal(viewGame(missed, leader('M')).projects.find(p => p.id === 'P9').reason, 'Срок истёк');
assert.equal(missed.score.M, negotiation.score.M);

for (const supplier of ['B', 'J']) {
  let settled = after(negotiation, envoy('M'), 'offer', { to: supplier, give: [0, 1, 0], take: [0, 0, 3] });
  settled = after(settled, envoy(supplier), 'accept', { dealId: latestDeal(settled) });
  settled = after(settled, host, 'advance');
  assert.equal(settled.resources[supplier][2], negotiation.resources[supplier][2] - 3);
  settled = payOrder(settled, 'M');
  assert.equal(settled.completed.P9, 6);
  assert.equal(settled.score.M, negotiation.score.M + 3);
  assert.equal(settled.score.B, negotiation.score.B + 1);
}
console.log('Negotiation: compensation reserves resources and blocks only the signer this cycle. Two suppliers can close the urgent order; missing the deadline expires it.');

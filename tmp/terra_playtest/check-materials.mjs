import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, GameError, playAction } from '../../site_app/game.mjs';

const folder = process.argv[2];
const rows = readFileSync(join(folder, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const host = { role: 'host' };
const cycles = new Map();
let state = createGame('baseline', '4x2');
for (const row of rows) {
  if (row.kind === 'snapshot' && row.phase === 'negotiation' && row.cycle <= 5) {
    assert.deepEqual(state, row.state);
    cycles.set(row.cycle, { start: state, funding: [] });
  }
  if (row.kind !== 'action' || !row.ok) continue;
  const before = state;
  state = playAction(state, row.actor, row.action);
  if (state.cycle > before.cycle) {
    state.resources.B[1] -= 1;
    state.resources.M[0] -= 1;
  }
  const data = cycles.get(before.cycle);
  if (!data) continue;
  if (before.phase === 'negotiation' && state.phase === 'planning') {
    data.signed = before;
    data.planning = state;
  }
  if (before.phase === 'planning' && ['fund', 'pledge'].includes(row.action.type)) {
    data.funding.push({ actor: row.actor, action: row.action, why: row.why });
  }
}
assert.deepEqual(state, result.game);
assert.equal(result.distinctSessions, 8);

const isMaterial = v => (v[0] || v[1]) && !v[2];
const isLabor = v => v[2] && !v[0] && !v[1];

function playFunding(signed, funding) {
  let state = playAction(signed, host, { type: 'advance' });
  const failed = [];
  for (const step of funding) {
    try { state = playAction(state, step.actor, step.action); }
    catch (error) {
      if (!(error instanceof GameError)) throw error;
      failed.push({ ...step, error: error.message });
    }
  }
  return { state, failed };
}

function withoutDeal(signed, id) {
  const before = structuredClone(signed);
  before.deals.find(deal => deal.id === id).status = 'declined';
  return before;
}

const summary = [];
const relevant = [];
for (const [cycle, data] of cycles) {
  const offers = result.game.deals.filter(deal => deal.cycle === cycle);
  const executed = offers.filter(deal => ['accepted', 'fulfilled'].includes(deal.status));
  const fund = playFunding(data.signed, data.funding);
  assert.equal(fund.failed.length, 0);
  const projects = Object.keys(fund.state.completed).filter(id => fund.state.completed[id] === cycle);
  const agreements = rows.find(row => row.kind === 'jointAgreements' && row.cycle === cycle).agreements;
  summary.push({ cycle, offers: offers.length, executed: executed.length, abstentions: executed.filter(d => d.abstainProject).length,
    jointAgreed: agreements.length, projects, offersDetails: offers, agreements });
  for (const deal of executed) {
    if (deal.abstainProject) continue;
    const seller = isMaterial(deal.give) && isLabor(deal.take) ? deal.from : isLabor(deal.give) && isMaterial(deal.take) ? deal.to : null;
    if (!seller) continue;
    const buyer = seller === deal.from ? deal.to : deal.from;
    const before = withoutDeal(data.signed, deal.id);
    const effect = playFunding(before, data.funding).failed.map(step => {
      const id = step.action.projectId;
      const unit = step.action.unit;
      const actuallyFunded = unit == null
        ? (fund.state.funded[id]?.length ?? 0) > (data.planning.funded[id]?.length ?? 0)
        : (fund.state.unitDone[id] ?? []).includes(unit) && !(data.planning.unitDone?.[id] ?? []).includes(unit);
      return { ...step, actuallyFunded };
    });
    const alternatives = [];
    for (const candidate of Object.keys(before.resources).filter(id => id !== buyer && id !== seller)) {
      try {
        let branch = playAction(before, { role: 'envoy', teamId: buyer }, { type: 'offer', to: candidate,
          give: seller === deal.from ? deal.take : deal.give, take: seller === deal.from ? deal.give : deal.take });
        branch = playAction(branch, { role: 'envoy', teamId: candidate }, { type: 'accept', dealId: branch.deals.at(-1).id });
        const reallocation = playFunding(branch, data.funding);
        alternatives.push({ team: candidate, compatible: !reallocation.failed.some(f => [candidate, buyer].includes(f.actor.teamId)) });
      } catch (error) {
        if (!(error instanceof GameError)) throw error;
      }
    }
    relevant.push({ cycle, deal, materialsSeller: seller, materialsBuyer: buyer, start: data.start.resources,
      effect, alternatives, completedInCycle: projects });
  }
}
const passed = relevant.some(row => row.effect.some(step => step.actuallyFunded && /не хватает/i.test(step.error)
  && [row.materialsBuyer, row.materialsSeller].includes(step.actor.teamId))
  && row.alternatives.some(option => option.compatible));
const check = { verdict: passed ? 'PASS' : 'NOT PASS', summary, relevant, score: state.score, marks: state.marks,
  progress: { T1: state.funded.T1?.length ?? 0, T1X: state.funded.T1X?.length ?? 0, T2: state.funded.T2?.length ?? 0 },
  replayed: rows.filter(row => row.kind === 'action' && row.ok).length };
writeFileSync(join(folder, 'checks.json'), JSON.stringify(check, null, 2));
console.log(JSON.stringify({ ...check, summary: summary.map(({ offersDetails, agreements, ...other }) => other) }, null, 2));

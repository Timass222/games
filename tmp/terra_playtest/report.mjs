import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, playAction } from '../../site_app/game.mjs';
import { fourCards, fourSites, fourTeams } from '../../site_app/four-team-data.mjs';

const folder = process.argv[2];
const result = JSON.parse(readFileSync(join(folder,'result.json'),'utf8'));
const entries = readFileSync(join(folder,'actions.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const actions = entries.filter(e=>e.kind==='action');
const decisions = entries.filter(e=>e.kind==='decision');
const teams = Object.keys(fourTeams);
const game = actions.filter(e=>e.ok).reduce((state,e)=>playAction(state,e.actor,e.action),createGame('baseline',result.format));
assert.deepEqual(game,result.game);
assert.equal(game.phase,'finished');
assert.equal(game.cycle,6);
assert.equal(result.distinctSessions,8);
assert.deepEqual([...new Set(decisions.map(d=>d.player))].sort(),result.players.slice().sort());

const teamName = id => fourTeams[id]?.name ?? id;
const cardName = id => fourCards[id]?.name ?? id;
const siteName = id => fourSites.find(s=>s.id===id)?.name ?? id;
const clean = v => String(v??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').trim();
const status = {accepted:'исполнена', fulfilled:'исполнена', declined:'отклонена', expired:'осталась без принятия'};
const vector = v => Array.isArray(v)?v.join('/'):'';
const describe = d => `${teamName(d.from)} → ${teamName(d.to)}: ${vector(d.give)}${d.abstainProject ? ` за отказ от вклада в «${cardName(d.abstainProject)}»` : ` в обмен на ${vector(d.take)}`}`;
const signed = game.deals.filter(d=>d.status==='accepted'||d.status==='fulfilled');
const ordinary = signed.filter(d=>!d.abstainProject);
const refused = signed.filter(d=>d.abstainProject);
const plansBefore = decisions.filter(d=>d.stage==='план до переговоров');
const validPriorities = decision => Array.isArray(decision?.priorities) ? decision.priorities.filter(p=>p && typeof p.projectId==='string') : [];
const refusedPlanned = refused.filter(deal=>validPriorities(plansBefore.find(d=>d.cycle===deal.cycle&&d.team===deal.to)?.decision).some(p=>p.projectId===deal.abstainProject));
const jointAgreements = entries.filter(e=>e.kind==='jointAgreements').flatMap(e=>e.agreements);
const leaderId = (team,cycle) => team+(cycle<=3?'1':'2');
const envoyId = (team,cycle) => team+(cycle<=3?'2':'1');
const markdown = [
  '# Вавилонская башня. Лог партии восьми агентов Terra',
  '',
  'Формат 4×2, восемь независимых сессий GPT‑6.1 Terra. У каждого игрока была информация его роли, фракции и видимого игрового поля. После третьего цикла в каждой команде игроки поменялись ролями. Движок запущен отдельно от действующих партий на сайте.',
  '',
  'Циклы идут без игрового таймера. Ведущий переключает фазы. Лидеры записывают приоритеты до переговоров, послы видят план своей команды. На переговорах послы предлагают обмены и совместные вклады, отвечают, затем могут сделать встречное предложение. Передачи и обязательства об отказе проверяет движок. Лидеры вносят доли в конкретные единицы проектов. При отклонении можно один раз скорректировать выбор. Порядок применения действий при одновременных ответах — Строители, Жители, Торговцы, Орден. Устное смешение языков в этом формате не проверяется.',
  '',
  'Все векторы показывают древесину / камень / рабочие действия. Короткие мотивы в логе написали агенты. Агентам прямо назвали 7 благополучия ориентиром на шесть циклов и отдельно поставили задачу продвинуться до готового каркаса. Партия идёт до среза демо. Итоги полной игры здесь не присуждаются.',
  '',
  '## Итог демо',
  '',
  `- Площадка — ${siteName(game.siteId)}.`,
  `- Башня: фундамент ${game.funded.T1?.length??0}/2, каркас ${game.funded.T2?.length??0}/2${game.siteId==='compromise'?`, усиление фундамента ${game.funded.T1X?.length??0}/1`:''}.`,
  `- Благополучие: ${Object.entries(game.score).map(([t,s])=>`${teamName(t)} ${s}`).join(', ')}.`,
  `- Представительства Ордена: ${Object.keys(game.marks).map(teamName).join(', ')||'ни одного'}.`,
  `- Ресурсные предложения или предложения компенсации: ${game.deals.length}. Приняты и исполнены: ${signed.length}. Из них с отказом от вклада: ${signed.filter(d=>d.abstainProject).length}.`,
  `- Обменов без запрета на вклад: ${ordinary.length}. Из ${refused.length} выкупов ${refusedPlanned.length} затронули проект, который лидер адресата указал в приоритетах до переговоров.`,
  `- Зарегистрированные планы совместного вклада: ${entries.filter(e=>e.kind==='jointProposal').length}. Подтверждены всеми указанными участниками: ${jointAgreements.length}.`,
  `- Лесной причал ${game.completed.G15?`готов в цикле ${game.completed.G15}`:'не завершён'}. Совместный резерв бригад ${game.completed.G09?`готов в цикле ${game.completed.G09}`:'не завершён'}.`,
  `- Срочный заказ: ${game.completed.G05?'закрыт в цикле '+game.completed.G05:'окно упущено'}. Грузовой двор: ${game.completed.G10?'готов в цикле '+game.completed.G10:'не завершён'}.`,
  '',
  '## Цикл 0. Выбор площадки',
  '',
];
for(const d of decisions.filter(e=>e.cycle===0).sort((a,b)=>a.stage.localeCompare(b.stage)||teams.indexOf(a.team)-teams.indexOf(b.team))) {
  markdown.push(`- ${clean(d.stage)}, ${teamName(d.team)} (${d.player}) — ${siteName(d.decision.siteId)}. ${clean(d.decision.why)}`);
}

for(let cycle=1;cycle<=6;cycle++) {
  const start=entries.find(e=>e.cycle===cycle&&e.kind==='snapshot'&&e.phase==='negotiation');
  const end=entries.find(e=>e.cycle===cycle&&e.kind==='cycleEnd');
  assert.ok(start&&end);
  const deals=game.deals.filter(d=>d.cycle===cycle);
  const agree=entries.find(e=>e.cycle===cycle&&e.kind==='jointAgreements').agreements;
  const projects=Object.entries(game.completed).filter(([,c])=>c===cycle).map(([id])=>cardName(id));
  markdown.push('',`## Цикл ${cycle}`,'',clean(start.state.notice),'','### Приоритеты до переговоров','');
  for (const plan of plansBefore.filter(p=>p.cycle===cycle)) {
    const priorities=validPriorities(plan.decision).map(p=>`${cardName(p.projectId)} (${clean(p.intent)})`);
    markdown.push(`- ${teamName(plan.team)} — ${priorities.join(', ')||'без указанного проекта'}. ${clean(plan.decision.why)}`);
  }
  markdown.push('','### Сделки','');
  if(!deals.length) markdown.push('Послы не отправили ни одного действительного предложения о передаче ресурсов.','');
  for(const d of deals) {
    const initiation=actions.find(a=>a.dealId===d.id);
    const response=actions.find(a=>a.ok&&a.action.dealId===d.id);
    markdown.push(`- №${d.id}. ${describe(d)} — **${status[d.status]??d.status}**.${clean(initiation?.why)?` ${clean(initiation.why)}`:''}${clean(response?.why)?` Ответ: ${clean(response.why)}`:''}`);
  }
  if(agree.length) {
    markdown.push('','Согласованные планы совместного вклада.','');
    for(const p of agree) markdown.push(`- ${cardName(p.projectId)}${p.unit?` · единица ${p.unit}`:''} — ${Object.entries(p.shares).map(([t,amount])=>`${teamName(t)} ${vector(amount)}`).join(', ')}. ${clean(p.why)}`);
  }
  const unsigned=entries.filter(e=>e.cycle===cycle&&e.kind==='jointProposal'&&!agree.some(p=>p.id===e.proposal.id));
  if(unsigned.length) markdown.push('',`Ещё ${unsigned.length} предложений по общим вкладам не собрали согласие всех участников.`);
  markdown.push('','### Решения лидеров','', '| Фракция | Игроки | Действия | Мотив лидера |','| --- | --- | --- | --- |');
  for(const team of teams) {
    const moves=actions.filter(e=>e.cycle===cycle&&e.actor.teamId===team&&['fund','pledge'].includes(e.action.type));
    const plan=decisions.find(e=>e.cycle===cycle&&e.team===team&&e.stage==='финальные вклады');
    const parts=moves.map(a=>`${a.action.type==='fund'?'Целая единица':'Доля '+vector(a.action.amount)}: ${cardName(a.action.projectId)}${a.action.unit?` №${a.action.unit}`:''}${a.ok?(a.projectCompleted?' ✓':''):` (не принято: ${a.error})`}`);
    markdown.push(`| ${teamName(team)} | Лидер ${leaderId(team,cycle)}, посол ${envoyId(team,cycle)} | ${clean(parts.join(' · ')||'Без вклада')} | ${clean(plan?.decision.why)} |`);
  }
  markdown.push('',`**Завершено:** ${projects.join(', ')||'ни одного проекта'}.`,`**Благополучие на выходе:** ${Object.entries(end.state.score).map(([t,s])=>`${teamName(t)} ${s}`).join(', ')}.`);
  const rejected=actions.filter(e=>e.cycle===cycle&&!e.ok&&!['fund','pledge'].includes(e.action.type));
  if(rejected.length) markdown.push('',`Движок отклонил ещё ${rejected.length} ${rejected.length===1?'заявку':'заявок'} в переговорах. Причины и параметры каждого вызова записаны в JSONL.`);
}

markdown.push('','## Проверка лога','',`Все ${actions.filter(e=>e.ok).length} принятые команды воспроизведены через движок. Повтор дал то же финальное состояние. В [журнале действий](actions.jsonl) есть исходные решения агентов, результаты валидации и состояния по циклам. [Финальное состояние](result.json).`,'');
writeFileSync(join(folder,'log.md'),markdown.join('\n'),'utf8');
console.log(JSON.stringify({ positiveActions:actions.filter(a=>a.ok).length, rejectedActions:actions.filter(a=>!a.ok).length, turns:decisions.length,
  cliRetries:entries.filter(e=>e.kind==='retry').length, placed:game.siteId, completed:game.completed, score:game.score,
  marks:game.marks,deals:game.deals.length,signed:signed.length,ordinary:ordinary.length,abstentions:refused.length,
  abstentionsOnRecordedPlan:refusedPlanned.map(d=>d.id),jointAgreements:jointAgreements.length,
  towerFunded:Object.fromEntries(['T1','T1X','T2'].map(id=>[id,game.funded[id]?.length??0])) }));

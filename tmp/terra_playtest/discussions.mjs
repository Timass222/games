import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fourCards, fourSites, fourTeams } from '../../site_app/four-team-data.mjs';
import { createGame, playAction } from '../../site_app/game.mjs';

const dir=process.argv[2];
const data=readFileSync(join(dir,'actions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8'));
const actions=data.filter(row=>row.kind==='action');
const decisions=data.filter(row=>row.kind==='decision');
const name=id=>fourTeams[id]?.name??id;
const card=id=>fourCards[id]?.name??id;
const site=id=>fourSites.find(option=>option.id===id)?.name??id;
const quote=str=>String(str??'').replace(/[\r\n]+/g,' ').replace(/\|/g,'\\|').trim();
const env=(id,cycle)=>id+(cycle<=3?'2':'1');
const speaker=(id,cycle)=>`${name(id)} (${env(id,cycle)})`;
const amount=v=>v.join('/');
const status={accepted:'Исполнена',fulfilled:'Исполнена',declined:'Отклонена',expired:'Истекла без принятия'};
const jointUnits=[];
let state=createGame('baseline','4x2');
for(const row of actions.filter(row=>row.ok)) {
  const { action,actor }=row;
  const before=state;
  state=playAction(state,actor,action);
  if(action.type!=='pledge') continue;
  const id=action.projectId;
  if((state.funded[id]?.length??0)===(before.funded[id]?.length??0)) continue;
  const shares=structuredClone(before.pools[id]??{});
  shares[actor.teamId]=(shares[actor.teamId]??[0,0,0]).map((v,i)=>v+action.amount[i]);
  jointUnits.push({cycle:before.cycle,id,shares});
}
assert.deepEqual(state,result.game);
const offerRows=actions.filter(row=>row.ok&&row.action.type==='offer');
assert.equal(offerRows.length,result.game.deals.length);
const roundTopics={1:'Ранний обмен и переправа',2:'Выкуп отказа от ночных рейсов',3:'Срочный крепёж и сделка с Орденом',4:'Паводок и представительство у Строителей',5:'Грузовой двор и набережная',6:'Последние городские проекты и представительства'};

const md=[
  '# Переговоры восьми агентов Terra', '',
  'Журнал предложений и ответов из одной партии 4×2. Это реконструкция структурированных переговоров по записанным действиям. Цитаты — краткие объяснения, которые агенты сами дали на игровом ходу. Когда посол ответил сразу на несколько заявок, его комментарий относится к пакету решений. Отсутствие подтверждения помечено отдельно от явного отказа.', '',
  'Цена записана как древесина / камень / рабочие действия. Обозначения B, J, M, O — Строители, Жители, Торговцы и Орден. Цифра после буквы обозначает игрока. В циклах 1–3 послы имеют номер 2, в циклах 4–6 номер 1.', '',
  '## Цикл 0. Выбор площадки', '',
  '| Голосование | Игрок | Голос | Его объяснение |', '| --- | --- | --- | --- |',
];
for (const d of decisions.filter(r=>r.cycle===0).sort((x,y)=>x.stage.localeCompare(y.stage)||x.player.localeCompare(y.player))) {
  md.push(`| ${d.stage.at(-1)} | ${name(d.team)} (${d.player}) | ${site(d.decision.siteId)} | ${quote(d.decision.why)} |`);
}
md.push('',`Итог — ${site(result.game.siteId)}. Обмен предложениями о площадке в этой фазе проходил через два голосования.`);

const stableShares=shares=>JSON.stringify(Object.entries(shares).sort(([a],[b])=>a.localeCompare(b)));
let proposalCount=0;
let jointMatches=0;
for(let cycle=1;cycle<=6;cycle++) {
  const offers=offerRows.filter(a=>a.cycle===cycle);
  const placed=data.filter(row=>row.kind==='jointProposal'&&row.cycle===cycle);
  const replies=data.filter(row=>row.kind==='jointReply'&&row.cycle===cycle);
  const agreements=data.find(e=>e.kind==='jointAgreements'&&e.cycle===cycle)?.agreements??[];
  const firstResponse=data.findIndex(e=>e.cycle===cycle&&e.kind==='decision'&&e.stage==='ответы на предложения');
  md.push('',`## Цикл ${cycle}. ${roundTopics[cycle]}`,'',
    '### Ресурсные сделки и компенсации','',
    '| № | Кто предложил → кому | Условия | Мотив предложения | Ответ и итог |', '| --- | --- | --- | --- | --- |');
  for(const a of offers) {
    const d=result.game.deals.find(d=>d.id===a.dealId);
    const reply=actions.find(r=>r.ok&&r.action.dealId===d.id);
    const term=d.abstainProject
      ? `${amount(d.give)} за отказ адресата от вклада в «${card(d.abstainProject)}» до конца цикла`
      : `${amount(d.give)} в обмен на ${amount(d.take)}`;
    const counter=firstResponse>=0&&data.indexOf(a)>firstResponse;
    md.push(`| ${d.id}${counter?' · встречное':''} | ${speaker(d.from,cycle)} → ${speaker(d.to,cycle)} | ${term} | ${quote(a.why)||'—'} | **${status[d.status]??d.status}.** ${quote(reply?.why)} |`);
  }
  if(!offers.length) md.push('| — | — | — | — | Предложений не зарегистрировано |');
  md.push('','### Совместные вклады','');
  if (!placed.length) md.push('Предложений с точными долями не зарегистрировано.');
  else md.push('| № | Автор и проект | Предложенные доли | Кто подтвердил | Результат | Мотив автора |','| --- | --- | --- | --- | --- | --- |');
  for(const {proposal:p} of placed) {
    proposalCount++;
    const accepted=[p.by,...replies.filter(r=>r.id===p.id).map(r=>r.team)];
    const agreed=agreements.some(a=>a.id===p.id);
    const payments=jointUnits.filter(u=>u.cycle===cycle&&u.id===p.projectId);
    const matched=payments.some(u=>stableShares(u.shares)===stableShares(p.shares));
    if(matched) jointMatches++;
    const outcome=[agreed?'Согласовано':'Нет полного согласия',matched?'оплачена единица с такими долями':payments.length?`эти доли не собраны. По другим долям оплачено ${payments.length} ед. за цикл`:'единица по этому плану не оплачена'].join(', ');
    md.push(`| ${p.id} | ${speaker(p.by,cycle)}, «${card(p.projectId)}» | ${Object.entries(p.shares).map(([t,v])=>`${name(t)} ${amount(v)}`).join(', ')} | ${accepted.map(name).join(', ')} | ${outcome} | ${quote(p.why)||'—'} |`);
  }
  const failures=actions.filter(a=>a.cycle===cycle&&!a.ok&&['offer','accept','decline'].includes(a.action.type));
  if(failures.length) {
    md.push('','Заявки, которые отклонил движок.','');
    for(const a of failures) md.push(`- ${speaker(a.actor.teamId,cycle)} — ${a.action.dealId?`сделка ${a.action.dealId}`:a.action.to?`предложение фракции «${name(a.action.to)}»`:'заявка'}. ${quote(a.error)}`);
  }
  const completion=Object.entries(result.game.completed).filter(([,n])=>n===cycle).map(([id])=>card(id));
  const after=data.find(e=>e.cycle===cycle&&e.kind==='cycleEnd');
  if (cycle===4) md.push('', 'По защите дворов подтвердили два набора долей, J4-4 и J4-5. Лидер Жителей отправил обе свои доли подряд. Вторая пришла, пока первая единица ещё не была закрыта, и не поместилась в её остаток цены. Торговцы закрыли первую единицу, а их оставшийся вклад в конце цикла вернулся. Защита осталась на 1 из 2.');
  md.push('',`Завершённые проекты: ${completion.join(', ')||'ни одного'}. Благополучие на выходе: ${Object.entries(after.state.score).map(([team,score])=>`${name(team)} ${score}`).join(', ')}.`);
}

md.push('','## Источники внутри прогона','',
  `Разобраны все предложения о передаче ресурсов (${offerRows.length}) и о совместных вкладах с точными долями (${proposalCount}). Сделки и вклады сверены повторным исполнением журнала. Мотивы и неподтверждённые заявки хранятся в [JSONL](actions.jsonl). Для решений лидеров см. [полный лог игры](log.md).`,'');
writeFileSync(join(dir,'negotiations.md'),md.join('\n'),'utf8');
console.log(JSON.stringify({cycles:6,offers:offerRows.length,jointProposals:proposalCount,exactJointPayments:jointMatches}));

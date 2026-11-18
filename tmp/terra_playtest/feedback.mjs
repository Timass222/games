import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fourTeams, fourCards } from '../../site_app/four-team-data.mjs';

const cwd = fileURLToPath(new URL('./', import.meta.url));
const folder = fileURLToPath(new URL('../../output/terra-playtest/2026-11-17T19-55-07/',import.meta.url));
const result = JSON.parse(readFileSync(join(folder,'result.json'),'utf8'));
const source = readFileSync(join(folder,'actions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const timeFolder = join(process.env.USERPROFILE,'.codex','sessions','2026','11','17');
const cli = join(process.env.APPDATA,'npm','node_modules','@openai','codex','bin','codex.js');
const sessions = {};
for (const name of readdirSync(timeFolder).filter(name=>name.startsWith('rollout-2026-11-17T22-55-'))) {
  const session = name.match(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/)?.[0];
  const text = readFileSync(join(timeFolder,name),'utf8');
  const player = text.match(/Ты игрок ([BJMO][12]), фракция/)?.[1];
  if (session && player) sessions[player] = session;
}
assert.deepEqual(Object.keys(sessions).sort(),result.players.slice().sort());

const questions = `Партия закончилась. Ты отвечаешь как тот же участник, от себя, по собственной игре и обеим ролям. Прочитай итог и вспомни свою сессию. Ответь по-русски, кратко и конкретно, с реальными примерами и номером цикла.
1. Что тебе понравилось? Назови 1–2 решения или ситуации, в которых было интересно выбирать, договариваться или распределять ресурсы.
2. Чего не хватило или что мешало? Назови 1–2 момента. Если проблема относится к текстовому формату этой сессии, скажи об этом отдельно.
3. Что первым изменить в игре? Дай одно конкретное изменение и признак, по которому мы на следующей игре увидим, помогло ли оно. Закрепи предложение за конкретным правилом, карточкой или этапом и учитывай нагрузку игрока, совмещающего роли лидера и ресурсного менеджера.
4. Что ты сам сделал бы иначе как посол или лидер? Одна личная точка роста с примером из игры.
Если в сессии ты не наблюдал эффект, обозначь это как предположение. При наличии уверенного воспоминания используй его; ничего не додумывай про чужие скрытые запасы или разговоры. Не вызывай инструменты. Верни ровно один JSON без Markdown: {"liked":["…"],"missing":["…"],"change":"…","success_signal":"…","own_growth":"…","format_limit":"…"}.`;

function context(player) {
  const team = player[0];
  const accepted = new Set(['accepted','fulfilled']);
  return {
    player, team:fourTeams[team].name, firstRole:player[1]==='1'?'лидер':'посол', secondRole:player[1]==='1'?'посол':'лидер',
    finalPublic:{site:result.game.siteId, score:result.game.score, foundation:result.game.funded.T1?.length??0,
      frame:result.game.funded.T2?.length??0, representation:Object.keys(result.game.marks),
      completed:Object.entries(result.game.completed).filter(([id])=>!fourCards[id].owner).map(([id,cycle])=>[id,fourCards[id].name,cycle])},
    teamDeals:result.game.deals.filter(d=>d.from===team||d.to===team).filter(d=>accepted.has(d.status)||d.status==='declined')
      .map(({id,cycle,from,to,give,take,abstainProject,status})=>({id,cycle,from,to,give,take,abstainProject,status})),
    teamProjectActions:source.filter(row=>row.kind==='action'&&row.actor.teamId===team&&['fund','pledge'].includes(row.action.type))
      .map(row=>({cycle:row.cycle,...row.action,ok:row.ok,error:row.error})),
  };
}

function interview(player, id) {
  return new Promise((resolve,reject)=>{
    const args = ['exec','resume','--ignore-user-config','--skip-git-repo-check','--disable','shell_tool','--disable','shell_snapshot',
      '-c','model_reasoning_effort="low"','-m','gpt-6.1-terra','--json',id,'-'];
    const child=spawn(process.execPath,[cli,...args],{cwd,windowsHide:true});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',str=>stdout+=str);
    child.stderr.setEncoding('utf8').on('data',str=>stderr+=str);
    child.stdin.on('error',()=>{});
    child.on('error',reject);
    child.on('close',code=>{
      const rows=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
      if(code) return reject(new Error((rows.find(r=>r.type==='error')?.message??stderr).slice(0,350)));
      try {
        assert.equal(rows.find(row=>row.type==='thread.started')?.thread_id,id);
        const answer=rows.filter(row=>row.item?.type==='agent_message').at(-1)?.item.text;
        const parsed=JSON.parse(answer.slice(answer.indexOf('{'),answer.lastIndexOf('}')+1));
        for(const key of ['liked','missing']) assert.ok(parsed[key].length&&parsed[key].every(x=>typeof x==='string'));
        for(const key of ['change','success_signal','own_growth','format_limit']) assert.ok(typeof parsed[key]==='string'&&parsed[key].length);
        resolve({player,team:fourTeams[player[0]].name,model:result.model,resumedSameThread:true,...parsed});
      } catch(error) { reject(new Error(`${player}: ${error.message}`)); }
    });
    child.stdin.end(`${questions}\nДанные после партии:\n${JSON.stringify(context(player))}\n`, 'utf8');
  });
}

const feedback=[];
const errors=[];
async function pull(player) {
  for(let attempt=1;attempt<=3;attempt++) {
    try { return await interview(player,sessions[player]); }
    catch(error) {
      errors.push({player,attempt,error:error.message});
      if(attempt===3) throw error;
    }
  }
}
for(let index=0;index<result.players.length;index+=4) {
  const wave=await Promise.allSettled(result.players.slice(index,index+4).map(pull));
  for(const row of wave) {
    if(row.status==='fulfilled') { feedback.push(row.value); console.log(`Feedback: ${row.value.player}`); }
    else console.error(row.reason.message);
  }
  writeFileSync(join(folder,'feedback.json'),JSON.stringify({questions,feedback,errors},null,2));
}
assert.equal(feedback.length,8);

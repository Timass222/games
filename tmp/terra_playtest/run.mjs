import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, playAction, viewGame, GameError } from '../../site_app/game.mjs';
import { fourTeams } from '../../site_app/four-team-data.mjs';

const model = 'gpt-6.1-terra';
const materialsTrial = process.argv.includes('--materials-smoke');
const cwd = fileURLToPath(new URL('./', import.meta.url));
const runId = new Date().toISOString().slice(0, 19).replace(/:/g, '-') + (materialsTrial ? '-materials' : '');
const output = fileURLToPath(new URL(`../../output/terra-playtest/${runId}/`, import.meta.url));
mkdirSync(output, { recursive: true });
const journal = join(output, 'actions.jsonl');
const cli = join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const teams = Object.keys(fourTeams);
const host = { role: 'host' };
const players = Object.fromEntries(teams.map(team => [team, [1, 2].map(i => ({ id: `${team}${i}`, team }))]));
const seat = (team, role, cycle) => players[team][Number((role === 'envoy') !== (cycle >= 4))];
let game = createGame('baseline', '4x2');

const named = id => fourTeams[id]?.name ?? id;
const publish = entry => appendFileSync(journal, JSON.stringify({ cycle: game.cycle, phase: game.phase, ...entry }) + '\n', 'utf8');
const short = (v, max = 350) => String(v ?? '').slice(0, max);
const list = (v, max = 12) => Array.isArray(v) ? v.slice(0, max) : [];
const brief = player => `Ты игрок ${player.id}, фракция «${named(player.team)}». Играй за неё. Ответ будет исполнен движком. Роли меняются после 3-го цикла. Фракции B Строители, J Жители, M Торговцы, O Орден. Ресурсы [Д,К,Р] = древесина, камень, рабочие действия. Материалы переносятся, Р сгорают. Цены за полную единицу. Для совместной оплаты доли должны точно собрать цену указанной единицы в текущем цикле. Единицы можно финансировать одновременно по номеру. Эффект проекта начисляется после его завершения. Лидер выбирает вложения, посол ведёт переговоры. Демо заканчивается после цикла 6. В полном сценарии готовая башня приносит городским фракциям общую победу. Рубеж прогресса демо для стройки — завершённые фундамент и каркас, на Другом берегу также требуется усиление. Рубеж отслеживается отдельно от благополучия. Игра без таймера. Не вызывай инструменты и не ищи скрытое состояние. Верни один JSON-объект без Markdown. Мотив в поле why по-русски одним предложением.\n` + (player.team === 'O' ? 'Твоя закрытая цель: договориться о представительствах в разных фракциях, ориентир два за демо. Орден стремится ограничивать строительство башни; помогать за реальную цену можно.' : 'Твои цели в демо: улучшить благополучие своей фракции, ориентир 7, и решить, сколько вложить в общий рубеж стройки. У других команд собственные интересы.');

function askOnce(player, prompt) {
  return new Promise((resolve, reject) => {
    const options = ['--ignore-user-config','--skip-git-repo-check','--disable','shell_tool','--disable','shell_snapshot','-c','model_reasoning_effort="low"','-m',model,'--json'];
    const args = player.thread ? ['exec','resume',...options,player.thread,'-'] : ['exec',...options,'--sandbox','read-only','-'];
    const child = spawn(process.execPath, [cli,...args], { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => stdout += value);
    child.stderr.setEncoding('utf8').on('data', value => stderr += value);
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => {
      const rows = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const result = rows.filter(row => row.item?.type === 'agent_message').at(-1)?.item.text;
      const error = rows.find(row => row.type === 'turn.failed' || row.type === 'error');
      const thread = rows.find(row => row.type === 'thread.started')?.thread_id;
      if (thread) player.thread = thread;
      if (code || !result) return reject(new Error(short(error?.error?.message ?? error?.message ?? stderr, 380) || `CLI exit ${code}`));
      try {
        const json = JSON.parse(result.slice(result.indexOf('{'),result.lastIndexOf('}')+1));
        resolve({ json, usage: rows.find(row => row.type === 'turn.completed')?.usage });
      } catch { reject(new Error('Ответ агента не был JSON')); }
    });
    child.stdin.end((player.thread ? '' : brief(player) + '\n\n') + prompt, 'utf8');
  });
}

async function ask(player, stage, data, instructions) {
  const prompt = `Ход ${game.cycle}, задача ${stage}. Роль и данные ниже.\n${instructions}\n${JSON.stringify(data)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { json, usage } = await askOnce(player, attempt === 1 ? prompt : `${prompt}\nВерни ровно один валидный JSON-объект, без комментариев.`);
      publish({ kind: 'decision', stage, player: player.id, team: player.team, decision: json, usage });
      return json;
    } catch (error) {
      publish({ kind: 'retry', stage, player: player.id, attempt, error: error.message });
      if (attempt === 3 || /usage limit|quota exceeded|not logged in/i.test(error.message)) throw new Error(`${player.id}/${stage}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 750 * attempt));
    }
  }
}

function board(team, role) {
  const view = viewGame(game, { teamId: team, role });
  return {
    role, team, resources: view.resources, scores: view.teams.map(({ id,score,representation }) => [id,score,representation]),
    place: view.siteId, announcement: view.notice, recentPublic: view.log.slice(-10),
    projects: view.projects.filter(p => p.available || p.tower || p.id === 'G05' && game.cycle === 3).map(p => ({
      id:p.id, name:p.name, price:p.cost, progress:`${p.progress}/${p.units}`, access:p.visibility, due:p.deadline,
      effect:p.effect, ...(p.shareable ? { joint:true } : {}), ...(p.abstainEligible ? { buyRefusal:true } : {}),
      ...(p.unitStates?.length > 1 ? { units:p.unitStates.map(u=>({ number:u.number, done:u.done, cost:u.cost, pooled:u.pooled, own:u.pooledByTeam })) } : {}),
      ...(p.available ? {} : { closed:p.reason }),
    })),
    deals: view.deals.filter(d => d.cycle === game.cycle),
  };
}

function act(actor, action, extra = {}) {
  const before = game;
  try {
    game = playAction(game, actor, action);
    if (materialsTrial && game.cycle > before.cycle) {
      game.resources.B[1] -= 1;
      game.resources.M[0] -= 1;
    }
    publish({ kind: 'action', atCycle: before.cycle, actor, action, ...extra, ok:true,
      ...(action.type === 'offer' ? { dealId:game.deals.at(-1).id } : {}),
      ...(action.projectId && game.completed[action.projectId] !== before.completed[action.projectId] ? { projectCompleted:true } : {}) });
    return true;
  } catch (error) {
    if (!(error instanceof GameError) || actor.role === 'host') throw error;
    publish({ kind: 'action', actor, action, ...extra, ok:false, error:error.message });
    return false;
  }
}

const batch = (role, stage, data, instructions) => Promise.all(teams.map(async team => [team,
  await ask(seat(team, role, game.cycle), stage, data(team), instructions)]));
const council = (winner = null) => publish({kind:'snapshot', winner, state:game});
const advance = () => act(host,{type:'advance'});

function addOffers(responses, notes, joint, counters = false) {
  for (const [team, response] of responses) {
    const envoy = { role:'envoy', teamId:team };
    for (const proposal of list(counters ? response.counter : response.offers, 3)) {
      if (!proposal || typeof proposal !== 'object') continue;
      const { to,give,take,abstainProject } = proposal;
      const fields = abstainProject ? { abstainProject } : {};
      if (act(envoy,{type:'offer',to,give,take,...fields},{why:short(proposal.why ?? response.why)})) {
        notes[game.deals.at(-1).id] = short(proposal.why ?? response.why);
      }
    }
    if (counters) continue;
    for (const proposal of list(response.joint, 2)) {
      const project = board(team,'envoy').projects.find(p => p.id === proposal?.projectId && p.joint && !p.closed);
      const entries = Object.entries(proposal?.shares ?? {});
      if (!project || !entries.some(([id]) => id===team) || entries.length<2 || entries.some(([t,v])=>!teams.includes(t)||!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isInteger(x)||x<0)||!v.some(Boolean))) continue;
      const unit = project.units?.find(u=>!u.done && u.number===proposal.unit) ?? (proposal.unit==null ? project.units?.find(u=>!u.done) : undefined);
      if (project.units && !unit) continue;
      if ((unit?.cost??project.price).some((cost,i)=>cost!==entries.reduce((t,[,v])=>t+v[i],0))) continue;
      if (project.access === 'partner' && entries.some(([id]) => !board(id,'envoy').projects.some(card => card.id===project.id))) continue;
      const entry = { id:`J${game.cycle}-${joint.length+1}`, by:team, projectId:project.id, unit:unit?.number, shares:proposal.shares, why:short(proposal.why), accepted:[team] };
      joint.push(entry);
      publish({kind:'jointProposal', proposal:entry});
    }
  }
}

function applyReplies(rows, joint) {
  for (const [team, response] of rows) {
    const actor={role:'envoy',teamId:team};
    for (const id of list(response.accept)) act(actor,{type:'accept',dealId:String(id)},{why:short(response.why)});
    for (const id of list(response.decline)) act(actor,{type:'decline',dealId:String(id)},{why:short(response.why)});
    for (const id of list(response.jointAccept)) {
      const proposal=joint.find(p=>p.id===id && Object.hasOwn(p.shares,team));
      if (proposal && !proposal.accepted.includes(team)) {
        proposal.accepted.push(team);
        publish({kind:'jointReply', team, id, accepted:true, why:short(response.why)});
      }
    }
  }
}

async function vote() {
  let prior = null;
  while (game.phase === 'vote') {
    const responses = await batch('leader',`голосование ${game.voteRound}`,team=>({
      team, role:'leader', prior, sites:viewGame(game,{role:'leader',teamId:team}).sites, scoreOrder:['B','J','M'],
    }),'Выбери площадку. Если 3 из 4 не сойдутся после 2 попыток, строим на другом берегу и платим за дополнительный фундамент. Формат {"siteId":"square","why":"..."}.');
    prior={};
    for (const [team, result] of responses) {
      act({role:'leader',teamId:team},{type:'vote',siteId:result.siteId},{why:short(result.why)});
      prior[team]=result.siteId;
    }
    advance();
  }
}

async function cycle() {
  console.log(`Cycle ${game.cycle}: plans and offers`);
  council();
  const joint=[], notes={};
  const preliminary=Object.fromEntries(await batch('leader','план до переговоров',team=>board(team,'leader'),
    'Запиши проекты в порядке приоритета и коротко укажи, что реально готов оплатить уже сейчас и для каких проектов ищешь партнёра. Это личная записка, её увидит только твой посол. Формат {"priorities":[{"projectId":"S1","intent":"готов оплатить"},{"projectId":"T1","intent":"ищу партнёра"}],"why":"..."}.'));
  const opening = await batch('envoy','предложения',team=>({ ...board(team,'envoy'), leaderPlan:preliminary[team] }),
    'Предложи до 3 ресурсных сделок и до 2 договорённостей о совместном вкладе, если это стоит ресурсов. Скрытые запасы других фракций неизвестны. Если покупаешь отказ другой фракции от вклада до конца этого цикла, укажи abstainProject и положи take=[0,0,0]. Для joint перечисли все доли, в них должен входить ты. У проекта с несколькими единицами обязательно назови номер unit. Если уже платите за один этап, учитывай отдельный номер каждой единицы. Формат {"offers":[{"to":"B","give":[1,0,0],"take":[0,0,1],"why":"..."}],"joint":[{"projectId":"T1","unit":1,"shares":{"J":[1,1,2],"B":[1,1,3]},"why":"..."}],"why":"..."}.');
  addOffers(opening,notes,joint);
  const replyView=team=>({ ...board(team,'envoy'), offersFromOthers: game.deals.filter(d=>d.cycle===game.cycle && d.to===team && d.status==='pending').map(d=>({...d,why:notes[d.id]})),joint:joint.filter(p=>Object.hasOwn(p.shares,team)&&p.by!==team) });
  if (game.deals.some(d=>d.cycle===game.cycle)||joint.length) {
    const replies = await batch('envoy','ответы на предложения',replyView,
      'Реши, какие предложения принять или отклонить. Проверяй свой запас с учётом исходящих обещаний. Совместный вклад (jointAccept) это план, лидер его увидит. Проверь номера единиц и выбери не более одного плана на каждую. Можно сделать до 2 встречных предложений. Формат {"accept":["12"],"decline":["13"],"jointAccept":["J1-1"],"counter":[{"to":"O","give":[1,0,0],"take":[0,0,1]}],"why":"..."}.');
    applyReplies(replies,joint);
    const before=game.deals.length;
    addOffers(replies,notes,joint,true);
    const counters=game.deals.slice(before);
    const recipients=[...new Set(counters.map(d=>d.to))];
    const answers=await Promise.all(recipients.map(async team=>[team,await ask(seat(team,'envoy',game.cycle),'ответ на встречное предложение',
      {...replyView(team), counterOffers:counters.filter(d=>d.to===team)},'Это последний обмен предложениями внутри переговорной фазы. Верни {"accept":["ID"],"decline":["ID"],"why":"..."}.')]));
    applyReplies(answers,joint);
  }
  const agreements=joint.filter(p=>p.accepted.length===Object.keys(p.shares).length);
  publish({kind:'jointAgreements', agreements});
  advance();
  console.log(`Cycle ${game.cycle}: funding`);
  const fundingPrompt='Ты принимаешь финальное решение. Соблюдай принятые запреты на вклад, учти соглашения и остаток запаса. Выбери доступные проекты. Для полной оплаты используй fund, для доли по договору pledge и точный amount [Д,К,Р]. У проекта с несколькими единицами укажи unit. Если есть одновременно несколько планов на одну единицу, выбери один. Оставить средства или пропустить ход разрешено. Формат {"steps":[{"type":"fund","projectId":"S1"},{"type":"pledge","projectId":"T1","unit":1,"amount":[1,1,3]}],"why":"..."}.';
  const plans=await batch('leader','финальные вклады',team=>({ ...board(team,'leader'), jointAgreements:agreements.filter(p=>Object.hasOwn(p.shares,team)), leaderPlan:preliminary[team], envoyBrief:short(opening.find(([id])=>id===team)?.[1].why) }),fundingPrompt);
  const failed={};
  const submitFunding = (team, plan) => {
    const actor={role:'leader', teamId:team};
    for (const step of list(plan.steps)) if (step && ['fund','pledge'].includes(step.type)) {
      const { type, projectId, amount, unit }=step;
      if (!act(actor,{type,projectId,...(unit==null?{}:{unit}),...(type==='pledge'?{amount}:{})},{why:short(step.why??plan.why)})) (failed[team]??=[]).push(step);
    }
  };
  for (const [team,plan] of plans) submitFunding(team,plan);
  if (Object.keys(failed).length) {
    const corrections=await Promise.all(Object.entries(failed).map(async ([team,rejected])=>[team,await ask(seat(team,'leader',game.cycle), 'коррекция вкладов', {
      ...board(team,'leader'), notExecuted:rejected, jointAgreements:agreements.filter(p=>Object.hasOwn(p.shares,team)),
    }, 'Часть плана не исполнилась. Уже оплаченные шаги сохраняются. По обновлённым данным можно один раз заменить отклонённые шаги или пропустить. '+fundingPrompt)]));
    for (const [team,plan] of corrections) submitFunding(team,plan);
  }
  publish({kind:'cycleEnd', cycle:game.cycle, state:game});
  advance();
  console.log(`Cycle ${game.cycle===6 && game.phase==='finished'?6:game.cycle-1}: completed`);
}

try {
  console.log(`Log: ${output}`);
  publish({kind:'start',model,format:'4x2',...(materialsTrial ? { trial:'material-cut', firstPlayedCycle:2, lastPlayedCycle:5 } : {})});
  if (materialsTrial) {
    const archive = new URL('../../output/terra-playtest/2026-11-17T20-52-26/actions.jsonl', import.meta.url);
    const seed = readFileSync(archive,'utf8').trim().split('\n').map(JSON.parse)
      .filter(row => row.kind === 'action' && row.ok && row.atCycle < 2);
    for (const row of seed) {
      if (!act(row.actor,row.action,{ seed:true })) throw new Error('Подготовительные ходы не воспроизводятся.');
    }
    if (game.cycle !== 2 || game.phase !== 'negotiation') throw new Error('Не удалось подготовить начало второго цикла.');
  } else await vote();
  while (game.phase!=='finished' && (!materialsTrial || game.cycle<=5)) await cycle();
  council();
  writeFileSync(join(output,'result.json'),JSON.stringify({model,format:game.format, players:teams.flatMap(t=>players[t].map(p=>p.id)), distinctSessions:new Set(teams.flatMap(t=>players[t].map(p=>p.thread))).size,...(materialsTrial ? {trial:'material-cut', firstPlayedCycle:2,lastPlayedCycle:5} : {}),game},null,2));
  console.log(`Finished, ${teams.flatMap(t=>players[t]).filter(p=>p.thread).length} sessions`);
} catch (error) {
  publish({kind:'interrupted',error:error.message,state:game});
  console.error(error.message);
  process.exitCode=1;
}

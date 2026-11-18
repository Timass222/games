import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fourTeams, fourCards } from '../../site_app/four-team-data.mjs';

const cwd = fileURLToPath(new URL('./', import.meta.url));
const folder = fileURLToPath(new URL('../../output/terra-playtest/2026-11-17T20-52-26/', import.meta.url));
const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const source = readFileSync(join(folder, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const timeFolder = join(process.env.USERPROFILE, '.codex', 'sessions', '2026', '11', '17');
const cli = join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const sessions = new Map();
for (const name of readdirSync(timeFolder).filter(name => /^rollout-2026-11-17T23-(52-(29|30)|53-05)-/.test(name))) {
  const session = name.match(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/)?.[0];
  const transcript = readFileSync(join(timeFolder, name), 'utf8');
  const player = transcript.match(/Ты игрок ([BJMO][12]), фракция/)?.[1];
  assert.ok(session && player && !sessions.has(player), `Нельзя однозначно сопоставить сессию ${name}`);
  sessions.set(player, session);
}
assert.deepEqual([...sessions.keys()].sort(), result.players.slice().sort());

const questions = `Партия завершена. Ты тот же участник, опиши свою партию от первого лица по-русски. Опирайся на собственные ходы из сессии и сверку итогов ниже. Не выдумывай чужих запасов, мотивов или своих совершённых действий. Указывай номер цикла, проект или сделку. Если причины партнёра тебе неизвестны, обозначь это. Не используй инструменты.
1. Где тебе было интересно? Один конкретный выбор или разговор и почему он увлёк.
2. Где тебе было скучно или нечего решать? Один конкретный момент и причина. Если такого эпизода не было, скажи об этом и назови наименее интересную часть.
3. Почему удалось или не удалось договориться? Приведи конкретный ход переговоров, различай озвученную причину и своё объяснение. Если личного отказа не было, укажи, где сделка не возникла или в чём была трудность. Какое минимальное изменение могло бы помочь и как проверить его эффект?
4. Позволила ли игра проявить компетенции? Дай по одному короткому примеру за посла и за лидера с управлением ресурсами. Для каждой роли назови компетенцию, своё наблюдаемое действие и что не получилось или было мало возможности проявить. Если примера нет, так и скажи.
5. Какое одно изменение нужно первому живому тесту? Укажи проект, правило или интерфейс и что можно будет наблюдать. Уточни отдельно, что помешал проверить именно текстовый протокол без таймера. Если есть конкретная проблема платформы, вынеси её отдельно, иначе укажи «не заметил».
Верни ровно один JSON без Markdown. Каждое значение — строка, максимум два кратких предложения. Поля: {"interesting":"…","boring":"…","negotiation":"…","negotiation_test":"…","envoy_skill":"…","leader_skill":"…","skill_gap":"…","change":"…","success_signal":"…","platform":"…","format_limit":"…"}.`;

function context(player) {
  const team = player[0];
  return {
    player,
    team: fourTeams[team].name,
    firstRole: player[1] === '1' ? 'лидер' : 'посол',
    secondRole: player[1] === '1' ? 'посол' : 'лидер',
    finalPublic: {
      site: result.game.siteId, score: result.game.score,
      foundation: result.game.funded.T1?.length ?? 0,
      strengthening: result.game.funded.T1X?.length ?? 0,
      frame: result.game.funded.T2?.length ?? 0,
      representation: Object.keys(result.game.marks),
      completed: Object.entries(result.game.completed).filter(([id]) => !fourCards[id].owner || fourCards[id].owner === team)
        .map(([id, cycle]) => [id, fourCards[id].name, cycle]),
    },
    teamDeals: result.game.deals.filter(d => d.from === team || d.to === team)
      .map(({ id, cycle, from, to, give, take, abstainProject, status }) => ({ id, cycle, from, to, give, take, abstainProject, status })),
    ownProjectActions: source.filter(row => row.kind === 'action' && row.actor.teamId === team
      && player[1] === (row.cycle <= 3 ? '1' : '2') && ['fund', 'pledge'].includes(row.action.type))
      .map(row => ({ cycle: row.cycle, ...row.action, ok: row.ok, error: row.error })),
  };
}

function interview(player) {
  return new Promise((resolve, reject) => {
    const id = sessions.get(player);
    const args = ['exec', 'resume', '--ignore-user-config', '--skip-git-repo-check', '--disable', 'shell_tool', '--disable', 'shell_snapshot',
      '-c', 'model_reasoning_effort="low"', '-m', result.model, '--json', id, '-'];
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true, timeout: 90000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', str => stdout += str);
    child.stderr.setEncoding('utf8').on('data', str => stderr += str);
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => {
      const rows = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const error = rows.find(row => row.type === 'turn.failed' || row.type === 'error');
      if (code) return reject(new Error((error?.error?.message ?? error?.message ?? stderr).slice(0, 350)));
      try {
        assert.equal(rows.find(row => row.type === 'thread.started')?.thread_id, id);
        const answer = rows.filter(row => row.item?.type === 'agent_message').at(-1)?.item.text;
        const parsed = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1));
        for (const key of ['interesting', 'boring', 'negotiation', 'negotiation_test', 'envoy_skill', 'leader_skill', 'skill_gap', 'change', 'success_signal', 'platform', 'format_limit']) {
          assert.ok(typeof parsed[key] === 'string' && parsed[key].trim().length, key);
        }
        resolve({ player, team: fourTeams[player[0]].name, model: result.model, resumedSameThread: true, ...parsed });
      } catch (error) { reject(new Error(`${player}: ${error.message}`)); }
    });
    child.stdin.end(`${questions}\nСверка фактов после партии:\n${JSON.stringify(context(player))}\n`, 'utf8');
  });
}

const feedback = [], errors = [];
async function pull(player) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await interview(player); }
    catch (error) {
      errors.push({ player, attempt, error: error.message });
      if (attempt === 2 || /usage limit|auth required/i.test(error.message)) throw error;
    }
  }
}
for (let index = 0; index < result.players.length; index += 4) {
  const wave = await Promise.allSettled(result.players.slice(index, index + 4).map(pull));
  for (const row of wave) {
    if (row.status === 'fulfilled') { feedback.push(row.value); console.log(`Feedback: ${row.value.player}`); }
    else console.error(row.reason.message);
  }
  writeFileSync(join(folder, 'feedback.json'), JSON.stringify({ questions, feedback, errors }, null, 2));
  if (errors.some(row => /usage limit|auth required/i.test(row.error))) break;
}
assert.equal(feedback.length, result.players.length);

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../output/terra-playtest/', import.meta.url));
const first = join(root, '2026-11-17T19-55-07');
const second = join(root, '2026-11-17T20-52-26');
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
const load = dir => ({
  game: JSON.parse(read(dir, 'result.json')).game,
  actions: read(dir, 'actions.jsonl').trim().split('\n').map(JSON.parse),
});
const runs = [load(first), load(second)];
const { feedback, errors } = JSON.parse(read(second, 'feedback.json'));
assert.equal(feedback.length, 8);
assert.equal(new Set(feedback.map(entry => entry.player)).size, 8);
assert.ok(feedback.every(entry => entry.resumedSameThread && entry.model === 'gpt-6.1-terra'));
assert.equal(errors.length, 0);

function stats({ game, actions }) {
  const trades = game.deals.filter(d => !d.abstainProject);
  const buyouts = game.deals.filter(d => d.abstainProject);
  const executed = d => ['accepted', 'fulfilled'].includes(d.status);
  const plans = actions.filter(a => a.kind === 'jointAgreements').flatMap(a => a.agreements.map(plan => ({ ...plan, cycle: a.cycle })));
  return {
    all: game.deals.length, done: game.deals.filter(executed).length,
    trades: trades.length, tradesDone: trades.filter(executed).length,
    buyouts: buyouts.length, buyoutsDone: buyouts.filter(executed).length,
    jointSent: actions.filter(a => a.kind === 'jointProposal').length, jointAgreed: plans.length, plans,
  };
}

const metrics = runs.map(stats);
const firstExact = read(first, 'negotiations.md').split('\n').filter(line => line.includes('Согласовано, оплачена единица с такими долями')).length;
const last = runs[1];
const secondExact = metrics[1].plans.filter(plan => {
  const contributions = last.actions.filter(a => a.kind === 'action' && a.ok && a.cycle === plan.cycle && a.action.type === 'pledge'
    && a.action.projectId === plan.projectId && (a.action.unit ?? 1) === (plan.unit ?? 1));
  const totals = {};
  for (const contribution of contributions) {
    const team = contribution.actor.teamId;
    totals[team] = (totals[team] ?? [0, 0, 0]).map((amount, index) => amount + contribution.action.amount[index]);
  }
  return Object.keys(plan.shares).length === Object.keys(totals).length && Object.entries(plan.shares)
    .every(([team, share]) => share.every((amount, index) => totals[team]?.[index] === amount));
}).length;
assert.deepEqual([firstExact, secondExact], [6, 6]);

const fields = {
  interesting: 'Где интересно', boring: 'Где скучно или мало выбора', negotiation: 'Что помогло или помешало договориться',
  negotiation_test: 'Как проверить причину', envoy_skill: 'Действие посла', leader_skill: 'Действие лидера', skill_gap: 'Что не удалось проявить',
  change: 'Что изменить перед живым тестом', success_signal: 'Что наблюдать', platform: 'Замечание о платформе', format_limit: 'Ограничение прогона',
};
const remarks = feedback.flatMap(entry => [
  `## ${entry.player} · ${entry.team}`, '',
  ...Object.entries(fields).filter(([field]) => field in entry).map(([field, label]) => `- **${label}.** ${entry[field]}`), '',
]);
writeFileSync(join(second, 'feedback.md'), [
  '# Обратная связь после второго прогона Terra', '',
  'Ответили все восемь агентов GPT‑6.1 Terra в тех же сессиях, где сыграли партию. Игроки с индексом 1 начинали лидерами, с индексом 2 — послами. После третьего цикла роли поменялись.', '',
  'Ниже дословные самоотчёты. Выводы о действиях, вкладах и итогах сверены с [журналом партии](log.md) в [отчёте](playtest-review.html).', '',
  ...remarks,
].join('\n'));

const rows = [
  ['Формальные предложения', ...metrics.map(m => m.all)],
  ['Обмены ресурсами', ...metrics.map(m => `${m.tradesDone} из ${m.trades}`)],
  ['Оплата за отказ от вклада', ...metrics.map(m => m.buyouts ? `${m.buyoutsDone} из ${m.buyouts}` : '0')],
  ['Предложения о совместных вкладах', ...metrics.map(m => m.jointSent)],
  ['Согласованные планы', ...metrics.map(m => m.jointAgreed)],
  ['Вклады внесены по согласованным долям', firstExact, secondExact],
].map(([label, a, b]) => `<tr><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`).join('\n          ');

const style = read(first, 'playtest-review.html').match(/<style>([\s\S]+?)<\/style>/)[1];
const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Вавилонская башня — второй плейтест Terra</title>
  <style>${style}
    table { border-collapse: collapse; width: 100%; background: var(--surface); font-size: .92rem; }
    th, td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; }
    thead th { background: var(--soft-green); color: var(--green); }
    th[scope=row] { font-weight: 550; }
    td { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .compare th:first-child { width: 64%; }
    .note-text { margin-top: 9px; color: var(--muted); font-size: .88rem; }
    .feedback-list { display: grid; gap: 12px; }
    .feedback-list article { border-left: 2px solid var(--line); padding-left: 12px; }
    .feedback-list p { margin-bottom: 0; }
    .competencies { margin: 0; }
    .competencies div { display: grid; grid-template-columns: 160px minmax(0,1fr); gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
    .competencies dt { font-weight: 650; color: var(--green); }
    .competencies dd { margin: 0; }
    ol { padding-left: 1.4em; margin: 0; }
    li + li { margin-top: 6px; }
    @media (max-width: 550px) {
      th, td { padding: 7px 8px; }
      .compare th:first-child { width: 58%; }
      .compare td { white-space: normal; }
      .competencies div { grid-template-columns: 1fr; gap: 3px; }
    }
    @media print { tr, .feedback-list article, .competencies div { break-inside: avoid; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="series">Вавилонская башня · подготовка к живому плейтесту</p>
      <h1>Как прошёл второй прогон Terra</h1>
      <p class="intro">Восемь агентов сыграли шесть циклов в формате 4×2. Обменов и компенсаций стало меньше. Команды защитили дворы от паводка, построили фундамент и усилили его. Каркас остался на 0 из 2.</p>
      <dl class="metrics" aria-label="Ключевые показатели второго прогона">
        <div><dt>Исполненные сделки</dt><dd><span class="value">${metrics[1].done}</span><span class="note">в первом прогоне ${metrics[0].done}</span></dd></div>
        <div><dt>Согласованные планы</dt><dd><span class="value">${metrics[1].jointAgreed}</span><span class="note">из ${metrics[1].jointSent} предложенных</span></dd></div>
        <div><dt>Каркас</dt><dd><span class="value">0/2</span><span class="note">фундамент и усиление готовы</span></dd></div>
      </dl>
      <p class="outcome">Итог демо · Другой берег. Благополучие: Строители <strong>7</strong>, Жители <strong>10</strong>, Торговцы <strong>5</strong>. У Ордена <strong>1</strong> представительство, у Жителей.</p>
    </header>

    <section aria-labelledby="deals">
      <h2 id="deals">Где стало сложнее договориться</h2>
      <table class="compare" aria-labelledby="deals">
        <thead><tr><th scope="col">Действие</th><th scope="col">Прогон 1</th><th scope="col">Прогон 2</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p class="note-text">Первые три строки показывают сделки через движок. Последние три показывают совместные планы и фактические вклады. Во втором прогоне оба обмена прошли в первом цикле. После третьего цикла в журнале остались только предложения о совместных вкладах.</p>
      <p>На исчезновение выкупов приходится 12 из 14 потерянных исполненных сделок. Обычных обменов тоже стало меньше. Доля принятых среди предложенных выросла с 4 из 26 до 2 из 9. По совместным проектам подтверждали меньше планов, хотя предлагали больше. Шесть согласованных вкладов команды исполнили в обеих партиях.</p>
    </section>

    <section aria-labelledby="events">
      <h2 id="events">Как прошла партия</h2>
      <dl class="timeline">
        <dt>Циклы 0–2</dt><dd>На втором голосовании все выбрали Другой берег. Строители обменяли камень на древесину с Жителями и Торговцами. Затем Жители и Орден вместе открыли кухню. Жители получили благополучие и со следующего цикла передавали Ордену одно рабочее действие.</dd>
        <dt>Цикл 3</dt><dd>Торговцы предлагали Строителям и Жителям по древесине и камню за два рабочих действия. Жители берегли труд для огородов, Строители выбрали фундамент и испытательный стенд. Торговцы вложились в фундамент со Строителями, а срок заказа на крепёж истёк.</dd>
        <dt>Цикл 4</dt><dd>Строители оплатили первую единицу защиты от паводка целиком. Жители и Торговцы закрыли вторую по согласованным долям. Город избежал потерь благополучия и надбавки к труду на каркас.</dd>
        <dt>Цикл 5</dt><dd>Строители дали два рабочих действия, Жители внесли остальное в усиление. Это открыло каркас на шестой цикл. Торговцы и Орден не согласовали вывоз товара из амбаров до дедлайна.</dd>
        <dt>Цикл 6</dt><dd>Городские команды располагали 10 рабочими действиями при цене каркаса 12. Орден рассматривал помощь за представительство. Плана на обе единицы не собрали. Строители завершили мастерские (+3 себе, −2 Торговцам), Жители восстановили дворы, Торговцы закрыли зимний контракт.</dd>
      </dl>
    </section>

    <section aria-labelledby="voices">
      <h2 id="voices">Что сказали восемь участников</h2>
      <div class="feedback-list">
        <article><h3>Интерес возникал, когда было за что спорить</h3><p>Торговцы и Строители выделили цикл 3, когда общий фундамент конкурировал со срочным заказом и своим проектом. Жители отметили распределение долей защиты дворов и решение вложиться в усиление. Обоим агентам Ордена запомнилась кухня, где малая доля открывала представительство.</p></article>
        <article><h3>Меньше всего выбора было после неудачных переговоров</h3><p>Жители и Орден вспомнили фазы без входящих предложений. Торговцы и Жители отметили коррекцию уже закрытой защиты, когда на запасной проект оставалось мало труда. Строители и Торговцы назвали финал предсказуемым, когда предложенные доли каркаса превышали запасы или оставались без подтверждения.</p></article>
        <article><h3>За материалы не удалось купить труд в нужный момент</h3><p>В циклах 2–3 семь запросов обменять материалы на труд получили отказ. В ответах фигурировали собственные проекты и согласованные вклады в те же циклы. В финале Орден мог дать недостающий труд, но рассчитывал получить представительство. По лесному причалу предложения получили только Торговцы, а по резерву бригад до прямых предложений дело не дошло.</p></article>
      </div>
      <p class="note-text">Ответили 8 из 8 участников в исходных сессиях. Причины отказов сверены с журналом, где они были записаны. <a href="feedback.md">Полные ответы</a>.</p>
    </section>

    <section aria-labelledby="skills">
      <h2 id="skills">Какие компетенции проявились в действиях</h2>
      <dl class="competencies">
        <div><dt>Переговоры</dt><dd>Посол Строителей согласился внести два действия в фундамент, оставив команде возможность оплатить стенд. Посол Жителей отказался от обмена двух действий на древесину, объяснив приоритет огородов и стройки. В обоих случаях можно обсудить, как игрок оценивал условия и сообщал о своих интересах.</dd></div>
        <div><dt>Ресурсы и решения</dt><dd>Лидер Строителей оплатил стенд и внёс долю в фундамент. Лидер Жителей после провала переговоров о каркасе оплатил восстановление дворов, которое улучшило благополучие двух фракций. Здесь видны расчёт запаса, приоритеты и смена плана.</dd></div>
        <div><dt>Лидерство в команде</dt><dd>Зафиксированы выбор действий и передача плана между двумя ролями. О распределении задач, влиянии на решение команды, устном убеждении и работе под таймером этот формат даёт мало данных. Отдельной роли ресурсного менеджера в 4×2 не было.</dd></div>
      </dl>
    </section>

    <div class="columns">
      <section class="panel platform" aria-labelledby="platform">
        <h2 id="platform">Платформа</h2>
        <article><h3>Проверить обновление карточек</h3><p>Привязка долей к единицам сработала на защите дворов. Две заявки на первую единицу пришли после её полной оплаты. В живом интерфейсе стоит проверить на двух устройствах, сразу ли оба лидера видят закрытие и успевают ли перенаправить вклад.</p></article>
        <article><h3>Проверить видимость условий</h3><p>Агенты пробовали оплатить партнёрские проекты Ордена целиком. Движок отклонил эти действия по правилам. На живом тесте проверить, считывают ли игроки требование совместного вклада и доступность карточки. Послам полезно иметь перед глазами цену и согласованные доли по каждой единице.</p></article>
        <p class="note-text">Все восемь ответили, что отдельной проблемы платформы не заметили. Они играли через движок в текстовом протоколе. Удобство сайта проверяется с людьми.</p>
      </section>
      <section class="panel design" aria-labelledby="design">
        <h2 id="design">Игровой дизайн</h2>
        <article><h3>Сравнить предложение с исходным планом</h3><p>В цикле 3 записать, кто реально мог продать труд без отмены важного проекта и на каких условиях. В циклах 5–6 отметить, кто собирался вложиться в спорную карточку и было ли что выкупать.</p></article>
        <article><h3>Следить за временем на окупаемость</h3><p>По лесному причалу и резерву бригад проверить, кому пригодится доход, когда он начнёт поступать и кто готов отдать труд сейчас. По башне отдельно отметить, к какому циклу соберут усиление и начнут искать вклады на обе единицы каркаса.</p></article>
        <article><h3>На первый тест оставить текущие цены</h3><p>Дать игрокам сначала обсудить варианты голосом. Если сделки снова не возникнут, будет видно, чего не хватило: подходящего партнёра, выполнимых долей, времени или ценности самого проекта.</p></article>
      </section>
    </div>

    <footer>
      <p>Две партии без таймера с отдельными сессиями и последовательным применением действий. Во втором прогоне агентам явно назвали ориентир 7 на шесть циклов и строительный рубеж. Между прогонами менялись сценарий, карточки и порядок фиксации вкладов, поэтому сравнение описывает эти две партии. Самоотчёты помогают выбрать эпизоды для наблюдения на живой игре.</p>
      <nav aria-label="Материалы"><a href="log.md">Журнал второй партии</a><a href="feedback.md">Ответы восьми агентов</a><a href="../2026-11-17T19-55-07/playtest-review.html">Отчёт первого прогона</a></nav>
    </footer>
  </main>
</body>
</html>
`;
writeFileSync(join(second, 'playtest-review.html'), html);

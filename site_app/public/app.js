'use strict';

const main = document.querySelector('#main');
const page = document.querySelector('#page');
const rail = document.querySelector('#rail');
const session = document.querySelector('#session');
const messages = document.querySelector('#messages');
const dialog = document.querySelector('#action-dialog');

const labels = ['Древесина', 'Камень', 'Рабочие действия'];
const unitLabels = ['дерево', 'камень', 'работа'];
const roleNames = { host: 'Ведущий', leader: 'Лидер', envoy: 'Посол' };
const hosted = document.documentElement.hasAttribute('data-hosted-site');
const storeKey = 'babel-high-water-session';
const context = { token: readToken(), state: null, demo: null, canHost: false, projectFilter: 'all', busy: false };
let messageTimer;
let towerScene;
let towerFrame = 0;
const towerMotion = window.matchMedia('(prefers-reduced-motion: no-preference)');

function readToken() {
  try { return sessionStorage.getItem(storeKey) || ''; } catch { return ''; }
}

function saveToken(token) {
  context.token = token;
  try {
    if (token) sessionStorage.setItem(storeKey, token);
    else sessionStorage.removeItem(storeKey);
  } catch { /* The current page can still use its in-memory session. */ }
}

function escape(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => replacements[character]);
}

function vector(value) {
  return [0, 1, 2].map(index => {
    const number = Number(value?.[index]);
    return Number.isFinite(number) ? number : 0;
  });
}

function teamName(id, state = context.state || context.demo?.state) {
  return state?.teams?.find(team => String(team.id) === String(id))?.name || id || '—';
}

function roleName(role, state) {
  return role === 'leader' && state?.format === '4x2' ? 'Лидер и ресурсы' : (roleNames[role] || role);
}

function formatSummary(state) {
  if (state?.format === '4x2') return '4 команды по 2 человека · 8 игроков и отдельный ведущий';
  if (state?.format === '4x3') return '4 команды по 3 человека · 12 игроков и отдельный ведущий';
  return '';
}

function phaseText(state) {
  const threshold = Number(state.votesRequired) || 4;
  const required = threshold === 4 ? 'четыре' : threshold === 3 ? 'три' : String(threshold);
  const phases = {
    vote: ['Выбор площадки', `Выберите место для башни. Нужны ${required} голоса за одну площадку. После двух неудачных голосований действует компромисс.`],
    negotiation: ['Переговоры', 'Послы заключают сделки текущего цикла. Команды в это время готовят свои планы.'],
    planning: ['Вклады в проекты', 'Лидеры распределяют ресурсы после переговоров. Для оплаты одной единицы можно объединить вклады нескольких команд.'],
    finished: ['Состояние города', 'Первый плейтест заканчивается после шестого цикла. Сравните результаты и обсудите принятые решения.'],
  };
  const [title, description] = phases[state.phase] || ['Игровое поле', 'Сверьте состояние города и доступные действия.'];
  if (state.role === 'leader') {
    if (state.format === '4x2' && state.phase === 'negotiation') return [title, 'Пока посол договаривается, проверьте запасы, сравните стоимость проектов и подготовьте план вложений.'];
    if (state.format === '4x2' && state.phase === 'planning') return [title, 'Сверьте остатки после сделок посла, распределите ресурсы между проектами и внесите вклады от имени команды.'];
    if (state.format === '4x3' && state.phase === 'negotiation') return [title, 'Пока посол договаривается, менеджер ресурсов проверяет запасы и стоимость проектов вместе с лидером за одним экраном.'];
    if (state.format === '4x3' && state.phase === 'planning') return [title, 'Менеджер ресурсов сверяет остатки после сделок и предлагает, куда их направить. Лидер оформляет вклады.'];
  }
  return [title, description];
}

function cycleNumber(state) {
  return Math.max(0, Math.min(6, Number(state.cycle) || 0));
}

function resourceChips(amounts, includeZero = true) {
  const values = vector(amounts);
  if (!includeZero && !values.some(Boolean)) return '<span class="muted">Нет передачи</span>';
  return values.map((amount, index) => {
    if (!amount && !includeZero) return '';
    return `<span class="unit r${index}${amount === 0 ? ' zero' : ''}">${escape(amount)} ${unitLabels[index]}</span>`;
  }).join('');
}

function positionLabel(state) {
  const site = state.sites?.find(item => String(item.id) === String(state.siteId));
  return site?.name || (state.siteId ? String(state.siteId) : '');
}

function setMessage(text, error = false) {
  clearTimeout(messageTimer);
  messages.innerHTML = text ? `<div class="message${error ? ' error' : ''}">${escape(text)}</div>` : '';
  if (text) messageTimer = setTimeout(() => { messages.innerHTML = ''; }, 4700);
}

async function request(path, method = 'GET', body) {
  const headers = { Accept: 'application/json' };
  if (context.token) headers.Authorization = `Bearer ${context.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Запрос не выполнен (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function updateState(payload) {
  const state = payload.state || payload;
  if (!state?.role) return;
  const before = context.state;
  if (before?.role === state.role && before.teamId === state.teamId && Number(before.revision) > Number(state.revision)) return;
  context.state = state;
  if (!before || before.revision !== state.revision || before.phase !== state.phase || before.cycle !== state.cycle || before.role !== state.role || before.teamId !== state.teamId || before.format !== state.format) {
    render();
  }
}

function renderSession() {
  const state = context.state;
  if (!state) { session.innerHTML = ''; return; }
  const label = state.role === 'host' ? 'Ведущий' : teamName(state.teamId);
  session.innerHTML = `<span><strong>${escape(label)}</strong><small>${escape(state.role === 'host' ? state.experimentLabel : roleName(state.role, state))}</small></span><button class="button link compact" type="button" data-action="leave">Выйти</button>`;
}

function renderRail(state) {
  rail.hidden = !state;
  page.classList.toggle('in-game', Boolean(state));
  if (!state) { rail.innerHTML = ''; return; }
  const links = [
    ['turn', '◉', 'Текущий цикл'], ['resources', '▪', 'Ресурсы'], ['tower', '▲', 'Башня'],
    ...(state.phase === 'vote' ? [['sites', '◆', 'Площадки']] : []),
    ['projects', '▦', 'Проекты'], ['deals', '↔', 'Сделки'], ['log', '≡', 'Журнал'],
  ];
  rail.innerHTML = `<p class="rail-title">Поле игры</p>${links.map(([id, icon, label]) => `<a href="#${id}"><span class="rail-icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')}`;
}

function demoCodes(showJoin) {
  const codes = context.demo?.codes || [];
  if (!codes.length) return '';
  const state = context.demo.state || context.state;
  const resourceNote = state?.format === '4x3' ? ' Менеджер ресурсов помогает с расчётами за экраном лидера; отдельного кода нет.' : '';
  const heading = hosted ? 'Коды ролей' : 'Коды репетиции';
  const help = hosted ? 'Передайте каждой команде её коды лидера и посла.' : 'Откройте разные вкладки и войдите под нужной ролью.';
  return `<section class="panel demo-list" aria-label="${heading}"><h2>${heading}</h2><p class="muted">${help}${resourceNote}</p><ul class="codes">${codes.map(entry => {
    const name = entry.role === 'host' ? 'Ведущий' : `${teamName(entry.teamId, state)} · ${roleName(entry.role, state)}`;
    return `<li><span>${escape(name)}</span><code>${escape(entry.code)}</code>${showJoin ? `<button class="button secondary compact" type="button" data-action="join" data-id="${escape(entry.code)}">Войти</button>` : ''}</li>`;
  }).join('')}</ul></section>`;
}

function renderLobby() {
  return `<section class="arrival" aria-labelledby="arrival-title">
    <div class="arrival-scene">
      <div class="arrival-art" aria-hidden="true"></div>
      <div class="arrival-content">
        <div class="arrival-brief">
          <p class="eyebrow">Вавилонская башня</p>
          <h1 id="arrival-title">Высокая<br> вода</h1>
          <p>Вода поднимается. Стройте башню вместе, обменивайтесь ресурсами и развивайте свою фракцию. В демо общий рубеж — фундамент и каркас.</p>
          <a class="button arrival-enter" href="#game-entry">Войти в игру <span aria-hidden="true">↘</span></a>
        </div>
      </div>
      <p class="arrival-scroll" aria-hidden="true"><span>↓</span> Прокрутите, чтобы увидеть вершину</p>
    </div>
  </section>
  <section class="welcome-form" id="game-entry" tabindex="-1" aria-labelledby="entry-title">
    <p class="entry-format" id="entry-format" hidden></p>
    <h2 id="entry-title">Подключиться к игре</h2><p class="muted">Возьмите код своей роли у ведущего.</p>
      <form data-form="join"><label for="access-code">Код доступа</label><input id="access-code" name="code" type="text" required autocomplete="off" maxlength="80" autocapitalize="none" spellcheck="false"><button class="button" type="submit">Войти в игру</button></form>
      <div class="form-note" id="lobby-error" role="status"></div>
      ${hosted ? '<div id="host-entry"></div>' : ''}
      <a href="#demo-roles" id="demo-link" hidden>Участники репетиции ↓</a>
  </section>
  <div id="demo-roles"></div>`;
}

function refreshLobby() {
  const roster = formatSummary(context.demo?.state);
  const format = document.querySelector('#entry-format');
  format.hidden = !roster;
  format.textContent = roster || '';
  if (hosted) {
    const hostEntry = document.querySelector('#host-entry');
    hostEntry.innerHTML = context.canHost
      ? '<button class="button secondary compact" type="button" data-action="host-join">Войти как ведущий</button>'
      : '<a href="/signin-with-chatgpt?return_to=%2F%23game-entry" target="_top">Ведущий · вход через ChatGPT</a>';
  }
  document.querySelector('#demo-link').hidden = !context.demo?.codes?.length;
  document.querySelector('#demo-roles').innerHTML = demoCodes(true);
}

function updateTowerView() {
  towerFrame = 0;
  if (!towerScene || !towerMotion.matches) return;
  const scene = towerScene.getBoundingClientRect();
  const frame = towerScene.firstElementChild;
  const stickyTop = parseFloat(getComputedStyle(frame).top) || 0;
  const distance = scene.height - frame.offsetHeight;
  const progress = distance > 0 ? Math.max(0, Math.min(1, (stickyTop - scene.top) / distance)) : 0;
  towerScene.style.setProperty('--tower-position', `${(1 - progress) * 100}%`);
  towerScene.style.setProperty('--scroll-hint', String(Math.max(0, 1 - 4 * progress)));
}

function scheduleTowerView() {
  if (towerScene && !towerFrame && towerMotion.matches) towerFrame = window.requestAnimationFrame(updateTowerView);
}

function renderTurn(state) {
  const [title, description] = phaseText(state);
  const cycle = cycleNumber(state);
  const site = positionLabel(state);
  const advance = { vote: 'Подвести итог голосования', negotiation: 'Завершить переговоры', planning: cycle < 6 ? 'Начать следующий цикл' : 'Подвести итог прогона' };
  const cast = typeof state.votesCast === 'number' ? state.votesCast : Object.keys(state.votesCast || {}).length;
  const showAdvance = state.role === 'host' && state.phase !== 'finished';
  const subtitle = state.phase === 'vote' ? `Цикл 0 · голосование ${Number(state.voteRound) || 1}` : `Цикл ${cycle} из 6${site ? ` · ${site}` : ''}`;
  const roster = formatSummary(state);
  const shortcut = state.role === 'envoy' && state.phase === 'negotiation'
    ? ['deals', 'К сделкам'] : state.role === 'leader' && state.phase === 'planning' ? ['projects', 'К проектам'] : null;
  const phaseAction = showAdvance ? `<div class="hero-action"><button type="button" class="button on-dark" data-action="advance"${state.canAdvance === false ? ' disabled' : ''}>${advance[state.phase] || 'Продолжить'}</button>${state.phase === 'vote' ? `<small>Подано голосов: ${escape(cast)} из ${escape(state.teams?.length || 6)}</small>` : ''}</div>`
    : shortcut ? `<div class="hero-action"><a class="button on-dark" href="#${shortcut[0]}">${shortcut[1]}</a></div>` : '';
  return `<section class="hero" id="turn"><div><div class="eyebrow">${escape(subtitle)}</div><h1>${title}</h1><p>${description}</p></div>${phaseAction}</section>
    <div class="phase-track" aria-label="Ход партии">${Array.from({ length: 7 }, (_, index) => `<span class="phase-dot${index === cycle ? ' current' : index < cycle ? ' passed' : ''}"${index === cycle ? ' aria-current="step"' : ''}>${index}</span>`).join('')}<span class="phase-summary">${cycle === 0 ? 'Площадка' : cycle < 4 ? 'Первый сезон' : 'Второй сезон'}</span>${roster ? `<span class="phase-summary">${escape(roster)}</span>` : ''}</div>
    ${state.notice ? `<div class="notice">${escape(state.notice)}</div>` : ''}`;
}

function renderDictionary(dictionary) {
  if (!Array.isArray(dictionary) || dictionary.length !== 3) return '';
  return `<aside class="panel dictionary"><b>Памятка послу</b><p>На внешних переговорах используйте обозначения своей фракции. Внутри команды речь обычная.</p><div class="resource-grid">${dictionary.map((word, index) => `<div class="resource r${index}"><small>${labels[index]}</small><b>${escape(word)}</b></div>`).join('')}</div></aside>`;
}

function formatScores(score) {
  if (score === null || score === undefined) return '—';
  return Number(score) < 0 ? `−${escape(Math.abs(Number(score)))}` : escape(score);
}

function renderOverview(state) {
  let resourcePanel = '<p class="muted">Запасы видны своим командам.</p>';
  if (state.resources) {
    resourcePanel = `<div class="resource-grid">${vector(state.resources).map((value, index) => `<div class="resource r${index}"><strong>${escape(value)}</strong><small>${labels[index]}</small></div>`).join('')}</div><p class="muted">Материалы сохраняются между циклами. Неиспользованные рабочие действия сгорают.</p>`;
  } else if (state.role === 'host' && state.resourcesByTeam) {
    const available = state.resourcesByTeam;
    const rows = state.teams?.filter(team => Array.isArray(available[team.id])) || [];
    if (rows.length) resourcePanel = `<div class="table-wrap"><table><thead><tr><th>Фракция</th><th title="Древесина">Д</th><th title="Камень">К</th><th title="Рабочие действия">Р</th></tr></thead><tbody>${rows.map(team => `<tr><td>${escape(team.name)}</td>${vector(available[team.id]).map(amount => `<td>${escape(amount)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (state.role === 'leader' && state.phase === 'negotiation') {
    resourcePanel += '<div class="allocation"><p>Вклады откроются, когда ведущий завершит переговоры.</p><a class="button secondary compact" href="#projects">Посмотреть проекты</a></div>';
  } else if (state.role === 'leader' && state.phase === 'planning') {
    resourcePanel += '<div class="allocation"><a class="button compact" href="#projects">Распределить ресурсы</a></div>';
  }
  return `<section class="field overview" id="resources" aria-label="Ресурсы и благополучие"><article class="panel"><h2>${state.role === 'host' ? 'Запасы команд' : 'Запасы команды'}</h2>${resourcePanel}</article><article class="panel"><h2>Благополучие</h2><ol class="score-list">${(state.teams || []).map(team => `<li${String(team.id) === String(state.teamId) ? ' class="own-team"' : ''}><span>${escape(team.name)}${team.representation ? ' <span class="mark" title="Представительство Ордена" aria-label="Представительство Ордена">◆</span>' : ''}</span><strong>${formatScores(team.score)}</strong></li>`).join('')}</ol><p class="muted">7 очков — пробный ориентир полной игры.${state.phase === 'finished' ? ' Здесь результат за шесть циклов демо.' : ''}</p></article></section>`;
}

function renderTower(state) {
  const projects = (state.projects || []).filter(project => project.tower);
  if (!projects.length) return `<section class="field" id="tower"><div class="section-top"><h2>Башня</h2></div><p class="empty">Стройка откроется после выбора площадки.</p></section>`;
  const demoNote = ['4x2', '4x3'].includes(state.format) ? '<p>Общий рубеж демо — фундамент и каркас. Следующий этап доступен с нового цикла после завершения предыдущего.</p>' : '';
  return `<section class="field" id="tower"><div class="section-top"><div><h2>Башня</h2>${demoNote}</div></div><div class="panel tower-box"><ol class="tower-list">${projects.map(project => `<li${project.available ? ' class="active"' : ''}><strong>${escape(project.name)}</strong><span>${escape(project.progress)} из ${escape(project.units)} ед.${project.available ? ' · доступно' : ''}</span></li>`).join('')}</ol></div></section>`;
}

function renderSiteEffects(site) {
  const values = site.effects;
  if (!values) return '';
  if (typeof values === 'string') return `<p class="site-effects">${escape(values)}</p>`;
  const entries = Array.isArray(values) ? values.map((value, index) => [context.state?.teams?.[index]?.id, value]) : Object.entries(values);
  return `<p class="site-effects">${entries.filter(([, value]) => value !== 0 && value !== null && value !== '').map(([id, value]) => `<span>${escape(teamName(id))} ${Number(value) > 0 ? '+' : ''}${escape(value)}</span>`).join('')}</p>`;
}

function renderSites(state) {
  if (state.phase !== 'vote') return '';
  const canVote = state.role === 'leader';
  return `<section class="field" id="sites"><div class="section-top"><div><h2>Площадки</h2><p>${canVote ? 'Голосует лидер команды.' : 'Ознакомьтесь с условиями площадок.'}</p></div></div><div class="cards">${(state.sites || []).map(site => {
    const selected = String(state.myVote) === String(site.id);
    return `<article class="panel card"${selected ? ' data-sel="true"' : ''}><h3>${escape(site.name)}</h3><p>${escape(site.summary)}</p>${renderSiteEffects(site)}${canVote ? `<div class="card-actions"><button class="button${selected ? ' secondary' : ''} compact" type="button" data-action="vote" data-id="${escape(site.id)}"${selected ? ' disabled' : ''}>${selected ? 'Голос подан' : 'Проголосовать'}</button></div>` : ''}</article>`;
  }).join('')}</div></section>`;
}

function projectVisibility(project) {
  if (project.tower) return 'Башня';
  const kind = String(project.visibility || '').toLowerCase();
  if (['order', 'private', 'personal', 'secret', 'team', 'own', 'closed'].includes(kind)) return 'Личный проект';
  if (['partner', 'restricted', 'representation'].includes(kind)) return 'Совместный проект';
  if (/[а-яё]/i.test(kind)) return project.visibility;
  return 'Общий проект';
}

function remainingCost(unit) {
  const pooled = vector(unit.pooled);
  return vector(unit.cost).map((amount, index) => Math.max(0, amount - pooled[index]));
}

function renderProjectUnit(project, unit, canAct, resources) {
  const number = escape(unit.number);
  const projectId = escape(project.id);
  const address = `data-id="${projectId}" data-unit="${number}"`;
  const title = `Единица ${number}`;
  const pool = vector(unit.pooled);
  const own = vector(unit.pooledByTeam);
  const remaining = remainingCost(unit);
  const affordable = remaining.every((amount, index) => amount <= resources[index]);
  const canPledge = remaining.some((amount, index) => amount > 0 && resources[index] > 0);
  const status = unit.done ? 'Завершена' : pool.some(Boolean) ? 'Идёт сбор' : 'Взносов пока нет';
  return `<li class="project-unit" data-project-unit ${address} tabindex="-1">
    <div class="project-unit-head"><strong>${title}</strong><span class="card-meta">${status}</span></div>
    ${unit.done ? '' : `<div><p class="card-meta">Осталось собрать</p><div class="vector">${resourceChips(remaining)}</div></div>`}
    ${own.some(Boolean) ? `<div><p class="card-meta">Ваш вклад</p><div class="vector">${resourceChips(own)}</div></div>` : ''}
    ${canAct && !unit.done ? `<div class="card-actions">
      ${unit.fundable ? `<button class="button compact" type="button" data-action="fund" ${address} aria-label="Оплатить единицу ${number}, ${escape(project.name)}"${affordable ? '' : ' disabled title="Недостаточно ресурсов"'}>Оплатить</button>` : ''}
      ${project.shareable ? `<button class="button secondary compact" type="button" data-action="open-pledge" ${address} aria-label="Внести вклад в единицу ${number}, ${escape(project.name)}"${canPledge ? '' : ' disabled title="Недостаточно ресурсов"'}>Внести вклад</button>` : ''}
    </div>` : ''}
  </li>`;
}

function renderProject(project, state) {
  const done = Number(project.progress) >= Number(project.units);
  const progress = Math.min(100, Math.max(0, 100 * Number(project.progress) / Math.max(1, Number(project.units)) || 0));
  const cost = vector(project.cost);
  const pool = vector(project.pooled);
  const own = vector(project.pooledByTeam);
  const canAct = state.role === 'leader' && state.phase === 'planning' && project.available && !done;
  const resources = vector(state.resources);
  const affordable = cost.every((amount, index) => amount <= resources[index]);
  const canFund = canAct && project.fundable !== false && !pool.some(Boolean);
  const units = Number(project.units) > 1 && project.unitStates?.length ? project.unitStates : null;
  return `<article class="panel card"><div class="card-label"><span class="pill">${escape(projectVisibility(project))}</span>${project.deadline ? `<span class="pill due">До конца цикла ${escape(project.deadline)}</span>` : ''}</div><h3>${escape(project.name)}</h3>
    ${project.effect ? `<p>${escape(project.effect)}</p>` : ''}
    ${units ? '' : `<div><p class="card-meta">Цена целой единицы</p><div class="vector">${resourceChips(cost)}</div></div>`}
    <div class="bar" role="progressbar" aria-label="Прогресс проекта" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div>
    <div class="card-status"><span>${escape(project.progress)} из ${escape(project.units)} ед.</span><span>${done ? 'Завершён' : project.available ? 'Доступен' : escape(project.reason || 'Пока недоступен')}</span></div>
    ${units ? `<ul class="project-units" aria-label="Единицы проекта">${units.map(unit => renderProjectUnit(project, unit, canAct, resources)).join('')}</ul>` : `
    ${pool.some(Boolean) && !done ? `<div><p class="card-meta">Собрано на следующую единицу${own.some(Boolean) ? ' · с вашим вкладом' : ''}</p><div class="vector">${resourceChips(pool)}</div></div>` : ''}
    ${canAct ? `<div class="card-actions">${canFund ? `<button class="button compact" type="button" data-action="fund" data-id="${escape(project.id)}"${affordable ? '' : ' disabled title="Недостаточно ресурсов"'}>Оплатить единицу</button>` : ''}${project.shareable ? `<button class="button secondary compact" type="button" data-action="open-pledge" data-id="${escape(project.id)}">Совместный вклад</button>` : ''}</div>` : ''}`}</article>`;
}

function renderProjectCards(state) {
  const projects = (state.projects || []).filter(project => {
    if (context.projectFilter === 'active') return project.available && Number(project.progress) < Number(project.units);
    if (context.projectFilter === 'tower') return project.tower;
    return true;
  });
  return projects.length ? `<div class="cards">${projects.map(project => renderProject(project, state)).join('')}</div>` : '<p class="empty">В этом разделе пока нет проектов.</p>';
}

function renderProjects(state) {
  const filters = [['all', 'Все видимые'], ['active', 'Доступны сейчас'], ['tower', 'Башня']];
  const guide = state.role === 'leader' && state.phase === 'planning'
    ? '<p>На карточке проекта оплатите целую единицу или внесите свою долю через «Совместный вклад».</p>' : '';
  return `<section class="field" id="projects"><div class="section-top"><div><h2>Проекты</h2>${guide}</div></div><div class="filter-set" aria-label="Фильтр проектов">${filters.map(([key, label]) => `<button class="filter" type="button" data-action="filter" data-id="${key}" aria-pressed="${context.projectFilter === key}">${label}</button>`).join('')}</div><div id="project-cards">${renderProjectCards(state)}</div></section>`;
}

function renderDeals(state) {
  const statuses = { pending: 'Ожидает ответа', accepted: 'Принята', fulfilled: 'Исполнена', declined: 'Отклонена', expired: 'Истекла' };
  const canOffer = state.role === 'envoy' && state.phase === 'negotiation';
  const deals = state.deals || [];
  const cards = deals.map(deal => {
    const from = escape(teamName(deal.from));
    const to = escape(teamName(deal.to));
    const term = deal.abstainProject
      ? `<div class="deal-obligation"><h4>Условие для команды «${to}»</h4><p>Не финансировать «${escape(deal.abstainTitle || deal.abstainProject)}» ${deal.cycle == null ? 'в этом цикле' : `в цикле ${escape(deal.cycle)}`}.</p></div>`
      : `<div><h4>${to} передаёт</h4><div class="vector">${resourceChips(deal.take, false)}</div></div>`;
    const decision = canOffer && deal.status === 'pending' && String(deal.to) === String(state.teamId)
      ? `<div class="card-actions"><button class="button compact" type="button" data-action="accept" data-id="${escape(deal.id)}">Принять</button><button class="button danger compact" type="button" data-action="decline" data-id="${escape(deal.id)}">Отклонить</button></div>` : '';
    return `<article class="panel card deal-card"><header><h3>${from} → ${to}</h3><span class="pill">${escape(statuses[deal.status] || deal.status)}</span></header><div class="deal-lines"><div><h4>${from} передаёт${deal.abstainProject ? ' компенсацию' : ''}</h4><div class="vector">${resourceChips(deal.give, false)}</div></div>${term}</div>${decision}</article>`;
  });
  return `<section class="field" id="deals"><div class="section-top"><h2>Сделки</h2>${canOffer ? '<button class="button compact" type="button" data-action="open-offer">Предложить сделку</button>' : ''}</div>${cards.length ? `<div class="cards">${cards.join('')}</div>` : '<p class="empty">Сделок пока нет.</p>'}</section>`;
}

function renderLog(state) {
  const log = state.log || [];
  return `<section class="field" id="log"><div class="section-top"><h2>Журнал</h2></div>${log.length ? `<ul class="panel logs">${log.slice(-30).reverse().map(entry => `<li>${escape(typeof entry === 'string' ? entry : entry.text)}</li>`).join('')}</ul>` : '<p class="empty">Записей пока нет.</p>'}</section>`;
}

function renderHostTools(state) {
  const canReset = hosted && (state.phase === 'finished' || (state.phase === 'vote' && state.voteRound === 1 && state.votesCast === 0));
  const reset = canReset ? ` <button class="button secondary compact" type="button" data-action="open-reset">${state.phase === 'finished' ? 'Новая партия' : 'Выбрать формат'}</button>` : '';
  return `<div class="host-tools"><button class="button secondary compact" type="button" data-action="demo">Показать коды команд</button>${reset}${demoCodes(false)}</div>`;
}

function render() {
  const state = context.state;
  const enteringGame = Boolean(state && towerScene);
  const focused = document.activeElement;
  const action = focused?.dataset?.action;
  const id = focused?.dataset?.id;
  const unit = focused?.dataset?.unit;
  const restoreFocus = (action || focused?.hasAttribute('data-project-unit')) && main.contains(focused);
  renderSession();
  renderRail(state);
  page.classList.toggle('in-lobby', !state);
  main.setAttribute('aria-busy', 'false');
  if (!state) {
    const newLobby = !towerScene;
    if (newLobby) {
      main.innerHTML = renderLobby();
      towerScene = main.querySelector('.arrival');
      scheduleTowerView();
    }
    refreshLobby();
    if (newLobby && (location.hash === '#game-entry' || location.hash === '#demo-roles')) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
    }
    return;
  }
  towerScene = null;
  main.innerHTML = `${renderTurn(state)}${renderSites(state)}${renderOverview(state)}${renderDictionary(state.dictionary)}${state.phase === 'negotiation' ? renderDeals(state) : ''}${renderTower(state)}${renderProjects(state)}${state.phase === 'negotiation' ? '' : renderDeals(state)}${renderLog(state)}${state.role === 'host' ? renderHostTools(state) : ''}`;
  if (enteringGame) {
    if (location.hash === '#game-entry' || location.hash === '#demo-roles') history.replaceState(null, '', location.pathname + location.search);
    window.scrollTo(0, 0);
  }
  if (restoreFocus) {
    const matchesTarget = element => element.dataset.id === id && element.dataset.unit === unit;
    const replacement = Array.from(main.querySelectorAll('[data-action]:not(:disabled)')).find(element => matchesTarget(element) && element.dataset.action === action)
      || (unit && Array.from(main.querySelectorAll('[data-project-unit]')).find(matchesTarget));
    replacement?.focus({ preventScroll: true });
  }
}

function modalFields(prefix, maxima) {
  return `<div class="amounts">${labels.map((label, index) => `<label>${label}<input type="number" name="${prefix}${index}" value="0" min="0" step="1" max="${Math.max(0, maxima?.[index] ?? 999)}" inputmode="numeric"></label>`).join('')}</div>`;
}

function modalFooter(actionTitle) {
  return `<div class="form-note" id="dialog-error" role="status"></div><div class="dialog-actions"><button class="button secondary" type="button" data-action="close-dialog">Отмена</button><button class="button" type="submit">${actionTitle}</button></div>`;
}

function openOffer() {
  const state = context.state;
  const otherTeams = (state.teams || []).filter(team => String(team.id) !== String(state.teamId));
  if (!otherTeams.length) return;
  const eligibleProjects = state.abstentionEnabled ? (state.projects || []).filter(project => project.abstainEligible) : [];
  const term = eligibleProjects.length ? `<label>Условие для другой команды<select name="abstainProject"><option value="">Обычный обмен</option>${eligibleProjects.map(project => `<option value="${escape(project.id)}">Не финансировать «${escape(project.name)}»</option>`).join('')}</select></label><p class="muted" id="offer-abstain-note" hidden>Вы платите указанную компенсацию. Другая команда после принятия не может финансировать выбранный проект в этом цикле.</p>` : '';
  dialog.innerHTML = `<div class="dialog-content"><h2 id="dialog-title">Предложить сделку</h2><p class="muted">После принятия согласованная передача относится к текущему циклу.</p><form data-form="offer"><label>Команда<select name="to" required>${otherTeams.map(team => `<option value="${escape(team.id)}">${escape(team.name)}</option>`).join('')}</select></label>${term}<fieldset><legend id="offer-give-legend">Вы передаёте</legend>${modalFields('give', vector(state.resources))}</fieldset><fieldset id="offer-take"><legend>Вы просите</legend>${modalFields('take')}</fieldset>${modalFooter('Отправить предложение')}</form></div>`;
  dialog.showModal();
}

function openPledge(projectId, unitNumber) {
  const state = context.state;
  const project = state.projects.find(entry => String(entry.id) === String(projectId));
  if (!project) return;
  const unit = unitNumber ? project.unitStates?.find(entry => entry.number === Number(unitNumber)) : project;
  if (!unit || unit.done) return;
  const remaining = remainingCost(unit);
  const maxima = remaining.map((amount, index) => Math.min(amount, vector(state.resources)[index]));
  dialog.innerHTML = `<div class="dialog-content"><h2 id="dialog-title">Совместный вклад</h2><p>${escape(project.name)}${unitNumber ? ` · единица ${escape(unitNumber)}` : ''} · осталось собрать</p><div class="vector">${resourceChips(remaining)}</div><p class="muted">Незакрытый вклад возвращается в конце планирования, неиспользованные рабочие действия сгорают.</p><form data-form="pledge" data-id="${escape(projectId)}"${unitNumber ? ` data-unit="${escape(unitNumber)}"` : ''}>${modalFields('amount', maxima)}${modalFooter('Внести вклад')}</form></div>`;
  dialog.showModal();
}

function readAmounts(form, prefix) {
  const values = vector([0, 1, 2].map(index => form.get(`${prefix}${index}`)));
  if (values.some(value => value < 0 || !Number.isSafeInteger(value))) throw new Error('Введите целые количества ресурсов.');
  return values;
}

function openReset() {
  const { revision, phase, format } = context.state;
  dialog.innerHTML = `<div class="dialog-content"><h2 id="dialog-title">Новая партия</h2><p class="muted">Для новой партии будут выданы новые коды ролей.</p><form data-form="reset" data-revision="${escape(revision)}" data-phase="${escape(phase)}"><label>Формат<select name="format"><option value="4x3"${format === '4x3' ? ' selected' : ''}>12 игроков · 4 команды по 3</option><option value="4x2"${format === '4x2' ? ' selected' : ''}>8 игроков · 4 команды по 2</option></select></label>${modalFooter('Создать партию')}</form></div>`;
  dialog.showModal();
}

async function signIn(code) {
  if (!code) throw new Error('Введите код роли.');
  await enterGame(await request('/api/join', 'POST', { code }));
}

async function enterGame(result) {
  if (!result.token) throw new Error('Сервер не вернул код сессии.');
  saveToken(result.token);
  context.state = null;
  if (result.state?.role) updateState(result.state);
  else updateState(await request('/api/state'));
  if (context.state?.role !== 'host') context.demo = null;
  main.focus({ preventScroll: true });
  setMessage('Вы подключились к игре.');
}

async function submitAction(payload) {
  if (hosted) {
    const { cycle, phase, revision } = context.state;
    payload = { ...payload, expectedCycle: cycle, expectedPhase: phase, expectedRevision: revision };
  }
  updateState(await request('/api/action', 'POST', payload));
}

async function withActivity(operation, errorTarget) {
  if (context.busy) return;
  context.busy = true;
  try {
    await operation();
  } catch (error) {
    const target = errorTarget ? document.querySelector(errorTarget) : null;
    if (target) target.textContent = error.message;
    else setMessage(error.message || 'Не удалось связаться с игрой.', true);
  } finally {
    context.busy = false;
  }
}

async function loadDemo() {
  const payload = await request('/api/demo');
  context.demo = { state: payload.state || payload, codes: payload.codes || [] };
}

async function loadLobbyAccess() {
  if (hosted) context.canHost = (await request('/api/host')).canHost;
  else await loadDemo();
  if (!context.state) render();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id, unit } = button.dataset;
  if (action === 'filter') {
    context.projectFilter = id;
    main.querySelectorAll('[data-action="filter"]').forEach(filter => { filter.setAttribute('aria-pressed', String(filter === button)); });
    const cards = document.querySelector('#project-cards');
    if (cards) cards.innerHTML = renderProjectCards(context.state);
    return;
  }
  if (action === 'leave') {
    saveToken('');
    context.state = null;
    context.demo = null;
    render();
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
    loadLobbyAccess().catch(() => {});
    return;
  }
  if (action === 'close-dialog') { dialog.close(); return; }
  if (action === 'open-offer') { openOffer(); return; }
  if (action === 'open-pledge') { openPledge(id, unit); return; }
  if (action === 'join') { void withActivity(() => signIn(id), '#lobby-error'); return; }
  if (action === 'host-join') { void withActivity(async () => enterGame(await request('/api/host', 'POST')), '#lobby-error'); return; }
  if (action === 'open-reset') { openReset(); return; }
  if (action === 'demo') { void withActivity(async () => { await loadDemo(); render(); }); return; }

  const actions = {
    vote: { type: 'vote', siteId: id }, fund: { type: 'fund', projectId: id, ...(unit ? { unit: Number(unit) } : {}) }, advance: { type: 'advance' },
    accept: { type: 'accept', dealId: id }, decline: { type: 'decline', dealId: id },
  };
  const payload = actions[action];
  if (payload) void withActivity(async () => {
    await submitAction(payload);
    if (action !== 'advance') setMessage({ vote: 'Голос учтён.', fund: 'Единица оплачена.', accept: 'Сделка принята.', decline: 'Сделка отклонена.' }[action]);
  });
});

dialog.addEventListener('change', event => {
  if (!event.target.matches('select[name="abstainProject"]')) return;
  const selected = Boolean(event.target.value);
  const take = dialog.querySelector('#offer-take');
  take.hidden = selected;
  take.disabled = selected;
  dialog.querySelector('#offer-abstain-note').hidden = !selected;
  dialog.querySelector('#offer-give-legend').textContent = selected ? 'Вы выплачиваете компенсацию' : 'Вы передаёте';
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (!form.matches('form[data-form]')) return;
  event.preventDefault();
  const data = new FormData(form);
  const action = form.dataset.form;
  if (action === 'join') { void withActivity(() => signIn(String(data.get('code') || '').trim()), '#lobby-error'); return; }
  void withActivity(async () => {
    if (action === 'offer') {
      const give = readAmounts(data, 'give');
      const abstainProject = data.get('abstainProject');
      const take = abstainProject ? [0, 0, 0] : readAmounts(data, 'take');
      if (abstainProject && !give.some(Boolean)) throw new Error('Укажите компенсацию за отказ от финансирования.');
      if (![...give, ...take].some(Boolean)) throw new Error('Укажите хотя бы один ресурс в сделке.');
      await submitAction({ type: 'offer', to: data.get('to'), give, take, ...(abstainProject ? { abstainProject } : {}) });
      setMessage('Предложение отправлено.');
    } else if (action === 'pledge') {
      const amount = readAmounts(data, 'amount');
      if (!amount.some(Boolean)) throw new Error('Укажите хотя бы один ресурс.');
      const { id, unit } = form.dataset;
      await submitAction({ type: 'pledge', projectId: id, amount, ...(unit ? { unit: Number(unit) } : {}) });
      setMessage('Вклад учтён.');
    } else if (action === 'reset') {
      const state = await request('/api/reset', 'POST', { format: data.get('format'), expectedRevision: Number(form.dataset.revision), expectedPhase: form.dataset.phase });
      context.demo = null;
      updateState(state);
      await loadDemo();
      render();
      setMessage('Новая партия создана.');
    }
    dialog.close();
  }, '#dialog-error');
});

async function poll() {
  if (!context.token || context.busy || document.hidden) return;
  const token = context.token;
  try {
    const state = await request('/api/state');
    if (token === context.token) updateState(state);
  }
  catch (error) {
    if (token === context.token && (error.status === 401 || error.status === 403)) {
      saveToken('');
      context.state = null;
      context.demo = null;
      if (dialog.open) dialog.close();
      render();
      setMessage('Сессия завершена. Войдите снова.', true);
    }
  }
}

async function start() {
  if (context.token) {
    try { updateState(await request('/api/state')); }
    catch (error) {
      saveToken('');
      if (error.status !== 401 && error.status !== 403) setMessage('Не удалось восстановить соединение.', true);
    }
  }
  if (!context.state) {
    render();
    try { await loadLobbyAccess(); } catch { /* The code form remains available. */ }
  }
  window.setInterval(poll, 1600);
}

const art = new Image();
art.onload = () => {
  document.body.classList.add('has-hero-art');
  scheduleTowerView();
};
art.src = '/hero.webp';
window.addEventListener('scroll', scheduleTowerView, { passive: true });
window.addEventListener('resize', scheduleTowerView);
towerMotion.addEventListener('change', scheduleTowerView);
void start();

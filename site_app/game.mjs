import { cards, negotiationCards, resourceLabels, siteOptions, teams, welfare } from './game-data.mjs';
import { fourCards, fourSites, fourTeams, fourWelfare } from './four-team-data.mjs';

const zero = () => [0, 0, 0];
const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const same = (a, b) => a.every((value, index) => value === b[index]);
const fits = (have, need) => have.every((value, index) => value >= need[index]);
const sum = values => values.reduce((total, value) => total + value, 0);
const fourTeamRules = { cards: fourCards, siteOptions: fourSites, teams: fourTeams, welfare: fourWelfare, votesRequired: 3 };
const formats = {
  '6x3': { cards, siteOptions, teams, welfare, votesRequired: 4 },
  '4x3': fourTeamRules,
  '4x2': fourTeamRules,
};
const rulesFor = game => formats[game.format ?? '6x3'];
const fourTeamGame = game => rulesFor(game) === fourTeamRules;

export const experiments = {
  baseline: 'Базовая экономика',
  'dry-yard': 'Сухой двор экономит рабочие действия',
  'stone-repair': 'Ремонт причала за камень',
  'less-stone': 'Меньше базового камня у строителей',
  negotiation: 'Срочный заказ и компенсация за отказ',
};

export class GameError extends Error {}

function check(condition, message) {
  if (!condition) throw new GameError(message);
}

export function createGame(experiment = 'baseline', format = '6x3') {
  check(Object.hasOwn(experiments, experiment), 'Неизвестный вариант экономики.');
  check(Object.hasOwn(formats, format), 'Неизвестный формат игры.');
  check(format === '6x3' || experiment === 'baseline', 'Для четырёх фракций используйте экономику baseline.');
  const { teams, welfare, votesRequired } = formats[format];
  return {
    experiment,
    format,
    revision: 0,
    cycle: 0,
    phase: 'vote',
    voteRound: 1,
    votes: {},
    siteId: null,
    resources: Object.fromEntries(Object.entries(teams).map(([id, team]) => [id, [...team.stock, 0]])),
    score: Object.fromEntries(welfare.map(id => [id, 0])),
    completed: {},
    funded: {},
    pools: {},
    deals: [],
    marks: {},
    intervention: null,
    log: ['Цикл 0. Команды выбирают площадку башни.'],
    notice: `Выберите площадку. Нужно ${votesRequired === 3 ? 'три голоса из четырёх' : 'четыре голоса из шести'}.`,
  };
}

function log(game, message) {
  game.log.push(message);
}

function previous(game, id, card) {
  return id === 'T2' && game.siteId === 'compromise' ? 'T1X' : card.previous;
}

function projectCard(game, id) {
  return (game.experiment === 'negotiation' && negotiationCards[id]) || rulesFor(game).cards[id];
}

function visible(game, id, card, actor) {
  if (card.compromiseOnly && game.siteId !== 'compromise') return false;
  if (card.failedCrisisOnly && (game.cycle < 5 || game.completed.C1)) return false;
  if (actor.role !== 'host') {
    if (card.owner && card.owner !== actor.teamId) return false;
    if (card.partner && actor.teamId !== 'O' && actor.teamId !== card.partner) return false;
  }
  return card.tower || game.cycle >= card.open;
}

function projectReason(game, id, card, actor) {
  if (game.completed[id]) return 'Завершено';
  if (game.cycle < card.open) return `Откроется с цикла ${card.open}`;
  if (card.deadline && (game.cycle > card.deadline || (game.phase === 'finished' && game.cycle === card.deadline))) {
    return 'Срок истёк';
  }
  if (game.phase === 'finished') return 'Демо завершилось';
  if (id === 'O3' && !activeTower(game)) return 'Нет открытого этапа башни для изысканий';
  const before = previous(game, id, card);
  if (before && (!game.completed[before] || game.completed[before] >= game.cycle)) {
    return `Доступно с цикла после завершения «${projectCard(game, before).name}»`;
  }
  if (actor?.teamId && card.sponsor && actor.teamId !== card.sponsor) {
    return `Заказ оформляют ${rulesFor(game).teams[card.sponsor].name.toLowerCase()}`;
  }
  if (card.abstention && acceptedAbstention(game, actor?.teamId, id)) {
    return 'Вы согласились не вкладываться в этот проект в текущем цикле';
  }
  return '';
}

function price(game, id, unit = firstRemaining(game, id) ?? 1) {
  const cost = [...projectCard(game, id).cost];
  if (id === 'C1' && game.completed.R2) {
    cost[0] -= 1;
    if (game.experiment === 'dry-yard') cost[2] -= 1;
  }
  if (id === 'R1' && game.experiment === 'stone-repair') {
    cost[0] = 0;
    cost[1] = 2;
  }
  if (fourTeamGame(game)) {
    if (id === 'G08' && game.completed.G03) cost[0] -= 1;
    if (id === 'T2') {
      if (game.cycle > 3 && !game.completed.G05 && unit === 1) cost[1] += 1;
      if (game.cycle === 5 && !game.completed.G08) cost[2] += 1;
    }
  }
  if (game.intervention?.cycle === game.cycle && game.intervention.id === id) cost[2] += 1;
  return cost;
}

function eligible(game, id, actor) {
  const card = projectCard(game, id);
  return card && visible(game, id, card, actor) && !projectReason(game, id, card, actor);
}

function activeTower(game) {
  const { cards } = rulesFor(game);
  return Object.keys(cards).find(id => cards[id].tower && eligible(game, id, { role: 'host' }));
}

function acceptedAbstention(game, teamId, projectId) {
  return game.deals.some(deal => deal.cycle === game.cycle && deal.status === 'accepted'
    && deal.to === teamId && deal.abstainProject === projectId);
}

function doneUnits(game, id) {
  return game.unitDone?.[id] ?? Array.from({ length: game.funded[id]?.length ?? 0 }, (_, i) => i + 1);
}

function firstRemaining(game, id) {
  const done = doneUnits(game, id);
  return Array.from({ length: projectCard(game, id).units }, (_, i) => i + 1).find(unit => !done.includes(unit));
}

function unitPool(game, id, unit) {
  const card = projectCard(game, id);
  if (card.units === 1) return game.pools[id];
  return game.unitPools?.[id]?.[unit] ?? (unit === firstRemaining(game, id) ? game.pools[id] : undefined);
}

function pendingPrice(game, id, unit = firstRemaining(game, id) ?? 1) {
  return Object.values(unitPool(game, id, unit) ?? {}).reduce(add, zero());
}

function unitStates(game, id, teamId) {
  const card = projectCard(game, id);
  const done = doneUnits(game, id);
  return Array.from({ length: card.units }, (_, i) => {
    const number = i + 1;
    const pool = unitPool(game, id, number);
    return { number, done: done.includes(number), cost: price(game, id, number),
      pooled: pendingPrice(game, id, number), pooledByTeam: pool?.[teamId] ?? zero(),
      fundable: !done.includes(number) && !card.partner && !card.joint && !pool };
  });
}

function reserved(game, teamId) {
  return game.deals.reduce((acc, deal) => {
    if (deal.cycle !== game.cycle || deal.status !== 'accepted' || game.phase !== 'negotiation') return acc;
    if (deal.from === teamId) return add(acc, deal.give);
    if (deal.to === teamId) return add(acc, deal.take);
    return acc;
  }, zero());
}

function negotiableFunds(game, teamId) {
  return subtract(game.resources[teamId], reserved(game, teamId));
}

export function viewGame(game, actor) {
  const { role, teamId } = actor;
  const { cards, teams, siteOptions, votesRequired } = rulesFor(game);
  const teamIds = Object.keys(teams);
  const projects = Object.keys(cards).map(id => [id, projectCard(game, id)])
    .filter(([id, card]) => visible(game, id, card, actor)).map(([id, card]) => ({
    id,
    name: card.name,
    visibility: card.partner ? 'partner' : card.owner ? 'personal' : 'public',
    cost: price(game, id),
    unitStates: unitStates(game, id, teamId),
    units: card.units,
    progress: game.funded[id]?.length ?? 0,
    available: eligible(game, id, actor) === true,
    deadline: card.deadline ?? null,
    effect: id === 'R2' && game.experiment === 'dry-yard'
      ? 'Предварительный склад уменьшает цену каждой единицы защиты прибрежных дворов на 1 древесину и 1 рабочее действие.'
      : card.effect,
    tower: !!card.tower,
    reason: projectReason(game, id, card, actor),
    pooled: pendingPrice(game, id),
    pooledByTeam: unitPool(game, id, firstRemaining(game, id) ?? 1)?.[teamId] ?? zero(),
    fundable: unitStates(game, id, teamId).find(unit => !unit.done)?.fundable ?? false,
    shareable: !card.owner && !card.sponsor && (card.income === undefined || !!card.joint),
    abstainEligible: !!card.abstention && !projectReason(game, id, card),
  }));

  return {
    role, teamId: teamId ?? null, format: game.format, cycle: game.cycle, phase: game.phase, revision: game.revision,
    voteRound: game.voteRound, siteId: game.siteId, votesRequired, votesCast: Object.keys(game.votes).length,
    myVote: game.votes[teamId] ?? null, canAdvance: game.phase !== 'finished', sites: siteOptions,
    teams: teamIds.map(id => ({ id, name: teams[id].name, score: game.score[id] ?? null, representation: !!game.marks[id] })),
    resources: teamId ? negotiableFunds(game, teamId) : null,
    resourcesByTeam: role === 'host' ? Object.fromEntries(teamIds.map(id => [id, negotiableFunds(game, id)])) : undefined,
    experimentLabel: role === 'host' ? experiments[game.experiment] : undefined,
    projects,
    abstentionEnabled: fourTeamGame(game) || game.experiment === 'negotiation',
    deals: game.deals.filter(deal => role === 'host' || deal.from === teamId || deal.to === teamId)
      .map(deal => deal.abstainProject
        ? { ...deal, abstainTitle: projectCard(game, deal.abstainProject).name }
        : deal),
    log: game.log.slice(-60), notice: game.notice,
    dictionary: role === 'envoy' && game.cycle >= 4 ? teams[teamId].dictionary : undefined,
  };
}

function selectSite(game) {
  const { siteOptions, welfare, votesRequired } = rulesFor(game);
  const counts = Object.values(game.votes).reduce((count, id) => ({ ...count, [id]: (count[id] ?? 0) + 1 }), {});
  const majority = siteOptions.find(option => counts[option.id] >= votesRequired);
  if (!majority && game.voteRound === 1) {
    game.voteRound = 2;
    game.votes = {};
    game.notice = `${votesRequired === 3 ? 'Трёх' : 'Четырёх'} голосов нет. После переговоров проголосуйте повторно.`;
    log(game, game.notice);
    return;
  }
  const site = majority ?? siteOptions.find(option => option.id === 'compromise');
  game.siteId = site.id;
  welfare.forEach((id, index) => { game.score[id] = site.effects[index]; });
  log(game, `Выбрана площадка «${site.name}».`);
  openCycle(game);
}

function openCycle(game) {
  game.cycle += 1;
  game.phase = 'negotiation';
  const round = game.cycle;
  const { cards, teams } = rulesFor(game);
  const income = Object.fromEntries(Object.entries(teams).map(([id, team]) => [id, [...team.income]]));
  if (game.experiment === 'less-stone') income.B[1] -= 1;
  for (const [id, card] of Object.entries(cards)) {
    if (card.income === undefined || ![1, 2].includes(round - game.completed[id])) continue;
    for (const recipient of new Set(game.funded[id].flat())) income[recipient][card.income] += 1;
  }
  const fourTeams = fourTeamGame(game);
  const noProtection = !game.completed[fourTeams ? 'G08' : 'C1'];
  const flood = round === 5 && noProtection;
  const lateLoss = round === 6 && noProtection && !game.completed.R1;
  if (flood) {
    if (fourTeams) {
      game.score.J -= 2;
      game.score.M -= 1;
    } else {
      income.B[1] -= 1;
      income.J[2] -= 1;
      income.M[0] -= 1;
      income.O[2] -= 1;
      for (const id of ['A', 'K', 'J', 'M']) game.score[id] -= 1;
    }
  }
  if (!fourTeams && lateLoss) income.M[0] -= 1;
  for (const [id, started] of Object.entries(game.marks)) {
    if (started < round && income[id][2] > 0) {
      income[id][2] -= 1;
      income.O[2] += 1;
    }
  }
  for (const id of Object.keys(teams)) {
    game.resources[id][2] = 0;
    game.resources[id] = add(game.resources[id], income[id]);
  }
  const messages = {
    1: 'Стройка началась. Первые грузы ещё идут старой переправой.',
    2: 'На возвышении найдено место для хранения запасов. Открывается Сухой двор.',
    3: 'Река прибывает. Проверьте незавершённые проекты перед сменой ролей.',
    4: 'Смените роли. Дворы затапливает, на защиту есть один цикл. У послов разные обозначения ресурсов.',
    5: flood ? 'Дворы не защитили. Применены потери, доступен ремонт старого причала.' : 'Вода уходит. Склады и подходы сохранены.',
    6: lateLoss ? 'Уходит последний караван. Из-за причала торговцы получают на одну древесину меньше.' : 'Острая фаза позади. До конца сезона уходит последний караван.',
  };
  game.notice = fourTeams ? fourTeamNotice(game, flood) : messages[round];
  if (!fourTeams && round === 4) {
    game.notice += ' При пропуске срока: администрация, архитекторы, жители и торговцы −1 благополучия; строители −1 камень, жители и Орден −1 действие, торговцы −1 древесина в цикле 5. Если причал не восстановить, торговцы теряют ещё 1 древесину в цикле 6.';
  }
  if (game.experiment === 'negotiation' && round === 5) {
    game.notice += ' Можно предложить компенсацию за отказ от вклада в грузовой двор или набережную в этом цикле.';
  }
  if (game.experiment === 'negotiation' && round === 6) {
    game.notice += ' Последний заказ могут оплатить только Торговцы. До конца цикла им нужно собрать пять рабочих действий.';
  }
  if (game.intervention?.cycle === round && eligible(game, game.intervention.id, { role: 'host' })) {
    game.notice += ` В этом цикле «${cards[game.intervention.id].name}» требует +1 рабочее действие на каждую оставшуюся единицу.`;
  }
  log(game, `Цикл ${round}. ${game.notice}`);
}

function fourTeamNotice(game, flood) {
  const rotation = game.format === '4x2'
    ? 'Лидер и посол меняются местами и передают друг другу коды ролей.'
    : 'Смените роли лидера, посла и ресурсного менеджера.';
  const missedOrder = game.completed.G05 ? '' : ' Заказ на крепёж пропущен. Первая единица каркаса требует дополнительный камень.';
  const messages = {
    1: 'Началась стройка. Решите, сколько ресурсов направить в фундамент, а сколько в первые городские и личные проекты.',
    2: 'Появился сухой участок под склад. Ночные рейсы ускорят подвоз, но ударят по благополучию жителей.',
    3: 'Открылся заказ на крепёж. Торговцам до конца цикла нужно собрать пять рабочих действий. Если заказ не выполнить, первая единица каркаса потребует на один камень больше.',
    4: `${rotation} У послов теперь разные обозначения ресурсов. До конца цикла можно защитить дворы. Иначе в следующем цикле Жители теряют 2 благополучия, Торговцы — 1, а каждая оставшаяся единица каркаса потребует дополнительное рабочее действие.${missedOrder}`,
    5: `${flood ? 'Дворы затопило. Жители и Торговцы понесли объявленные потери, работы на каркасе подорожали.' : 'Город защитил дворы от паводка.'} Открылись грузовой двор и набережная. Послы могут предложить компенсацию за отказ от вклада в спорный проект.`,
    6: 'Заканчивается сезон. Выберите между работами на башне, восстановлением дворов и новыми городскими проектами.',
  };
  return messages[game.cycle];
}

function advance(game) {
  if (game.phase === 'vote') return selectSite(game);
  if (game.phase === 'negotiation') {
    for (const deal of game.deals.filter(deal => deal.cycle === game.cycle)) {
      if (deal.status === 'accepted') {
        game.resources[deal.from] = add(subtract(game.resources[deal.from], deal.give), deal.take);
        game.resources[deal.to] = add(subtract(game.resources[deal.to], deal.take), deal.give);
      } else if (deal.status === 'pending') {
        deal.status = 'expired';
      }
    }
    game.phase = 'planning';
    log(game, 'Переговоры закрыты. Подтверждённые передачи исполнены.');
    return;
  }
  check(game.phase === 'planning', 'Демо уже завершилось.');
  for (const [id, pool] of Object.entries(game.pools)) {
    for (const [teamId, amounts] of Object.entries(pool)) {
      game.resources[teamId] = add(game.resources[teamId], amounts);
    }
    const card = projectCard(game, id);
    if (!card.owner && !card.partner) log(game, `Единица «${card.name}» не набрана. Вклады возвращены.`);
  }
  for (const [id, units] of Object.entries(game.unitPools ?? {})) {
    for (const pool of Object.values(units)) {
      for (const [teamId, amounts] of Object.entries(pool)) game.resources[teamId] = add(game.resources[teamId], amounts);
      const card = projectCard(game, id);
      if (!card.owner && !card.partner) log(game, `Единица «${card.name}» не набрана. Вклады возвращены.`);
    }
  }
  game.pools = {};
  game.unitPools = {};
  for (const deal of game.deals) {
    if (deal.cycle === game.cycle && deal.abstainProject && deal.status === 'accepted') deal.status = 'fulfilled';
  }
  for (const balances of Object.values(game.resources)) balances[2] = 0;
  if (game.cycle === 6) {
    game.phase = 'finished';
    game.notice = 'Демо завершено. Обсудите решения и текущее состояние города.';
    if (game.experiment === 'negotiation' && !game.completed.P9) {
      log(game, 'Караван ушёл без последнего заказа. Срок истёк.');
    }
    log(game, game.notice);
  } else {
    openCycle(game);
  }
}

function vector(value) {
  check(Array.isArray(value) && value.length === 3 && value.every(number => Number.isSafeInteger(number) && number >= 0 && number <= 100), 'Введите три целых числа от 0 до 100.');
  return [...value];
}

function makeOffer(game, actor, payload) {
  const { cards, teams } = rulesFor(game);
  check(typeof payload.to === 'string' && Object.hasOwn(teams, payload.to) && payload.to !== actor.teamId, 'Выберите другую команду.');
  const give = vector(payload.give);
  const take = vector(payload.take);
  check(sum(give) + sum(take) > 0, 'В сделке должен быть хотя бы один ресурс.');
  check(fits(negotiableFunds(game, actor.teamId), give), 'У команды недостаточно свободных ресурсов.');
  const deal = { id: String(game.revision + 1), from: actor.teamId, to: payload.to, give, take, cycle: game.cycle, status: 'pending' };
  if (payload.abstainProject != null) {
    const id = payload.abstainProject;
    const card = typeof id === 'string' && Object.hasOwn(cards, id) && projectCard(game, id);
    check(card?.abstention && !projectReason(game, id, card), 'Выберите открытый проект для сделки об отказе.');
    check(sum(take) === 0, 'В сделке об отказе ресурсы передаёт сторона, предлагающая компенсацию.');
    check(!acceptedAbstention(game, deal.to, id), 'Эта команда уже согласилась не вкладываться в проект.');
    deal.abstainProject = id;
  }
  game.deals.push(deal);
}

function receiveOffer(game, actor, payload) {
  const deal = game.deals.find(item => item.id === payload.dealId && item.cycle === game.cycle);
  check(deal && deal.to === actor.teamId && deal.status === 'pending', 'Предложение уже обработано или недоступно.');
  if (payload.type === 'accept') {
    if (deal.abstainProject) {
      check(!acceptedAbstention(game, deal.to, deal.abstainProject), 'Вы уже согласились не вкладываться в этот проект.');
    }
    check(fits(negotiableFunds(game, deal.from), deal.give) && fits(negotiableFunds(game, deal.to), deal.take), 'У одной из сторон недостаточно свободных ресурсов. Предложите новые условия.');
    deal.status = 'accepted';
  } else {
    deal.status = 'declined';
  }
}

function finishUnit(game, id, contributor, unit) {
  const card = projectCard(game, id);
  const done = [...doneUnits(game, id), unit];
  (game.unitDone ??= {})[id] = done;
  const units = game.funded[id] ??= [];
  units.push(contributor);
  if (units.length < card.units) {
    if (!card.owner && !card.partner) log(game, `«${card.name}»: готово ${units.length} из ${card.units}.`);
    return;
  }
  game.completed[id] = game.cycle;
  for (const [teamId, value] of Object.entries(card.score ?? {})) game.score[teamId] += value;
  if (card.partner) {
    game.marks[card.partner] = game.cycle;
    log(game, `Орден открыл представительство у фракции «${rulesFor(game).teams[card.partner].name}».`);
  } else if (!card.owner) {
    log(game, `Завершён проект «${card.name}».`);
  }
  if (id === 'O3') game.intervention = { id: activeTower(game), cycle: game.cycle + 1 };
}

function fund(game, actor, payload) {
  const id = payload.projectId;
  check(typeof id === 'string' && Object.hasOwn(rulesFor(game).cards, id), 'Проект сейчас недоступен.');
  const card = projectCard(game, id);
  check(visible(game, id, card, actor), 'Проект сейчас недоступен.');
  const reason = projectReason(game, id, card, actor);
  check(!reason, reason);
  const unit = payload.unit === undefined ? firstRemaining(game, id) : payload.unit;
  check(Number.isSafeInteger(unit) && unit >= 1 && unit <= card.units && !doneUnits(game, id).includes(unit), 'Единица проекта недоступна или уже завершена.');
  if (card.units > 1 && game.pools[id]) {
    const oldUnit = firstRemaining(game, id);
    ((game.unitPools ??= {})[id] ??= {})[oldUnit] = game.pools[id];
    delete game.pools[id];
  }
  const cost = price(game, id, unit);
  const teamId = actor.teamId;
  if (payload.type === 'fund') {
    check(!card.partner && !card.joint && !unitPool(game, id, unit), 'Для этой единицы нужен совместный вклад.');
    check(fits(game.resources[teamId], cost), 'Не хватает ресурсов на целую единицу.');
    game.resources[teamId] = subtract(game.resources[teamId], cost);
    finishUnit(game, id, teamId, unit);
    return;
  }
  check(!card.owner && !card.sponsor && (card.income === undefined || card.joint), 'Этот проект оплачивается целой единицей одной командой.');
  const offer = vector(payload.amount);
  const pool = card.units === 1 ? (game.pools[id] ??= {}) : (((game.unitPools ??= {})[id] ??= {})[unit] ??= {});
  const next = add(pendingPrice(game, id, unit), offer);
  check(sum(offer) > 0 && fits(cost, next), 'Вклад должен быть ненулевым и помещаться в остаток цены.');
  check(fits(game.resources[teamId], offer), 'У вашей команды не хватает ресурсов.');
  if (card.joint) {
    const participants = new Set([...Object.keys(pool), teamId]);
    check(participants.size <= 2, 'В проекте участвуют ровно две фракции.');
    check(!same(next, cost) || participants.size === 2, 'Для завершения нужны вклады двух фракций.');
  }
  if (card.partner && same(next, cost)) {
    const participants = new Set([...Object.keys(pool), teamId]);
    check(participants.has('O') && participants.has(card.partner), 'Для представительства нужен вклад обеих сторон.');
  }
  if (card.partner && !same(next, cost)) {
    const other = teamId === 'O' ? card.partner : 'O';
    check(pool[other] || sum(subtract(cost, next)) >= 1, 'Оставьте часть цены для вклада партнёра.');
  }
  game.resources[teamId] = subtract(game.resources[teamId], offer);
  pool[teamId] = add(pool[teamId] ?? zero(), offer);
  if (same(next, cost)) {
    if (card.units === 1) delete game.pools[id];
    else delete game.unitPools[id][unit];
    finishUnit(game, id, card.joint ? Object.keys(pool) : teamId, unit);
  }
}

export function playAction(previousState, actor, payload) {
  const game = structuredClone(previousState);
  const { teams, siteOptions } = rulesFor(game);
  check(actor.role === 'host' || Object.hasOwn(teams, actor.teamId), 'Этой команды нет в партии.');
  check(payload && typeof payload === 'object', 'Некорректный запрос.');
  switch (payload.type) {
    case 'advance':
      check(actor.role === 'host', 'Сменить фазу может ведущий.');
      advance(game);
      break;
    case 'vote':
      check(actor.role === 'leader' && game.phase === 'vote', 'Голосование доступно лидеру в цикле 0.');
      check(siteOptions.some(option => option.id === payload.siteId), 'Выберите площадку.');
      game.votes[actor.teamId] = payload.siteId;
      break;
    case 'offer':
    case 'accept':
    case 'decline':
      check(actor.role === 'envoy' && game.phase === 'negotiation', 'Сделки оформляют послы во время переговоров.');
      if (payload.type === 'offer') makeOffer(game, actor, payload);
      else receiveOffer(game, actor, payload);
      break;
    case 'fund':
    case 'pledge':
      check(actor.role === 'leader' && game.phase === 'planning', 'Вклады оформляет лидер после переговоров.');
      fund(game, actor, payload);
      break;
    default:
      throw new GameError(`Неизвестное действие. В игре используются: ${resourceLabels.join(', ')}.`);
  }
  game.revision += 1;
  return game;
}

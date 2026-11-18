import { createGame, GameError, playAction, viewGame } from './game/game.mjs';
import assets from './dist/server/assets.json' with { type: 'json' };

const HOST = { role: 'host' };
const initialFormat = '4x3';
const SESSION_LENGTH = 7 * 24 * 60 * 60;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function randomHex(length) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), value => value.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(value) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

function roomFor(format) {
  const game = createGame('baseline', format);
  const codes = Object.keys(game.resources).flatMap(teamId => ['leader', 'envoy'].map(role => ({
    teamId, role, code: randomHex(9).toUpperCase(),
  })));
  return { generation: randomHex(16), game, codes };
}

async function readRoom(db) {
  const get = () => db.prepare('SELECT generation, state, codes FROM game_room WHERE id = 1').first();
  let row = await get();
  if (!row) {
    const room = roomFor(initialFormat);
    await db.prepare('INSERT INTO game_room (id, generation, revision, state, codes) VALUES (1, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(room.generation, JSON.stringify(room.game), JSON.stringify(room.codes)).run();
    row = await get();
    if (!row) throw new Error('Game room was not initialized');
  }
  return { generation: row.generation, game: JSON.parse(row.state), codes: JSON.parse(row.codes) };
}

async function requestData(request) {
  if (Number(request.headers.get('Content-Length')) > 8192) throw new HttpError(413, 'Запрос слишком большой.');
  let data;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 8192) throw new HttpError(413, 'Запрос слишком большой.');
    data = JSON.parse(text);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Некорректный запрос.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Некорректный запрос.');
  return data;
}

function isOwner(request, env) {
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  return Boolean(email && request.headers.get('oai-authenticated-user-id') && email === env.GAME_HOST_EMAIL?.trim().toLowerCase());
}

async function issueSession(db, room, actor) {
  const token = randomHex(24);
  const time = Math.floor(Date.now() / 1000);
  await db.prepare('INSERT INTO game_session (token_hash, generation, role, team_id, expires) VALUES (?, ?, ?, ?, ?)')
    .bind(await fingerprint(token), room.generation, actor.role, actor.teamId ?? null, time + SESSION_LENGTH).run();
  return json({ token, state: viewGame(room.game, actor) });
}

async function identify(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([\da-f]{48})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare('SELECT generation, role, team_id FROM game_session WHERE token_hash = ? AND expires > ?')
    .bind(await fingerprint(token), Math.floor(Date.now() / 1000)).first();
  if (!row || (row.role === 'host' && !isOwner(request, env))) return null;
  return { role: row.role, teamId: row.team_id, generation: row.generation };
}

function authorize(room, actor) {
  if (actor.role !== 'host' && actor.generation !== room.generation) throw new HttpError(401, 'Началась новая партия. Получите новый код у ведущего.');
}

function checkCurrent(game, payload) {
  if ((payload.expectedCycle !== undefined && payload.expectedCycle !== game.cycle)
      || (payload.expectedPhase !== undefined && payload.expectedPhase !== game.phase)
      || (payload.type === 'advance' && payload.expectedRevision !== game.revision)) {
    throw new HttpError(409, 'Фаза или состояние изменились. Обновите экран и повторите действие.');
  }
}

async function applyAction(db, actor, payload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = await readRoom(db);
    authorize(room, actor);
    checkCurrent(room.game, payload);
    const game = playAction(room.game, actor, payload);
    const saved = await db.prepare('UPDATE game_room SET revision = ?, state = ? WHERE id = 1 AND generation = ? AND revision = ?')
      .bind(game.revision, JSON.stringify(game), room.generation, room.game.revision).run();
    if (saved.meta.changes === 1) return json(viewGame(game, actor));
  }
  throw new HttpError(409, 'Команды одновременно изменили партию. Обновите экран и повторите действие.');
}

async function resetRoom(db, payload, actor) {
  if (actor.role !== 'host') throw new HttpError(403, 'Формат выбирает ведущий.');
  if (!['4x3', '4x2'].includes(payload.format)) throw new HttpError(400, 'Выберите формат на 12 или 8 игроков.');
  const room = await readRoom(db);
  const { game } = room;
  const idle = game.phase === 'vote' && game.voteRound === 1 && Object.keys(game.votes).length === 0;
  if (game.phase !== 'finished' && !idle) throw new HttpError(409, 'Новая партия доступна до голосования или после финала.');
  if (payload.expectedRevision !== game.revision || payload.expectedPhase !== game.phase) throw new HttpError(409, 'Состояние изменилось. Повторите выбор формата.');
  const fresh = roomFor(payload.format);
  // Keep UI revisions monotonic even when an old tab is still polling.
  fresh.game.revision = game.revision + 1;
  const saved = await db.prepare('UPDATE game_room SET generation = ?, revision = ?, state = ?, codes = ? WHERE id = 1 AND generation = ? AND revision = ?')
    .bind(fresh.generation, fresh.game.revision, JSON.stringify(fresh.game), JSON.stringify(fresh.codes), room.generation, game.revision).run();
  if (saved.meta.changes !== 1) throw new HttpError(409, 'Состояние изменилось. Повторите выбор формата.');
  return json(viewGame(fresh.game, actor));
}

async function api(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (method === 'POST' && request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Откройте игру напрямую.');

  // Pin reads to the primary and sequence writes within this request.
  const db = env.DB.withSession('first-primary');
  if (pathname === '/api/host' && method === 'GET') return json({ canHost: isOwner(request, env) });
  if (pathname === '/api/host' && method === 'POST') {
    if (!isOwner(request, env)) throw new HttpError(403, 'Войти как ведущий может владелец игры.');
    return issueSession(db, await readRoom(db), HOST);
  }
  if (pathname === '/api/join' && method === 'POST') {
    const { code } = await requestData(request);
    const key = typeof code === 'string' && code.trim().toUpperCase();
    if (!key || !/^[0-9A-F]{18}$/.test(key)) throw new HttpError(401, 'Код входа не найден.');
    const room = await readRoom(db);
    const actor = room.codes.find(entry => entry.code === key);
    if (!actor) throw new HttpError(401, 'Код входа не найден.');
    return issueSession(db, room, actor);
  }

  const actor = await identify(request, env);
  if (pathname === '/api/demo' && method === 'GET') {
    if (actor?.role !== 'host') throw new HttpError(403, 'Коды доступны ведущему.');
    const room = await readRoom(db);
    return json({ state: viewGame(room.game, actor), codes: room.codes });
  }
  if (!actor) throw new HttpError(401, 'Войдите по коду команды или как ведущий.');
  if (pathname === '/api/state' && method === 'GET') {
    const room = await readRoom(db);
    authorize(room, actor);
    return json(viewGame(room.game, actor));
  }
  if (pathname === '/api/action' && method === 'POST') return applyAction(db, actor, await requestData(request));
  if (pathname === '/api/reset' && method === 'POST') return resetRoom(db, await requestData(request), actor);
  throw new HttpError(404, 'Страница не найдена.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); }
      catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        if (error instanceof GameError) return json({ error: error.message }, 400);
        console.error('Game request failed:', error instanceof Error ? error.name + ': ' + error.message : 'unknown');
        return json({ error: 'Не удалось обработать действие.' }, 500);
      }
    }
    const asset = assets[url.pathname === '/' ? '/index.html' : url.pathname];
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return json({ error: 'Страница не найдена.' }, 404);
    const image = asset.type.startsWith('image/');
    const body = image ? Uint8Array.from(atob(asset.body), char => char.charCodeAt(0)) : asset.body;
    return new Response(request.method === 'HEAD' ? null : body, { headers: {
      'Content-Type': asset.type,
      'Cache-Control': image ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    } });
  },
};

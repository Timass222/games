import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createGame, experiments, GameError, playAction, viewGame } from './game.mjs';

const host = process.env.GAME_HOST ?? '127.0.0.1';
const port = Number(process.env.GAME_PORT ?? '8796');
const preview = process.env.DEMO_PREVIEW === '1' && host === '127.0.0.1';
const sessions = new Map();
const codes = new Map();
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/hero.webp': ['hero.webp', 'image/webp'],
};
let game = createGame(process.env.GAME_EXPERIMENT ?? 'baseline', process.env.GAME_FORMAT ?? '6x3');

function addAccess(role, teamId) {
  const code = randomBytes(9).toString('hex').toUpperCase();
  codes.set(code, { role, teamId });
  return code;
}

const hostCode = addAccess('host', null);
for (const id of Object.keys(game.resources)) {
  addAccess('leader', id);
  addAccess('envoy', id);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw new GameError('Запрос слишком большой.');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new GameError('Некорректный запрос.');
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const path = new URL(request.url, 'http://localhost').pathname;
  const actor = sessions.get(request.headers.authorization?.match(/^Bearer ([a-f0-9]+)$/)?.[1]);
  try {
    if (request.method === 'GET' && path === '/api/demo') {
      if (actor?.role !== 'host' && !preview) return json(response, 403, { error: 'Коды доступны ведущему.' });
      return json(response, 200, {
        state: viewGame(game, { role: 'host' }),
        codes: [...codes].map(([code, item]) => ({ ...item, code })),
      });
    }
    if (request.method === 'POST' && path === '/api/join') {
      const body = await readJson(request);
      const identity = codes.get(typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '');
      if (!identity) return json(response, 401, { error: 'Код входа не найден.' });
      const token = randomBytes(24).toString('hex');
      sessions.set(token, identity);
      return json(response, 200, { token });
    }
    if (path === '/api/state' || path === '/api/action') {
      if (!actor) return json(response, 401, { error: 'Войдите по коду ведущего или команды.' });
      if (request.method === 'GET' && path === '/api/state') return json(response, 200, viewGame(game, actor));
      if (request.method === 'POST' && path === '/api/action') {
        const body = await readJson(request);
        // The validation and replacement are synchronous and share one snapshot.
        game = playAction(game, actor, body);
        return json(response, 200, viewGame(game, actor));
      }
    }
    const entry = Object.hasOwn(staticFiles, path) && staticFiles[path];
    if (request.method === 'GET' && entry) {
      const [filename, type] = entry;
      try {
        const contents = await readFile(new URL(`./public/${filename}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return response.end(contents);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return json(response, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    if (error instanceof GameError) return json(response, 400, { error: error.message });
    console.error(error);
    return json(response, 500, { error: 'Не удалось обработать действие.' });
  }
});

server.listen(port, host, () => {
  console.log(`Игра: http://${host}:${port}`);
  console.log(`Код ведущего: ${hostCode}`);
  console.log(`Формат: ${game.format.replace('x', '×')}`);
  console.log(`Экономика: ${experiments[game.experiment]}`);
  if (preview) console.log('Учебный просмотр: коды ролей доступны на экране входа.');
});

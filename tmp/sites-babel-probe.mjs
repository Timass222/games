import { once } from 'node:events';

const terminal = process.stdin.isTTY;
if (terminal) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
console.log('Ready for private probe JSON on stdin (input is hidden).');
let line = '';
let done;
const completed = new Promise(resolve => { done = resolve; });
process.stdin.on('data', chunk => {
  line += chunk;
  if (/[\r\n]/.test(line)) done();
});
process.stdin.on('end', done);
await completed;
if (terminal) process.stdin.setRawMode(false);
process.stdin.pause();

const { url, service, testOwnerEmail, testRole } = JSON.parse(line.trim());
if (new URL(url).hostname !== 'babel-tower.timapochta63.chatgpt.site') throw new Error('Unexpected probe origin');
const run = (path, { method = 'GET', value, authenticated = true, extra = {} } = {}) => fetch(new URL(path, url), {
  method,
  redirect: 'manual',
  headers: {
    ...(authenticated && service ? { 'OAI-Sites-Authorization': `Bearer ${service}` } : {}),
    ...(value ? { 'Content-Type': 'application/json' } : {}),
    ...extra,
  },
  body: value ? JSON.stringify(value) : undefined,
  signal: AbortSignal.timeout(12000),
});

const [anonymous, page, image, state, codes, login, d1, spoof] = await Promise.all([
  run('/', { authenticated: false }),
  run('/'),
  run('/hero.webp', { method: 'HEAD' }),
  run('/api/state'),
  run('/api/demo'),
  run('/api/host', { method: 'POST' }),
  run('/api/join', { method: 'POST', value: { code: '000000000000000000' } }),
  run('/api/host', { extra: { 'oai-authenticated-user-id': 'test-principal', 'oai-authenticated-user-email': testOwnerEmail } }),
]);
let anonymousJoin;
if (testRole && anonymous.ok) {
  const joined = await run('/api/join', { method: 'POST', authenticated: false, value: { code: testRole.code } });
  const session = await joined.json();
  const teamState = await run('/api/state', { authenticated: false, extra: { Authorization: `Bearer ${session.token ?? ''}` } });
  const view = await teamState.json();
  const teamCannotReadCodes = (await run('/api/demo', { authenticated: false, extra: { Authorization: `Bearer ${session.token ?? ''}` } })).status === 403;
  anonymousJoin = {
    joined: joined.status,
    state: teamState.status,
    correctRole: view.role === testRole.role && view.teamId === testRole.teamId,
    privateTeamView: !Object.hasOwn(view, 'resourcesByTeam') && teamCannotReadCodes,
    format: view.format,
    cycle: view.cycle,
  };
}
console.log(JSON.stringify({
  anonymous: anonymous.status,
  lobby: page.status,
  correctGame: (await page.text()).includes('data-hosted-site'),
  hero: image.status,
  heroType: image.headers.get('Content-Type'),
  state: state.status,
  codes: codes.status,
  hostWithoutIdentity: login.status,
  roleCodeDatabaseCheck: d1.status,
  roleCheckError: d1.status >= 500 ? (await d1.json().catch(() => ({}))).error : undefined,
  fakeHeadersRecognizedAsOwner: (await spoof.json().catch(() => ({}))).canHost === true,
  anonymousJoin,
}));

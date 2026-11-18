import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const project = new URL('./', import.meta.url);
const paths = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'text/css; charset=utf-8'],
  ['/hero.webp', 'image/webp'],
]);

const assets = {};
for (const [path, type] of paths) {
  const file = await readFile(new URL(`./public${path}`, project));
  const body = path === '/index.html'
    ? file.toString('utf8').replace('<html lang="ru">', '<html lang="ru" data-hosted-site>')
    : type.startsWith('image/') ? file.toString('base64') : file.toString('utf8');
  assets[path] = { type, body };
}

await mkdir(new URL('./dist/server/', project), { recursive: true });
await mkdir(new URL('./dist/.openai/', project), { recursive: true });
await writeFile(new URL('./dist/server/assets.json', project), JSON.stringify(assets));
await build({
  entryPoints: ['worker.mjs'], outfile: 'dist/server/index.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
});
await copyFile(new URL('./.openai/hosting.json', project), new URL('./dist/.openai/hosting.json', project));

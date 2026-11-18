import { copyFile, mkdir } from 'node:fs/promises';

const app = new URL('./', import.meta.url);
const site = new URL('../sites/babel-tower/', app);
for (const folder of ['game/', 'public/']) await mkdir(new URL(folder, site), { recursive: true });
for (const filename of ['game.mjs', 'game-data.mjs', 'four-team-data.mjs']) {
  await copyFile(new URL(filename, app), new URL(`game/${filename}`, site));
}
for (const filename of ['index.html', 'app.js', 'style.css', 'hero.webp']) {
  await copyFile(new URL(`public/${filename}`, app), new URL(`public/${filename}`, site));
}

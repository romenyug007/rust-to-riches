// Собирает index.html (или public/index.html, если есть папка public): вставляет движок правил в клиент.
import fs from 'node:fs';
const eng = fs.readFileSync('game-engine.js', 'utf8').replace(/^export /gm, '');
const src = fs.readFileSync('client.src.html', 'utf8');
const out = fs.existsSync('public') ? 'public/index.html' : 'index.html';
fs.writeFileSync(out, src.replace('/*ENGINE*/', () => eng));
console.log(out + ' собран');

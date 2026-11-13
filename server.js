// Rust to Riches — онлайн-сервер. Без внешних зависимостей (только Node.js 20+).
// HTTP + Server-Sent Events: клиент получает состояние по SSE, действия шлёт через POST.
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as E from './game-engine.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const CARDS = JSON.parse(fs.readFileSync(path.join(dir, 'cards.json'), 'utf8'));
const SCALE = Number(process.env.TIMER_SCALE || 1);   // для тестов: ускорение таймеров
const MAX_ROOMS = 300, ROOM_TTL_MS = 6 * 3600e3;
const rooms = new Map();

const clean = (s) => String(s || '').replace(/[<>&"'`\\]/g, '').trim().slice(0, 16);
const code = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c)); return c; };

// ---------- таймеры (те же правила, что в интерфейсе) ----------
const tkey = (s) => s.phase === 'move' ? 'm' + s.turn : s.phase === 'auction' ? 'a' + s.auction.bid + '/' + s.auction.bidder
  : s.phase === 'race_join' ? 'r' + s.turn : s.phase === 'race_roll' ? 'g' + s.turn + '/' + s.race.queue[0] + '/' + s.race.round : s.phase === 'loan' ? 'l' : s.phase === 'swap_offer' ? 'o' + s.turn : 't' + s.turn;
const secs = (k) => ({ m: E.MOVE_SECONDS, a: E.AUCTION_SECONDS, r: E.RACE_JOIN_SECONDS, g: E.RACE_ROLL_SECONDS, l: E.LOAN_SECONDS, o: E.LOAN_SECONDS }[k[0]] ?? E.ACT_SECONDS);
function arm(room, pause = 0) {
  const s = room.state;
  if (s.phase === 'over') { room.deadline = 0; return; }
  const k = tkey(s);
  if (k === room.key) return;
  if (k === 'l') room.paused = { key: room.key, left: room.deadline - Date.now() };
  if (room.key === 'l' && room.paused && room.paused.key === k) room.deadline = Date.now() + room.paused.left;
  else room.deadline = Date.now() + (secs(k) * 1000 + pause) * SCALE; // пока все смотрят карты/кубики — отсчёт не идёт
  room.key = k;
}
function doTimeout(room) {
  const s = room.state, evs = [];
  const take = (r) => { if (!r.ok) return false; evs.push(...(r.state.log || [])); room.state = r.state; return true; };
  let ok;
  if (s.phase === 'loan') ok = take(E.applyAction(s, { type: 'loan_cancel', player: s.loanReq.borrower }));
  else if (s.phase === 'move') ok = take(E.timeoutStep(s));
  else if (s.phase === 'auction') ok = take(E.applyAction(s, { type: 'auction_close' }));
  else if (s.phase === 'race_roll') ok = take(E.timeoutStep(s));
  else if (s.phase === 'race_join') ok = take(E.applyAction(s, { type: 'race_close' }));
  else {
    const t = s.turn; ok = true;
    for (let g = 0; g < 30 && room.state.phase !== 'over' && room.state.turn === t; g++) if (!take(E.timeoutStep(room.state))) { ok = false; break; }
  }
  if (!ok) { room.deadline = Date.now() + 5000; return; }
  changed(room, evs);
}

// ---------- рассылка ----------
function mask(s) { // клиент не видит порядок колод: только количество карт
  const { catalog, defectTemplate, rng, forcedRolls, log, decks, defectDecks, inspectDeck, lotteryDeck, ...rest } = s;
  const v = structuredClone(rest);
  const nulls = (o) => Object.fromEntries(Object.entries(o).map(([k, d]) => [k, d.map(() => null)]));
  v.decks = nulls(decks); v.defectDecks = nulls(defectDecks);
  return v;
}
function payload(room, seat, events, full) {
  const base = { room: room.code, me: seat, host: 0, players: room.seats.map((x) => x.name), colors: room.seats.map((x) => x.color), goals: room.seats.map((x) => x.goal || null) };
  if (!room.state) return { ...base, phase: 'lobby' };
  return { ...base, phase: 'game', state: mask(room.state), events, deadline: room.deadline, now: Date.now(), key: room.key, catalog: full ? room.state.catalog : undefined };
}
function send(res, data) { res.write('data: ' + JSON.stringify(data) + '\n\n'); }
function broadcast(room, events = [], full = false) {
  room.touched = Date.now();
  for (const [seat, set] of room.clients) for (const res of set) send(res, payload(room, seat, events, full));
}
function changed(room, evs) { arm(room, E.eventPause(evs)); broadcast(room, evs); }

// ---------- HTTP ----------
const html = () => { const p = path.join(dir, 'public', 'index.html'); return fs.readFileSync(fs.existsSync(p) ? p : path.join(dir, 'index.html')); };
function body(req) {
  return new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { no(new Error('json')); } }); });
}
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
const seatOf = (room, token) => room.seats.findIndex((x) => x.token === token);
const PAWNS = ['red', 'blue', 'green', 'yellow', 'black', 'white']; // цвета человечков
const freePawn = (room) => PAWNS.find((c) => !room.seats.some((x) => x.color === c));
// никнеймы: один ник — одно устройство (хранится в памяти сервера, пропадает при перезапуске)
const nicks = new Map();
const devOk = (d) => typeof d === 'string' && /^[a-f0-9]{16,40}$/.test(d);
function suggestNick(nick, taken) {
  for (let n = 2; n < 100; n++) { const c = (nick.slice(0, 13) + n); if (!taken(c)) return c; }
  return nick.slice(0, 11) + Math.floor(Math.random() * 1e5);
}
const nickTaken = (device) => (c) => { const d = nicks.get(c.toLowerCase()); return d && d !== device; };
const FORBIDDEN = new Set(['auction_close']); // закрывает аукцион только сервер по таймеру

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html()); }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get((url.searchParams.get('room') || '').toUpperCase());
      const seat = room ? seatOf(room, url.searchParams.get('token')) : -1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      if (seat < 0) { send(res, { error: 'Комната не найдена или ссылка устарела' }); return res.end(); }
      if (!room.clients.has(seat)) room.clients.set(seat, new Set());
      room.clients.get(seat).add(res);
      send(res, payload(room, seat, [], true));
      const ka = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); room.clients.get(seat)?.delete(res); });
      return;
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const b = await body(req);
    if (url.pathname === '/api/nick') { // проверить и закрепить ник за устройством
      const nick = clean(b.nick); if (!nick) return json(res, 400, { error: 'Введите никнейм' });
      if (!devOk(b.device)) return json(res, 400, { error: 'Неверное устройство' });
      if (nickTaken(b.device)(nick)) return json(res, 409, { error: 'Ник «' + nick + '» уже занят', suggest: suggestNick(nick, nickTaken(b.device)) });
      if (b.old) { const o = clean(b.old).toLowerCase(); if (nicks.get(o) === b.device) nicks.delete(o); }
      nicks.set(nick.toLowerCase(), b.device);
      return json(res, 200, { ok: true, nick });
    }
    if (url.pathname === '/api/create') {
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Сервер занят, попробуйте позже' });
      const name = clean(b.name); if (!name) return json(res, 400, { error: 'Введите имя' });
      const room = { code: code(), seats: [{ name, token: randomBytes(12).toString('hex'), color: PAWNS.includes(b.color) ? b.color : 'red' }], state: null, clients: new Map(), key: '', deadline: 0, touched: Date.now() };
      rooms.set(room.code, room);
      return json(res, 200, { room: room.code, token: room.seats[0].token, seat: 0 });
    }
    const room = rooms.get(String(b.room || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'Комната не найдена' });
    if (url.pathname === '/api/join') {
      const name = clean(b.name); if (!name) return json(res, 400, { error: 'Введите имя' });
      if (room.state) return json(res, 400, { error: 'Игра уже началась' });
      if (room.seats.length >= 6) return json(res, 400, { error: 'В комнате уже 6 игроков' });
      const inRoom = (c) => room.seats.some((x) => x.name.toLowerCase() === c.toLowerCase());
      if (inRoom(name)) return json(res, 409, { error: 'В этой комнате уже есть игрок «' + name + '»', suggest: suggestNick(name, inRoom) });
      const token = randomBytes(12).toString('hex');
      const color = PAWNS.includes(b.color) && !room.seats.some((x) => x.color === b.color) ? b.color : freePawn(room);
      room.seats.push({ name, token, color });
      broadcast(room);
      return json(res, 200, { room: room.code, token, seat: room.seats.length - 1 });
    }
    const seat = seatOf(room, b.token);
    if (seat < 0) return json(res, 403, { error: 'Нет доступа' });
    if (url.pathname === '/api/goal') { // каждый выбирает цель; играем до самой маленькой
      if (room.state) return json(res, 400, { error: 'Игра уже началась' });
      if (!E.GOALS.includes(Number(b.goal))) return json(res, 400, { error: 'Неверная цель' });
      room.seats[seat].goal = Number(b.goal); broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/color') { // выбор человечка в лобби
      if (room.state) return json(res, 400, { error: 'Игра уже началась' });
      if (!PAWNS.includes(b.color)) return json(res, 400, { error: 'Неверный цвет' });
      if (room.seats.some((x, i) => i !== seat && x.color === b.color)) return json(res, 400, { error: 'Этот цвет уже занят' });
      room.seats[seat].color = b.color; broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/start') {
      if (seat !== 0) return json(res, 403, { error: 'Начать может только создатель комнаты' });
      if (room.state) return json(res, 400, { error: 'Игра уже идёт' });
      if (room.seats.length < 2) return json(res, 400, { error: 'Нужно минимум 2 игрока' });
      room.state = E.createGame({ names: room.seats.map((x) => x.name), goal: room.seats.some((x) => x.goal) ? Math.min(...room.seats.filter((x) => x.goal).map((x) => x.goal)) : (E.GOALS.includes(Number(b.goal)) ? Number(b.goal) : 30000), seed: Date.now() % 2147483647, cards: CARDS });
      arm(room); broadcast(room, [{ type: 'game_start', first: room.state.current }], true);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/action') {
      if (!room.state) return json(res, 400, { error: 'Игра не началась' });
      const a = b.action;
      if (!a || typeof a.type !== 'string' || FORBIDDEN.has(a.type)) return json(res, 400, { error: 'Неверное действие' });
      if (a.type === 'race_close' && seat !== room.state.current) return json(res, 400, { error: 'Гонку начинает организатор' });
      const r = E.applyAction(room.state, { ...a, player: seat });
      if (!r.ok) return json(res, 400, { error: r.error });
      room.state = r.state; changed(room, r.events);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { if (!res.headersSent) json(res, 400, { error: 'Ошибка запроса' }); }
});

const tick = setInterval(() => {
  const now = Date.now();
  for (const [c, room] of rooms) {
    if (now - room.touched > ROOM_TTL_MS) { rooms.delete(c); continue; }
    if (room.state && room.state.phase !== 'over' && room.deadline && now > room.deadline) doTimeout(room);
  }
}, 250);
tick.unref();

export function start(port = Number(process.env.PORT || 3000)) {
  return new Promise((ok) => server.listen(port, () => ok(server)));
}
export { server, rooms };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(() => console.log('Rust to Riches: http://localhost:' + server.address().port));
}

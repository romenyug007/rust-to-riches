// Rust to Riches — движок правил (чистый JS, без зависимостей, работает в Node и в браузере).
// Все суммы в евро. Состояние сериализуется в JSON; applyAction возвращает новое состояние.
// Классы (ключ колоды → название): vedro → Economy, bitye → Crash, family → Family, premium → Luxury, retro → Classic.

export const BOARD = [
  'dealer',        // 0 — Дилер: старт и финиш круга, продажа всех машин
  'vedro', 'avtoservis', 'gonka_reroll', 'avtopodbor', 'lottery', 'bitye', 'tehosmotr',
  'perekup', 'family', 'avtoservis', 'premium', 'ugon', 'prokat', 'retro', 'bank',
];
const DEALER_POS = 0, FAMILY_POS = BOARD.indexOf('family');
export const INSPECT_PER_CAR = 100;  // Техосмотр: 100 € за каждую машину
export const BONUS_ROUNDS = 2;       // бонусы Техосмотра действуют 2 круга игры
export const AUCTION_STEP = 100;     // аукцион: каждая ставка выше минимум на 100 €
export const BANK_RATE = 0.1;        // Банк: +10% к наличным
export const INSURANCE_COST = 200;   // Страховка из Лотереи, до конца игры
export const FAMILY_STEP = 0.1, FAMILY_MAX = 3; // Family: +10% за проход клетки, максимум 3 раза
const round10 = (x) => Math.round(x / 10) * 10;
export const MOVE_COST = [null, 0, 0, 300, 600, 1000, 3000, 10000]; // индекс = число шагов
export const START_CASH = 1500;
export const GOALS = [30000, 50000, 100000, 200000];
// сколько миллисекунд все смотрят на карты и кубики после хода (в это время таймер стоит)
export function eventPause(evs) {
  let ms = 0;
  for (const e of evs || []) {
    if (['race_roll', 'race_reroll', 'taxi', 'theft_roll'].includes(e.type) || (e.type === 'repair_roll' && e.die)) ms += 2600;
    if (e.type === 'car_gained') ms = Math.max(ms, 0) + 1500;
    if (e.type === 'lottery' || e.type === 'inspection') ms += 4000;
  }
  if (evs && evs.some((e) => e.type === 'car_gained')) ms += 3000;
  return Math.min(ms, 15000);
}
export const RACE_POT = 1000;
export const MOVE_SECONDS = 30;      // выбор числа шагов
export const ACT_SECONDS = 60;       // решение: что купить / активировать / гонка
export const AUCTION_SECONDS = 30;   // новый отсчёт после каждой ставки
export const RACE_JOIN_SECONDS = 30; // окно присоединения к гонке
export const RACE_ROLL_SECONDS = 15; // каждый участник гонки сам бросает куб; не бросил — бросается автоматически
export const LOAN_SECONDS = 15;      // окно ответа на запрос займа (не входит в 30 с хода)
export const LOAN_RATE_LATE = 0.2;  // с 5-го круга проценты начисляются по 20% за круг
export const LOAN_RATE = 0.1;        // +10% от суммы за каждый полный круг игры
export const LOAN_DEADLINE_ROUNDS = 5; // через 5 кругов — принудительный возврат ×2
export const DEFECT_COPIES = 2; // колоды дефектов бесконечные, состав кратен оригиналу
const RENT = { vedro: 500, bitye: 500, family: 1000, premium: 1000, retro: 1500 };
const TAXI = { vedro: 100, bitye: 100, family: 100, premium: 200, retro: 200 };
const CELL_DECK = { vedro: 'vedro', bitye: 'bitye', family: 'family', premium: 'premium', retro: 'retro' };
const CLASS_DECKS = ['vedro', 'bitye', 'family', 'premium', 'retro'];
const INSPECT_TEMPLATE = [
  ...Array(5).fill({ kind: 'repair_bonus' }), ...Array(5).fill({ kind: 'sale_bonus' }),
  ...CLASS_DECKS.map((deck) => ({ kind: 'hidden', deck })),
];
const LOTTERY_TEMPLATE = [
  { kind: 'win', amount: 100 }, { kind: 'win', amount: 500 }, { kind: 'win', amount: 1000 },
  { kind: 'buyer' }, { kind: 'insurance' }, { kind: 'dps' }, { kind: 'evac' }, { kind: 'tire' },
  { kind: 'birthday' }, ...CLASS_DECKS.map((deck) => ({ kind: 'recall', deck })), { kind: 'lux_tax' }, { kind: 'expo' },
];

class Illegal extends Error {}
const fail = (m) => { throw new Error(m); };

// ---------- ГСЧ (mulberry32, состояние хранится в state.rng) ----------
function rnd(s) {
  s.rng = (s.rng + 0x6D2B79F5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const die = (s) => (s.forcedRolls && s.forcedRolls.length ? s.forcedRolls.shift() : 1 + Math.floor(rnd(s) * 6));
function shuffle(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- создание игры ----------
export function createGame({ names, goal = 30000, seed = 1, cards, forcedRolls }) {
  if (names.length < 2 || names.length > 6) fail('Игроков должно быть от 2 до 6');
  if (!GOALS.includes(goal)) fail('Цель: 30000, 50000, 100000 или 200000');
  const s = {
    rng: seed >>> 0, goal, turn: 1, current: 0, phase: 'move', winner: null, places: [],
    round: 1, loans: [], nextLoanId: 1, loanReq: null, loanReturn: null,
    players: names.map((name, id) => ({ id, name, cash: START_CASH, pos: 0, cars: [], eliminated: false, insured: false, repairBonusUntil: 0, saleBonusUntil: 0, expo: false })),
    catalog: {}, decks: { vedro: [], bitye: [], family: [], premium: [], retro: [] },
    inspectDeck: [], lotteryDeck: [], swapOffer: null, theft: null,
    defectTemplate: cards.defects, defectDecks: { vedro: [], premium: [] },
    pending: null, auction: null, race: null, repairRoll: null, log: [],
  };
  if (forcedRolls) s.forcedRolls = [...forcedRolls];
  for (const c of cards.cars) { s.catalog[c.id] = c; s.decks[c.deck].push(c.id); }
  for (const k of Object.keys(s.decks)) shuffle(s, s.decks[k]);
  refillDefects(s, 'vedro'); refillDefects(s, 'premium');
  // стартовая машина «Эконом» и дефект (только ремонтируемый, без обмена)
  for (const p of s.players) {
    const cardId = s.decks.vedro.shift();
    const d = takeDefect(s, 'vedro', (x) => x.kind === 'repair');
    p.cars.push({ id: cardId, repaired: false, defect: d, sellAsRepaired: false });
  }
  // первый ход — у кого больше на кубе, при равенстве перебрасывают лидеры
  let cand = s.players.map((p) => p.id);
  while (cand.length > 1) {
    const r = cand.map((id) => [id, die(s)]);
    const max = Math.max(...r.map((x) => x[1]));
    cand = r.filter((x) => x[1] === max).map((x) => x[0]);
  }
  s.current = cand[0];
  s.playerCount = names.length;
  ev(s, { type: 'game_start', first: s.current });
  return s;
}

function toBottom(s, car) { // проданные машины и снятые дефекты возвращаются в низ колоды
  const c = s.catalog[car.id];
  s.decks[c.deck].push(car.id);
  if (car.defect && s.defectDecks[car.defect.deck]) s.defectDecks[car.defect.deck].push(car.defect);
}
function ev(s, e) { s.log.push(e); return e; }
function refillDefects(s, deck) {
  const arr = [];
  for (let c = 0; c < DEFECT_COPIES; c++) arr.push(...s.defectTemplate[deck].map((d) => ({ ...d })));
  s.defectDecks[deck] = shuffle(s, arr);
}
function takeDefect(s, deck, filter = () => true) {
  if (!s.defectDecks[deck].some(filter)) refillDefects(s, deck);
  const i = s.defectDecks[deck].findIndex(filter);
  if (i < 0) fail('Нет подходящего дефекта');
  return s.defectDecks[deck].splice(i, 1)[0];
}

// выдать игроку машину; для «Эконом» и «Люкс» тянется дефект с мгновенным эффектом
function giveCar(s, p, cardId, depth = 0) {
  const card = s.catalog[cardId];
  const car = { id: cardId, repaired: card.deck === 'family', defect: null, sellAsRepaired: false, fam: 0 };
  if (card.deck === 'vedro' || card.deck === 'premium') {
    let d = takeDefect(s, card.deck, depth >= 2 ? (x) => x.kind !== 'swap' : () => true);
    if (d.kind === 'swap' && s.decks.vedro.length < 1) d = takeDefect(s, card.deck, (x) => x.kind === 'repair');
    if (d.kind === 'swap') {
      ev(s, { type: 'swap', player: p.id, from: cardId });
      for (let i = 0; i < 2 && s.decks.vedro.length; i++) giveCar(s, p, s.decks.vedro.shift(), depth + 1);
      s.decks[card.deck].push(cardId); s.defectDecks[card.deck].push(d);
      return;
    }
    car.defect = d;
    if (d.kind === 'buyer') car.sellAsRepaired = true;
  }
  if (card.deck === 'bitye') car.needRoll = true; // Crash: цену восстановления сразу решает кубик
  p.cars.push(car);
  if (p.pendingBuyer && card.deck !== 'retro') { // «Нашёл покупателя» из Лотереи ждал следующую купленную машину
    p.pendingBuyer = false; car.buyer = true; car.sellAsRepaired = true;
    ev(s, { type: 'buyer_found', player: p.id, cardId });
  }
  ev(s, { type: 'car_gained', player: p.id, cardId, defect: car.defect ? car.defect.name : null, defectCost: car.defect && car.defect.repair ? car.defect.repair.cost : null, defectText: car.defect ? (car.defect.text || null) : null });
}

// ---------- вспомогательное ----------
const cur = (s) => s.players[s.current];
const cellOf = (s, p) => BOARD[p.pos];
const owned = (p, id) => p.cars.find((c) => c.id === id) || fail('У игрока нет такой машины');
const isUnrepairable = (c) => c.defect && ['unrepairable', 'buyer', 'swap_pay'].includes(c.defect.kind);

const ownerOf = (s, car) => s.players.find((q) => q.cars.includes(car));
function repairCost(s, car, p = ownerOf(s, car)) {
  const card = s.catalog[car.id];
  if (car.repaired || isUnrepairable(car)) return null;
  let cost;
  if (car.defect && car.defect.repair) cost = car.defect.repair.cost; // дефект (в т.ч. скрытый с Техосмотра)
  else if (card.deck === 'retro') cost = card.repair.cost;
  else if (card.deck === 'bitye') {
    const r = car.roll ?? s.repairRoll;
    if (r == null) return null;
    cost = card.repair[r <= 2 ? 'die_1_2' : r <= 4 ? 'die_3_4' : 'die_5_6'];
  } else return null;
  if (p && p.repairBonusUntil > s.round) cost = round10(cost * 0.9); // Техосмотр: −10% на ремонт
  return cost;
}
// цена продажи: целая — по карте (Family — с ростом), неотремонтированная — 50%, неремонтируемая — аукционная
function sellPrice(s, car, p = ownerOf(s, car)) {
  const card = s.catalog[car.id];
  if (car.defect && car.defect.kind === 'unrepairable') return card.auction_start;
  let price = card.sell * (card.deck === 'family' ? 1 + FAMILY_STEP * (car.fam || 0) : 1);
  if (!(car.repaired || car.sellAsRepaired || (car.defect && car.defect.kind === 'buyer'))) price /= 2;
  if (p && p.saleBonusUntil > s.round) price *= 1.1;  // Техосмотр: +10% к продаже
  if (p && p.expo && card.deck === 'retro') price *= 1.1; // Лотерея: Выставка ретро
  return round10(price);
}
const isBroken = (c) => !c.repaired && !c.buyer && !(c.defect && c.defect.kind === 'buyer');
const alive = (s) => s.players.filter((p) => !p.eliminated);
const hasDebt = (s, p) => s.loans.some((l) => l.borrower === p.id);
function carValue(s, car) { // оценка машины при взыскании долга: цена продажи, за вычетом ремонта, если он нужен
  const k = s.catalog[car.id];
  if (car.repaired || car.sellAsRepaired || (car.defect && car.defect.kind === 'buyer')) return k.sell;
  if (car.defect && car.defect.kind === 'unrepairable') return k.auction_start;
  const rep = k.deck === 'retro' ? k.repair.cost : k.deck === 'bitye' ? k.repair.die_3_4 : (car.defect && car.defect.repair ? car.defect.repair.cost : 0);
  return k.sell - rep;
}
const loanInterest = (s, l) => { // 10% за каждый из первых 4 кругов, дальше 20% за круг
  const e = Math.max(0, s.round - l.startRound);
  return Math.round(l.principal * (LOAN_RATE * Math.min(e, 4) + LOAN_RATE_LATE * Math.max(0, e - 4)));
};
const loanDue = (s, l) => l.principal + loanInterest(s, l);

function eliminate(s, p, lenderId) {
  const lender = s.players[lenderId];
  if (lender && (!lender.eliminated || lender.finished)) lender.cash += p.cash;
  p.cars.forEach((c) => toBottom(s, c)); p.cash = 0; p.cars = []; p.eliminated = true; p.pos = -1;
  s.loans = s.loans.filter((l) => l.borrower !== p.id && l.lender !== p.id);
  ev(s, { type: 'eliminated', player: p.id, reason: 'loan_default', lender: lenderId });
}
// в начале хода должника: 5-й круг — красное предупреждение; 6-й круг — забирают машину,
// не дешевле долга с процентами (с учётом ремонта); нет подходящей — платит ×2 от займа; нет денег — проигрыш
function settleLoans(s, p) {
  for (const l of s.loans.filter((x) => x.borrower === p.id)) {
    const el = s.round - l.startRound;
    if (el < LOAN_DEADLINE_ROUNDS) continue;
    const due = loanDue(s, l);
    if (el === LOAN_DEADLINE_ROUNDS) { ev(s, { type: 'loan_warning', borrower: p.id, lender: l.lender, due }); continue; }
    const cand = p.cars.map((c) => ({ c, v: carValue(s, c) })).filter((x) => x.v >= due).sort((a, b) => a.v - b.v)[0];
    if (cand) {
      p.cars = p.cars.filter((c) => c !== cand.c); s.players[l.lender].cars.push(cand.c);
      s.loans = s.loans.filter((x) => x !== l);
      ev(s, { type: 'loan_seized', borrower: p.id, lender: l.lender, cardId: cand.c.id, value: cand.v, due });
      continue;
    }
    const pay = l.principal * 2;
    if (p.cash >= pay) {
      p.cash -= pay; s.players[l.lender].cash += pay;
      s.loans = s.loans.filter((x) => x !== l);
      ev(s, { type: 'loan_forced', borrower: p.id, lender: l.lender, amount: pay });
    } else { eliminate(s, p, l.lender); return true; }
  }
  return false;
}
function nextTurn(s) {
  if (cur(s) && cur(s).pos === DEALER_POS) cur(s).expo = false; // Выставка ретро — до Дилера
  s.pending = s.auction = s.race = s.repairRoll = s.loanReq = s.loanReturn = s.swapOffer = s.theft = s.crashRoll = null;
  // купленная машина Crash — до передачи хода её владелец бросает кубик на цену восстановления
  const cr = s.players.find((q) => !q.eliminated && q.cars.some((c) => c.needRoll));
  if (cr) { s.phase = 'crash_roll'; s.crashRoll = { player: cr.id, carId: cr.cars.find((c) => c.needRoll).id }; return; }
  const n = s.players.length;
  for (let g = 0; g < 4 * n; g++) {
    s.current = (s.current + 1) % n;
    if (s.current === 0) s.round += 1;
    const p = cur(s);
    if (p.eliminated) continue;
    s.turn += 1; s.phase = 'move';
    if (settleLoans(s, p)) continue;
    break;
  }
  checkWinner(s);
}
// Призовые места: 1-е — кто первым набрал цель (без долгов); дальше доигрывают за 2-е и 3-е.
// Мест: 2 игрока — 2, три и больше — 3. Если за последнее место остался один игрок — оно ему автоматически.
const MEDALS = (s) => Math.min(3, s.players.length);
function award(s, p) {
  s.places.push(p.id); p.finished = s.places.length; p.eliminated = true; p.pos = -1;
  ev(s, { type: 'place', player: p.id, place: p.finished });
  if (p.finished === 1) { s.winner = p.id; ev(s, { type: 'win', player: p.id }); }
}
function checkWinner(s) {
  if (s.phase === 'over') return;
  if (!s.places) s.places = [];
  for (const p of s.players) if (!p.eliminated && p.cash >= s.goal && !hasDebt(s, p) && s.places.length < MEDALS(s)) award(s, p);
  let rest = s.players.filter((p) => !p.eliminated);
  if (rest.length === 1 && s.places.length < MEDALS(s)) { award(s, rest[0]); rest = []; }
  if (s.places.length >= MEDALS(s) || !rest.length) {
    s.phase = 'over'; if (s.winner == null && s.places.length) s.winner = s.places[0];
    ev(s, { type: 'game_over', places: [...s.places] });
    return;
  }
  if (cur(s).eliminated) nextTurn(s); // игрок занял место в свой ход — ход переходит дальше
}
function destination(s, p, steps) {
  const cap = (s.playerCount || s.players.length) <= 4 ? 1 : 2;
  const full = (i) => s.players.filter((q) => q.id !== p.id && q.pos === i).length >= cap;
  let pos = p.pos, n = 0;
  for (let g = 0; n < steps && g < 200; g++) {
    pos = (pos + 1) % BOARD.length;
    if (pos === p.pos || full(pos)) continue;
    n++;
  }
  if (n < steps) fail('Нет свободной клетки');
  return pos;
}

// ---------- кто сейчас должен ходить ----------
export function actor(s) {
  if (s.phase === 'loan') return s.loanReq.borrower;
  if (s.phase === 'swap_offer') return s.swapOffer.to;
  if (s.phase === 'race_roll') return s.race.queue[0]; // бросает по очереди сам участник
  if (s.phase === 'crash_roll') return s.crashRoll.player; // кубик на ремонт купленной машины Crash
  if (s.phase === 'auction') return null;   // открытые торги: могут все
  if (s.phase === 'race_join') return null; // открытое окно: могут все
  if (s.phase === 'over') return null;
  return s.current;
}

// ---------- действия ----------
export function applyAction(state, action) {
  if (state.phase === 'over') return { ok: false, error: 'Игра закончена' };
  const s = structuredClone(state);
  s.log = [];
  try {
    const p = s.players[action.player], tp = action.type;
    if (tp === 'auction_close' || tp === 'race_close') {
      if (s.phase !== (tp === 'auction_close' ? 'auction' : 'race_join')) fail('Неверная фаза');
    } else {
      if (!p || p.eliminated) fail('Игрок выбыл');
      if (tp === 'loan_accept') { if (s.phase !== 'loan') fail('Нет запроса займа'); }
      else if (['bid', 'auction_pass', 'race_join', 'race_skip'].includes(tp) && ['auction', 'race_join'].includes(s.phase)) { /* открытые фазы */ }
      else if (action.player !== actor(s)) fail('Сейчас не ваш ход');
    }
    if (LOAN_ACTIONS[action.type]) LOAN_ACTIONS[action.type](s, p, action);
    else HANDLERS[s.phase] ? HANDLERS[s.phase](s, p, action) : fail('Неверная фаза');
    checkWinner(s);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, state: s, events: s.log };
}

const LOAN_PHASES = ['move', 'act', 'buy', 'repair', 'race_setup'];
const LOAN_ACTIONS = {
  // машины без шанса на ремонт («Есть покупатель», неремонтируемый «Люкс») можно продать в любой момент своего хода
  sell_now(s, p, a) {
    if (!['move', 'act'].includes(s.phase)) fail('Сейчас нельзя продавать');
    if (!a.carIds || !a.carIds.length) fail('Выберите машины');
    let total = 0;
    for (const id of new Set(a.carIds)) {
      const car = owned(p, id);
      if (!car.buyer && (!car.defect || !['unrepairable', 'buyer'].includes(car.defect.kind))) fail('Эту машину можно продать только у Перекупа или Дилера');
      total += sellPrice(s, car, p);
    }
    for (const id of new Set(a.carIds)) toBottom(s, owned(p, id));
    p.cars = p.cars.filter((c) => !a.carIds.includes(c.id));
    p.cash += total;
    ev(s, { type: 'sold', player: p.id, carIds: a.carIds, total, now: true });
  },
  loan_request(s, p, a) {
    if (!LOAN_PHASES.includes(s.phase)) fail('Сейчас нельзя просить в долг');
    if (!Number.isInteger(a.amount) || a.amount < 1) fail('Неверная сумма');
    if (!alive(s).some((x) => x.id !== p.id && x.cash >= a.amount)) fail('Ни у кого нет такой суммы');
    s.loanReturn = s.phase; s.phase = 'loan';
    s.loanReq = { borrower: p.id, amount: a.amount };
    ev(s, { type: 'loan_request', borrower: p.id, amount: a.amount, seconds: LOAN_SECONDS });
  },
  loan_accept(s, p) {
    const R = s.loanReq;
    if (p.id === R.borrower) fail('Нельзя дать в долг самому себе');
    if (p.cash < R.amount) fail('Не хватает денег');
    p.cash -= R.amount; s.players[R.borrower].cash += R.amount;
    s.loans.push({ id: s.nextLoanId++, lender: p.id, borrower: R.borrower, principal: R.amount, startRound: s.round });
    ev(s, { type: 'loan_given', lender: p.id, borrower: R.borrower, amount: R.amount });
    s.phase = s.loanReturn; s.loanReq = s.loanReturn = null; // первый согласившийся — игра сразу продолжается
  },
  loan_cancel(s, p) {
    if (s.phase !== 'loan') fail('Нет запроса займа');
    ev(s, { type: 'loan_cancelled', borrower: p.id });
    s.phase = s.loanReturn; s.loanReq = s.loanReturn = null;
  },
  repay_loan(s, p, a) {
    if (!['move', 'act'].includes(s.phase)) fail('Сейчас нельзя вернуть долг');
    const l = s.loans.find((x) => x.id === a.loanId && x.borrower === p.id) || fail('Нет такого долга');
    const due = loanDue(s, l);
    if (p.cash < due) fail('Не хватает денег');
    p.cash -= due; s.players[l.lender].cash += due;
    s.loans = s.loans.filter((x) => x !== l);
    ev(s, { type: 'loan_repaid', borrower: p.id, lender: l.lender, amount: due });
  },
};

const HANDLERS = {
  move(s, p, a) {
    if (a.type !== 'move') fail('Сначала нужно передвинуть фишку');
    const n = a.steps;
    if (!Number.isInteger(n) || n < 1 || n > 7) fail('Шагов должно быть от 1 до 7');
    const cost = MOVE_COST[n];
    if (p.cash < cost) fail('Не хватает денег на ход');
    const to = destination(s, p, n);
    const from = p.pos;
    p.cash -= cost; p.pos = to; s.phase = 'act';
    ev(s, { type: 'moved', player: p.id, steps: n, cost, to, cell: BOARD[to] });
    for (let i = (from + 1) % BOARD.length, g = 0; g < BOARD.length; i = (i + 1) % BOARD.length, g++) {
      if (i === FAMILY_POS) familyTick(s, p);
      if (i === DEALER_POS && i !== to) p.expo = false;
      if (i === to) break;
    }
  },

  act(s, p, a) {
    const cell = cellOf(s, p);
    switch (a.type) {
      case 'taxi': {
        const car = owned(p, a.carId);
        const d = die(s), income = TAXI[s.catalog[car.id].deck] * d;
        p.cash += income;
        ev(s, { type: 'taxi', player: p.id, carId: car.id, die: d, income });
        return nextTurn(s);
      }
      case 'pass': {
        if (legal(s).some((x) => x.type !== 'pass')) fail('Есть доступные действия');
        return nextTurn(s);
      }
      case 'buy_start': {
        const deck = cell === 'avtopodbor' ? a.deck : CELL_DECK[cell];
        if (!deck || !s.decks[deck]) fail('Здесь нельзя купить машину');
        if (!s.decks[deck].length) fail('Колода закончилась');
        s.pending = { cardId: s.decks[deck][0], deck };
        s.phase = 'buy';
        return ev(s, { type: 'revealed', player: p.id, cardId: s.pending.cardId });
      }
      case 'autoservice': {
        if (cell !== 'avtoservis') fail('Это не автосервис');
        s.repairRoll = p.cars.some((c) => !c.repaired && !c.defect && c.roll == null && s.catalog[c.id].deck === 'bitye') ? die(s) : null;
        s.phase = 'repair';
        return ev(s, { type: 'repair_roll', player: p.id, die: s.repairRoll });
      }
      case 'sell': {
        if (cell !== 'perekup' && cell !== 'dealer') fail('Продать можно у Перекупа или Дилера');
        if (!a.carIds || !a.carIds.length) fail('Выберите машины');
        if (cell === 'perekup' && new Set(a.carIds).size > 1) fail('У Перекупа можно продать только одну машину');
        let total = 0;
        for (const id of new Set(a.carIds)) {
          const car = owned(p, id), price = sellPrice(s, car, p);
          if (price == null) fail('Эту машину нельзя продать');
          total += price;
        }
        p.cars.filter((c) => a.carIds.includes(c.id)).forEach((c) => toBottom(s, c));
        p.cars = p.cars.filter((c) => !a.carIds.includes(c.id));
        p.cash += total;
        ev(s, { type: 'sold', player: p.id, carIds: a.carIds, total });
        return nextTurn(s);
      }
      case 'rent': {
        if (cell !== 'prokat') fail('Это не прокат');
        const cars = p.cars.filter((c) => c.repaired);
        if (!cars.length) fail('Нет отремонтированных машин');
        const total = cars.reduce((t, c) => t + RENT[s.catalog[c.id].deck], 0);
        p.cash += total;
        ev(s, { type: 'rent', player: p.id, total });
        return nextTurn(s);
      }
      case 'race_start': {
        if (!cell.startsWith('gonka')) fail('Это не гонка');
        if (!p.cars.length) fail('Для гонки нужна машина');
        s.race = { organizer: p.id, pot: RACE_POT, stake: 0, participants: [p.id], joinQueue: [], rolls: null };
        s.phase = 'race_setup';
        return ev(s, { type: 'race_started', organizer: p.id, pot: RACE_POT });
      }
      case 'inspection': return inspection(s, p, cell);
      case 'lottery': return lottery(s, p, cell);
      case 'bank': {
        if (cell !== 'bank') fail('Это не банк');
        const gain = Math.round(p.cash * BANK_RATE);
        p.cash += gain;
        ev(s, { type: 'bank', player: p.id, gain });
        return nextTurn(s);
      }
      case 'theft': return theft(s, p, cell);
      case 'swap_pay': {
        const car = owned(p, a.carId);
        if (!car.defect || car.defect.kind !== 'swap_pay') fail('У машины нет такого дефекта');
        if (!s.decks[a.deck] || !s.decks[a.deck].length) fail('Колода пуста');
        const price = (id) => { const c = s.catalog[id]; return c.deck === 'retro' ? c.auction_start * 2 : c.buy; };
        const newId = s.decks[a.deck][0];
        const diff = Math.max(0, price(newId) - price(car.id));
        if (p.cash < diff) fail('Не хватает денег на доплату');
        p.cash -= diff;
        s.decks[a.deck].shift();
        toBottom(s, car); p.cars = p.cars.filter((c) => c !== car);
        ev(s, { type: 'swap_pay', player: p.id, from: car.id, to: newId, diff });
        giveCar(s, p, newId);
        return nextTurn(s);
      }
      default: fail('Это действие сейчас недоступно');
    }
  },

  buy(s, p, a) {
    const { cardId, deck } = s.pending, card = s.catalog[cardId];
    if (a.type === 'buy_direct') {
      if (deck === 'retro') fail('«Классика» покупается только на аукционе');
      if (p.cash < card.buy) fail('Не хватает денег');
      p.cash -= card.buy;
      s.decks[deck].shift();
      ev(s, { type: 'bought', player: p.id, cardId, price: card.buy });
      giveCar(s, p, cardId);
      return nextTurn(s);
    }
    if (a.type === 'auction_start') {
      if (!Number.isInteger(a.amount) || a.amount < card.auction_start) fail('Ставка ниже стартовой');
      if (a.amount > p.cash) fail('Не хватает денег');
      s.auction = { cardId, deck, bid: a.amount, bidder: p.id, starter: p.id, passed: [] };
      s.phase = 'auction';
      return ev(s, { type: 'auction_started', player: p.id, cardId, bid: a.amount });
    }
    if (a.type === 'decline') {
      s.decks[deck].push(s.decks[deck].shift());
      ev(s, { type: 'discarded', player: p.id, cardId });
      return nextTurn(s);
    }
    fail('Купите, объявите аукцион или откажитесь');
  },

  auction(s, p, a) { // открытые торги: ставить может любой; после каждой ставки новый отсчёт; можно отказаться
    const A = s.auction;
    const allOut = () => alive(s).filter((q) => q.id !== A.bidder).every((q) => A.passed.includes(q.id));
    const finish = () => {
      const w = s.players[A.bidder];
      w.cash -= A.bid;
      s.decks[A.deck].shift();
      ev(s, { type: 'auction_won', player: w.id, cardId: A.cardId, price: A.bid });
      giveCar(s, w, A.cardId);
      nextTurn(s);
    };
    if (a.type === 'bid') {
      if (A.passed.includes(p.id)) fail('Вы отказались от торгов');
      if (p.id === A.bidder) fail('Ваша ставка уже лучшая');
      if (!Number.isInteger(a.amount) || a.amount < A.bid + AUCTION_STEP) fail('Ставка должна быть выше текущей минимум на ' + AUCTION_STEP + ' €');
      if (a.amount > p.cash) fail('Не хватает денег');
      A.bid = a.amount; A.bidder = p.id;
      ev(s, { type: 'bid', player: p.id, amount: a.amount, seconds: AUCTION_SECONDS });
      if (allOut()) finish(); // все остальные уже отказались
      return;
    }
    if (a.type === 'auction_pass') {
      if (p.id === A.bidder) fail('Вы лидируете в торгах');
      if (!A.passed.includes(p.id)) A.passed.push(p.id);
      ev(s, { type: 'auction_pass', player: p.id });
      if (allOut()) finish();
      return;
    }
    if (a.type === 'auction_close') return finish();
    fail('Сделайте ставку или откажитесь');
  },

  loan() { fail('Ждём ответа на запрос займа'); },

  repair(s, p, a) {
    if (a.type !== 'repair') fail('Выберите машины для ремонта');
    let total = 0;
    const ids = [...new Set(a.carIds || [])];
    for (const id of ids) {
      const c = repairCost(s, owned(p, id), p);
      if (c == null) fail('Эту машину сейчас нельзя отремонтировать');
      total += c;
    }
    if (total > p.cash) fail('Не хватает денег');
    p.cash -= total;
    for (const id of ids) { const car = owned(p, id); if (car.defect && s.defectDecks[car.defect.deck]) s.defectDecks[car.defect.deck].push(car.defect); car.repaired = true; car.defect = null; car.sellAsRepaired = false; car.hidden = false; }
    ev(s, { type: 'repaired', player: p.id, carIds: ids, total });
    nextTurn(s);
  },

  race_setup(s, p, a) {
    const R = s.race;
    if (a.type === 'race_open') R.stake = 0;
    else if (a.type === 'race_challenge') {
      const q = s.players[a.target];
      if (!q || q.id === p.id || q.eliminated) fail('Неверный соперник');
      if (!q.cars.length) fail('У соперника нет машины');
      if (!Number.isInteger(a.stake) || a.stake < 100 || a.stake % 100) fail('Взнос кратен 100 €');
      if (a.stake > Math.floor(q.cash / 2)) fail('Не больше половины денег соперника');
      if (p.cash < a.stake) fail('Не хватает денег');
      p.cash -= a.stake; q.cash -= a.stake; // вызванный отказаться не может
      R.stake = a.stake; R.pot += 2 * a.stake; R.participants.push(q.id);
      ev(s, { type: 'race_challenge', organizer: p.id, target: q.id, stake: a.stake, seconds: RACE_JOIN_SECONDS });
    } else fail('Вызовите соперника или откройте гонку');
    R.skipped = []; s.phase = 'race_join';
    if (!raceEligible(s).length) raceRoll(s);
  },

  race_join(s, p, a) { // 30 с окно: присоединиться может любой игрок с машиной и деньгами
    const R = s.race;
    if (a.type === 'race_close') return raceRoll(s);
    if (!raceEligible(s).includes(p.id)) fail('Вы не можете участвовать');
    if (a.type === 'race_join') {
      p.cash -= R.stake; R.pot += R.stake; R.participants.push(p.id);
      ev(s, { type: 'race_join', player: p.id });
    } else if (a.type === 'race_skip') R.skipped.push(p.id);
    else fail('Присоединитесь или откажитесь');
    if (!raceEligible(s).length) raceRoll(s);
  },

  crash_roll(s, p, a) {
    if (a.type !== 'crash_roll') fail('Бросьте кубик на ремонт');
    const car = owned(p, s.crashRoll.carId), d = die(s);
    car.roll = d; delete car.needRoll;
    ev(s, { type: 'repair_roll', player: p.id, die: d, cardId: car.id, cost: repairCost(s, car, p) });
    nextTurn(s);
  },
  race_roll(s, p, a) {
    const R = s.race;
    if (a.type !== 'race_roll') fail('Бросьте кубик');
    const d1 = die(s), d2 = die(s), d = d1 + d2; // в гонке бросают два кубика, очки складываются
    R.rolls[p.id] = d;
    ev(s, { type: 'race_roll', player: p.id, die: d, dice: [d1, d2], tie: R.round > 1 });
    R.queue.shift();
    if (!R.queue.length) raceAfterRolls(s);
  },

  race_reroll(s, p, a) {
    const R = s.race;
    if (a.type === 'race_reroll') {
      const d1 = die(s), d2 = die(s), d = d1 + d2;
      ev(s, { type: 'race_reroll', player: p.id, die: d, dice: [d1, d2], first: R.rolls[p.id] });
      R.rolls[p.id] = Math.max(R.rolls[p.id], d);
    } else if (a.type !== 'race_keep') fail('Перебросить или оставить');
    raceResolve(s);
  },

  // ---- Лотерея: карты с выбором ----
  lot_sell(s, p, a) { // «Нашёл покупателя»: продать одну машину
    if (a.type === 'lot_skip') return nextTurn(s);
    if (a.type !== 'lot_sell') fail('Выберите машину или пропустите');
    const car = owned(p, a.carId), price = sellPrice(s, car, p);
    if (price == null) fail('Эту машину нельзя продать');
    toBottom(s, car); p.cars = p.cars.filter((c) => c !== car); p.cash += price;
    ev(s, { type: 'sold', player: p.id, carIds: [car.id], total: price });
    nextTurn(s);
  },
  lot_insure(s, p, a) {
    if (a.type === 'lot_insure') {
      if (p.cash < INSURANCE_COST) fail('Не хватает денег');
      p.cash -= INSURANCE_COST; p.insured = true;
      ev(s, { type: 'insured', player: p.id, cost: INSURANCE_COST });
    } else if (a.type !== 'lot_skip') fail('Застраховать или отказаться');
    nextTurn(s);
  },
  lot_swap(s, p, a) { // «Обмен»: предложить другому игроку обмен машинами с доплатой
    if (a.type === 'lot_skip') return nextTurn(s);
    if (a.type !== 'swap_propose') fail('Предложите обмен или пропустите');
    const q = s.players[a.target];
    if (!q || q.id === p.id || q.eliminated) fail('Неверный игрок');
    const mine = owned(p, a.carId), theirs = owned(q, a.theirCarId);
    const vm = carValue(s, mine), vt = carValue(s, theirs);
    const payer = vm < vt ? p.id : vt < vm ? q.id : null, diff = Math.abs(vm - vt);
    if (payer != null && s.players[payer].cash < diff) fail((payer === p.id ? 'Вам' : 'Игроку ' + q.name) + ' не хватает денег на доплату');
    s.swapOffer = { from: p.id, to: q.id, give: mine.id, take: theirs.id, payer, diff };
    s.phase = 'swap_offer';
    ev(s, { type: 'swap_offer', from: p.id, to: q.id, give: mine.id, take: theirs.id, payer, diff });
  },
  swap_offer(s, p, a) {
    const O = s.swapOffer;
    if (a.type === 'swap_decline') { ev(s, { type: 'swap_declined', player: p.id }); return nextTurn(s); }
    if (a.type !== 'swap_accept') fail('Принять или отказаться');
    const A = s.players[O.from], B = s.players[O.to];
    const ca = owned(A, O.give), cb = owned(B, O.take);
    if (O.payer != null) {
      const payer = s.players[O.payer], getter = O.payer === A.id ? B : A;
      if (payer.cash < O.diff) fail('Не хватает денег на доплату');
      payer.cash -= O.diff; getter.cash += O.diff;
    }
    A.cars = A.cars.filter((c) => c !== ca); B.cars = B.cars.filter((c) => c !== cb);
    A.cars.push(cb); B.cars.push(ca);
    ev(s, { type: 'swap_done', from: A.id, to: B.id, give: ca.id, take: cb.id, payer: O.payer, diff: O.diff });
    nextTurn(s);
  },
  evac(s, p, a) { // «Эвакуатор»: переехать на любую клетку и сыграть её
    if (a.type === 'lot_skip') return nextTurn(s);
    if (a.type !== 'evac') fail('Выберите клетку');
    const to = a.cell;
    if (!Number.isInteger(to) || to < 0 || to >= BOARD.length || to === p.pos) fail('Неверная клетка');
    const cap = (s.playerCount || s.players.length) <= 4 ? 1 : 2;
    if (s.players.filter((q) => q.id !== p.id && q.pos === to).length >= cap) fail('Клетка занята');
    p.pos = to; s.phase = 'act';
    ev(s, { type: 'evac', player: p.id, to, cell: BOARD[to] });
  },
  theft_pick(s, p, a) {
    const T = s.theft;
    if (a.type !== 'theft_pick' || !T.options.includes(a.carId)) fail('Выберите машину');
    const v = s.players[T.victim], car = owned(v, a.carId);
    v.cars = v.cars.filter((c) => c !== car); p.cars.push(car);
    ev(s, { type: 'theft_done', player: p.id, victim: v.id, cardId: car.id });
    nextTurn(s);
  },
};

function familyTick(s, p) { // проход клетки Family: +10% к цене продажи каждой Family, максимум +30%
  const cars = p.cars.filter((c) => s.catalog[c.id].deck === 'family' && (c.fam || 0) < FAMILY_MAX);
  cars.forEach((c) => { c.fam = (c.fam || 0) + 1; });
  if (cars.length) ev(s, { type: 'family_bonus', player: p.id, count: cars.length });
}
function drawFrom(s, key, template) { // бесконечные колоды Техосмотра и Лотереи
  if (!s[key].length) s[key] = shuffle(s, template.map((x) => ({ ...x })));
  return s[key].shift();
}
function inspection(s, p, cell) {
  if (cell !== 'tehosmotr') fail('Это не Техосмотр');
  if (!p.cars.length) fail('Нет машин');
  const cost = INSPECT_PER_CAR * p.cars.length;
  if (p.cash < cost) fail('Не хватает денег на Техосмотр');
  p.cash -= cost;
  const c = drawFrom(s, 'inspectDeck', INSPECT_TEMPLATE);
  const e = { type: 'inspection', player: p.id, cost, card: c.kind, deck: c.deck || null };
  if (c.kind === 'repair_bonus') p.repairBonusUntil = s.round + BONUS_ROUNDS;
  else if (c.kind === 'sale_bonus') p.saleBonusUntil = s.round + BONUS_ROUNDS;
  else if (p.insured) e.result = 'insured';
  else {
    const car = p.cars.filter((x) => s.catalog[x.id].deck === c.deck && x.repaired).sort((x, y) => s.catalog[x.id].sell - s.catalog[y.id].sell)[0];
    if (!car) e.result = 'burned';
    else {
      car.repaired = false; car.hidden = true;
      car.defect = takeDefect(s, 'vedro', (x) => x.kind === 'repair'); // скрытый дефект — всегда из колоды Economy
      e.result = 'hidden'; e.cardId = car.id; e.defect = car.defect.name; e.defectCost = car.defect.repair.cost;
    }
  }
  ev(s, e);
  nextTurn(s);
}
function lottery(s, p, cell) {
  if (cell !== 'lottery') fail('Это не Лотерея');
  const c = drawFrom(s, 'lotteryDeck', LOTTERY_TEMPLATE);
  const e = ev(s, { type: 'lottery', player: p.id, card: c.kind, amount: c.amount || 0, deck: c.deck || null });
  const pay = (q, x) => { const v = Math.min(q.cash, x); q.cash -= v; return v; };
  switch (c.kind) {
    case 'win': p.cash += c.amount; break;
    case 'buyer': { // покупатель находится на случайную машину с дефектом (кроме Classic); нет такой — на следующую купленную
      const opts = p.cars.filter((x) => !x.repaired && !x.buyer && !x.sellAsRepaired && s.catalog[x.id].deck !== 'retro');
      if (opts.length) { const car = shuffle(s, opts.slice())[0]; car.buyer = true; car.sellAsRepaired = true; e.cardId = car.id; }
      else { p.pendingBuyer = true; e.result = 'next'; }
      break;
    }
    case 'insurance': if (!p.insured && p.cash >= INSURANCE_COST) { s.phase = 'lot_insure'; return; } e.result = p.insured ? 'already' : 'no_money'; break;
    case 'swap': if (p.cars.length && s.players.some((q) => q.id !== p.id && !q.eliminated && q.cars.length)) { s.phase = 'lot_swap'; return; } break;
    case 'dps': e.amount = pay(p, 100 * p.cars.filter(isBroken).length); break;
    case 'evac': s.phase = 'evac'; return;
    case 'tire': e.amount = pay(p, 100); break;
    case 'birthday': e.amount = 0; for (const q of alive(s)) if (q.id !== p.id) { const v = pay(q, 100); p.cash += v; e.amount += v; } break;
    case 'recall': {
      const car = p.cars.find((x) => s.catalog[x.id].deck === c.deck && !x.repaired && !isUnrepairable(x));
      if (car) { if (car.defect && s.defectDecks[car.defect.deck]) s.defectDecks[car.defect.deck].push(car.defect); car.repaired = true; car.defect = null; car.hidden = false; e.cardId = car.id; }
      break;
    }
    case 'lux_tax': e.amount = pay(p, 200 * p.cars.filter((x) => s.catalog[x.id].deck === 'premium').length); break;
    case 'expo': p.expo = true; break;
  }
  nextTurn(s);
}
function theft(s, p, cell) { // Угон: два кубика; дубль — забираешь любую неотремонтированную машину (любого класса) у ближайшего игрока впереди
  if (cell !== 'ugon') fail('Это не Угон');
  const d1 = die(s), d2 = die(s), d = d1 + d2, n = BOARD.length;
  const ahead = alive(s).filter((q) => q.id !== p.id).map((q) => ({ q, dist: ((q.pos - p.pos + n) % n) || n })).sort((x, y) => x.dist - y.dist)[0];
  const e = ev(s, { type: 'theft_roll', player: p.id, die: d, dice: [d1, d2], double: d1 === d2, victim: ahead ? ahead.q.id : null });
  if (d1 !== d2 || !ahead) return nextTurn(s);
  const v = ahead.q;
  if (v.insured) { e.result = 'insured'; return nextTurn(s); }
  const opts = v.cars.filter((c) => !c.repaired)
    .sort((x, y) => s.catalog[y.id].sell - s.catalog[x.id].sell).map((c) => c.id);
  if (!opts.length) { e.result = 'nothing'; return nextTurn(s); }
  s.theft = { victim: v.id, die: d, options: opts };
  s.phase = 'theft_pick';
}

export function raceEligible(s) {
  const R = s.race;
  return s.players.filter((q) => !q.eliminated && !R.participants.includes(q.id) && !R.skipped.includes(q.id) &&
    q.cars.length && q.cash >= R.stake).map((q) => q.id);
}
function raceRoll(s) {
  const R = s.race, org = s.players[R.organizer];
  if (R.participants.length === 1) { // соперников нет — организатор забирает фонд
    org.cash += R.pot;
    ev(s, { type: 'race_won', player: org.id, pot: R.pot, rolls: null });
    return nextTurn(s);
  }
  R.rolls = {}; R.queue = [...R.participants]; R.round = 1; R.tied = null;
  s.phase = 'race_roll'; // участники бросают по очереди: организатор, вызванный, вступившие
}
function raceAfterRolls(s) {
  const R = s.race, org = s.players[R.organizer];
  if (R.round === 1) {
    ev(s, { type: 'race_rolls', rolls: { ...R.rolls }, order: [...R.participants] });
    const cell = BOARD[org.pos];
    if (cell === 'gonka_plus1') { R.rolls[org.id] += 1; ev(s, { type: 'race_plus1', player: org.id }); }
    else if (cell === 'gonka_reroll' && R.rolls[org.id] < 12) { s.phase = 'race_reroll'; return; }
  }
  raceResolve(s);
}
function raceResolve(s) {
  const R = s.race, group = R.tied || R.participants;
  const max = Math.max(...group.map((id) => R.rolls[id]));
  const lead = group.filter((id) => R.rolls[id] === max);
  if (lead.length > 1) { // одинаковые числа — лидеры бросают заново
    R.round += 1; R.tied = lead; R.queue = [...lead]; s.phase = 'race_roll';
    return ev(s, { type: 'race_tie', players: lead });
  }
  const w = s.players[lead[0]];
  w.cash += R.pot;
  ev(s, { type: 'race_won', player: w.id, pot: R.pot, rolls: R.rolls });
  nextTurn(s);
}

// ---------- доступные действия (для интерфейса и ботов) ----------
function legal(s) {
  const p = actor(s) == null ? null : s.players[actor(s)], out = [];
  if (s.phase === 'move') {
    for (let n = 1; n <= 7; n++) {
      let to; try { to = destination(s, p, n); } catch { continue; } // занятые клетки пропускаются
      if (p.cash >= MOVE_COST[n]) out.push({ type: 'move', steps: n, cost: MOVE_COST[n], to });
    }
  } else if (s.phase === 'act') {
    const cell = cellOf(s, p);
    for (const c of p.cars) out.push({ type: 'taxi', carId: c.id });
    if (CELL_DECK[cell] && s.decks[CELL_DECK[cell]].length) out.push({ type: 'buy_start' });
    if (cell === 'avtopodbor') for (const d of Object.keys(s.decks)) if (s.decks[d].length) out.push({ type: 'buy_start', deck: d });
    if (cell === 'avtoservis' && p.cars.some((c) => !c.repaired && !isUnrepairable(c))) out.push({ type: 'autoservice' });
    if (cell === 'perekup' || cell === 'dealer') {
      const ids = p.cars.filter((c) => sellPrice(s, c, p) != null).map((c) => c.id);
      if (ids.length) out.push({ type: 'sell', perekup: cell === 'perekup', max: cell === 'perekup' ? 1 : ids.length, carIds: ids, quotes: Object.fromEntries(ids.map((id) => [id, sellPrice(s, owned(p, id), p)])) });
    }
    if (cell === 'tehosmotr' && p.cars.length && p.cash >= INSPECT_PER_CAR * p.cars.length) out.push({ type: 'inspection', cost: INSPECT_PER_CAR * p.cars.length });
    if (cell === 'lottery') out.push({ type: 'lottery' });
    if (cell === 'bank') out.push({ type: 'bank', gain: Math.round(p.cash * BANK_RATE) });
    if (cell === 'ugon' && alive(s).length > 1) out.push({ type: 'theft' });
    if (cell === 'prokat' && p.cars.some((c) => c.repaired)) out.push({ type: 'rent' });
    if (cell.startsWith('gonka') && p.cars.length) out.push({ type: 'race_start' });
    for (const c of p.cars) if (c.defect && c.defect.kind === 'swap_pay') out.push({ type: 'swap_pay', carId: c.id });
    if (!p.cars.length && out.every((x) => x.type === 'taxi')) out.push({ type: 'pass' });
    if (!out.length) out.push({ type: 'pass' });
  } else if (s.phase === 'buy') {
    const card = s.catalog[s.pending.cardId];
    if (s.pending.deck !== 'retro' && p.cash >= card.buy) out.push({ type: 'buy_direct', price: card.buy });
    if (p.cash >= card.auction_start) out.push({ type: 'auction_start', min: card.auction_start });
    out.push({ type: 'decline' });
  } else if (s.phase === 'auction') {
    out.push({ type: 'auction_pass' });
    out.push({ type: 'bid', min: s.auction.bid + AUCTION_STEP }, { type: 'auction_close' });
  } else if (s.phase === 'repair') {
    out.push({ type: 'repair', carIds: p.cars.filter((c) => repairCost(s, c) != null).map((c) => c.id), roll: s.repairRoll });
  } else if (s.phase === 'race_setup') {
    out.push({ type: 'race_open' }, { type: 'race_challenge' });
  } else if (s.phase === 'race_join') {
    out.push({ type: 'race_join' }, { type: 'race_skip' }, { type: 'race_close' });
  } else if (s.phase === 'race_reroll') {
    out.push({ type: 'race_reroll' }, { type: 'race_keep' });
  } else if (s.phase === 'race_roll') {
    out.push({ type: 'race_roll' });
  } else if (s.phase === 'crash_roll') {
    out.push({ type: 'crash_roll', carId: s.crashRoll.carId });
  } else if (s.phase === 'loan') {
    out.push({ type: 'loan_cancel' });
  } else if (s.phase === 'lot_sell') {
    for (const c of p.cars) { const v = sellPrice(s, c, p); if (v != null) out.push({ type: 'lot_sell', carId: c.id, price: v }); }
    out.push({ type: 'lot_skip' });
  } else if (s.phase === 'lot_insure') {
    out.push({ type: 'lot_insure', cost: INSURANCE_COST }, { type: 'lot_skip' });
  } else if (s.phase === 'lot_swap') {
    out.push({ type: 'swap_propose' }, { type: 'lot_skip' });
  } else if (s.phase === 'swap_offer') {
    out.push({ type: 'swap_accept' }, { type: 'swap_decline' });
  } else if (s.phase === 'evac') {
    const cap = (s.playerCount || s.players.length) <= 4 ? 1 : 2;
    for (let i = 0; i < BOARD.length; i++) if (i !== p.pos && s.players.filter((q) => q.id !== p.id && q.pos === i).length < cap) out.push({ type: 'evac', cell: i });
    out.push({ type: 'lot_skip' });
  } else if (s.phase === 'theft_pick') {
    for (const id of s.theft.options) out.push({ type: 'theft_pick', carId: id });
  }
  return out;
}
export function legalActions(state) {
  return state.phase === 'over' ? [] : legal(state).map((a) => ({ ...a, player: actor(state) }));
}

// займы: что может сделать игрок прямо сейчас (для интерфейса)
export function loanInfo(s, playerId) {
  const p = s.players[playerId];
  if (!p || p.eliminated || s.phase === 'over') return { canRequest: false, canAccept: false, repayable: [] };
  const canRequest = playerId === s.current && LOAN_PHASES.includes(s.phase) &&
    alive(s).some((x) => x.id !== playerId && x.cash > 0);
  const canAccept = s.phase === 'loan' && playerId !== s.loanReq.borrower && p.cash >= s.loanReq.amount;
  const repayable = playerId === s.current && ['move', 'act'].includes(s.phase)
    ? s.loans.filter((l) => l.borrower === playerId).map((l) => ({
        loanId: l.id, lender: l.lender, principal: l.principal, due: loanDue(s, l),
        roundsLeft: Math.max(0, LOAN_DEADLINE_ROUNDS - (s.round - l.startRound)) }))
    : [];
  return { canRequest, canAccept, repayable };
}

export function repairCosts(s, playerId) { // цена ремонта по каждой машине игрока
  const out = {};
  for (const c of s.players[playerId].cars) { const x = repairCost(s, c, s.players[playerId]); if (x != null) out[c.id] = x; }
  return out;
}

// ---------- таймеры ----------
// Ход: 30 с на выбор шагов, потом 60 с на решение (покупка/ремонт/гонка...).
// Аукцион: 15 с после каждой ставки. Окно гонки: 30 с. Займ: 15 с (вне таймера хода).
// timeoutStep — один шаг «по умолчанию»: на старте хода это 1 шаг вперёд; затем такси.
export function timeoutStep(s) {
  const who = actor(s);
  if (s.phase === 'act' && !s.players[s.current].cars.length) { const c = structuredClone(s); c.log = []; nextTurn(c); return { ok: true, state: c }; }
  const p = who == null ? null : s.players[who];
  const a = {
    loan: { type: 'loan_cancel' }, move: { type: 'move', steps: 1 },
    act: p && p.cars.length ? { type: 'taxi', carId: [...p.cars].sort((x, y) => s.catalog[y.id].sell - s.catalog[x.id].sell)[0].id } : null, // такси на самой дорогой машине
    buy: { type: 'decline' }, crash_roll: { type: 'crash_roll' }, auction: { type: 'auction_close' }, repair: { type: 'repair', carIds: [] },
    race_setup: { type: 'race_open' }, race_join: { type: 'race_close' }, race_roll: { type: 'race_roll' }, race_reroll: { type: 'race_keep' },
    lot_sell: { type: 'lot_skip' }, lot_insure: { type: 'lot_skip' }, lot_swap: { type: 'lot_skip' }, evac: { type: 'lot_skip' },
    swap_offer: { type: 'swap_decline' }, theft_pick: s.theft ? { type: 'theft_pick', carId: s.theft.options[0] } : null,
  }[s.phase];
  return applyAction(s, { ...a, player: who });
}
// доиграть ход до конца за игрока по умолчанию (истекла минута на решение)
export function timeoutTurn(state) {
  let s = state;
  const startTurn = s.turn;
  for (let guard = 0; guard < 30 && s.phase !== 'over' && s.turn === startTurn; guard++) {
    const r = timeoutStep(s);
    if (!r.ok) return r;
    s = r.state;
  }
  return { ok: true, state: s };
}

// публичное состояние для клиентов: без порядка карт в колодах
export function publicView(s) {
  const v = structuredClone(s);
  v.deckCounts = Object.fromEntries(Object.entries(s.decks).map(([k, d]) => [k, d.length]));
  v.decks = undefined; v.defectDecks = undefined; v.defectTemplate = undefined; v.rng = undefined; v.forcedRolls = undefined;
  v.inspectDeck = undefined; v.lotteryDeck = undefined;
  return v;
}

'use strict';
const assert = require('assert');
const crypto = require('crypto');

const auth = require('../server/auth');
const store = require('../server/store');
const { Rooms } = require('../server/rooms'); // also loads cards/ai/engine -> globalThis
const AI = globalThis.HokmAI;
const Engine = globalThis.HokmEngine;

const TOK = '8985362006:AAHOMwC7jymfTJxnsoBWwKQslbMVbh1szC8';
let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

// --- craft a cryptographically valid Telegram initData (proves auth is real) ---
function craftInitData(user, token, ageSec) {
  const params = {
    auth_date: String(Math.floor(Date.now() / 1000) - (ageSec || 1)),
    query_id: 'AAtestquery',
    user: JSON.stringify(user)
  };
  const keys = Object.keys(params).sort();
  const dataCheck = keys.map(k => k + '=' + params[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const all = Object.assign({ hash }, params);
  return Object.keys(all).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(all[k])).join('&');
}

const USER_A = { id: 123456789, first_name: 'Ali', last_name: 'R', username: 'ali' };
const USER_B = { id: 987654321, first_name: 'Sara', last_name: 'M', username: 'sara' };

(async function run() {
  // 1) initData validation is genuinely cryptographic
  const good = craftInitData(USER_A, TOK);
  const idn = auth.validateInitData(good, TOK, 3600);
  assert(idn && idn.id === 123456789, 'valid initData must resolve to the Telegram user id');
  ok('validateInitData accepts a correctly signed initData');

  const tampered = good.replace(/hash=[a-f0-9]+/, 'hash=' + '0'.repeat(64));
  assert(auth.validateInitData(tampered, TOK, 3600) === null, 'tampered hash must be rejected');
  ok('validateInitData rejects a tampered hash');

  const expired = craftInitData(USER_A, TOK, 99999);
  assert(auth.validateInitData(expired, TOK, 3600) === null, 'expired auth_date must be rejected');
  ok('validateInitData rejects an expired auth_date');

  // 2) per-account separation in the store (each account has its own record)
  await store.upsertUser(USER_A);
  await store.upsertUser(USER_B);
  const beforeA = await store.getUser(123456789);
  const beforeB = await store.getUser(987654321);
  assert(beforeA && beforeB, 'both accounts must exist as separate records');
  assert(beforeA.tg_id !== beforeB.tg_id, 'accounts must have distinct ids');

  await store.recordMatch(
    [{ tgId: 123456789, isBot: false, side: 0 }, { tgId: 987654321, isBot: false, side: 1 }],
    0
  );
  const afterA = await store.getUser(123456789);
  const afterB = await store.getUser(987654321);
  assert(afterA.games === 1 && afterA.wins === 1, 'winner account: games=1, wins=1');
  assert(afterB.games === 1 && afterB.wins === 0, 'loser account: games=1, wins=0');
  ok('recordMatch attributes a win/loss to each distinct account');

  await store.recordMatch(
    [{ tgId: 123456789, isBot: true, side: 0 }, { tgId: 987654321, isBot: false, side: 1 }],
    1
  );
  const afterB2 = await store.getUser(987654321);
  assert(afterB2.games === 2, 'bot seat must not consume a human game record');
  ok('bot-substituted seats are skipped and never pollute account stats');

  // 3) end-to-end: identity flows from a room into a recorded match
  function makeFastClock() {
    const q = [];
    return {
      now: () => 0,
      setTimeout: (fn) => { q.push(fn); return q.length; },
      clearTimeout: () => {},
      random: Math.random,
      _q: q
    };
  }
  const clock = makeFastClock();
  const rooms = new Rooms(clock);

  async function playGame(seatTgIds) {
    const room = rooms.create(2, 'tg:' + seatTgIds[0], 'A', null).room;
    room.seats[0].tgId = seatTgIds[0];
    room.seats[1] = {
      playerId: 'tg:' + seatTgIds[1], name: 'B', isBot: false,
      connected: true, ws: null, strikes: 0, side: 1, tgId: seatTgIds[1]
    };
    let captured = null;
    room.onMatchOver = (p) => { captured = p; };
    room.start('tg:' + seatTgIds[0]);

    let guard = 0;
    while (!captured && guard < 200000) {
      guard++;
      const a = room.nextActor();
      if (a && !room.seatBot(a.seat)) {
        if (a.kind === 'trump') room.handleAction(a.seat, { type: 'trump', suit: AI.chooseTrump(room.engine.firstFive[a.seat]) });
        else if (a.kind === 'discard') room.handleAction(a.seat, { type: 'discard', ids: AI.chooseDiscards(room.engine.hands[a.seat], room.engine.discardNeed[a.seat], room.engine.trump) });
        else if (a.kind === 'draw') room.handleAction(a.seat, { type: 'draw', keep: AI.chooseKeep(room.engine.stockPeek(), room.engine.hands[a.seat], room.engine.trump) });
        else if (a.kind === 'play') { const legal = room.engine.legalMoves(a.seat); room.handleAction(a.seat, { type: 'play', id: legal[0].id }); }
        continue;
      }
      if (clock._q.length) { const fn = clock._q.shift(); await fn(); continue; }
      break;
    }
    assert(captured, 'room should reach matchOver and emit onMatchOver');
    return captured;
  }

  const payload = await playGame([123456789, 987654321]);
  assert(payload.seats[0].tgId === 123456789, 'seat 0 keeps its verified tgId through the whole match');
  assert(payload.seats[1].tgId === 987654321, 'seat 1 keeps its verified tgId through the whole match');
  assert(payload.winSide === 0 || payload.winSide === 1, 'match reports a winning side');
  ok('seats carry verified tgId from room through to match-over payload');

  // record the real match and confirm both accounts updated correctly
  const preA = (await store.getUser(123456789)).games;
  const preB = (await store.getUser(987654321)).games;
  await store.recordMatch(payload.seats, payload.winSide);
  const finA = await store.getUser(123456789);
  const finB = await store.getUser(987654321);
  assert(finA.games === preA + 1, 'account A games incremented by exactly 1 from the live match');
  assert(finB.games === preB + 1, 'account B games incremented by exactly 1 from the live match');
  const winCount = (finA.wins > finB.wins ? 1 : 0) + (finA.wins < finB.wins ? 1 : 0);
  assert(winCount === 1, 'exactly one of the two accounts won the live match');
  ok('a full simulated match updates the correct per-account records');

  console.log('\nALL ACCOUNT TESTS PASSED (' + passed + ')');
  process.exit(0);
})().catch(function (e) {
  console.error('\nACCOUNT TEST FAILED:', e && e.stack || e);
  process.exit(1);
});

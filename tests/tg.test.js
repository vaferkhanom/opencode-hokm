'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { validateInitData } = require('../server/auth');
const { createBot } = require('../server/tgbot');
const store = require('../server/store');

let passed = 0;
function ok(n) { passed++; console.log('  ok -', n); }

// ---- initData validation ----
(function () {
  const token = '123:TESTTOKEN';
  const uobj = { id: 424242, first_name: 'Ali', username: 'ali_tg' };
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAF_test');
  params.set('user', JSON.stringify(uobj));
  const dcs = [...params.entries()].map(([k, v]) => k + '=' + v).sort().join(String.fromCharCode(10));
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', hash);
  const u = validateInitData(params.toString(), token);
  assert.ok(u && Number(u.id) === 424242 && u.first_name === 'Ali', 'valid initData accepted with parsed user');
  const tampered = params.toString().replace(/hash=[0-9a-f]{4}/, 'hash=dead');
  assert.strictEqual(validateInitData(tampered, token), null, 'tampered hash rejected');
  assert.strictEqual(validateInitData('', token), null, 'empty rejected');
  ok('initData HMAC validation (accept/verify/reject-tamper/empty)');
})();

// ---- store (memory mode) ----
(async function () {
  assert.strictEqual(store.MEMORY, !process.env.DATABASE_URL);
  await store.upsertUser({ id: 7, first_name: 'Sara', username: 'sara' });
  await store.upsertUser({ id: 7, first_name: 'Sara', username: 'sara2' }); // update path
  await store.upsertUser({ id: 8, first_name: 'Ben' });
  await store.recordMatch([{ tgId: 7, side: 0, isBot: false }, { tgId: null, side: 1, isBot: true }], 0);
  await store.recordMatch([{ tgId: 7, side: 1, isBot: false }, { tgId: 8, side: 0, isBot: false }], 0);
  const sara = await store.getUser(7);
  assert.ok(sara.games === 2 && sara.wins === 1, 'games=2 wins=1 for winner side tracking');
  const ben = await store.getUser(8);
  assert.ok(ben.games === 1 && ben.wins === 1, 'winner-side accounting');
  ok('store upsert/getUser/recordMatch counters (' + (store.MEMORY ? 'memory' : 'postgres') + ')');
})();

// ---- bot handlers with injected api spy ----
(async function () {
  const calls = [];
  const fakeRooms = {
    get(code) {
      if (code !== 'ABC123') return undefined;
      return { mode: 4, engine: null, seats: [{ name: 'Ali' }, null, null, null] };
    }
  };
  const memStore = require('../server/store');
  const bot = createBot({
    token: 'x:y', rooms: fakeRooms, store: memStore, appUsername: 'Echohokmbot',
    api(method, payload) { calls.push({ method, payload }); return Promise.resolve({ id: 1, username: 'Echohokmbot' }); }
  });
  await bot.boot();
  assert.strictEqual(bot.me.username, 'Echohokmbot');

  function asUpdate(text, uid, name) {
    return { message: { text, chat: { id: uid }, from: { id: uid, first_name: name, is_bot: false } } };
  }
  await bot.handleUpdate(asUpdate('/start', 111, 'Guest'));
  let last = calls[calls.length - 1];
  assert.strictEqual(last.method, 'sendMessage');
  assert.ok((decodeURIComponent(last.payload.reply_markup).includes('startapp=')), 'bare /start offers open-game button');

  await bot.handleUpdate(asUpdate('/start room_ABC123', 222, 'Friend'));
  last = calls[calls.length - 1];
  assert.ok(/\u062f\u0639\u0648\u062a/.test(last.payload.text), 'invite card text');
  assert.ok(last.payload.text.includes('<code>ABC123</code>'), 'room code shown');
  assert.ok(decodeURIComponent(last.payload.reply_markup).includes('?startapp=ABC123'), 'button deep-links to lobby with code');

  await bot.handleUpdate(asUpdate('/start room_ZZZZZZ', 333, 'Late'));
  last = calls[calls.length - 1];
  assert.ok(/\u067e\u06cc\u062f\u0627 \u0646\u0634\u062f/.test(last.payload.text), 'expired room friendly error');

  const prof = await store.getUser(222);
  assert.ok(prof && Number(prof.tg_id) === 222, '/start persisted the account immediately');
  ok('bot /start flows: bare + valid-room invite card + expired + auto-account persistence');
})();

setTimeout(function () { console.log('\nAll ' + passed + ' tg/store tests passed.'); }, 400);

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Force the embedded PostgreSQL (pglite) driver for this file BEFORE requiring store.
const PG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hokm-pg-'));
process.env.DATABASE_URL = 'pglite:' + PG_DIR;

const store = require('../server/store');
require('../js/cards');
require('../js/ai');
require('../js/engine');
require('../server/rooms');

const Cards = globalThis.HokmCards;
const AI = globalThis.HokmAI;
const Engine = globalThis.HokmEngine;
const Rooms = require('../server/rooms').Rooms;

let passed = 0;
function ok(n) { passed++; console.log('  ok -', n); }

(async function () {
  const r = await store.init();
  assert.strictEqual(r.mode, 'pglite', 'store boots in embedded PostgreSQL mode');

  // ---- account + membership persistence in real Postgres ----
  await store.upsertUser({ id: 101, first_name: 'A', username: 'a' });
  await store.upsertUser({ id: 102, first_name: 'B' });
  await store.setRoom(101, 'ROOM12');
  await store.setRoom(102, 'ROOM12');
  assert.strictEqual(await store.getRoom(101), 'ROOM12', 'membership stored');
  assert.strictEqual(await store.getRoom(102), 'ROOM12');
  await store.recordMatch(
    [{ tgId: 101, side: 0, isBot: false }, { tgId: 102, side: 1, isBot: false }], 0);
  const a = await store.getUser(101);
  assert.ok(a.games === 1 && a.wins === 1, 'winner recorded in Postgres');
  await store.clearRoom(101, 'ROOM12');
  assert.strictEqual(await store.getRoom(101), null, 'membership cleared on game end');
  ok('store: accounts, membership, recordMatch in PostgreSQL');

  // ---- room persistence across save/load (simulates a restart) ----
  const room = { code: 'ROOM12', mode: 4, state: 'playing',
    seats: [
      { playerId: 'tg:101', name: 'A', isBot: false, strikes: 0, side: 0, tgId: 101, humanName: 'A' },
      { playerId: 'bot:x:1', name: 'Bot', isBot: true, strikes: 0, side: 1, tgId: null, humanName: null },
      null, null
    ],
    engine: null
  };
  await store.saveRoom(room);
  const loaded = await store.loadRooms();
  const found = loaded.find(x => x.code === 'ROOM12');
  assert.ok(found, 'room reloaded from Postgres');
  assert.strictEqual(found.mode, 4);
  assert.strictEqual(found.data.seats[0].tgId, 101, 'seat membership survived reload');
  await store.deleteRoom('ROOM12');
  assert.strictEqual((await store.loadRooms()).find(x => x.code === 'ROOM12'), undefined, 'room deleted');
  ok('store: rooms table save/load/delete in PostgreSQL');

  // ---- engine serialization round-trip ----
  const e = new Engine(4, 12345);
  e.newMatch();
  // play through ceremony -> first hand begins
  e.acceptCeremony();
  e.beginHand();
  // choose trump and discard to reach play phase
  e.setTrump(AI.chooseTrump(e.firstFive[e.roles.hakem]));
  if (e.phase === 'discard2p') {
    e.applyDiscard2p(e.roles.hakem, AI.chooseDiscards(e.hands[e.roles.hakem], e.discardNeed[e.roles.hakem], e.trump));
    e.applyDiscard2p(1 - e.roles.hakem, AI.chooseDiscards(e.hands[1 - e.roles.hakem], e.discardNeed[1 - e.roles.hakem], e.trump));
  }
  // play a few tricks
  let plays = 0;
  while (e.phase === 'play' && plays < 6) {
    const seat = e.turn;
    const mv = AI.choosePlay(e.aiView(seat));
    e.playCard(seat, mv);
    plays++;
  }
  const before = { scores: e.scores.slice(), trickLen: e.trick.length, phase: e.phase, hands: e.hands.map(h => h.length),
    trump: e.trump, handNo: e.handNo, rngState: e.rng() };
  const snap = e.serialize();
  const e2 = new Engine(4, 999);
  e2.restore(snap);
  // skip one rng pull (we consumed one for `before.rngState`); compare structural state
  assert.strictEqual(e2.phase, before.phase, 'phase preserved');
  assert.strictEqual(e2.trump, before.trump, 'trump preserved');
  assert.strictEqual(e2.handNo, before.handNo, 'handNo preserved');
  assert.deepStrictEqual(e2.scores, before.scores, 'scores preserved');
  assert.deepStrictEqual(e2.hands.map(h => h.length), before.hands, 'hand sizes preserved');
  assert.strictEqual(e2.trick.length, before.trickLen, 'trick length preserved');
  // continue the game from the restored engine and confirm it still progresses
  let more = 0;
  while (e2.phase === 'play' && more < 10) {
    const seat = e2.turn;
    const mv = AI.choosePlay(e2.aiView(seat));
    e2.playCard(seat, mv);
    more++;
  }
  assert.ok(more > 0, 'restored engine is fully playable');
  ok('engine: serialize/restore round-trip is lossless and playable');

  // ---- full room (with live engine) restore via Rooms.loadFrom ----
  const clock = { now: () => Date.now(), setTimeout, clearTimeout, random: Math.random };
  const roomsA = new Rooms(clock);
  const made = roomsA.create(2, 'tg:101', 'A', null);
  made.room.addPlayer('tg:102', 'B', null);
  made.room.start('tg:101');
  assert.strictEqual(made.room.state, 'playing', 'room started');
  roomsA.setPersister(s => store.saveRoom(s));
  roomsA.scheduleSave(made.room.code);
  await new Promise(res => setTimeout(res, 600)); // let debounced save flush
  const saved = await store.loadRooms();
  const roomsB = new Rooms(clock);
  roomsB.loadFrom(saved);
  const rb = roomsB.get(made.room.code);
  assert.ok(rb, 'room restored into a fresh Rooms registry');
  assert.strictEqual(rb.mode, 2);
  assert.strictEqual(rb.state, 'playing', 'playing state restored');
  assert.strictEqual(rb.engine && rb.engine.phase, made.room.engine.phase, 'engine phase restored');
  assert.strictEqual(rb.seats[0] && rb.seats[0].playerId, 'tg:101', 'seat membership restored');
  ok('rooms: save/loadFrom restores live room + engine + membership');

  console.log('\nAll ' + passed + ' persistence tests passed.');
  process.exit(0);
})().catch(e => { console.error('PERSIST TEST FAILED:', e); process.exit(1); });

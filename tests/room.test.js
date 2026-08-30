'use strict';
const assert = require('assert');
const { Rooms } = require('../server/rooms');
const AI = globalThis.HokmAI;

const GRACE_MS = 30000;

function makeClock() {
  const c = {
    _t: 0,
    timers: [],
    now() { return this._t; },
    setTimeout(fn, ms) { const id = { fn, due: this._t + (ms || 0) }; this.timers.push(id); return id; },
    clearTimeout(id) { this.timers = this.timers.filter(function (t) { return t !== id; }); },
    random() { return Math.random(); },
    // Execute every timer whose due-time is <= limit (in order).
    runUntil(limit) {
      let guard = 0;
      for (;;) {
        this.timers.sort(function (a, b) { return a.due - b.due; });
        const t = this.timers[0];
        if (!t || t.due > limit) break;
        this.timers.shift();
        this._t = t.due;
        t.fn();
        if (++guard > 100000) break;
      }
    },
    // Advance virtual time by ms WITHOUT racing past long timers
    // (e.g. a live human's 45s turn window). Fires only what is due.
    step(ms) {
      const target = this._t + ms;
      this.runUntil(target);
      if (this._t < target) this._t = target;
    },
    // Full fast-forward: drains every pending timer (bot-driven games).
    run() {
      let guard = 0;
      while (this.timers.length && guard++ < 100000) {
        this.timers.sort(function (a, b) { return a.due - b.due; });
        const t = this.timers.shift();
        this._t = t.due;
        t.fn();
      }
    }
  };
  return c;
}

function humanDrive(r, seat) {
  const e = r.engine;
  if (!e) return false;
  if (e.phase === 'awaitTrump' && e.roles.hakem === seat) { e.setTrump(AI.chooseTrump(e.firstFive[seat])); r.advance(); return true; }
  if (e.phase === 'discard2p' && !e.discardedFlags[seat]) { e.applyDiscard2p(seat, AI.chooseDiscards(e.hands[seat], e.discardNeed[seat], e.trump)); r.advance(); return true; }
  if (e.phase === 'draw2p' && e.drawTurn() === seat) { e.drawDecision(AI.chooseKeep(e.stockPeek(), e.hands[seat], e.trump)); r.advance(); return true; }
  if (e.phase === 'play' && e.turn === seat) { r.applyPlay(seat, AI.choosePlay(e.aiView(seat))); return true; }
  return false;
}

function fillBots(r) {
  for (let i = 0; i < r.mode; i++) {
    if (!r.seats[i] || !r.seats[i].isBot) {
      r.seats[i] = { playerId: 'bot' + i, name: 'B' + i + ' 🤖', isBot: true, connected: false, ws: null, strikes: 0, side: r.sideOf(i) };
    }
  }
}

function mkHuman(pid, name, i, r) {
  return { playerId: pid, name: name, isBot: false, connected: true, ws: null, strikes: 0, side: r.sideOf(i) };
}
function mkBot(i, r) {
  return { playerId: 'bot' + i, name: 'B' + i + ' 🤖', isBot: true, connected: false, ws: null, strikes: 0, side: r.sideOf(i) };
}

let passed = 0;
function ok(name) { passed++; console.log('  ok -', name); }

// Test 1: full 4p bot vs bot game completes
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(4, 'x', 'X', null).room;
  fillBots(r);
  r.start('x');
  clock.run();
  assert.strictEqual(r.state, 'matchOver', '4p game should reach matchOver');
  assert.ok(r.engine.scores[0] >= 7 || r.engine.scores[1] >= 7, 'a side should reach target');
  ok('4p full bot game completes to matchOver (score ' + r.engine.scores.join('-') + ')');
})();

// Test 2: full 2p bot vs bot game completes
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'x', 'X', null).room;
  fillBots(r);
  r.start('x');
  clock.run();
  assert.strictEqual(r.state, 'matchOver', '2p game should reach matchOver');
  ok('2p full bot game completes to matchOver (score ' + r.engine.scores.join('-') + ')');
})();

// Test 3: idle human seat times out -> strikes -> permanent bot replacement
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Human', null).room;
  r.seats[0] = mkHuman('p0', 'Human', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  clock.run(); // drains turn timers -> human times out repeatedly -> becomes bot
  assert.strictEqual(r.state, 'matchOver', 'timed-out human game should still complete');
  assert.strictEqual(r.seats[0].isBot, true, 'idle human should be replaced by bot');
  assert.ok(r.seats[0].strikes >= 3, 'three-strike rule should trigger replacement');
  ok('idle human auto-replaced by bot after strikes; game completes (strikes=' + r.seats[0].strikes + ')');
})();

// Test 4: interactive human plays promptly via handleAction (stepped clock, no timeouts)
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Human', null).room;
  r.seats[0] = mkHuman('p0', 'Human', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  let guard = 0;
  while (r.state !== 'matchOver' && guard++ < 20000) {
    if (humanDrive(r, 0)) continue;
    clock.step(6000); // lets bot timers (0.7s) and hand-end pauses fire,
                      // but never reaches the live human's 45s turn window
    if (r.seats[0].isBot) break; // should never happen when playing on time
  }
  assert.strictEqual(r.state, 'matchOver', 'interactive game should complete');
  assert.strictEqual(r.seats[0].isBot, false, 'human should NOT be replaced when playing');
  assert.strictEqual(r.seats[0].strikes, 0, 'no strikes when playing on time');
  ok('interactive human completes game without strikes or replacement');
})();

// Test 5: snapshot exposes the acting human's hand
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Human', null).room;
  r.seats[0] = mkHuman('p0', 'Human', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  const snap = r.buildSnapshot(0);
  assert.ok(Array.isArray(snap.hand), 'human snapshot should include hand');
  assert.strictEqual(snap.mode, 2);
  ok('snapshot includes human hand + seats');
})();

// Test 6: explicit leave mid-game -> bot takes over instantly, no grace wait,
//         and the leaver can reclaim their exact seat later
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Ali', null).room;
  r.seats[0] = mkHuman('p0', 'Ali', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  let guard = 0;
  while ((r.state === 'playing' || r.state === 'handEnd') &&
         r.engine.hands[0].length > 11 && guard++ < 500) {
    if (!humanDrive(r, 0)) clock.step(1000);
  }
  assert.ok(r.state === 'playing' || r.state === 'handEnd', 'should be mid-match, got ' + r.state);
  assert.ok(r.engine.hands[0].length > 0, 'cards still in hand');
  // Ali explicitly quits
  r.onDisconnect(0, true);
  assert.strictEqual(r.seats[0].isBot, true, 'explicit leave should hand the seat to a bot immediately');
  assert.ok(!r.reconnectTimers.has(0), 'no reconnection grace for explicit quit');
  // game keeps flowing without Ali
  guard = 0;
  while (r.state !== 'matchOver' && guard++ < 20000) clock.step(2000);
  assert.strictEqual(r.state, 'matchOver', 'game should finish with bots after departure');
  // Ali returns later: same seat, name restored, human again
  const backSeat = r.addPlayer('p0', 'Ali', null);
  assert.strictEqual(backSeat, 0, 'leaver must get their original seat back');
  assert.strictEqual(r.seats[0].isBot, false);
  assert.strictEqual(r.seats[0].name, 'Ali', 'bot suffix removed on return');
  ok('explicit leave: instant bot takeover + seat reclaim works');
})();

// Test 7: dropped connection -> 30s grace -> friend rejoins in time and
//         retakes the seat WITH their cards intact
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Sara', null).room;
  r.seats[0] = mkHuman('p0', 'Sara', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  let guard = 0;
  while (r.state === 'playing' && guard++ < 200 && r.engine.hands[0].length !== 13) {
    if (!humanDrive(r, 0)) clock.step(1000);
  }
  const handBefore = r.engine.hands[0].map(function (c) { return c.id; }).join(',');
  // Sara drops (network blip)
  r.onDisconnect(0, false);
  assert.strictEqual(r.seats[0].connected, false);
  assert.strictEqual(r.seats[0].isBot, false, 'no instant replacement during grace');
  // she comes back after 10s
  clock.step(10000);
  r.addPlayer('p0', 'Sara', null);
  clock.step(5); // flush any pending timers
  assert.strictEqual(r.seats[0].isBot, false, 'rejoin within grace must cancel replacement');
  assert.strictEqual(r.seats[0].connected, true);
  assert.strictEqual(r.engine.hands[0].map(function (c) { return c.id; }).join(','), handBefore,
    'hand must be exactly what it was before the drop');
  ok('grace-window rejoin restores seat + identical cards, timer cancelled');
})();

// Test 8: nobody rejoins -> at GRACE_MS the seat is automated automatically
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Reza', null).room;
  r.seats[0] = mkHuman('p0', 'Reza', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  let guard = 0;
  while (r.state === 'playing' && guard++ < 300) { if (!humanDrive(r, 0)) clock.step(1000); }
  r.onDisconnect(0, false);
  clock.run(); // full drain: grace fires, bot plays rest of match
  assert.strictEqual(r.state, 'matchOver', 'match completes without the absent player');
  assert.strictEqual(r.seats[0].isBot, true, 'seat automated after grace expires');
  ok('absent player replaced by bot at grace expiry; match still completes');
})();

// Test 9: two simultaneous drops are handled independently (per-seat timers)
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(4, 'h', 'Host', null).room;
  fillBots(r);
  r.seats[1] = mkHuman('pA', 'A', 1, r);
  r.seats[3] = mkHuman('pB', 'B', 3, r);
  r.creatorId = 'h';
  // This test asserts on fixed seat indices; disable the random team
  // shuffle so seat positions stay exactly as set up above.
  r.teamAssignMode = 'manual';
  r.start('h');
  let guard = 0;
  for (;;) {
    const e = r.engine;
    if ((e && e.phase === 'play' && e.turn === 1) || guard++ > 900) break;
    // keep human seats responsive so no artificial strikes accrue
    if (!(humanDrive(r, 1) || humanDrive(r, 3))) clock.step(500);
  }
  r.onDisconnect(1, false);   // A drops now
  clock.step(15000);
  r.onDisconnect(3, false);   // B drops 15s later
  clock.step(16000);          // total 31s: A's grace expired, B's has not
  assert.strictEqual(r.seats[1].isBot, true, "A's grace (30s) should have expired");
  assert.strictEqual(r.seats[3].isBot, false, "B's grace (15s old) must still be running");
  assert.ok(!r.reconnectTimers.has(1));
  assert.ok(r.reconnectTimers.has(3));
  clock.run();
  assert.strictEqual(r.state, 'matchOver');
  ok('simultaneous drops get independent grace timers');
})();

// Test 10: lobby leave frees the seat so the invite link admits someone new
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(4, 'p0', 'Ali', null).room;
  assert.strictEqual(r.addPlayer('p1', 'Sara', null), 1, 'friend joins via invite code');
  r.onDisconnect(0, false); // Ali closes the app while still in lobby
  assert.strictEqual(r.seats[0], null, 'lobby leave releases the seat');
  assert.strictEqual(r.creatorId, 'p1', 'host role transfers to a connected player');
  assert.strictEqual(r.addPlayer('pX', 'Kian', null), 0, 'new player takes the freed seat');
  ok('lobby leave frees seats; host transfers');
})();

// Test 11: countdown reaches the client (turnMsLeft on the acting seat only)
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const r = rooms.create(2, 'p0', 'Ali', null).room;
  r.seats[0] = mkHuman('p0', 'Ali', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  let guard = 0;
  for (;;) {
    const e = r.engine;
    if ((e && e.phase === 'play' && e.turn === 0) || guard++ > 800) break;
    if (!humanDrive(r, 0)) clock.step(500); // answer our own prompts promptly
  }
  const mine = r.buildSnapshot(0);
  const other = r.buildSnapshot(1);
  assert.ok(mine.yourTurn === true, 'acting seat sees its prompt');
  assert.ok(mine.turnMsLeft > 40000 && mine.turnMsLeft <= 45000, 'countdown ms present (' + mine.turnMsLeft + ')');
  assert.strictEqual(other.turnMsLeft, 0, 'other players get no countdown');
  ok('snapshot carries per-seat countdown (turnMsLeft=' + Math.round(mine.turnMsLeft / 1000) + 's)');
})();

// Test 12: room codes use the unambiguous alphabet and the right length
(function () {
  const { genCode } = require('../server/rooms');
  for (let i = 0; i < 300; i++) {
    const c = genCode(Math.random);
    assert.strictEqual(c.length, 6);
    assert.ok(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/.test(c), 'no lookalike chars (0/O/1/I): ' + c);
  }
  ok('room codes: 6 chars, unambiguous alphabet (shareable by voice)');
})();

// Test 13: empty rooms are pruned immediately; live rooms survive prune()
(function () {
  const clock = makeClock();
  const rooms = new Rooms(clock);
  const dead = rooms.create(2, 'gone', 'Gone', null).room;
  dead.onDisconnect(0, false); // lobby leave -> zero seated players
  const alive = rooms.create(2, 'p0', 'Ali', null).room;
  alive.addPlayer('p1', 'Sara', null);
  rooms.prune();
  assert.strictEqual(rooms.get(dead.code), undefined, 'empty room pruned right away');
  assert.ok(rooms.get(alive.code), 'occupied room survives');
  ok('prune drops emptied rooms, keeps occupied ones');
})();

// Test 14: server restart mid-discard and mid-draw must NOT corrupt the room
// (regression: discardedFlags/drawState used to be lost on restore, making
// advance() throw and crash-loop the process -> room stuck forever)
(function () {
  // --- mid-discard snapshot ---
  let clock = makeClock();
  let rooms = new Rooms(clock);
  let r = rooms.create(2, 'p0', 'Ali', null).room;
  r.seats[0] = mkHuman('p0', 'Ali', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  let guard = 0;
  while (guard++ < 3000) {
    const e = r.engine;
    if (e && e.phase === 'discard2p' && e.discardedFlags[0] !== e.discardedFlags[1]) break;
    if (!humanDrive(r, 0)) clock.step(200);
  }
  const snapDiscard = r.serialize();
  assert.strictEqual(snapDiscard.engine.phase, 'discard2p', 'snapshot taken mid-discard');
  assert.ok(snapDiscard.engine.discardedFlags, 'discardedFlags serialized');

  let rooms2 = new Rooms(makeClock());
  let restored = rooms2.loadFrom([snapDiscard]).get(snapDiscard.code);
  restored.advance(); // must not throw
  guard = 0;
  while (restored.state !== 'matchOver' && guard++ < 20000) {
    if (!humanDrive(restored, 0)) restored.clock.step(1000);
  }
  assert.strictEqual(restored.state, 'matchOver', 'restored mid-discard room completes');
  ok('restart mid-discard restores discardedFlags and completes');

  // --- mid-draw snapshot ---
  clock = makeClock();
  rooms = new Rooms(clock);
  r = rooms.create(2, 'p0', 'Ali', null).room;
  r.seats[0] = mkHuman('p0', 'Ali', 0, r);
  r.seats[1] = mkBot(1, r);
  r.creatorId = 'p0';
  r.start('p0');
  guard = 0;
  while (guard++ < 3000) {
    const e = r.engine;
    if (e && e.phase === 'draw2p' && e.stock && e.stock.length > 2) break;
    if (!humanDrive(r, 0)) clock.step(200);
  }
  const snapDraw = r.serialize();
  assert.strictEqual(snapDraw.engine.phase, 'draw2p', 'snapshot taken mid-draw');
  assert.ok(snapDraw.engine.drawState, 'drawState serialized');

  rooms2 = new Rooms(makeClock());
  restored = rooms2.loadFrom([snapDraw]).get(snapDraw.code);
  restored.advance(); // must not throw
  guard = 0;
  while (restored.state !== 'matchOver' && guard++ < 20000) {
    if (!humanDrive(restored, 0)) restored.clock.step(1000);
  }
  assert.strictEqual(restored.state, 'matchOver', 'restored mid-draw room completes');
  ok('restart mid-draw restores drawState and completes');
})();

console.log('\nAll ' + passed + ' room tests passed.');

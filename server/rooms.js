'use strict';

const path = require('path');

// Load the browser game modules (they attach to globalThis) so the server can
// reuse the exact same rules engine and AI that the client uses.
require(path.join(__dirname, '..', 'js', 'cards.js'));
require(path.join(__dirname, '..', 'js', 'ai.js'));
require(path.join(__dirname, '..', 'js', 'engine.js'));

const Cards = globalThis.HokmCards;
const Engine = globalThis.HokmEngine;
const AI = globalThis.HokmAI;

const TURN_MS = 45000;          // hard limit per human decision
const WARN_MS = 15000;          // warn the player 15s before the limit
const GRACE_MS = 30000;         // disconnected player is replaced after 30s
const STRIKES_MAX = 3;          // strikes -> permanent bot replacement
const HANDEND_PAUSE_MS = 4500;  // pause between hands
const BOT_DELAY_MS = 700;       // delay between automatic bot moves (feel)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const BOT_NAMES = ['آرش', 'سارا', 'کیان', 'نگار', 'بهرام', 'لیلا', 'رامین', 'شیرین'];

function randInt(rng, n) { return Math.floor(rng() * n); }

function genCode(rng) {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randInt(rng, CODE_ALPHABET.length)];
  return s;
}

class Room {
  constructor(opts) {
    this.code = opts.code;
    this.mode = opts.mode;
    this.clock = opts.clock; // { now, setTimeout, clearTimeout, random }
    this.seats = [];
    for (let i = 0; i < this.mode; i++) this.seats.push(null);
    this.creatorId = null;
    this.engine = null;
    this.state = 'lobby'; // lobby | playing | handEnd | matchOver
    this.turnTimer = null;
    this.warnTimer = null;
    this.botTimer = null;
    this.turnSeat = -1;
    this.turnKind = null;
    this.turnDeadline = 0;
    this.warned = false;
    this.reconnectTimers = new Map(); // seat -> timer (per-seat disconnect grace)
    this.lastTrick = null;
    this.lastWinner = -1;
    this.logs = [];
    this.feed = [];
    this._lastActive = opts.clock ? opts.clock.now() : Date.now();
  }

  // ----- transport helpers -----
  send(seat, msg) {
    const s = this.seats[seat];
    if (s && s.ws) { try { s.ws.send(JSON.stringify(msg)); } catch (e) {} }
  }
  broadcast(msg) {
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s && s.ws) { try { s.ws.send(JSON.stringify(msg)); } catch (e) {} }
    }
  }
  broadcastState() {
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i] && this.seats[i].ws) this.send(i, this.buildSnapshot(i));
    }
  }
  addLog(text) {
    this.logs.push(text);
    if (this.logs.length > 60) this.logs.shift();
    this.broadcast({ type: 'log', text: text });
  }
  addFeed(text) {
    this.feed.push(text);
    if (this.feed.length > 12) this.feed.shift();
  }

  touch() {
    this._lastActive = this.clock.now();
  }

  // ----- seat management -----
  seatBot(seat) {
    const s = this.seats[seat];
    return !s || s.isBot;
  }
  sideOf(seat) { return this.mode === 4 ? seat % 2 : seat; }

  cancelReconnectTimer(seat) {
    const t = this.reconnectTimers.get(seat);
    if (t) { this.clock.clearTimeout(t); this.reconnectTimers.delete(seat); }
  }

  freeLobbySeat(seat) {
    const s = this.seats[seat];
    if (!s) return;
    const wasCreator = s.playerId === this.creatorId;
    const name = s.name;
    if (wasCreator) {
      for (let i = 0; i < this.seats.length; i++) {
        if (this.seats[i] && this.seats[i].connected) { this.creatorId = this.seats[i].playerId; break; }
      }
    }
    this.addLog(name + ' لابی را ترک کرد');
    this.seats[seat] = null;
    this.broadcastState();
  }

  addPlayer(playerId, name, ws) {
    this.touch();
    // rejoin by playerId
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s && s.playerId === playerId) {
        const wasBot = s.isBot;
        s.name = s.humanName || name || s.name;
        s.ws = ws;
        s.connected = true;
        this.cancelReconnectTimer(i);
        if (wasBot) {
          s.isBot = false;
          s.strikes = 0;
          if (this.state === 'playing' || this.state === 'handEnd') {
            this.addLog(s.name + ' برگشت و صندلی‌اش را از ربات پس گرفت');
          }
        }
        this.broadcastState();
        if (this.state === 'playing') this.advance();
        return i;
      }
    }
    // new seat
    for (let i = 0; i < this.seats.length; i++) {
      if (!this.seats[i]) {
        this.seats[i] = {
          playerId: playerId,
          name: name || ('بازیکن ' + (i + 1)),
          isBot: false,
          connected: true,
          ws: ws,
          strikes: 0,
          side: this.sideOf(i)
        };
        this.broadcastState();
        this.maybeAutoStart();
        return i;
      }
    }
    return -1; // full
  }

  onDisconnect(seat, explicit) {
    const s = this.seats[seat];
    if (!s || s.isBot) return;
    if (!s.connected && !s.ws) return; // already handled (idempotent)
    s.connected = false;
    s.ws = null;

    if (this.state === 'lobby') {
      // In lobby a leaving player should not hold their seat hostage.
      this.freeLobbySeat(seat);
      return;
    }

    if (explicit) {
      // Voluntary exit: no waiting — the bot takes over immediately,
      // but the seat stays reclaimable if they come back.
      this.addLog(s.name + ' بازی را ترک کرد — ربات جای او بازی می‌کند');
      this.botReplace(seat, 'خروج');
      this.advance();
      return;
    }

    // Dropped connection: give them a grace window to come back.
    this.addLog(s.name + ' قطع شد — ' + Math.round(GRACE_MS / 1000) + ' ثانیه فرصت بازگشت دارد');
    this.cancelReconnectTimer(seat);
    this.reconnectTimers.set(seat, this.clock.setTimeout(() => {
      this.reconnectTimers.delete(seat);
      if (this.seats[seat] && !this.seats[seat].isBot && !this.seats[seat].connected) {
        this.botReplace(seat, 'قطع شدن طولانی');
        this.advance();
      }
    }, GRACE_MS));
    this.broadcastState();
  }

  botReplace(seat, reason) {
    const s = this.seats[seat];
    if (!s || s.isBot) return;
    s.isBot = true;
    if (!s.humanName) s.humanName = s.name;
    s.name = s.humanName + ' 🤖';
    this.addLog('صندلی ' + this.seatLabel(seat) + ' با ربات جایگزین شد (' + reason + ')');
  }

  seatLabel(seat) {
    const s = this.seats[seat];
    return s ? s.name : ('صندلی ' + (seat + 1));
  }

  maybeAutoStart() {
    if (this.state !== 'lobby') return;
    const allHuman = this.seats.every(function (s) { return s && !s.isBot; });
    if (allHuman) this.start(this.creatorId);
  }

  start(byPlayerId) {
    if (this.state !== 'lobby' && this.state !== 'matchOver') return;
    // fill empty seats with bots
    for (let i = 0; i < this.seats.length; i++) {
      if (!this.seats[i]) {
        this.seats[i] = {
          playerId: 'bot:' + this.code + ':' + i,
          name: BOT_NAMES[i % BOT_NAMES.length] + ' 🤖',
          isBot: true,
          connected: false,
          ws: null,
          strikes: 0,
          side: this.sideOf(i)
        };
      }
    }
    for (const t of this.reconnectTimers.values()) this.clock.clearTimeout(t);
    this.reconnectTimers.clear();
    const seed = (this.clock.random() * 0xffffffff) >>> 0;
    this.engine = new Engine(this.mode, seed);
    this.engine.newMatch();
    this.state = 'playing';
    this.lastTrick = null;
    this.touch();
    this.addLog('بازی شروع شد — ' + this.mode + ' نفره');
    this.broadcastState();
    this.advance();
  }

  // ----- action handling -----
  handleAction(seat, action) {
    const s = this.seats[seat];
    if (!s || s.isBot || !s.connected) return;
    if (this.state !== 'playing') return;
    const e = this.engine;
    if (!e) return;
    try {
      if (action.type === 'trump') {
        if (e.phase !== 'awaitTrump' || e.roles.hakem !== seat) return;
        e.setTrump(action.suit);
      } else if (action.type === 'discard') {
        if (e.phase !== 'discard2p' || e.discardedFlags[seat]) return;
        e.applyDiscard2p(seat, action.ids);
      } else if (action.type === 'draw') {
        if (e.phase !== 'draw2p' || e.drawTurn() !== seat) return;
        e.drawDecision(!!action.keep);
      } else if (action.type === 'play') {
        if (e.phase !== 'play' || e.turn !== seat) return;
        this.applyPlay(seat, action.id);
        return; // applyPlay already advances
      } else {
        return;
      }
    } catch (err) {
      this.send(seat, { type: 'error', message: String(err.message || err) });
      return;
    }
    this.advance();
  }

  applyPlay(seat, id) {
    const e = this.engine;
    const card = e.hands[seat].find(function (c) { return c.id === id; });
    e.playCard(seat, id);
    if (card) this.addFeed(this.seats[seat].name + ': ' + Cards.SUIT_SYM[card.suit] + Cards.faNum(card.rank));
    if (e.trick.length === 1) { this.lastTrick = null; }
    if (e.trick.length === 0 && e.lastTrickResult) {
      this.lastTrick = e.lastTrickResult.cards.map(function (t) { return { seat: t.seat, card: t.card }; });
      this.lastWinner = e.lastTrickResult.winner;
    }
    this.advance();
  }

  // ----- core advance loop -----
  clearTimers() {
    if (this.turnTimer) { this.clock.clearTimeout(this.turnTimer); this.turnTimer = null; }
    if (this.warnTimer) { this.clock.clearTimeout(this.warnTimer); this.warnTimer = null; }
    if (this.botTimer) { this.clock.clearTimeout(this.botTimer); this.botTimer = null; }
  }

  nextActor() {
    const e = this.engine;
    if (!e) return null;
    const ph = e.phase;
    if (ph === 'awaitTrump') return { seat: e.roles.hakem, kind: 'trump' };
    if (ph === 'discard2p') {
      for (const s of [0, 1]) if (!e.discardedFlags[s]) return { seat: s, kind: 'discard' };
      return null;
    }
    if (ph === 'draw2p') {
      const s = e.drawTurn();
      if (s >= 0) return { seat: s, kind: 'draw' };
      return null;
    }
    if (ph === 'play') return { seat: e.turn, kind: 'play' };
    return null;
  }

  scheduleBot(fn) {
    this.botTimer = this.clock.setTimeout(fn, BOT_DELAY_MS);
  }

  advance() {
    this.clearTimers();
    const e = this.engine;
    if (!e) return;
    if (this.state === 'matchOver') { this.broadcastState(); return; }

    const ph = e.phase;
    if (ph === 'ceremony') {
      e.acceptCeremony();
      e.beginHand();
      return this.advance();
    }
    if (ph === 'handEnd') {
      this.state = 'handEnd';
      this.broadcastState();
      this.clock.setTimeout(() => {
        if (this.engine.matchOver) { this.state = 'matchOver'; this.broadcastState(); return; }
        this.engine.proceedAfterHand();
        this.engine.beginHand();
        this.state = 'playing';
        this.lastTrick = null;
        this.advance();
      }, HANDEND_PAUSE_MS);
      return;
    }

    const a = this.nextActor();
    if (!a) return;
    if (this.seatBot(a.seat)) {
      const seat = a.seat;
      return this.scheduleBot(() => {
        this.forceBotAct(seat);
        this.advance();
      });
    }
    this.armTurn(a.seat, a.kind);
  }

  armTurn(seat, kind) {
    this.clearTimers();
    this.turnSeat = seat;
    this.turnKind = kind;
    this.turnDeadline = this.clock.now() + TURN_MS;
    this.warned = false;
    this.touch();
    this.broadcastState();
    this.warnTimer = this.clock.setTimeout(() => {
      this.warned = true;
      this.broadcast({ type: 'system', text: '«' + this.seatLabel(seat) + '» عجله کن! ' + Math.round(WARN_MS / 1000) + ' ثانیه وقت داری', tone: 'warn' });
      this.broadcastState();
    }, TURN_MS - WARN_MS);
    this.turnTimer = this.clock.setTimeout(() => this.onTurnTimeout(seat, kind), TURN_MS);
  }

  onTurnTimeout(seat, kind) {
    if (this.state !== 'playing' || !this.engine) return;
    const e = this.engine;
    const still = (kind === 'trump' && e.phase === 'awaitTrump' && e.roles.hakem === seat) ||
      (kind === 'discard' && e.phase === 'discard2p' && !e.discardedFlags[seat]) ||
      (kind === 'draw' && e.phase === 'draw2p' && e.drawTurn() === seat) ||
      (kind === 'play' && e.phase === 'play' && e.turn === seat);
    if (!still) { this.clearTimers(); return; }
    this.forceBotAct(seat);
    const s = this.seats[seat];
    if (s && !s.isBot) {
      s.strikes++;
      this.addLog(s.name + ' سر وقت بازی نکرد — ربات برایش بازی کرد (' + s.strikes + '/' + STRIKES_MAX + ')');
      if (s.strikes >= STRIKES_MAX) this.botReplace(seat, 'سه بار تاخیر');
    }
    this.advance();
  }

  forceBotAct(seat) {
    const e = this.engine;
    if (e.phase === 'awaitTrump' && e.roles.hakem === seat) {
      e.setTrump(AI.chooseTrump(e.firstFive[seat]));
    } else if (e.phase === 'discard2p' && !e.discardedFlags[seat]) {
      e.applyDiscard2p(seat, AI.chooseDiscards(e.hands[seat], e.discardNeed[seat], e.trump));
    } else if (e.phase === 'draw2p' && e.drawTurn() === seat) {
      const peek = e.stockPeek();
      e.drawDecision(AI.chooseKeep(peek, e.hands[seat], e.trump));
    } else if (e.phase === 'play' && e.turn === seat) {
      this.applyPlay(seat, AI.choosePlay(e.aiView(seat)));
    }
  }

  // ----- snapshot -----
  buildSnapshot(forSeat) {
    const e = this.engine;
    const self = this;
    const seatsInfo = this.seats.map(function (s, i) {
      if (!s) return { empty: true, side: self.sideOf(i), seat: i };
      return {
        name: s.name, isBot: s.isBot, connected: s.connected,
        strikes: s.strikes, side: s.side, seat: i, isYou: i === forSeat
      };
    });
    const snap = {
      type: 'state',
      code: this.code, mode: this.mode, state: this.state,
      you: forSeat,
      seats: seatsInfo,
      phase: e ? e.phase : 'lobby',
      turn: e ? e.turn : -1,
      leader: e ? e.leader : -1,
      trump: e ? e.trump : null,
      trick: e ? e.trick.map(function (t) { return { seat: t.seat, card: t.card }; }) : [],
      lastTrick: this.lastTrick,
      lastWinner: this.lastWinner,
      scores: e ? e.scores.slice() : [0, 0],
      handNo: e ? e.handNo : 0,
      target: globalThis.HOKM_TARGET_POINTS,
      yourTurn: false,
      prompt: null,
      hand: null,
      legal: [],
      feed: this.feed.slice(),
      log: this.logs.slice(-20),
      turnDeadline: this.turnSeat === forSeat ? this.turnDeadline : 0,
      turnMsLeft: (this.turnSeat === forSeat && this.turnDeadline > 0)
        ? Math.max(0, this.turnDeadline - this.clock.now()) : 0,
      warned: this.turnSeat === forSeat ? this.warned : false
    };
    if (e && forSeat != null && this.seats[forSeat] && !this.seats[forSeat].isBot) {
      snap.hand = e.hands[forSeat].slice();
    }
    if (e && this.state === 'playing') {
      const ph = e.phase;
      const you = forSeat;
      if (ph === 'awaitTrump' && e.roles.hakem === you && !this.seatBot(you)) {
        snap.prompt = 'trump'; snap.yourTurn = true; snap.trumpFive = e.firstFive[you].slice();
      } else if (ph === 'discard2p' && !e.discardedFlags[you] && !this.seatBot(you)) {
        snap.prompt = 'discard'; snap.yourTurn = true; snap.discardCount = e.discardNeed[you];
      } else if (ph === 'draw2p' && e.drawTurn() === you && !this.seatBot(you)) {
        snap.prompt = 'draw'; snap.yourTurn = true; snap.drawCard = e.stockPeek();
      } else if (ph === 'play' && e.turn === you && !this.seatBot(you)) {
        snap.prompt = 'play'; snap.yourTurn = true; snap.legal = e.legalMoves(you).map(function (c) { return c.id; });
      }
    }
    if (e && (this.state === 'handEnd' || this.state === 'matchOver')) {
      snap.handResult = e.handResult ? this.viewHandResult(forSeat) : null;
      snap.matchOver = e.matchOver;
      snap.matchWinner = e.matchWinner;
    }
    return snap;
  }

  viewHandResult(forSeat) {
    const e = this.engine;
    const hr = e.handResult;
    const side = this.seats[forSeat] ? this.seats[forSeat].side : 0;
    const won = hr.winSide === side;
    return {
      label: hr.label, won: won, pts: hr.pts, kot: hr.kot, hakemKot: hr.hakemKot,
      tricksUs: hr.tricks[side], tricksThem: hr.tricks[1 - side],
      ptsDelta: hr.pts,
      usName: this.seats[forSeat] ? this.seats[forSeat].name : 'شما',
      scoreUs: e.scores[side], scoreThem: e.scores[1 - side],
      matchOver: e.matchOver
    };
  }
}

class Rooms {
  constructor(clock) {
    this.clock = clock || { now: Date.now.bind(Date), setTimeout: setTimeout, clearTimeout: clearTimeout, random: Math.random };
    this.map = new Map();
  }
  genCode() {
    let code;
    do { code = genCode(this.clock.random); } while (this.map.has(code));
    return code;
  }
  create(mode, playerId, name, ws) {
    const code = this.genCode();
    const room = new Room({ code: code, mode: mode, clock: this.clock });
    room.creatorId = playerId;
    const seat = room.addPlayer(playerId, name, ws);
    this.map.set(code, room);
    return { room: room, seat: seat };
  }
  get(code) { return this.map.get(code); }
  prune() {
    const now = this.clock.now();
    for (const [code, room] of this.map) {
      // nobody seated at all -> the room is dead weight, drop it now
      if (!room.seats.some(function (s) { return !!s; })) { this.map.delete(code); continue; }
      const anyConnected = room.seats.some(function (s) { return s && s.connected; });
      if (!anyConnected && now - (room._lastActive || now) > 3600000) this.map.delete(code);
    }
  }
}

module.exports = { Rooms: Rooms, Room: Room, genCode: genCode };

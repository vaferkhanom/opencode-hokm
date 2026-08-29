(function (root) {
  'use strict';

  const Cards = root.HokmCards;

  const TARGET_POINTS = 7;
  const TRICKS_TO_WIN = 7;

  function Engine(mode, seed, opts) {
    this.mode = mode;
    this.n = mode;
    this.rngSeed = seed != null ? seed : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this.rng = Cards.mulberry32(this.rngSeed);
    this.handNo = 0;
    this.scores = [0, 0];
    this.roles = null;
    this.matchOver = false;
    this.matchWinner = -1;
    opts = opts || {};
    this.targetPoints = opts.targetPoints || TARGET_POINTS;
    this.tricksToWin = opts.tricksToWin || TRICKS_TO_WIN;
    this._clearHand();
  }

  Engine.prototype._clearHand = function () {
    this.hands = [];
    for (let i = 0; i < this.n; i++) this.hands.push([]);
    this.stock = [];
    this.trick = [];
    this.tricksWon = [0, 0];
    this.trump = null;
    this.leader = null;
    this.turn = null;
    this.phase = 'idle';
    this.lastTrickResult = null;
    this.discardPile = [];
    this.drawState = null;
    this.pendingRoles = null;
    this.handResult = null;
    this.ceremony = null;
    this.firstFive = null;
    this.dealOrder = null;
    this.restDeck = null;
    this.playedHistory = [];
  };

  Engine.prototype.newMatch = function () {
    this.handNo = 0;
    this.scores = [0, 0];
    this.roles = null;
    this.matchOver = false;
    this.matchWinner = -1;
    this._clearHand();
    return this.beginHand();
  };

  Engine.prototype.beginHand = function () {
    this._clearHand();
    if (!this.roles) {
      this.ceremony = this._buildCeremony();
      this.phase = 'ceremony';
      return { phase: 'ceremony', ceremony: this.ceremony };
    }
    this.handNo++;
    this._startDeal();
    return { phase: 'awaitTrump', firstFive: this.firstFive };
  };

  Engine.prototype.acceptCeremony = function () {
    if (!this.ceremony) throw new Error('no ceremony');
    this.roles = { hakem: this.ceremony.hakem, dealer: this.ceremony.dealer };
    this.ceremony = null;
  };

  Engine.prototype._buildCeremony = function () {
    const deck = Cards.shuffle(Cards.makeDeck(), this.rng);
    const reveals = [];
    let hakemSeat = -1;
    let partnerSeat = -1;
    let pos = 0;
    let step = 0;

    const needPartner = this.mode === 4;
    while (hakemSeat === -1 || (needPartner && partnerSeat === -1)) {
      if (pos >= deck.length) throw new Error('deck exhausted in ceremony');
      let seat = step % this.n;
      if (hakemSeat !== -1 && seat === hakemSeat) {
        step++;
        continue;
      }
      const card = deck[pos++];
      reveals.push({ seat: seat, card: card });
      if (card.rank === 14) {
        if (hakemSeat === -1) {
          hakemSeat = seat;
          if (!needPartner) break;
        } else {
          partnerSeat = seat;
        }
      }
      step++;
    }

    let dealer;
    if (this.mode === 4) {
      dealer = (hakemSeat + 3) % 4;
    } else {
      dealer = 1 - hakemSeat;
    }
    return { reveals: reveals, hakem: hakemSeat, partner: partnerSeat, dealer: dealer };
  };

  Engine.prototype._startDeal = function () {
    const deck = Cards.shuffle(Cards.makeDeck(), this.rng);
    const order = [];
    for (let k = 0; k < this.n; k++) order.push((this.roles.hakem + k) % this.n);
    this.dealOrder = order;
    let p = 0;
    this.firstFive = {};
    for (const s of order) {
      this.firstFive[s] = deck.slice(p, p + 5);
      p += 5;
    }
    this.restDeck = deck.slice(p);
    for (const s of order) this.hands[s] = this.firstFive[s].slice();
    this.phase = 'awaitTrump';
  };

  Engine.prototype.setTrump = function (suit) {
    if (this.phase !== 'awaitTrump') throw new Error('bad phase: ' + this.phase);
    if (Cards.SUITS.indexOf(suit) === -1) throw new Error('bad suit');
    this.trump = suit;
    if (this.mode === 4) {
      this._completeDeal4();
    } else {
      this.discardNeed = {};
      this.discardNeed[this.roles.hakem] = 3;
      this.discardNeed[1 - this.roles.hakem] = 2;
      this.discardedFlags = { 0: false, 1: false };
      this.phase = 'discard2p';
    }
  };

  Engine.prototype._completeDeal4 = function () {
    let p = 0;
    for (let round = 0; round < 2; round++) {
      for (const s of this.dealOrder) {
        const chunk = this.restDeck.slice(p, p + 4);
        p += 4;
        for (const c of chunk) this.hands[s].push(c);
      }
    }
    this.phase = 'play';
    this.leader = this.roles.hakem;
    this.turn = this.leader;
  };

  Engine.prototype.applyDiscard2p = function (seat, ids) {
    if (this.phase !== 'discard2p') throw new Error('bad phase');
    if (ids.length !== this.discardNeed[seat]) throw new Error('wrong discard count');
    const hand = this.hands[seat];
    for (const id of ids) {
      const idx = hand.findIndex(function (c) { return c.id === id; });
      if (idx === -1) throw new Error('card not in hand: ' + id);
    }
    for (const id of ids) {
      const idx = hand.findIndex(function (c) { return c.id === id; });
      this.discardPile.push(hand.splice(idx, 1)[0]);
    }
    this.discardedFlags[seat] = true;
    if (this.discardedFlags[0] && this.discardedFlags[1]) {
      this._startDrawPhase2();
    }
  };

  Engine.prototype._startDrawPhase2 = function () {
    this.stock = this.restDeck.slice();
    this.drawState = { turn: this.roles.hakem };
    this.drawState.left = {};
    this.drawState.left[this.roles.hakem] = 13 - this.hands[this.roles.hakem].length;
    this.drawState.left[1 - this.roles.hakem] = 13 - this.hands[1 - this.roles.hakem].length;
    this.phase = 'draw2p';
  };

  Engine.prototype.drawTurn = function () {
    return this.phase === 'draw2p' ? this.drawState.turn : -1;
  };

  Engine.prototype.drawsLeft = function (seat) {
    return this.phase === 'draw2p' ? this.drawState.left[seat] : 0;
  };

  Engine.prototype.stockPeek = function () {
    return this.stock.length ? this.stock[0] : null;
  };

  Engine.prototype.drawDecision = function (keep) {
    if (this.phase !== 'draw2p') throw new Error('bad phase');
    const drawer = this.drawState.turn;
    if (this.stock.length < 2) throw new Error('stock too small');
    const c1 = this.stock.shift();
    let result;
    if (keep) {
      this.hands[drawer].push(c1);
      const c2 = this.stock.shift();
      this.discardPile.push(c2);
      result = { drawer: drawer, taken: c1, burned: c2 };
    } else {
      this.discardPile.push(c1);
      const c2 = this.stock.shift();
      this.hands[drawer].push(c2);
      result = { drawer: drawer, rejected: c1, taken: c2 };
    }
    this.drawState.left[drawer]--;
    if (this.drawState.left[drawer] > 0) {
      this.drawState.turn = drawer;
    } else {
      const other = 1 - drawer;
      this.drawState.turn = this.drawState.left[other] > 0 ? other : -1;
    }
    if (this.drawState.turn === -1) {
      this.phase = 'play';
      this.leader = this.roles.hakem;
      this.turn = this.leader;
    }
    return result;
  };

  Engine.prototype.sideOf = function (seat) {
    return this.mode === 4 ? seat % 2 : seat;
  };

  Engine.prototype.partnerOf = function (seat) {
    return this.mode === 4 ? (seat + 2) % 4 : -1;
  };

  Engine.prototype.legalMoves = function (seat) {
    const hand = this.hands[seat];
    if (!this.trick.length) return hand.slice();
    const led = this.trick[0].card.suit;
    const follow = hand.filter(function (c) { return c.suit === led; });
    return follow.length ? follow : hand.slice();
  };

  Engine.prototype.canPlayCard = function (seat, id) {
    if (this.phase !== 'play' || this.turn !== seat) return false;
    return this.legalMoves(seat).some(function (c) { return c.id === id; });
  };

  Engine.prototype.playCard = function (seat, id) {
    if (this.phase !== 'play') throw new Error('not in play phase');
    if (seat !== this.turn) throw new Error('not your turn');
    const legal = this.legalMoves(seat);
    const idx = this.hands[seat].findIndex(function (c) { return c.id === id; });
    if (idx === -1 || !legal.some(function (c) { return c.id === id; })) {
      throw new Error('illegal move: ' + id);
    }
    const card = this.hands[seat].splice(idx, 1)[0];
    this.trick.push({ seat: seat, card: card });
    this.playedHistory.push({ seat: seat, card: card });

    this.lastTrickResult = null;
    if (this.trick.length === this.n) {
      const winner = this._trickWinnerSeat();
      const side = this.sideOf(winner);
      this.tricksWon[side]++;
      this.lastTrickResult = {
        winner: winner,
        side: side,
        winningCard: this.trick.filter(function (t) { return t.seat === winner; })[0].card,
        cards: this.trick.slice()
      };
      this.trick = [];
      this.leader = winner;
      this.turn = winner;
      if (this.tricksWon[side] >= this.tricksToWin) {
        this._finishHand(side);
      }
    } else {
      this.turn = (seat + 1) % this.n;
    }
    return this.lastTrickResult;
  };

  Engine.prototype._trickWinnerSeat = function () {
    const trump = this.trump;
    let best = this.trick[0];
    for (let i = 1; i < this.trick.length; i++) {
      const t = this.trick[i];
      const b = best.card;
      const c = t.card;
      if (c.suit === b.suit) {
        if (c.rank > b.rank) best = t;
      } else if (c.suit === trump && b.suit !== trump) {
        best = t;
      }
    }
    return best.seat;
  };

  Engine.prototype.currentBestEntry = function () {
    if (!this.trick.length) return null;
    const trump = this.trump;
    let best = this.trick[0];
    for (let i = 1; i < this.trick.length; i++) {
      const t = this.trick[i];
      const b = best.card;
      const c = t.card;
      if (c.suit === b.suit) {
        if (c.rank > b.rank) best = t;
      } else if (c.suit === trump && b.suit !== trump) {
        best = t;
      }
    }
    return best;
  };

  Engine.prototype._finishHand = function (winSide) {
    this.phase = 'handEnd';
    const loseSide = 1 - winSide;
    const hakemSide = this.sideOf(this.roles.hakem);
    const kot = this.tricksWon[loseSide] === 0;
    const hakemKot = kot && loseSide === hakemSide;
    let pts;
    let label;
    if (hakemKot) {
      pts = 3;
      label = 'hakemKot';
    } else if (kot) {
      pts = 2;
      label = 'kot';
    } else {
      pts = 1;
      label = 'win';
    }
    this.scores[winSide] += pts;
    this.handResult = {
      winSide: winSide,
      loseSide: loseSide,
      tricks: this.tricksWon.slice(),
      pts: pts,
      label: label,
      kot: kot,
      hakemKot: hakemKot
    };
    if (this.scores[winSide] >= this.targetPoints) {
      this.matchOver = true;
      this.matchWinner = winSide;
    }
    if (winSide === hakemSide) {
      this.pendingRoles = { hakem: this.roles.hakem, dealer: this.roles.dealer };
    } else if (this.mode === 4) {
      this.pendingRoles = { hakem: (this.roles.hakem + 1) % 4, dealer: this.roles.hakem };
    } else {
      this.pendingRoles = { hakem: 1 - this.roles.hakem, dealer: this.roles.hakem };
    }
  };

  Engine.prototype.proceedAfterHand = function () {
    if (this.matchOver) return false;
    this.roles = this.pendingRoles;
    this.pendingRoles = null;
    return true;
  };

  Engine.prototype.aiView = function (seat) {
    const playedBySuit = { S: 0, H: 0, D: 0, C: 0 };
    const playedRanks = { S: [], H: [], D: [], C: [] };
    for (const p of this.playedHistory) {
      playedBySuit[p.card.suit]++;
      playedRanks[p.card.suit].push(p.card.rank);
    }
    const remainingBySuit = {};
    for (const s of Cards.SUITS) remainingBySuit[s] = 13 - playedBySuit[s];
    return {
      mode: this.mode,
      playerCount: this.n,
      seat: seat,
      trump: this.trump,
      hand: this.hands[seat].slice(),
      legal: this.legalMoves(seat),
      trick: this.trick.map(function (t) { return { seat: t.seat, card: t.card }; }),
      leader: this.leader,
      turn: this.turn,
      playedBySuit: playedBySuit,
      playedRanks: playedRanks,
      remainingBySuit: remainingBySuit,
      tricksWon: this.tricksWon.slice(),
      tricksTotal: this.tricksWon[0] + this.tricksWon[1],
      partner: this.partnerOf(seat),
      hakem: this.roles ? this.roles.hakem : -1
    };
  };

  Engine.prototype.serialize = function () {
    return {
      mode: this.mode, n: this.n, rngSeed: this.rngSeed, handNo: this.handNo,
      scores: this.scores.slice(), roles: this.roles, matchOver: this.matchOver, matchWinner: this.matchWinner,
      hands: this.hands, stock: this.stock, trick: this.trick, tricksWon: this.tricksWon.slice(),
      trump: this.trump, leader: this.leader, turn: this.turn, phase: this.phase,
      lastTrickResult: this.lastTrickResult, discardPile: this.discardPile, drawState: this.drawState,
      pendingRoles: this.pendingRoles, handResult: this.handResult, ceremony: this.ceremony,
      firstFive: this.firstFive, dealOrder: this.dealOrder, restDeck: this.restDeck,
      discardNeed: this.discardNeed, playedHistory: this.playedHistory,
      targetPoints: this.targetPoints, tricksToWin: this.tricksToWin
    };
  };

  Engine.prototype.restore = function (d) {
    this.mode = d.mode; this.n = d.n;
    this.rngSeed = d.rngSeed != null ? d.rngSeed : 1;
    this.rng = Cards.mulberry32(this.rngSeed);
    this.handNo = d.handNo || 0;
    this.scores = (d.scores || [0, 0]).slice();
    this.roles = d.roles || null;
    this.matchOver = !!d.matchOver;
    this.matchWinner = d.matchWinner != null ? d.matchWinner : -1;
    this.targetPoints = d.targetPoints || TARGET_POINTS;
    this.tricksToWin = d.tricksToWin || TRICKS_TO_WIN;
    this.hands = d.hands || [];
    this.stock = d.stock || [];
    this.trick = d.trick || [];
    this.tricksWon = (d.tricksWon || [0, 0]).slice();
    this.trump = d.trump != null ? d.trump : null;
    this.leader = d.leader != null ? d.leader : null;
    this.turn = d.turn != null ? d.turn : null;
    this.phase = d.phase || 'idle';
    this.lastTrickResult = d.lastTrickResult || null;
    this.discardPile = d.discardPile || [];
    this.drawState = d.drawState || null;
    this.pendingRoles = d.pendingRoles || null;
    this.handResult = d.handResult || null;
    this.ceremony = d.ceremony || null;
    this.firstFive = d.firstFive || null;
    this.dealOrder = d.dealOrder || null;
    this.restDeck = d.restDeck || null;
    this.discardNeed = d.discardNeed || null;
    this.playedHistory = d.playedHistory || [];
    return this;
  };

  root.HokmEngine = Engine;
  root.HOKM_TARGET_POINTS = TARGET_POINTS;
  root.HOKM_TRICKS_TO_WIN = TRICKS_TO_WIN;
})(typeof window !== 'undefined' ? window : globalThis);

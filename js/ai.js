(function (root) {
  'use strict';

  const Cards = root.HokmCards;
  const SUITS = Cards.SUITS;

  function pickBest(cands) {
    let best = null;
    let bs = -Infinity;
    for (const c of cands) {
      if (c.score > bs) {
        bs = c.score;
        best = c;
      }
    }
    return best;
  }

  function cardPower(c, trump) {
    if (c.suit === trump) return 100 + c.rank;
    return c.rank;
  }

  function beats(card, bestCard, trump) {
    if (card.suit === bestCard.suit) return card.rank > bestCard.rank;
    return card.suit === trump && bestCard.suit !== trump;
  }

  function lowest(arr) {
    let m = arr[0];
    for (const c of arr) if (c.rank < m.rank || (c.rank === m.rank && c.suit < m.suit)) m = c;
    return m;
  }

  function lowestWinning(arr, bestCard, trump) {
    let m = null;
    for (const c of arr) {
      if (beats(c, bestCard, trump) && (!m || c.rank < m.rank)) m = c;
    }
    return m;
  }

  function isBoss(view, card) {
    const suit = card.suit;
    const seen = new Set(view.playedRanks[suit]);
    for (const x of view.hand) {
      if (x.suit === suit && x.id !== card.id) seen.add(x.rank);
    }
    const mineInSuit = view.hand.filter(function (x) { return x.suit === suit; }).length;
    const playedCount = view.playedBySuit[suit];
    const unknown = 13 - playedCount - mineInSuit;
    if (unknown <= 0) return true;
    for (let r = card.rank + 1; r <= 14; r++) {
      if (!seen.has(r)) return false;
    }
    return true;
  }

  const AI = {
    setRng: function (rng) { this._rng = rng || Math.random; },

    chooseTrump: function (cards5) {
      const self = this;
      const cands = [];
      for (const s of SUITS) {
        const mine = cards5.filter(function (c) { return c.suit === s; });
        let sc = 0;
        for (const c of mine) {
          if (c.rank === 14) sc += 5;
          else if (c.rank === 13) sc += 4;
          else if (c.rank === 12) sc += 3;
          else if (c.rank === 11) sc += 2;
          else if (c.rank === 10) sc += 1.5;
          else sc += 0.7;
        }
        if (mine.length >= 5) sc += 2.2;
        else if (mine.length >= 4) sc += 1.1;
        sc += self._rnd() * 0.3;
        cands.push({ suit: s, score: sc });
      }
      return pickBest(cands).suit;
    },

    _rnd: function () { return this._rng ? this._rng() : Math.random(); },

    choosePlay: function (view) {
      const legal = view.legal;
      if (legal.length === 1) return legal[0].id;
      const trump = view.trump;
      const led = view.trick.length ? view.trick[0].card.suit : null;
      const self = this;

      if (!view.trick.length) {
        const suitLen = {};
        for (const c of legal) suitLen[c.suit] = (suitLen[c.suit] || 0) + 1;
        const late = view.tricksTotal >= 5;
        const cands = [];
        for (const c of legal) {
          let sc = 0;
          const boss = isBoss(view, c);
          const isTrump = c.suit === trump;
          if (boss && !isTrump) sc += 11 + (suitLen[c.suit] || 1) * 0.4;
          else if (boss && isTrump) sc += late ? 9 : 4;
          else {
            sc -= c.rank * 0.38;
            sc -= (suitLen[c.suit] || 1) * 0.15;
            if (isTrump) sc -= 6;
            else sc += (7 - (suitLen[c.suit] || 1)) * 0.25;
          }
          sc += self._rnd() * 0.7;
          cands.push({ id: c.id, score: sc });
        }
        return pickBest(cands).id;
      }

      const curBest = view.trick.reduce(function (b, t) {
        if (beats(t.card, b.card, trump)) return t;
        return b;
      }, view.trick[0]);
      const winningSeat = curBest.seat;
      const partnerWinning = view.partner >= 0 && winningSeat === view.partner;
      const isLast = view.trick.length === view.playerCount - 1;
      const following = legal.every(function (c) { return c.suit === led; });

      const winners = legal.filter(function (c) { return beats(c, curBest.card, trump); });

      if (following) {
        if (partnerWinning && (isLast || isBoss(view, curBest.card))) {
          return lowest(legal).id;
        }
        if (winners.length) {
          if (isLast) return lowest(winners).id;
          const bossWinner = winners.find(function (c) { return isBoss(view, c); });
          if (bossWinner) return bossWinner.id;
          const cheap = lowestWinning(winners, curBest.card, trump);
          if (cheap) return cheap.id;
          return lowest(winners).id;
        }
        return lowest(legal).id;
      }

      const nonTrump = legal.filter(function (c) { return c.suit !== trump; });
      if (partnerWinning) {
        return (nonTrump.length ? lowest(nonTrump) : lowest(legal)).id;
      }
      const trumpsWinning = winners.filter(function (c) { return c.suit === trump; });
      if (trumpsWinning.length) {
        const trickWorth = curBest.card.rank >= 12 || curBest.card.suit === trump || view.tricksTotal >= 5;
        const myTrumps = view.hand.filter(function (c) { return c.suit === trump; }).length;
        if (trickWorth || myTrumps >= 4 || view.tricksTotal >= 6) {
          return lowest(trumpsWinning).id;
        }
      }
      if (nonTrump.length) return lowest(nonTrump).id;
      return lowest(legal).id;
    },

    discardValue: function (card, hand, trump) {
      let v;
      if (card.rank === 14) v = 40;
      else if (card.rank === 13) v = 35;
      else if (card.rank === 12) v = 30;
      else if (card.rank === 11) v = 25;
      else if (card.rank === 10) v = 20;
      else v = 5 + card.rank * 0.5;
      if (trump && card.suit === trump) v += 45;
      const len = hand.filter(function (h) { return h.suit === card.suit; }).length;
      v += Math.min(len, 5) * 0.8;
      return v;
    },

    chooseDiscards: function (hand, count, trump) {
      const scored = hand.map(function (c) {
        return { c: c, v: this.discardValue(c, hand, trump) };
      }, this);
      scored.sort(function (a, b) { return a.v - b.v; });
      return scored.slice(0, count).map(function (s) { return s.c.id; });
    },

    drawValue: function (card, hand, trump) {
      let v;
      if (card.rank <= 10) v = (card.rank - 6) * 0.18;
      else if (card.rank === 11) v = 1.4;
      else if (card.rank === 12) v = 2.0;
      else if (card.rank === 13) v = 3.0;
      else v = 4.0;
      if (trump && card.suit === trump) v += 4.5;
      const len = hand.filter(function (h) { return h.suit === card.suit; }).length;
      v += len * 0.28;
      return v;
    },

    chooseKeep: function (drawnCard, hand, trump) {
      const v = this.drawValue(drawnCard, hand, trump);
      if (v >= 5.5) return true;
      let sum = 0;
      for (const h of hand) sum += this.drawValue(h, hand, trump);
      const avg = sum / Math.max(1, hand.length);
      const threshold = Math.max(2.2, avg * 0.85);
      return v >= threshold;
    }
  };

  root.HokmAI = AI;
})(typeof window !== 'undefined' ? window : globalThis);

(function (root) {
  'use strict';

  const SUITS = ['S', 'H', 'D', 'C'];
  const SUIT_SYM = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
  const SUIT_FA = { S: 'پیک', H: 'دل', D: 'خشت', C: 'گشنیز' };
  const RED = { H: true, D: true };
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  const RANK_LABEL = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' };

  function faNum(n) {
    return String(n).replace(/\d/g, function (d) { return FA_DIGITS[+d]; });
  }

  function rankLabel(r) {
    return RANK_LABEL[r] || faNum(r);
  }

  function makeDeck() {
    const deck = [];
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ suit: s, rank: r, id: s + r });
      }
    }
    return deck;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function sortHand(hand, trumpSuit) {
    const order = trumpSuit
      ? [trumpSuit].concat(SUITS.filter(function (s) { return s !== trumpSuit; }))
      : SUITS.slice();
    return hand.slice().sort(function (a, b) {
      const sa = order.indexOf(a.suit);
      const sb = order.indexOf(b.suit);
      if (sa !== sb) return sa - sb;
      return b.rank - a.rank;
    });
  }

  root.HokmCards = {
    SUITS: SUITS,
    SUIT_SYM: SUIT_SYM,
    SUIT_FA: SUIT_FA,
    RED: RED,
    RANKS: RANKS,
    faNum: faNum,
    rankLabel: rankLabel,
    makeDeck: makeDeck,
    mulberry32: mulberry32,
    shuffle: shuffle,
    sortHand: sortHand
  };
})(typeof window !== 'undefined' ? window : globalThis);

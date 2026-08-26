'use strict';

require('../js/cards.js');
require('../js/engine.js');
require('../js/ai.js');

const C = globalThis.HokmCards;
const E = globalThis.HokmEngine;
const AI = globalThis.HokmAI;

let passed = 0;
let failed = 0;

function eq(actual, expected, msg) {
  if (actual !== expected) {
    failed++;
    console.error('FAIL:', msg, '| expected', expected, 'got', actual);
  } else {
    passed++;
  }
}

function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('FAIL:', msg);
  }
}

function card(suit, rank) {
  return { suit: suit, rank: rank, id: suit + rank };
}

function ids(arr) {
  return arr.map(function (c) { return c.id; }).sort().join(',');
}

function sameSet(a, b, msg) {
  eq(ids(a), ids(b), msg);
}

function aiOnlyHand(engine) {
  let guard = 0;
  while (engine.phase === 'play') {
    const seat = engine.turn;
    const view = engine.aiView(seat);
    const move = AI.choosePlay(view);
    engine.playCard(seat, move);
    if (++guard > 500) throw new Error('play loop stuck');
  }
}

function playFullMatch(mode, seed) {
  const eng = new E(mode, seed);
  AI.setRng(C.mulberry32(seed * 7919 + 13));
  eng.newMatch();
  eng.acceptCeremony();
  let hands = 0;
  while (!eng.matchOver) {
    if (hands++ > 200) throw new Error('match too long');
    const res = eng.beginHand();
    ok(res.phase === 'awaitTrump', mode + 'p hand starts in awaitTrump');
    eng.setTrump(AI.chooseTrump(eng.firstFive[eng.roles.hakem]));
    if (mode === 2) {
      for (const seat of [0, 1]) {
        const need = seat === eng.roles.hakem ? 3 : 2;
        eng.applyDiscard2p(seat, AI.chooseDiscards(eng.hands[seat], need, eng.trump));
      }
      while (engineInDraw(eng)) {
        const peek = eng.stockPeek();
        const keep = AI.chooseKeep(peek, eng.hands[eng.drawTurn()], eng.trump);
        eng.drawDecision(keep);
      }
    }
    aiOnlyHand(eng);
    if (!eng.matchOver) ok(eng.proceedAfterHand(), 'proceed allowed');
  }
  return eng;
}

function engineInDraw(eng) {
  return eng.phase === 'draw2p';
}

console.log('--- deck & utils ---');
const deck = C.makeDeck();
eq(deck.length, 52, 'deck has 52 cards');
eq(new Set(deck.map(function (c) { return c.id; })).size, 52, 'deck ids unique');
const rngA = C.mulberry32(42);
const rngB = C.mulberry32(42);
const sh1 = C.shuffle(deck, rngA);
const sh2 = C.shuffle(deck, rngB);
sameSet(sh1, deck, 'shuffle preserves multiset');
eq(ids(sh1), ids(sh2), 'seeded shuffle deterministic');
const sorted = C.sortHand([card('H', 5), card('S', 14), card('D', 9), card('H', 14)], 'H');
eq(sorted.map(function (c) { return c.id; }).join(','), 'H14,H5,S14,D9', 'sortHand trumps first then desc rank');
eq(C.faNum(1370), '۱۳۷۰', 'faNum converts digits');

console.log('--- ceremony (4p) ---');
{
  const eng = new E(4, 1234);
  const res = eng.newMatch();
  eq(res.phase, 'ceremony', 'first call returns ceremony');
  const cer = eng.ceremony;
  ok(cer.reveals.length >= 2, 'ceremony has reveals');
  const firstAce = cer.reveals.find(function (r) { return r.card.rank === 14; });
  eq(firstAce.seat, cer.hakem, 'first ace seat is hakem');
  const hakemRevealIdx = cer.reveals.findIndex(function (r) { return r.card.rank === 14; });
  const secondAce = cer.reveals.slice(hakemRevealIdx + 1).find(function (r) { return r.card.rank === 14 && r.seat !== cer.hakem; });
  eq(secondAce ? secondAce.seat : -1, cer.partner, 'second ace on other seat is partner');
  eq((cer.hakem + 2) % 4, cer.partner % 4 || (cer.partner === 2 ? 0 : -1) === 0 ? (cer.partner) : cer.partner, 'partner opposite hakem');
  ok(cer.reveals.every(function (r, i) {
    return i === 0 || r.seat !== undefined;
  }), 'reveals well formed');
  eq(cer.dealer, (cer.hakem + 3) % 4, 'dealer sits at hakem left (+3 anticlockwise)');
  const partnerCount = cer.reveals.filter(function (r) { return r.seat === cer.hakem; }).length;
  eq(partnerCount, 1, 'hakem receives no further reveal cards');
  eng.acceptCeremony();
  eq(eng.roles.hakem, cer.hakem, 'acceptCeremony sets hakem');
  eq(eng.roles.dealer, cer.dealer, 'acceptCeremony sets dealer');
}
console.log('--- ceremony (2p) ---');
{
  const eng = new E(2, 777);
  const res = eng.newMatch();
  const cer = eng.ceremony;
  const firstAceIdx = cer.reveals.findIndex(function (r) { return r.card.rank === 14; });
  eq(firstAceIdx >= 0, true, '2p ceremony contains an ace');
  eq(cer.reveals[firstAceIdx].seat, cer.hakem, '2p first ace is hakem');
  eq(firstAceIdx, cer.reveals.length - 1, '2p ceremony stops right after first ace');
  eq(cer.dealer, 1 - cer.hakem, '2p dealer is the other player');
  eng.acceptCeremony();
}

console.log('--- trick resolution examples from spec ---');
{
  const eng = new E(4, 1);
  eng.roles = { hakem: 0, dealer: 3 };
  eng.phase = 'play';
  eng.trump = 'S';
  eng.trick = [
    { seat: 0, card: card('H', 14) },
    { seat: 1, card: card('H', 13) },
    { seat: 2, card: card('H', 12) },
    { seat: 3, card: card('S', 2) }
  ];
  eq(eng._trickWinnerSeat(), 3, 'spec 19: 2♠ beats A♥ K♥ Q♥ when trump spade');
}
{
  const eng = new E(4, 1);
  eng.trump = 'S';
  eng.trick = [
    { seat: 0, card: card('S', 3) },
    { seat: 1, card: card('S', 7) },
    { seat: 2, card: card('S', 13) },
    { seat: 3, card: card('S', 5) }
  ];
  eq(eng._trickWinnerSeat(), 2, 'spec 20: highest trump K♠ wins');
}
{
  const eng = new E(4, 1);
  eng.trump = 'S';
  eng.trick = [
    { seat: 0, card: card('H', 10) },
    { seat: 1, card: card('H', 14) },
    { seat: 2, card: card('H', 13) },
    { seat: 3, card: card('H', 3) }
  ];
  eq(eng._trickWinnerSeat(), 1, 'spec 21: no trump → highest led suit A♥ wins');
}
{
  const eng = new E(4, 1);
  eng.trump = 'H';
  eng.trick = [
    { seat: 0, card: card('C', 10) },
    { seat: 1, card: card('C', 13) },
    { seat: 2, card: card('C', 2) },
    { seat: 3, card: card('C', 14) }
  ];
  eq(eng._trickWinnerSeat(), 3, 'spec example: everyone follows suit, A♣ wins even with heart trump');
}
{
  const eng = new E(4, 1);
  eng.trump = 'H';
  eng.trick = [
    { seat: 0, card: card('S', 10) },
    { seat: 1, card: card('S', 13) },
    { seat: 2, card: card('H', 3) },
    { seat: 3, card: card('S', 14) }
  ];
  eq(eng._trickWinnerSeat(), 2, 'spec cutting: 3♥ cuts and beats spades incl A♠');
}
{
  const eng = new E(4, 1);
  eng.trump = 'S';
  eng.trick = [
    { seat: 0, card: card('H', 10) },
    { seat: 1, card: card('H', 14) },
    { seat: 2, card: card('D', 13) },
    { seat: 3, card: card('H', 13) }
  ];
  eq(eng._trickWinnerSeat(), 1, 'off-suit discard cannot win');
}

console.log('--- legal moves ---');
{
  const eng = new E(4, 1);
  eng.trump = 'H';
  eng.hands[1] = [card('C', 14), card('C', 7), card('H', 13)];
  eng.trick = [{ seat: 0, card: card('C', 10) }];
  sameSet(eng.legalMoves(1), [card('C', 14), card('C', 7)], 'must follow led suit only');
  eng.hands[1] = [card('H', 13), card('D', 4), card('S', 6)];
  sameSet(eng.legalMoves(1), eng.hands[1], 'void in led suit → any card legal');
  eng.trick = [];
  sameSet(eng.legalMoves(1), eng.hands[1], 'leading → any card legal');
}

console.log('--- dealing & full random 4p hand ---');
for (let s = 100; s < 106; s++) {
  const eng = playFullMatch(4, s);
  eq(eng.mode, 4, 'mode preserved');
  ok(eng.scores[eng.matchWinner] >= 7, 'winner reached 7 points');
}

console.log('--- scoring kot / hakem kot / rotation ---');
{
  const eng = new E(4, 9);
  eng.roles = { hakem: 0, dealer: 3 };
  eng.tricksWon = [7, 0];
  eng._finishHand(0);
  eq(eng.handResult.label, 'kot', '7-0 by hakem team = kot');
  eq(eng.handResult.pts, 2, 'kot worth 2 points');
  eq(eng.scores[0], 2, 'score applied');
  eq(eng.pendingRoles.hakem, 0, 'hakem team won → same hakem');
  eq(eng.pendingRoles.dealer, 3, 'same dealer');
}
{
  const eng = new E(4, 9);
  eng.roles = { hakem: 1, dealer: 0 };
  eng.tricksWon = [7, 0];
  eng._finishHand(0);
  eq(eng.handResult.label, 'hakemKot', '7-0 against hakem team = hakem kot');
  eq(eng.handResult.pts, 3, 'hakem kot worth 3 points');
  eq(eng.pendingRoles.hakem, 2, 'rotation: hakem+1 becomes hakem');
  eq(eng.pendingRoles.dealer, 1, 'old hakem becomes dealer');
  eng.proceedAfterHand();
  eq(eng.roles.hakem, 2, 'roles applied on proceed');
}
{
  const eng = new E(4, 9);
  eng.roles = { hakem: 2, dealer: 1 };
  eng.tricksWon = [4, 7];
  eng._finishHand(1);
  eq(eng.handResult.pts, 1, 'normal win 1 point');
}
{
  const eng = new E(4, 9);
  eng.roles = { hakem: 0, dealer: 3 };
  eng.tricksWon = [0, 7];
  eng._finishHand(1);
  eq(eng.handResult.label, 'hakemKot', 'opponents kot over hakem team');
  eq(eng.scores[1], 3, '3 points to opponents');
}

console.log('--- 4p deal integrity ---');
{
  const eng = new E(4, 555);
  AI.setRng(Math.random);
  eng.newMatch();
  eng.acceptCeremony();
  eng.beginHand();
  eng.setTrump(AI.chooseTrump(eng.firstFive[eng.roles.hakem]));
  for (let i = 0; i < 4; i++) eq(eng.hands[i].length, 13, 'player ' + i + ' has 13 cards');
  const all = [].concat.apply([], eng.hands);
  eq(all.length, 52, 'all 52 dealt');
  eq(new Set(all.map(function (c) { return c.id; })).size, 52, 'no duplicates');
  eq(eng.turn, eng.roles.hakem, 'hakem leads first trick');
  const orderOK = eng.dealOrder[0] === eng.roles.hakem && eng.dealOrder[3] === eng.roles.dealer;
  ok(orderOK, 'deal starts at hakem ends at dealer');
  aiOnlyHand(eng);
  ok(eng.handResult != null, 'hand finished');
  const t = eng.handResult.tricks;
  eq(t[0] + t[1], 7 + Math.min(t[0], t[1]), 'tricks stop at 7 for winner');
  eq(t[eng.handResult.winSide], 7, 'winner has exactly 7 tricks');
  ok(t[0] + t[1] <= 13 && t[eng.handResult.loseSide] <= 6, 'loser under 7');
}

console.log('--- 2p flow integrity ---');
for (let s = 200; s < 204; s++) {
  const eng = playFullMatch(2, s);
  ok(eng.scores[eng.matchWinner] >= 7, '2p winner reached 7');
}
{
  const eng = new E(2, 31337);
  AI.setRng(C.mulberry32(5));
  eng.newMatch();
  eng.acceptCeremony();
  eng.beginHand();
  eng.setTrump(AI.chooseTrump(eng.firstFive[eng.roles.hakem]));
  eq(eng.phase, 'discard2p', 'phase discard2p');
  const hk = eng.roles.hakem;
  eq(eng.discardNeed[hk], 3, 'hakem discards 3');
  eq(eng.discardNeed[1 - hk], 2, 'opponent discards 2');
  eq(eng.hands[hk].length, 5, 'hands start at 5');
  eng.applyDiscard2p(hk, AI.chooseDiscards(eng.hands[hk], 3, eng.trump));
  eq(eng.hands[hk].length, 2, 'hakem keeps 2');
  eq(eng.discardedFlags[1 - hk], false, 'waiting other discard');
  eng.applyDiscard2p(1 - hk, AI.chooseDiscards(eng.hands[1 - hk], 2, eng.trump));
  eq(eng.hands[1 - hk].length, 3, 'opponent keeps 3');
  eq(eng.phase, 'draw2p', 'draw phase begins');
  eq(eng.drawTurn(), hk, 'hakem draws first');
  eq(eng.stock.length, 42, 'stock has 42 cards');
  eq(eng.drawsLeft(hk), 11, 'hakem draws 11');
  eq(eng.drawsLeft(1 - hk), 10, 'other draws 10');

  let flips = 0;
  while (eng.phase === 'draw2p') {
    const turn = eng.drawTurn();
    const peek = eng.stockPeek();
    const keep = AI.chooseKeep(peek, eng.hands[turn], eng.trump);
    const before = eng.stock.length;
    const r = eng.drawDecision(keep);
    eq(eng.stock.length, before - 2, 'each draw consumes exactly 2 stock cards');
    if (!keep) flips++;
    if (keep) ok(r.taken && r.burned, 'keep: second burned');
    else ok(r.rejected && r.taken, 'reject: forced take of second');
  }
  eq(eng.stock.length, 0, 'stock exactly exhausted');
  eq(eng.hands[0].length, 13, 'player0 ends 13');
  eq(eng.hands[1].length, 13, 'player1 ends 13');
  eq(flips <= 21, true, 'sanity flips');
  eq(eng.turn, hk, 'hakem leads tricks');
  aiOnlyHand(eng);
  ok(eng.handResult, '2p hand completes');
}

console.log('--- 2p scoring & rotation ---');
{
  const eng = new E(2, 42);
  eng.roles = { hakem: 0, dealer: 1 };
  eng.tricksWon = [7, 0];
  eng._finishHand(0);
  eq(eng.handResult.label, 'kot', 'hakem 7-0 = kot (2 pts)');
  eq(eng.handResult.pts, 2, '');
  eq(eng.pendingRoles.hakem, 0, 'hakem stays');
}
{
  const eng = new E(2, 42);
  eng.roles = { hakem: 1, dealer: 0 };
  eng.tricksWon = [7, 0];
  eng._finishHand(0);
  eq(eng.handResult.label, 'hakemKot', 'non-hakem 7-0 = hakem kot (3 pts)');
  eq(eng.handResult.pts, 3, '');
  eq(eng.pendingRoles.hakem, 0, 'loser deals: old hakem(1) now dealer? check');
  eq(eng.pendingRoles.dealer, 1, 'old hakem becomes dealer');
}
{
  const eng = new E(2, 42);
  eng.roles = { hakem: 0, dealer: 1 };
  eng.tricksWon = [3, 7];
  eng._finishHand(1);
  eq(eng.handResult.pts, 1, 'normal 1pt');
  eq(eng.pendingRoles.hakem, 1, 'opponent becomes hakem');
  eq(eng.pendingRoles.dealer, 0, 'old hakem deals');
}

console.log('--- match target ---');
{
  const eng = new E(4, 8);
  eng.roles = { hakem: 0, dealer: 3 };
  eng.scores = [6, 2];
  eng.tricksWon = [7, 0];
  eng._finishHand(0);
  eq(eng.matchOver, true, 'match over at 8>=7');
  eq(eng.matchWinner, 0, 'winner side recorded');
}

console.log('\nRESULT:', passed, 'passed,', failed, 'failed');
process.exit(failed ? 1 : 0);

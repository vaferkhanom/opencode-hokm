'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body>' +
  '<div id="bg"></div><div id="app"></div><div id="banner-layer"></div><div id="fx"></div>' +
  '</body></html>', {
    url: 'https://hokm.example/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });

const w = dom.window;

w.matchMedia = function () {
  return { matches: false, addEventListener: function () {}, removeEventListener: function () {} };
};
w.Element.prototype.animate = function (frames, opts) {
  const a = { onfinish: null, oncancel: null };
  setTimeout(function () { if (a.onfinish) a.onfinish(); }, 1);
  void frames; void opts;
  return a;
};
w.Element.prototype.scrollTo = function () {};
w.HTMLElement.prototype.scrollTo = function () {};

const scripts = ['cards.js', 'engine.js', 'ai.js', 'sound.js', 'ui.js', 'app.js'];
for (const s of scripts) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', s), 'utf8');
  w.eval(code);
}

const DEBUG = !!process.env.DEBUG_SMOKE;
let dbgN = 0;
if (DEBUG) {
  const OE = w.HokmEngine.prototype;
  let n = 0;
  const oPlay = OE.playCard;
  OE.playCard = function (seat, id) {
    if (++n < 400) console.log('[dbg] play s' + seat, id, 'tw', this.tricksWon.join('-'), this.phase);
    return oPlay.call(this, seat, id);
  };
  const OW = w.HokmUI;
  ['dealWave', 'sealStamp', 'ceremonyStart', 'ceremonyClear', 'showPiles',
    'wait', 'highlightWinner', 'sweepTrick', 'bumpCoin', 'placePlayed',
    'flyFromHandToTrick'].forEach(function (m) {
      const orig = OW[m].bind(OW);
      OW[m] = function () {
        if (++dbgN < 500000) console.log('[dbg]', m);
        return orig.apply(null, arguments);
      };
    });
  const oRenderDbg = OW.renderHand.bind(OW);
  OW.renderHand = function () {
    if (++dbgN < 500000) console.log('[dbg] renderHand enabled=' + arguments[2] + ' cb=' + (!!arguments[3]));
    return oRenderDbg.apply(null, arguments);
  };
}

const UI = w.HokmUI;
const AI = w.HokmAI;
const App = w.App;
void App;

let passed = 0;
let failedN = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failedN++; console.error('FAIL:', msg); }
}

UI.speed = 0.001;
UI.reduced = true;
UI.wait = function () { return Promise.resolve(); };
UI.anim = function (node, frames) {
  const last = frames[frames.length - 1];
  for (const k in last) node.style[k] = last[k];
  return Promise.resolve();
};
UI.banner = function () { return Promise.resolve(); };
UI.confetti = function () {};
UI.sealStamp = function (suit) { UI.setTrumpChip(suit); return Promise.resolve(); };

UI.handEndOverlay = function () { return Promise.resolve(); };
UI.matchEndOverlay = function (v) {
  lastMatchView = v;
  return Promise.resolve('menu');
};
let lastMatchView = null;
UI.confirmExit = function () { return Promise.resolve(false); };
UI.trumpPicker = function (five) { return Promise.resolve(AI.chooseTrump(five)); };

const origRenderHand = UI.renderHand.bind(UI);
UI.renderHand = function (cardsArr, legalIds, enabled, onPlay) {
  const r = origRenderHand(cardsArr, legalIds, enabled, onPlay);
  if (enabled && onPlay && legalIds && legalIds.size > 0 && !UI._discardMode) {
    const arr = Array.from(legalIds);
    const pickId = arr[Math.floor(Math.random() * arr.length)];
    setTimeout(function () {
      if (UI._handCb && !UI._discardMode) UI._handCb(pickId, null);
    }, 1);
  }
  return r;
};

UI.discardPrompt = function (count) {
  const eng = App.eng;
  const ids = AI.chooseDiscards(eng.hands[0], count, eng.trump);
  return Promise.resolve(ids);
};
UI.drawChoice = function () { return Promise.resolve(true); };

async function runMatch(mode, label) {
  await App.start(mode);
  ok(lastMatchView && typeof lastMatchView.won === 'boolean', label + ': match end overlay shown');
  ok(w.document.querySelectorAll('.ov').length === 0, label + ': overlays cleaned');
}

(async function main() {
  const t0 = Date.now();
  try {
    if (w.document.readyState === 'loading') {
      await new Promise(function (r) { w.document.addEventListener('DOMContentLoaded', r); });
    }
    ok(typeof w.App === 'object' && typeof w.App.start === 'function', 'app bootstrapped');

    ok(w.document.querySelector('#btn-4p'), 'menu rendered with 4p button');
    ok(w.document.querySelector('#btn-2p'), 'menu rendered with 2p button');

    UI.rulesModal();
    ok(w.document.querySelector('.rules-panel'), 'rules modal opens');
    w.document.querySelector('#rl-close').click();
    ok(!w.document.querySelector('.rules-panel'), 'rules modal closes');

    await runMatch(4, '4p');
    ok(true, '4p full match completed headlessly');

    App.showMenu();
    ok(w.document.querySelector('.menu.on'), 'back at menu');

    await runMatch(2, '2p');
    ok(true, '2p full match completed headlessly');
  } catch (e) {
    failedN++;
    console.error('FAIL: exception during smoke run:', e && e.stack || e);
  }

  console.log('\nSMOKE RESULT:', passed, 'passed,', failedN, 'failed,', (Date.now() - t0) + 'ms');
  process.exit(failedN ? 1 : 0);
})();

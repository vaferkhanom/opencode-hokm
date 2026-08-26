(function (root) {
  'use strict';

  const C = root.HokmCards;
  const Engine = root.HokmEngine;
  const AI = root.HokmAI;
  const UI = root.HokmUI;
  const Snd = root.HokmSound;

  const AI_NAMES = ['آرش', 'سارا', 'کیان', 'نگار', 'بهرام', 'لیلا', 'رامین', 'شیرین'];

  function abortErr() { return { abort: true }; }

  const App = {
    prefs: { sound: true, fast: false },
    stats: { w: 0, l: 0, kot: 0 },
    tg: null,
    humanName: 'تو',
    mode: null,
    eng: null,
    names: null,
    gen: 0,
    _moveResolve: null,

    init: function () {
      UI.init();
      this.loadPrefs();
      this.loadStats();
      UI.speed = this.prefs.fast ? 0.55 : 1;
      Snd.setMuted(!this.prefs.sound);
      this.initTG();
      document.addEventListener('pointerdown', function once() {
        Snd.ensure();
        document.removeEventListener('pointerdown', once);
      });
      this.showMenu();
    },

    initTG: function () {
      const t = root.Telegram && root.Telegram.WebApp;
      if (!t || !t.initDataUnsafe) return;
      this.tg = t;
      try {
        t.ready();
        t.expand();
        if (t.setHeaderColor) t.setHeaderColor('#070a12');
        if (t.setBackgroundColor) t.setBackgroundColor('#070a12');
        if (t.disableVerticalSwipes) t.disableVerticalSwipes();
      } catch (e) {}
      const u = t.initDataUnsafe && t.initDataUnsafe.user;
      if (u && u.first_name) this.humanName = u.first_name.split(/\s+/)[0];
      const self = this;
      const setVh = function () {
        const h = (typeof t.viewportStableHeight === 'number' && t.viewportStableHeight > 0)
          ? t.viewportStableHeight : window.innerHeight;
        document.documentElement.style.setProperty('--vhh', h + 'px');
      };
      setVh();
      if (t.onEvent) t.onEvent('viewportChanged', setVh);
      if (t.BackButton) {
        this._bb = t.BackButton;
        this._bb.onClick(function () {
          self.onBackPressed();
        });
      }
    },

    onBackPressed: async function () {
      if (!UI.screenEl || !UI.screenEl.classList.contains('on')) return;
      const yes = await UI.confirmExit();
      if (yes) this.toMenu();
    },

    syncBack: function (show) {
      if (this._bb) {
        try { if (show) this._bb.show(); else this._bb.hide(); } catch (e) {}
      }
    },

    loadPrefs: function () {
      try { Object.assign(this.prefs, JSON.parse(localStorage.getItem('hokm-prefs') || '{}')); } catch (e) {}
    },
    savePrefs: function () {
      try { localStorage.setItem('hokm-prefs', JSON.stringify(this.prefs)); } catch (e) {}
    },
    loadStats: function () {
      try { Object.assign(this.stats, JSON.parse(localStorage.getItem('hokm-stats') || '{}')); } catch (e) {}
    },
    saveStats: function () {
      try { localStorage.setItem('hokm-stats', JSON.stringify(this.stats)); } catch (e) {}
    },

    showMenu: function () {
      this.syncBack(false);
      UI.clearRoot();
      const scr = UI.buildMenu(this.stats);
      scr.querySelector('#btn-4p').addEventListener('click', function () {
        Snd.play('click');
        App.start(4);
      });
      scr.querySelector('#btn-2p').addEventListener('click', function () {
        Snd.play('click');
        App.start(2);
      });
      scr.querySelector('#btn-rules').addEventListener('click', function () {
        Snd.play('click');
        UI.rulesModal();
      });
      scr.querySelector('#btn-set').addEventListener('click', function () {
        Snd.play('click');
        UI.settingsModal(App.prefs, function (p) {
          App.prefs = p;
          App.savePrefs();
          UI.speed = p.fast ? 0.55 : 1;
          Snd.setMuted(!p.sound);
        });
      });
    },

    namesFor: function (mode) {
      const pool = AI_NAMES.slice();
      const pick = function () {
        return pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      };
      const out = [{ name: this.humanName }];
      for (let i = 1; i < mode; i++) out.push({ name: pick() });
      return out.map(function (n) {
        return { name: n.name, initial: n.name.slice(0, 1) };
      });
    },

    alive: function (g) {
      if (g !== this.gen) throw abortErr();
    },

    start: async function (mode) {
      const g = ++this.gen;
      this.mode = mode;
      UI.clearRoot(true);
      this.names = this.namesFor(mode);
      this.eng = new Engine(mode);
      AI.setRng(Math.random);
      UI.buildGame({ mode: mode, names: this.names, usSide: 0 });
      UI.setTarget(7);
      UI.updateScores(0, 0);
      this.syncBack(true);

      const self = this;
      const scrEl = UI.screenEl;
      scrEl.querySelector('#g-exit').addEventListener('click', function () {
        Snd.play('click');
        self.onBackPressed();
      });
      scrEl.querySelector('#g-help').addEventListener('click', function () {
        Snd.play('click');
        UI.rulesModal();
      });

      try {
        const first = this.eng.newMatch();
        if (first.phase === 'ceremony') await this.runCeremony(g);
        while (!this.eng.matchOver) {
          this.alive(g);
          await this.playHand(g);
          this.alive(g);
          if (this.eng.matchOver) break;
          await this.showHandEnd(g);
          this.eng.proceedAfterHand();
        }
        await this.showMatchEnd(g);
      } catch (e) {
        if (!e || !e.abort) console.error(e);
      }
    },

    toMenu: function () {
      this.gen++;
      UI.destroyGame();
      this.showMenu();
    },

    runCeremony: async function (g) {
      const cer = this.eng.ceremony;
      UI.ceremonyStart();
      UI.setDockText('یارگیری با آس…');
      let hakemAnnounced = false;
      for (let i = 0; i < cer.reveals.length; i++) {
        this.alive(g);
        const r = cer.reveals[i];
        await UI.ceremonyReveal(i, r.card, cer.reveals.length);
        if (r.card.rank !== 14) continue;
        UI.ceremonyFlash(r.seat);
        const nm = '<b>' + this.names[r.seat].name + '</b>';
        if (!hakemAnnounced) {
          hakemAnnounced = true;
          Snd.play('kot');
          await UI.banner(nm + ' آس آورد — حاکم شد', 'gold', 1500);
        } else if (this.mode === 4 && r.seat === cer.partner) {
          await UI.banner(nm + ' آس آورد — یارِ حاکم شد', 'emerald', 1500);
        }
      }
      await UI.ceremonyClear();
      this.eng.acceptCeremony();
      UI.setDockText('');
    },

    suitTone: function (suit) {
      return C.RED[suit] ? 'red' : '';
    },

    hintText: function () {
      const eng = this.eng;
      if (!eng.trick.length) return 'نوبت توست — هر کارتی می‌توانی بزنی';
      const led = eng.trick[0].card.suit;
      const canFollow = eng.hands[0].some(function (c) { return c.suit === led; });
      const cls = C.RED[led] ? 'rs' : 'bs';
      if (canFollow) {
        return 'خال زمینه: <b class="' + cls + '">' + C.SUIT_SYM[led] + ' ' + C.SUIT_FA[led] + '</b> — وصل کن';
      }
      return 'بی‌خالی — می‌توانی با حکم ببری یا دور بیندازی';
    },

    waitHumanMove: function () {
      const self = this;
      return new Promise(function (resolve) {
        self._moveResolve = resolve;
      });
    },

    humanPlayed: function (id, nodeRect) {
      const eng = this.eng;
      const cardObj = eng.hands[0].filter(function (c) { return c.id === id; })[0];
      if (!cardObj || !eng.canPlayCard(0, id)) return;
      eng.playCard(0, id);
      UI.flyFromHandToTrick(id, 0, cardObj);
      const res = this._moveResolve;
      this._moveResolve = null;
      if (res) res(nodeRect);
    },

    playHand: async function (g) {
      const eng = this.eng;
      const mode = this.mode;
      const self = this;

      const res = eng.beginHand();
      UI.setHandNo(eng.handNo);
      UI.setRoles(eng.roles.hakem, eng.roles.dealer);
      UI.setTrumpChip(null);
      UI.renderCoins([0, 0]);
      UI.clearTrick();
      UI.hideDock();

      await UI.dealWave(eng.dealOrder.map(function (s) { return { seat: s, count: 5 }; }));
      this.alive(g);
      UI.renderHand(eng.hands[0], null, false, null);

      const hk = eng.roles.hakem;
      let suit;
      if (hk === 0) {
        UI.setDockText('با پنج کارت اولت، خال حکم را اعلام کن');
        suit = await UI.trumpPicker(eng.firstFive[0], AI.chooseTrump(eng.firstFive[0]));
      } else {
        UI.setDockText(this.names[hk].name + ' کارت‌هایش را بررسی می‌کند…');
        await UI.wait(1000);
        this.alive(g);
        suit = AI.chooseTrump(eng.firstFive[hk]);
        await UI.banner(
          this.names[hk].name + ' حکم را <b class="' + this.suitTone(suit) + '">' +
          C.SUIT_SYM[suit] + ' ' + C.SUIT_FA[suit] + '</b> اعلام کرد',
          'gold', 1700
        );
      }
      this.alive(g);
      eng.setTrump(suit);
      UI.trump = suit;
      await UI.sealStamp(suit);
      this.alive(g);

      if (mode === 4) {
        if (eng.roles.dealer !== undefined) {
          const partnerOfHakem = (hk + 2) % 4;
          await UI.banner('<b>' + this.names[partnerOfHakem].name + '</b> دستهٔ ورق را کوپ کرد', 'plain', 1200);
        }
        await UI.dealWave([{ seat: 0, count: 8 }, { seat: 1, count: 8 }, { seat: 2, count: 8 }, { seat: 3, count: 8 }]);
        this.alive(g);
      } else {
        await this.discardPhase2p(g);
        this.alive(g);
        await this.drawPhase2p(g);
        this.alive(g);
      }

      while (eng.phase === 'play') {
        this.alive(g);
        const seat = eng.turn;
        if (seat === 0) {
          const legal = new Set(eng.legalMoves(0).map(function (c) { return c.id; }));
          UI.renderHand(eng.hands[0], legal, true, function (id, node) {
            const rect = node ? node.getBoundingClientRect() : null;
            self.humanPlayed(id, rect);
          });
          UI.setTurn(0);
          UI.setDockText(this.hintText());
          await this.waitHumanMove();
          this.alive(g);
          UI.setDockText('');
        } else {
          UI.renderHand(eng.hands[0], null, false, null);
          UI.setTurn(seat);
          UI.setDockText(this.names[seat].name + ' در فکر است…');
          await UI.wait(mode === 4 ? 680 : 760);
          this.alive(g);
          const view = eng.aiView(seat);
          const id = AI.choosePlay(view);
          const cardObj = eng.hands[seat].filter(function (c) { return c.id === id; })[0];
          eng.playCard(seat, id);
          UI.placePlayed(seat, cardObj, {});
          Snd.play('place');
        }

        if (eng.lastTrickResult) {
          const r = eng.lastTrickResult;
          await UI.wait(420);
          this.alive(g);
          UI.highlightWinner(r.winner, r.winningCard.id);
          Snd.play('flip');
          await UI.wait(620);
          this.alive(g);
          await UI.sweepTrick(r.winner);
          UI.bumpCoin(r.side, eng.tricksWon.slice());
          if (r.side !== eng.sideOf(0)) UI.haptic('error');
        }
      }
      UI.setTurn(-1);
      UI.hideDock();
    },

    discardPhase2p: async function (g) {
      const eng = this.eng;
      UI.showPiles(true);
      UI.updatePileCounts(42, 0);
      const hk = eng.roles.hakem;
      const orderSeats = [hk, 1 - hk];

      await UI.banner('هر نفر چند کارت دور می‌اندازد — حاکم ۳، حریف ۲', 'plain', 1700);

      for (const seat of orderSeats) {
        this.alive(g);
        const need = eng.discardNeed[seat];
        let ids;
        if (seat === 0) {
          UI.renderHand(eng.hands[0], null, true, null);
          UI.setDockText('');
          ids = await UI.discardPrompt(need);
        } else {
          UI.setDockText(this.names[seat].name + ' کارت‌هایش را سبک‌سنگ می‌کند…');
          UI.renderHand(eng.hands[0], null, false, null);
          await UI.wait(950);
          this.alive(g);
          ids = AI.chooseDiscards(eng.hands[seat], need, eng.trump);
        }
        eng.applyDiscard2p(seat, ids);
        if (seat === 0) {
          const selNodes = ids.map(function (id) {
            return UI.handBox.querySelector('[data-id="' + id + '"]');
          });
          const rects = selNodes.map(function (n) { return n ? n.parentElement.getBoundingClientRect() : null; });
          ids.forEach(function (id) { UI.removeHandCard(id); });
          rects.forEach(function (rect, i) {
            if (rect) UI.flyGhost(null, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, UI.pileCenter('burn'), { faceUp: false, dur: 340, rot1: 180, fadeOut: true });
          });
          await UI.wait(360);
        } else {
          await UI.flyGhost(null, UI.avatarCenter(seat), UI.pileCenter('burn'), { faceUp: false, dur: 380, scale1: 0.8, fadeOut: true });
        }
        Snd.play('deal');
        UI.updatePileCounts(42, eng.discardPile.length);
      }
      UI.renderHand(eng.hands[0], null, false, null);
      UI.updatePileCounts(eng.restDeck ? eng.restDeck.length : 42, eng.discardPile.length);
    },

    drawPhase2p: async function (g) {
      const eng = this.eng;
      UI.updatePileCounts(eng.stock.length, eng.discardPile.length);
      await UI.banner('مرحلهٔ برداشت — نوبتی، تا ۱۳ کارت', 'plain', 1600);
      let guard = 0;
      while (eng.phase === 'draw2p') {
        guard++;
        if (guard > 40) break;
        this.alive(g);
        const turn = eng.drawTurn();
        const top = eng.stockPeek();
        UI.updatePileCounts(eng.stock.length, eng.discardPile.length);
        if (turn === 0) {
          UI.renderHand(eng.hands[0], null, false, null);
          const keep = await UI.drawChoice(top, {
            stock: eng.stock.length,
            myHand: eng.hands[0].length,
            need: eng.drawsLeft(0)
          });
          this.alive(g);
          const r = eng.drawDecision(keep);
          if (!keep) {
            await UI.flyGhost(null, UI.pileCenter('stock'), UI.pileCenter('burn'), { faceUp: false, dur: 240, rot1: 150, fadeOut: true });
          }
          Snd.play('place');
          UI.renderHand(eng.hands[0], null, true, null);
          void r;
        } else {
          UI.setDockText(this.names[turn].name + ' از برگه برمی‌دارد…');
          const keep = AI.chooseKeep(top, eng.hands[turn], eng.trump);
          await UI.wait(720);
          this.alive(g);
          const r = eng.drawDecision(keep);
          if (keep) {
            await UI.flyGhost(null, UI.pileCenter('stock'), UI.avatarCenter(turn), { faceUp: false, dur: 260, scale1: 0.75, fadeOut: true });
            await UI.flyGhost(null, UI.pileCenter('stock'), UI.pileCenter('burn'), { faceUp: false, dur: 240, rot1: 140, fadeOut: true });
          } else {
            await UI.flyGhost(null, UI.pileCenter('stock'), UI.pileCenter('burn'), { faceUp: false, dur: 240, rot1: 140, fadeOut: true });
            await UI.flyGhost(null, UI.pileCenter('stock'), UI.avatarCenter(turn), { faceUp: false, dur: 260, scale1: 0.75, fadeOut: true });
          }
          void r;
        }
        UI.updatePileCounts(eng.stock.length, eng.discardPile.length);
        UI.hideDock();
      }
      UI.showPiles(false);
      UI.setDockText('');
    },

    showHandEnd: async function (g) {
      const eng = this.eng;
      const hr = eng.handResult;
      const mySide = eng.sideOf(0);
      const won = hr.winSide === mySide;
      if (won && hr.kot) {
        this.stats.kot = (this.stats.kot || 0) + 1;
        this.saveStats();
      }
      const view = {
        won: won,
        label: hr.label,
        kot: hr.kot,
        ptsDelta: hr.pts,
        tricksUs: hr.tricks[mySide],
        tricksThem: hr.tricks[1 - mySide],
        scoreUs: eng.scores[mySide],
        scoreThem: eng.scores[1 - mySide],
        usName: this.mode === 4 ? 'تیم ما' : 'تو',
        matchOver: eng.matchOver
      };
      this.alive(g);
      await UI.handEndOverlay(view);
      this.alive(g);
    },

    showMatchEnd: async function (g) {
      const eng = this.eng;
      const won = eng.matchWinner === eng.sideOf(0);
      if (won) this.stats.w = (this.stats.w || 0) + 1;
      else this.stats.l = (this.stats.l || 0) + 1;
      this.saveStats();
      const mySide = eng.sideOf(0);
      this.alive(g);
      const action = await UI.matchEndOverlay({
        won: won,
        scoreUs: eng.scores[mySide],
        scoreThem: eng.scores[1 - mySide]
      });
      this.alive(g);
      if (action === 'again') this.start(this.mode);
      else this.toMenu();
    }
  };

  root.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.init(); });
  } else {
    App.init();
  }
})(typeof window !== 'undefined' ? window : globalThis);

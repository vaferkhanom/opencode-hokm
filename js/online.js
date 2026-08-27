(function (root) {
  'use strict';

  const UI = root.HokmUI;
  const Snd = root.HokmSound;
  const AI = root.HokmAI;
  const App = root.App;
  const Cards = root.HokmCards;

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function mySideOf(snap, seat) { return snap.mode === 4 ? (seat % 2) : seat; }
  function otherSeat(snap, seat) { return snap.mode === 4 ? (seat + 1) % 4 : 1 - seat; }
  function initialOf(name) { return (name || '؟').replace(/\s/g, '').slice(0, 1); }
  function sig(cards) { return (cards || []).map(function (c) { return c.id; }).join(','); }
  function fa(n) { try { return Cards.faNum(n); } catch (e) { return String(n); } }

  const RECONNECT_MAX_TRIES = 60;   // ~2min of retries (> server 30s grace)
  const RECONNECT_DELAY_MS = 2000;

  const Online = {
    net: null,
    code: null,
    seat: -1,
    isHost: false,
    built: false,
    awaiting: false,
    promptKind: null,
    lobbyEl: null,
    lastHandSig: null,
    lastTrickSig: null,
    _heShown: false,
    _meShown: false,
    exiting: false,
    _tries: 0,
    _retryTimer: null,
    layerEl: null,
    pillEl: null,
    pillTimer: null,
    deadlineTs: 0,
    _hapticWarned: false,

    playerId: function () {
      try {
        let id = localStorage.getItem('hokm-pid');
        if (!id) { id = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('hokm-pid', id); }
        return id;
      } catch (e) { return 'u' + Math.random().toString(36).slice(2, 10); }
    },
    name: function () {
      try {
        const t = root.Telegram && root.Telegram.WebApp;
        if (t && t.initDataUnsafe && t.initDataUnsafe.user && t.initDataUnsafe.user.first_name) {
          return t.initDataUnsafe.user.first_name.split(/\s+/)[0];
        }
        const n = localStorage.getItem('hokm-name');
        if (n) return n;
      } catch (e) {}
      return 'تو';
    },

    // Room code from ?room=CODE (web link), tgWebAppStartParam (t.me startapp)
    // or Telegram initDataUnsafe.start_param — all equivalent invite paths.
    inviteCodeFromUrl: function () {
      let code = null;
      try {
        const p = new URLSearchParams(location.search);
        code = p.get('room') || p.get('tgWebAppStartParam') || p.get('startapp');
      } catch (e) {}
      if (!code) {
        try {
          const t = root.Telegram && root.Telegram.WebApp;
          if (t && t.initDataUnsafe && t.initDataUnsafe.start_param) code = t.initDataUnsafe.start_param;
        } catch (e) {}
      }
      return code ? String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : null;
    },

    isActive: function () { return !!this.net && !this.exiting && (!!this.code || !!this.lobbyEl); },

    bindNet: function (n) {
      const self = this;
      n.on('welcome', function (m) {
        self.code = m.code; self.seat = m.seat; self.isHost = m.isHost;
        self._tries = 0;
        if (m.isHost) { try { localStorage.setItem('hokm-lastcode', m.code); } catch (e) {} }
        self.hideLayer();
      });
      n.on('state', function (m) { self.onState(m); });
      n.on('system', function (m) { UI.banner(m.text, m.tone || 'info', 1600); });
      n.on('error', function (m) { UI.banner(m.message || 'خطا', 'bad', 2200); });
      n.on('close', function () { self.onNetClose(); });
      return n;
    },

    ensureNet: function () {
      if (this.net) return Promise.resolve();
      this.net = this.bindNet(new root.HokmNet());
      return this.net.connect();
    },

    onNetClose: function () {
      if (this.exiting || !this.net) return;
      const inRoom = !!this.code && !this.lobbyEl;
      if (!inRoom) { this.net = null; return; } // shell dropped silently
      this.net = null;
      this.showLayer('اتصال قطع شد — در حال بازگشت به اتاق…');
      this.tryReconnect();
    },

    tryReconnect: function () {
      const self = this;
      if (this.exiting || this.net) return;
      this._tries++;
      if (this._tries > RECONNECT_MAX_TRIES) {
        this.layerMsg('اتصال برقرار نشد — دوباره تلاش کن');
        return;
      }
      const n = new root.HokmNet();
      this.bindNet(n);
      n.connect().then(function () {
        if (self.exiting || self.net) { try { n.ws.close(); } catch (e) {} return; }
        self.net = n;
        n.send({ type: 'join', code: self.code, playerId: self.playerId(), name: self.name() });
      }).catch(function () {
        self._retryTimer = setTimeout(function () { self._retryTimer = null; self.tryReconnect(); }, RECONNECT_DELAY_MS);
      });
    },

    showLayer: function (text) {
      const self = this;
      if (!this.layerEl) {
        this.layerEl = el('div', 'reconnect-layer',
          '<div class="reconnect-box"><i class="spin"></i><p class="rc-msg"></p>' +
          '<button class="btn ghost small" id="rc-cancel">خروج از بازی</button></div>');
        document.body.appendChild(this.layerEl);
        this.layerEl.querySelector('#rc-cancel').addEventListener('click', function () {
          Snd.play('click');
          self.doExit(true);
        });
      }
      this.layerMsg(text);
      this.layerEl.classList.add('on');
    },
    layerMsg: function (text) {
      if (this.layerEl) this.layerEl.querySelector('.rc-msg').textContent = text;
    },
    hideLayer: function () {
      this._tries = 0;
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      if (this.layerEl) this.layerEl.classList.remove('on');
    },

    // ---------------- turn countdown ----------------
    ensurePill: function () {
      if (this.pillTimer) return;
      const self = this;
      this.pillEl = el('div', 'turn-pill hidden', '');
      document.body.appendChild(this.pillEl);
      this.pillTimer = setInterval(function () { self.tickPill(); }, 250);
    },
    tickPill: function () {
      if (!this.pillEl) return;
      const waiting = this.awaiting && this.promptKind != null && this.deadlineTs > 0 && !this.exiting;
      if (!waiting) { this.pillEl.classList.add('hidden'); this._hapticWarned = false; return; }
      const left = Math.max(0, Math.ceil((this.deadlineTs - Date.now()) / 1000));
      this.pillEl.textContent = '⏱ ' + fa(left) + ' ثانیه';
      const danger = left <= 15;
      this.pillEl.classList.toggle('danger', danger);
      this.pillEl.classList.remove('hidden');
      if (danger && !this._hapticWarned) {
        this._hapticWarned = true;
        try { UI.banner('عجله کن!', 'warn', 1100); UI.haptic && UI.haptic('warn'); } catch (e) {}
      }
    },

    resetRoundView: function () {
      this.built = false;
      this.lastHandSig = null;
      this.lastTrickSig = null;
      this.awaiting = false;
      this.promptKind = null;
      this.deadlineTs = 0;
      this._heShown = false;
      this._meShown = false;
      try { if (UI.screenEl && UI.screenEl.dataset.scr === 'game') UI.destroyGame(); } catch (e) {}
    },

    startOnline: function () {
      const self = this;
      Snd.play('click');
      this.exiting = false;
      this.ensurePill();
      UI.clearRoot();
      UI.showScreen && UI.showScreen('menu');
      this.ensureNet().then(function () {
        const room = self.inviteCodeFromUrl();
        if (room) {
          self.net.send({ type: 'join', code: room, playerId: self.playerId(), name: self.name() });
        } else {
          self.renderLobbyShell();
        }
      }).catch(function () { UI.banner('اتصال به سرور ممکن نشد', 'bad', 2500); });
    },

    create: function (mode) {
      const self = this;
      this.ensureNet().then(function () {
        self.net.send({ type: 'create', mode: mode, playerId: self.playerId(), name: self.name() });
      });
    },
    join: function (code) {
      const self = this;
      this.ensureNet().then(function () {
        self.net.send({ type: 'join', code: String(code || '').toUpperCase(), playerId: self.playerId(), name: self.name() });
      });
    },
    leave: function () {
      if (this.net) this.net.send({ type: 'leave' });
      if (App) App.toMenu();
      this.teardown(true);
    },
    // In-game exit: confirm first — server hands the seat to a bot immediately.
    requestExit: function () {
      if (this.exiting) return Promise.resolve(false);
      Snd.play('click');
      const self = this;
      return UI.confirmExit().then(function (yes) {
        if (yes) self.doExit(true);
        return yes;
      });
    },
    doExit: function (sendLeave) {
      this.exiting = true;
      if (sendLeave && this.net) this.net.send({ type: 'leave' });
      if (App) App.toMenu();
      this.teardown(true);
    },
    teardown: function () {
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      if (this.net) { try { this.net.ws && this.net.ws.close(); } catch (e) {} }
      this.net = null;
      this.code = null; this.seat = -1; this.isHost = false;
      this.built = false; this.lobbyEl = null; this.lastHandSig = null; this.lastTrickSig = null;
      this._heShown = false; this._meShown = false; this.awaiting = false;
      this.promptKind = null; this.deadlineTs = 0;
      if (this.layerEl) this.layerEl.classList.remove('on');
    },

    // ---------------- state routing ----------------
    onState: function (snap) {
      if (snap.state === 'lobby') { this.renderLobby(snap); return; }
      if (this.lobbyEl) { this.lobbyEl.remove(); this.lobbyEl = null; }
      if (snap.state === 'matchOver' && !this._meShown) { this.renderGame(snap); return; }
      this.renderGame(snap);
    },

    // ---------------- lobby ----------------
    renderLobbyShell: function () {
      const self = this;
      UI.clearRoot();
      const scr = el('section', 'screen lobby on');
      scr.innerHTML =
        '<h1 class="lobby-title">بازی آنلاین</h1>' +
        '<p class="lobby-sub">اتاق بساز یا با کد ملحق شو</p>' +
        '<div class="lobby-actions">' +
        '<button class="btn gold wide" id="lob-2p">ساخت بازی ۲ نفره</button>' +
        '<button class="btn gold wide" id="lob-4p">ساخت بازی ۴ نفره</button>' +
        '</div>' +
        '<div class="lobby-join">' +
        '<input id="lob-code" class="code-in" maxlength="6" placeholder="کد اتاق" />' +
        '<button class="btn ghost" id="lob-join">ملحق شدن</button>' +
        '</div>' +
        '<button class="btn ghost wide" id="lob-back">بازگشت به منو</button>';
      UI.root.appendChild(scr);
      UI.screenEl = scr;
      scr.querySelector('#lob-2p').addEventListener('click', function () { self.create(2); });
      scr.querySelector('#lob-4p').addEventListener('click', function () { self.create(4); });
      scr.querySelector('#lob-join').addEventListener('click', function () {
        self.join(scr.querySelector('#lob-code').value.trim());
      });
      scr.querySelector('#lob-back').addEventListener('click', function () { self.leave(); });
      this.lobbyEl = scr;
    },

    renderLobby: function (snap) {
      if (!this.lobbyEl || !this.lobbyEl.querySelector('#lob-room')) {
        this.renderLobbyShell();
        const scr = this.lobbyEl;
        const box = el('div', 'lobby-room', '');
        box.id = 'lob-room';
        scr.insertBefore(box, scr.querySelector('.lobby-join'));
      }
      const box = this.lobbyEl.querySelector('#lob-room');
      const link = location.origin + location.pathname + '?room=' + snap.code;
      let slots = '';
      snap.seats.forEach(function (s) {
        if (s.empty) slots += '<div class="slot empty">صندلی خالی</div>';
        else slots += '<div class="slot' + (s.isBot ? ' bot' : '') + (s.connected ? '' : ' off') + '">' + s.name + (s.isBot ? '' : (s.connected ? '' : ' (قطع)')) + '</div>';
      });
      box.innerHTML =
        '<div class="room-code"><span>کد اتاق</span><b>' + snap.code + '</b><span class="rc-hint">این کد یا لینک را برای دوستت بفرست</span></div>' +
        '<div class="share-row">' +
        '<button class="btn ghost small grow" id="lob-copy">کپی لینک دعوت</button>' +
        '<button class="btn ghost small grow" id="lob-share">دعوت در تلگرام</button>' +
        '</div>' +
        '<div class="slots">' + slots + '</div>';
      const self = this;
      const copy = box.querySelector('#lob-copy');
      if (copy) copy.addEventListener('click', function () {
        const done = function () { UI.banner('لینک دعوت کپی شد', 'good', 1400); };
        const fail = function () { UI.banner(link, 'info', 3000); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fail);
          else fail();
        } catch (e) { fail(); }
      });
      const share = box.querySelector('#lob-share');
      if (share) share.addEventListener('click', function () {
        const text = 'بیا حُکم آنلاین بازی کنیم! کد اتاق: ' + snap.code;
        const tgUrl = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
        try {
          const t = root.Telegram && root.Telegram.WebApp;
          if (t && t.openTelegramLink) { t.openTelegramLink(tgUrl); return; }
        } catch (e) {}
        if (navigator.share) { navigator.share({ title: 'حُکم آنلاین', text: text, url: link }).catch(function () {}); return; }
        try { root.open(tgUrl, '_blank'); } catch (e) { UI.banner(link, 'info', 3000); }
      });
      const startBtn = this.lobbyEl.querySelector('#lob-start');
      if (snap.seats.every(function (s) { return !s.empty; }) && !startBtn) {
        const b = el('button', 'btn gold wide', 'شروع بازی', '');
        b.id = 'lob-start';
        b.addEventListener('click', function () { self.net.send({ type: 'start' }); });
        this.lobbyEl.insertBefore(b, this.lobbyEl.querySelector('#lob-back'));
      }
      if (!snap.seats.every(function (s) { return !s.empty; })) {
        // Host may start early; empty seats get bots.
        if (this.isHost && !this.lobbyEl.querySelector('#lob-start-bots')) {
          const w = el('button', 'btn emerald wide', 'شروع با ربات‌ها', '');
          w.id = 'lob-start-bots';
          w.addEventListener('click', function () { self.net.send({ type: 'start' }); });
          this.lobbyEl.insertBefore(w, this.lobbyEl.querySelector('#lob-back'));
        }
        const note = this.lobbyEl.querySelector('#lob-wait');
        if (!note) {
          const n = el('div', 'lobby-wait', 'در انتظار بازیکنان… لینک یا کد بالا را بفرست');
          n.id = 'lob-wait';
          this.lobbyEl.insertBefore(n, this.lobbyEl.querySelector('#lob-back'));
        }
      } else {
        const waitNote = this.lobbyEl.querySelector('#lob-wait');
        if (waitNote) waitNote.remove();
        const sb = this.lobbyEl.querySelector('#lob-start-bots');
        if (sb) sb.remove();
      }
    },

    // ---------------- game ----------------
    renderGame: function (snap) {
      if (!this.built) this.buildGame(snap);
      this.applyCommon(snap);
      this.renderTrick(snap);
      this.renderHandSafe(snap);
      this.handlePrompt(snap);

      if (snap.state === 'handEnd' && !this._heShown) {
        this._heShown = true;
        const self = this;
        UI.handEndOverlay(snap.handResult);
      }
      if (snap.state === 'playing' && this._heShown) { UI.closeModal && UI.closeModal(); this._heShown = false; }
      if (snap.state === 'matchOver' && !this._meShown) {
        this._meShown = true;
        const self = this;
        UI.matchEndOverlay(snap.handResult).then(function (action) {
          if (action === 'again') self.net.send({ type: 'start' });
          else self.doExit(true);
        });
      }
    },

    buildGame: function (snap) {
      const names = snap.seats.map(function (s) {
        return { name: s.name, initial: initialOf(s.name) };
      });
      UI.buildGame({ mode: snap.mode, names: names, usSide: snap.seats[snap.you].side });
      UI.setTarget(snap.target);
      const scr = UI.screenEl;
      const self = this;
      scr.querySelector('#g-exit').addEventListener('click', function () { self.requestExit(); });
      scr.querySelector('#g-help').addEventListener('click', function () { UI.rulesModal(); });
      // pill names
      const usName = snap.seats[snap.you].name;
      const themName = snap.seats[otherSeat(snap, snap.you)].name;
      const usEl = document.getElementById('pl-us-name'); if (usEl) usEl.textContent = usName;
      const themEl = document.getElementById('pl-them-name'); if (themEl) themEl.textContent = themName;
      this.built = true;
    },

    applyCommon: function (snap) {
      snap.seats.forEach(function (s, i) {
        if (s.empty) return;
        UI.setSeatName(i, s.name, initialOf(s.name));
        const node = UI.seatNode(i);
        if (node) {
          node.classList.toggle('off', !s.connected);
          node.classList.toggle('is-bot', !!s.isBot);
          let chip = node.querySelector('.strike-chip');
          if (s.strikes > 0) {
            if (!chip) {
              chip = el('span', 'strike-chip');
              const holder = node.querySelector('.badges') || node;
              holder.appendChild(chip);
            }
            chip.title = 'سه بار تأخیر = ربات تا پایان بازی';
            chip.innerHTML = '⚠ ' + fa(s.strikes);
          } else if (chip) chip.remove();
        }
      });
      const mySide = snap.seats[snap.you].side;
      UI.updateScores(snap.scores[mySide], snap.scores[1 - mySide]);
      UI.setHandNo(snap.handNo);
      UI.setTrumpChip(snap.trump);
      if (snap.turn != null && snap.turn >= 0) UI.setTurn(snap.turn);
      // countdown anchor for our own pending decisions
      if (snap.yourTurn && snap.turnMsLeft > 0) this.deadlineTs = Date.now() + snap.turnMsLeft;
      else if (!snap.yourTurn) this.deadlineTs = 0;
    },

    renderTrick: function (snap) {
      const cards = (snap.lastTrick && (!snap.trick || snap.trick.length === 0)) ? snap.lastTrick : (snap.trick || []);
      const s = sig(cards.map(function (c) { return c.seat + ':' + c.card.id; }));
      if (s === this.lastTrickSig) return;
      this.lastTrickSig = s;
      UI.clearTrick();
      cards.forEach(function (c) { try { UI.placePlayed(c.seat, c.card, {}); } catch (e) {} });
      if (snap.lastTrick && (!snap.trick || snap.trick.length === 0)) {
        try { UI.highlightWinner(snap.lastWinner, snap.lastTrick[snap.lastTrick.length - 1].card.id); } catch (e) {}
      }
    },

    renderHandSafe: function (snap) {
      if (!snap.hand) return;
      const s = sig(snap.hand) + '|' + (this.awaiting && this.promptKind === 'play');
      if (s === this.lastHandSig) return;
      this.lastHandSig = s;
      if (this.awaiting && this.promptKind === 'play') return;
      UI.renderHand(snap.hand, [], false, null);
    },

    handlePrompt: function (snap) {
      if (!snap.yourTurn) { this.awaiting = false; this.promptKind = null; return; }
      const self = this;
      const p = snap.prompt;
      if (this.awaiting) return;

      if (p === 'play') {
        this.awaiting = true; this.promptKind = 'play';
        UI.renderHand(snap.hand, snap.legal, true, function (id) {
          self.net.send({ type: 'play', id: id });
          self.awaiting = false; self.promptKind = null;
        });
        return;
      }
      if (p === 'trump') {
        this.awaiting = true; this.promptKind = 'trump';
        const rec = AI.chooseTrump(snap.trumpFive);
        UI.trumpPicker(snap.trumpFive, rec).then(function (suit) {
          self.net.send({ type: 'trump', suit: suit });
          self.awaiting = false; self.promptKind = null;
        }).catch(function () { self.awaiting = false; self.promptKind = null; });
        return;
      }
      if (p === 'discard') {
        this.awaiting = true; this.promptKind = 'discard';
        UI.discardPrompt(snap.discardCount).then(function (ids) {
          self.net.send({ type: 'discard', ids: ids });
          self.awaiting = false; self.promptKind = null;
        }).catch(function () { self.awaiting = false; self.promptKind = null; });
        return;
      }
      if (p === 'draw') {
        this.awaiting = true; this.promptKind = 'draw';
        const ctx = { stock: '—', myHand: snap.hand ? snap.hand.length : 0, need: snap.hand ? (13 - snap.hand.length) : 0 };
        UI.drawChoice(snap.drawCard, ctx).then(function (keep) {
          self.net.send({ type: 'draw', keep: !!keep });
          self.awaiting = false; self.promptKind = null;
        }).catch(function () { self.awaiting = false; self.promptKind = null; });
        return;
      }
      this.promptKind = null;
    }
  };

  root.HokmOnline = Online;
})(typeof window !== 'undefined' ? window : globalThis);

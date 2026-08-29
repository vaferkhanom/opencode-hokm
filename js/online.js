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
  function otherSeat(snap, seat) { return snap.mode === 4 ? (seat + 1) % 4 : 1 - seat; }
  function initialOf(name) { return (name || '?').replace(/\s/g, '').slice(0, 1); }
  function sig(cards) { return (cards || []).map(function (c) { return c.id; }).join(','); }
  function fa(n) { try { return Cards.faNum(n); } catch (e) { return String(n); } }

  // ---- reliable clipboard that works inside Telegram webviews ----
  function copyText(text, okMsg) {
    const done = function () { try { UI.banner(okMsg || '\u06a9\u067e\u06cc \u0634\u062f', 'good', 1300); } catch (e) {} };
    const fallback = function () {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-200px;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const okExec = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        if (okExec) done();
        else UI.banner(text, 'info', 4000);
      } catch (e) { UI.banner(text, 'info', 4000); }
    };
    let handled = false;
    try {
      const t = root.Telegram && root.Telegram.WebApp;
      if (t && !t.initDataUnsafe && t.clipboardErrHandled) handled = true;
    } catch (e) {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
        handled = true;
      }
    } catch (e) {}
    if (!handled) fallback();
  }

  const Online = {
    net: null, code: null, seat: -1, isHost: false,
    built: false, awaiting: false, promptKind: null,
    lobbyEl: null, _lobbyKey: null, _slotSig: '',
    lastHandSig: null, lastTrickSig: null,
    _heShown: false, _meShown: false,
    exiting: false, layerEl: null,
    pillEl: null, pillTimer: null, deadlineTs: 0, _hapticWarned: false,
    inviteInfo: null,
    targetHands: 7, teamAssignMode: 'random',

    playerId: function () {
      try {
        let id = localStorage.getItem('hokm-pid');
        if (!id) { id = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('hokm-pid', id); }
        return id;
      } catch (e) { return 'u' + Math.random().toString(36).slice(2, 10); }
    },
    authData: function () {
      try { const t = root.Telegram && root.Telegram.WebApp; return (t && t.initData) || ''; } catch (e) { return ''; }
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
      return '';
    },
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

    // ---------------- networking ----------------
    bindNet: function (n) {
      const self = this;
      n.onStateChange(function (up) { self.setStatusDot(up); });
      n.on('welcome', function (m) {
        self.code = m.code; self.seat = m.seat; self.isHost = m.isHost;
        if (m.botUsername) root.__TG_BOT = m.botUsername;
        try { localStorage.setItem('hokm-lastcode', m.code); } catch (e) {}
        self.hideLayer();
      });
      n.on('inviteInfo', function (m) { self.showInviteSheet(m); });
      n.on('state', function (m) { self.onState(m); });
      n.on('system', function (m) { UI.banner(m.text, m.tone || 'info', 1600); });
      n.on('error', function (m) {
        if (/\u067e\u0631 \u0627\u0633\u062a|\u067e\u06cc\u062f\u0627 \u0646\u0634\u062f/.test(m.message || '')) {
          UI.banner(m.message || '\u062e\u0637\u0627', 'bad', 2400);
          // Room missing/full: return to the lobby instead of dropping the player.
          self.code = null;
          try { localStorage.removeItem('hokm-lastcode'); } catch (e) {}
          setTimeout(function () { self.renderLobbyShell(); }, 600);
          return;
        }
        UI.banner(m.message || '\u062e\u0637\u0627', 'bad', 2200);
      });
      n.on('close', function () { self.onNetClose(); });
      return n;
    },
    onNetClose: function () {
      if (this.exiting || !this.net) return;
      const wasInRoom = !!this.code && !this.lobbyEl;
      if (!wasInRoom && this.lobbyEl) {
        // lobby transport dropped: net.js auto-reconnects; buttons work via lazy send
        this.setStatusDot(false);
        return;
      }
      this.showLayer('\u0627\u062a\u0635\u0627\u0644 \u0642\u0637\u0639 \u0634\u062f \u2014 \u062f\u0631 \u062d\u0627\u0644 \u0628\u0627\u0632\u06af\u0634\u062a \u0628\u0647 \u0627\u062a\u0627\u0642\u2026');
    },
    showLayer: function (text) {
      const self = this;
      if (!this.layerEl) {
        this.layerEl = el('div', 'reconnect-layer',
          '<div class="reconnect-box"><i class="spin"></i><p class="rc-msg"></p>' +
          '<button class="btn ghost small" data-action="exit-hard">\u062e\u0631\u0648\u062c \u0627\u0632 \u0628\u0627\u0632\u06cc</button></div>');
        document.body.appendChild(this.layerEl);
      }
      this.layerMsg(text);
      this.layerEl.classList.add('on');
    },
    layerMsg: function (text) { if (this.layerEl) this.layerEl.querySelector('.rc-msg').textContent = text; },
    hideLayer: function () { if (this.layerEl) this.layerEl.classList.remove('on'); },
    setStatusDot: function (up) {
      let dot = document.getElementById('net-dot');
      if (!dot) {
        dot = el('i', '', '');
        dot.id = 'net-dot';
        document.body.appendChild(dot);
      }
      dot.classList.toggle('on', !!up);
      dot.classList.toggle('off', !up);
    },

    send: function (obj) { if (this.net) this.net.send(obj); else this.ensureNet().then(function () {}); },

    ensureNet: function () {
      if (this.net) return Promise.resolve();
      this.net = this.bindNet(new root.HokmNet());
      return this.net.connect().then(function () {
        // small delay not needed; queued messages flushed by socket open
      }).catch(function () {});
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
      this.pillEl.textContent = '\u23f1 ' + fa(left) + ' \u062b\u0627\u0646\u06cc\u0647';
      const danger = left <= 15;
      this.pillEl.classList.toggle('danger', danger);
      this.pillEl.classList.remove('hidden');
      if (danger && !this._hapticWarned) {
        this._hapticWarned = true;
        try { UI.banner('\u0639\u062c\u0644\u0647 \u06a9\u0646!', 'warn', 1100); UI.haptic && UI.haptic('warn'); } catch (e) {}
      }
    },

    // ---------------- sheets ----------------
    sheetOpen: function (html) {
      this.sheetClose();
      const ov = el('div', 'sheet-layer on', el('div', 'sheet', html).outerHTML);
      document.body.appendChild(ov);
      this._sheet = ov;
      return ov.querySelector('.sheet');
    },
    sheetClose: function () { if (this._sheet) { this._sheet.remove(); this._sheet = null; } },

    showInviteSheet: function (m) {
      this.inviteInfo = m;
      const self = this;
      const sh = this.sheetOpen(
        '<h3>\u062f\u0639\u0648\u062a \u062f\u0648\u0633\u062a</h3>' +
        '<div class="copy-row code-chip" data-copy="' + m.code + '" data-action="copy" role="button">' +
        '  <b>' + m.code + '</b><span class="tap-hint">\u0628\u0631\u0627\u06cc \u06a9\u067e\u06cc \u0628\u0632\u0646</span></div>' +
        '<div class="copy-row inv-link mono" data-copy="' + (m.tgUrl || '') + '" data-action="copy">' +
        '  <span class="lbl">\u0644\u06cc\u0646\u06a9 \u062f\u0639\u0648\u062a (\u062a\u0644\u06af\u0631\u0627\u0645)</span>' +
        '  <span class="val">' + (m.tgUrl ? 't.me/' + String(m.tgUrl).split('t.me/')[1] : '') + '</span></div>' +
        '<div class="row-btns">' +
        '  <button class="btn text-gold grow" data-action="share-tg">\u0641\u0631\u0633\u062a\u0627\u062f\u0646 \u062f\u0631 \u0686\u062a</button>' +
        '  <button class="btn ghost" data-action="close-sheet">\u0628\u0633\u062a\u0646</button></div>');
      // store for share button
      this._inviteUrl = m.tgUrl || '';
      this._inviteText = '\u0628\u06cc\u0627 \u062d\u064f\u06a9\u0645 \u0622\u0646\u0644\u0627\u06cc\u0646! \u06a9\u062f \u0627\u062a\u0627\u0642: ' + m.code;
      try { Snd.play('click'); } catch (e) {}
    },

    showJoinConfirm: function (code) {
      const self = this;
      const sh = this.sheetOpen(
        '<h3>\u0648\u0631\u0648\u062f \u0628\u0647 \u0644\u0627\u0628\u06cc\u061f</h3>' +
        '<p class="sub">\u0628\u0627 \u06a9\u062f <b class="mono gold">' + code + '</b> \u0628\u0647 \u0627\u062a\u0627\u0642 \u062f\u0639\u0648\u062a \u0634\u062f\u06cc. \u0645\u0644\u062d\u0642 \u0645\u06cc\u200f\u0634\u0648\u06cc\u061f</p>' +
        '<div class="row-btns">' +
        '  <button class="btn ghost" data-action="no-join">\u0646\u0647</button>' +
        '  <button class="btn emerald" data-action="yes-join" data-code="' + code + '">\u0628\u0644\u0647\u060c \u0645\u0644\u062d\u0642 \u0634\u0648</button></div>');
      Snd.play('click');
    },

    // ---------------- lifecycle ----------------
    startOnline: function () {
      const self = this;
      Snd.play('click');
      this.exiting = false;
      this.ensurePill();
      UI.clearRoot();
      UI.showScreen && UI.showScreen('menu');
      this.ensureNet().then(function () {
        const room = self.inviteCodeFromUrl();
        if (room && !self._confirmShown) {
          self._confirmShown = true;
          self.showJoinConfirm(room);
          return;
        }
        // After a reload, jump straight back into the last room if it still exists.
        let last = null;
        try { last = localStorage.getItem('hokm-lastcode'); } catch (e) {}
        if (last && /^[A-Z0-9]{6}$/i.test(last)) {
          self.joinByCode(last);
          return;
        }
        self.renderLobbyShell();
      });
    },
    create: function (mode) {
      const self = this;
      this.ensureNet().then(function () {
        self.net.send({ type: 'create', mode: mode, playerId: self.playerId(), name: self.name(), initData: self.authData(),
          targetHands: self.targetHands, teamAssignMode: self.teamAssignMode });
      });
    },
    joinByCode: function (code) {
      this.ensureNet();
      this.net.send({ type: 'join', code: String(code || '').toUpperCase(), playerId: this.playerId(), name: this.name(), initData: this.authData() });
    },
    leaveLobby: function () {
      if (this.net) this.net.send({ type: 'leave' });
      try { localStorage.removeItem('hokm-lastcode'); } catch (e) {}
      if (App) App.toMenu();
      this.teardown(true);
    },
    requestExit: function () {
      if (this.exiting) return Promise.resolve(false);
      if (!this.code || this.stateIsLobby()) { this.leaveLobby(); return Promise.resolve(false); }
      Snd.play('click');
      const self = this;
      return UI.confirmExit().then(function (yes) { if (yes) self.doExit(true); return yes; });
    },
    stateIsLobby: function () { return !!(this.lobbyEl); },
    doExit: function (sendLeave) {
      this.exiting = true;
      if (sendLeave && this.net && this.net.isLive()) this.net.send({ type: 'leave' });
      try { localStorage.removeItem('hokm-lastcode'); } catch (e) {}
      if (App) App.toMenu();
      this.teardown(true);
      setTimeout(function () { window.__hokmExitDone = true; }, 0);
    },
    teardown: function (hard) {
      this.sheetClose();
      this.hideLayer();
      if (hard && this.net) this.net.destroy();
      else if (this.net && this.net.ws) { try { this.net.ws.close(); } catch (e) {} }
      if (hard) { this.net = null; try { localStorage.removeItem('hokm-lastcode'); } catch (e) {} }
      this.code = null; this.seat = -1; this.isHost = false;
      this.built = false; this.lobbyEl = null; this._lobbyKey = null;
      this.lastHandSig = null; this.lastTrickSig = null;
      this._heShown = false; this._meShown = false; this.awaiting = false;
      this.promptKind = null; this.deadlineTs = 0;
    },

    // ---------------- delegated actions ----------------
    actions: {
      'create-2p': function () { Online.create(2); },
      'create-4p': function () { Online.create(4); },
      'join-input': function (btn) {
        const inp = document.getElementById('lob-code');
        const v = inp ? inp.value.trim() : '';
        if (/^[A-Z0-9]{6}$/i.test(v)) Online.joinByCode(v);
        else UI.banner('\u06a9\u062f 6 \u0631\u0642\u0645\u06cc/\u062d\u0631\u0641\u06cc \u0628\u0647 \u0644\u0627\u062a\u06cc\u0646', 'warn', 1800);
      },
      'back-menu': function () { Online.leaveLobby(); },
      'start': function () { Online.net.send({ type: 'start' }); },
      'set-target': function (btn) {
        const v = Number(btn.getAttribute('data-val'));
        if (v === 3 || v === 5 || v === 7) {
          Online.targetHands = v;
          Online.net.send({ type: 'setTargetHands', targetHands: v, playerId: Online.playerId(), initData: Online.authData() });
          // update UI
          document.querySelectorAll('[data-action="set-target"]').forEach(function (b) { b.classList.toggle('sel', Number(b.getAttribute('data-val')) === v); });
        }
      },
      'set-team-assign': function (btn) {
        const v = btn.getAttribute('data-val');
        if (v === 'random' || v === 'manual') {
          Online.teamAssignMode = v;
          Online.net.send({ type: 'setTeamAssign', mode: v, playerId: Online.playerId(), initData: Online.authData() });
          document.querySelectorAll('[data-action="set-team-assign"]').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-val') === v); });
        }
      },
      'invite': function () {
        const code = Online.code;
        copyText('https://t.me/' + (root.__TG_BOT || 'Echohokmbot') + '?startapp=' + code, '\u0644\u06cc\u0646\u06a9 \u062f\u0639\u0648\u062a \u06a9\u067e\u06cc \u0634\u062f');
        Online.net.send({ type: 'invite', code: code }); // refresh canonical links server-side
      },
      'copy': function (elm) {
        const txt = elm.getAttribute('data-copy') || elm.textContent.trim();
        copyText(txt, '\u06a9\u067e\u06cc \u0634\u062f');
        elm.classList.add('copied');
        setTimeout(function () { elm.classList.remove('copied'); }, 900);
      },
      'close-sheet': function () { Online.sheetClose(); },
      'yes-join': function (elm) { Online.sheetClose(); Online.joinByCode(elm.getAttribute('data-code')); },
      'no-join': function () { Online.sheetClose(); Online.renderLobbyShell(); },
      'exit-hard': function () { Online.doExit(true); },
      'exit-confirm': function () { Online.requestExit(); }
    },
    initDelegation: function () {
      const self = this;
      if (self._delegated) return;
      self._delegated = true;
      root.__TG_BOT = (function () { try { return (window.TELEGRAM_BOT_USERNAME) || 'Echohokmbot'; } catch (e) { return 'Echohokmbot'; } })();
      document.addEventListener('click', function (ev) {
        let t = ev.target;
        while (t && t !== document.body) {
          const act = t.getAttribute && t.getAttribute('data-action');
          if (act) { ev.preventDefault(); ev.stopPropagation(); const fn = self.actions[act]; if (fn) fn(t, ev); return; }
          t = t.parentNode;
        }
      }, { passive: false });
    },

    // ---------------- lobby (build once, patch after) ----------------
    renderLobbyShell: function () {
      UI.clearRoot();
      const scr = el('section', 'screen lobby on');
      scr.innerHTML =
        '<h1 class="lobby-title">\u0628\u0627\u0632\u06cc \u0622\u0646\u0644\u0627\u06cc\u0646</h1>' +
        '<p class="lobby-sub">اتاق بساز یا با کد ملحق شو</p>' +
        '<div class="lobby-actions">' +
        '  <button class="btn text-gold wide" data-action="create-2p">\u0633\u0627\u062e\u062a \u0628\u0627\u0632\u06cc 2 \u0646\u0641\u0631\u0647</button>' +
          '  <button class="btn text-gold wide" data-action="create-4p">\u0633\u0627\u062e\u062a \u0628\u0627\u0632\u06cc 4 \u0646\u0641\u0631\u0647</button>' +
        '</div>' +
        '<div class="lobby-join">' +
        '  <input id="lob-code" class="code-in" maxlength="6" placeholder="\u06a9\u062f \u0627\u062a\u0627\u0642" autocomplete="off" autocapitalize="characters" />' +
        '  <button class="btn emerald" data-action="join-input">\u0645\u0644\u062d\u0635</button>' +
        '</div>' +
        '<div id="lob-room"></div>' +
        '<button class="btn ghost wide" data-action="back-menu">\u0628\u0627\u0632\u06af\u0634\u062a \u0628\u0647 \u0645\u0646\u0648</button>';
      UI.root.appendChild(scr);
      UI.screenEl = scr;
      this.lobbyEl = scr;
    },

    onLobbyState: function (snap) {
      const key = snap.code + ':' + snap.mode;
      if (!this.lobbyEl) this.renderLobbyShell();
      if (this._lobbyKey !== key) {
        this._lobbyKey = key;
        const th = snap.targetHands || 7;
        const tam = snap.teamAssignMode || 'random';
        this.targetHands = th;
        this.teamAssignMode = tam;
        const box = this.lobbyEl.querySelector('#lob-room');
        box.innerHTML =
          '<div class="lobby-room">' +
          '  <div class="room-code-head">' +
          '    <span class="lbl">\u06a9\u062f \u0627\u062a\u0627\u0642</span>' +
          '    <div class="code-chip" role="button" data-copy="' + snap.code + '" data-action="copy"><b>' + snap.code + '</b><i>\u2756</i></div>' +
          '    <span class="rc-hint">\u0628\u0632\u0646 \u062a\u0627 \u06a9\u067e\u06cc \u0634\u0647</span>' +
          '  </div>' +
          '  <div class="share-row">' +
          '    <button class="btn text-gold grow" data-action="invite">\u062f\u0639\u0648\u062a \u062f\u0648\u0633\u062a</button>' +
          '    <button class="btn ghost grow" data-action="copy" data-copy="https://t.me/' + (root.__TG_BOT || 'Echohokmbot') + '?startapp=' + snap.code + '">\u06a9\u067e\u06cc \u0644\u06cc\u0646\u06a9 \u062a\u0644\u06af\u0631\u0627\u0645</button>' +
          '  </div>' +
          '  <div class="lobby-opts" id="lob-opts">' +
          '    <div class="opt-row">' +
          '      <span class="opt-lbl">\u062a\u0639\u062f\u0627\u062f \u062f\u0633\u062a</span>' +
          '      <div class="opt-btns">' +
          '        <button class="opt-btn' + (th === 3 ? ' sel' : '') + '" data-action="set-target" data-val="3">3</button>' +
          '        <button class="opt-btn' + (th === 5 ? ' sel' : '') + '" data-action="set-target" data-val="5">5</button>' +
          '        <button class="opt-btn' + (th === 7 ? ' sel' : '') + '" data-action="set-target" data-val="7">7</button>' +
          '      </div></div>' +
          (snap.mode === 4 ? '    <div class="opt-row">' +
          '      <span class="opt-lbl">\u062a\u06cc\u0645 \u0628\u0646\u062f\u06cc</span>' +
          '      <div class="opt-btns">' +
          '        <button class="opt-btn' + (tam === 'random' ? ' sel' : '') + '" data-action="set-team-assign" data-val="random">\u062a\u0635\u0627\u062f\u0641\u06cc</button>' +
          '        <button class="opt-btn' + (tam === 'manual' ? ' sel' : '') + '" data-action="set-team-assign" data-val="manual">\u062f\u0633\u062a\u06cc</button>' +
          '      </div></div>' : '') +
          '  </div>' +
          '  <div class="slots" id="lob-slots"></div>' +
          '  <div id="lob-cta"></div>' +
          '</div>';
        this._slotSig = '';
      }
      // update options if they changed
      var optsEl = this.lobbyEl.querySelector('#lob-opts');
      if (optsEl) {
        var newTh = snap.targetHands || 7;
        var newTam = snap.teamAssignMode || 'random';
        if (this.targetHands !== newTh || this.teamAssignMode !== newTam) {
          this.targetHands = newTh;
          this.teamAssignMode = newTam;
          optsEl.querySelectorAll('[data-action="set-target"]').forEach(function (b) { b.classList.toggle('sel', Number(b.getAttribute('data-val')) === newTh); });
          optsEl.querySelectorAll('[data-action="set-team-assign"]').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-val') === newTam); });
        }
      }
      // slots patch (only when changed)
      let sigStr = '', html = '';
      snap.seats.forEach(function (s, i) {
        if (s.empty) { sigStr += 'e'; html += '<div class="slot empty">\u0635\u0646\u062f\u0644\u06cc \u062e\u0627\u0644\u06cc</div>'; }
        else {
          sigStr += s.isBot ? 'B' : (s.connected ? 'H' : 'h');
          html += '<div class="slot' + (s.isBot ? ' bot' : '') + (s.connected ? '' : ' off') + '">' +
            s.name + (s.isYou ? ' (\u0634\u0645\u0627)' : '') + '</div>';
        }
      });
      if (sigStr !== this._slotSig) {
        this._slotSig = sigStr;
        const slots = this.lobbyEl.querySelector('#lob-slots');
        if (slots) slots.innerHTML = html;
      }
      // CTA area (wait note / start button) — patched wholesale, safe: not during taps mid-flight? acceptable, guarded by change-check below
      const full = snap.seats.every(function (s) { return !s.empty; });
      let ctaSig = 'w';
      if (full) ctaSig = 'start';
      else ctaSig = 'bots' + (this.isHost ? '1' : '0') + 'wait';
      const cta = this.lobbyEl.querySelector('#lob-cta');
      if (cta && cta.dataset.sig !== ctaSig) {
        cta.dataset.sig = ctaSig;
        if (full) cta.innerHTML = '<button class="btn text-gold wide" data-action="start">\u0634\u0631\u0648\u0639 \u0628\u0627\u0632\u06cc</button>';
        else cta.innerHTML =
          (this.isHost ? '<button class="btn emerald wide" data-action="start">\u0634\u0631\u0648\u0639 \u0628\u0627 \u0631\u0628\u0627\u062a\u200f\u0647\u0627</button>' : '<div class="lobby-wait">\u062f\u0631 \u0627\u0646\u062a\u0638\u0627\u0631 \u0628\u0627\u0632\u06cc\u06a9\u0646\u2026 \u0644\u06cc\u0646\u06a9 \u062f\u0639\u0648\u062a \u0631\u0627 \u0628\u0641\u0631\u0633\u062a</div>');
      }
    },

    // ---------------- game ----------------
    onState: function (snap) {
      if (snap.state === 'lobby') { this.onLobbyState(snap); return; }
      if (this.lobbyEl) { this.lobbyEl.remove(); this.lobbyEl = null; this._lobbyKey = null; this.sheetClose(); }
      if (!this.built) this.buildGame(snap);
      this.applyCommon(snap);
      this.renderTrick(snap);
      this.renderHandSafe(snap);
      this.handlePrompt(snap);

      if (snap.state === 'handEnd' && !this._heShown && snap.handResult) {
        this._heShown = true;
        UI.handEndOverlay(snap.handResult);
      }
      if (snap.state === 'playing' && this._heShown) { UI.closeModal && UI.closeModal(); this._heShown = false; }
      if (snap.state === 'matchOver' && !this._meShown) {
        this._meShown = true;
        const self = this;
        UI.matchEndOverlay(snap.handResult || {}).then(function (action) {
          if (action === 'again') self.net.send({ type: 'start' });
          else self.doExit(true);
        });
      }
    },
    buildGame: function (snap) {
      const names = snap.seats.map(function (s) { return { name: s.name, initial: initialOf(s.name) }; });
      UI.buildGame({ mode: snap.mode, names: names, usSide: snap.seats[snap.you].side });
      UI.setTarget(snap.target);
      const scr = UI.screenEl;
      scr.querySelector('#g-exit').setAttribute('data-action', 'exit-confirm');
      scr.querySelector('#g-exit').removeAttribute('id');
      const help = scr.querySelector('#g-help');
      if (help) help.addEventListener('click', function () { UI.rulesModal(); });
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
          node.classList.toggle('off', !!s.connected ? false : true);
          node.classList.toggle('is-bot', !!s.isBot);
          let chip = node.querySelector('.strike-chip');
          if (s.strikes > 0) {
            if (!chip) { chip = el('span', 'strike-chip'); const h = node.querySelector('.badges') || node; h.appendChild(chip); }
            chip.innerHTML = '\u26a0 ' + fa(s.strikes);
          } else if (chip) chip.remove();
        }
      });
      const mySide = snap.seats[snap.you].side;
      UI.updateScores(snap.scores[mySide], snap.scores[1 - mySide]);
      UI.setHandNo(snap.handNo);
      UI.setTrumpChip(snap.trump);
      if (snap.turn != null && snap.turn >= 0) UI.setTurn(snap.turn);
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
          self.net.send({ type: 'trump', suit: suit }); self.awaiting = false; self.promptKind = null;
        }).catch(function () { self.awaiting = false; self.promptKind = null; });
        return;
      }
      if (p === 'discard') {
        this.awaiting = true; this.promptKind = 'discard';
        UI.discardPrompt(snap.discardCount).then(function (ids) {
          self.net.send({ type: 'discard', ids: ids }); self.awaiting = false; self.promptKind = null;
        }).catch(function () { self.awaiting = false; self.promptKind = null; });
        return;
      }
      if (p === 'draw') {
        this.awaiting = true; this.promptKind = 'draw';
        const ctx = { stock: '\u2014', myHand: snap.hand ? snap.hand.length : 0, need: snap.hand ? (13 - snap.hand.length) : 0 };
        UI.drawChoice(snap.drawCard, ctx).then(function (keep) {
          self.net.send({ type: 'draw', keep: !!keep }); self.awaiting = false; self.promptKind = null;
        }).catch(function () { self.awaiting = false; self.promptKind = null; });
        return;
      }
      this.promptKind = null;
    }
  };

  root.HokmOnline = Online;
  if (typeof document !== 'undefined') {
    const boot = function () { Online.initDelegation(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);

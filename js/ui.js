(function (root) {
  'use strict';

  const Cards = root.HokmCards;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function center(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const UI = {
    reduced: false,
    speed: 1,

    init: function () {
      this.root = document.getElementById('app');
      this.fxLayer = document.getElementById('fx');
      this.reduced = !!(root.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      root.addEventListener('resize', function () { UI.layoutHand(); });
    },

    el: el,
    fa: function (n) { return Cards.faNum(n); },
    trump: null,
    wait: function (ms) {
      let d = Math.max(0, ms * UI.speed);
      if (UI.reduced) d = Math.min(d, 120);
      return new Promise(function (r) { setTimeout(r, d); });
    },

    anim: function (node, frames, opts) {
      opts = opts || {};
      if (this.reduced || !node.animate) {
        const last = frames[frames.length - 1];
        for (const k in last) node.style[k] = last[k];
        return Promise.resolve();
      }
      return new Promise(function (res) {
        const a = node.animate(frames, Object.assign({ easing: 'cubic-bezier(.22,.9,.3,1)', fill: 'both' }, opts));
        a.onfinish = res;
        a.oncancel = res;
      });
    },

    rectOf: function (node) { return node.getBoundingClientRect(); },
    centerOf: function (node) { return center(node.getBoundingClientRect()); },

    cardEl: function (card, faceUp, sizeCls) {
      const c = el('div', 'card' + (faceUp ? '' : ' is-back') + (sizeCls ? ' ' + sizeCls : ''));
      if (card && faceUp) {
        c.classList.add(Cards.RED[card.suit] ? 'red' : 'blk');
        c.dataset.id = card.id;
        const sym = Cards.SUIT_SYM[card.suit];
        const lab = Cards.rankLabel(card.rank);
        c.innerHTML =
          '<div class="cor tr"><b>' + lab + '</b><i>' + sym + '</i></div>' +
          '<div class="pip">' + sym + '</div>' +
          '<div class="cor bl"><b>' + lab + '</b><i>' + sym + '</i></div>';
        if (card.rank === 14 || card.rank === 13) c.classList.add('royal');
      }
      return c;
    },

    ghostCard: function (card, atC, faceUp, scale) {
      const g = this.cardEl(card, faceUp, '');
      g.classList.add('ghost');
      g.style.position = 'fixed';
      g.style.zIndex = '60';
      g.style.setProperty('--gs', scale == null ? 1 : scale);
      this.fxLayer.appendChild(g);
      const w = g.offsetWidth || 66;
      const h = g.offsetHeight || 92;
      g.style.left = (atC.x - w / 2) + 'px';
      g.style.top = (atC.y - h / 2) + 'px';
      return g;
    },

    flyGhost: async function (card, fromC, toC, opts) {
      opts = opts || {};
      const g = this.ghostCard(card, fromC, !!opts.faceUp, opts.scale != null ? opts.scale : 0.9);
      const dx = toC.x - fromC.x;
      const dy = toC.y - fromC.y;
      await this.anim(g, [
        { transform: 'translate(0,0) rotate(' + (opts.rot0 || 0) + 'deg) scale(' + (opts.scale0 != null ? opts.scale0 : 0.7) + ')', opacity: '0.95' },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (opts.rot1 || 0) + 'deg) scale(' + (opts.scale1 != null ? opts.scale1 : 1) + ')', opacity: opts.fadeOut ? '0' : '1' }
      ], { duration: opts.dur || 360 });
      g.remove();
    },

    showScreen: function (name) {
      document.querySelectorAll('.screen').forEach(function (s) {
        s.classList.toggle('on', s.dataset.scr === name);
      });
    },

    clearRoot: function (keepFx) {
      Array.from(this.root.children).forEach(function (c) { c.remove(); });
      if (!keepFx) this.fxLayer.innerHTML = '';
      this.closeModal(true);
    },

    buildMenu: function (stats) {
      const scr = el('section', 'screen menu on');
      scr.dataset.scr = 'menu';
      const fan = el('div', 'menu-fan');
      ['S', 'H', 'D'].forEach(function (s, i) {
        const b = UI.cardEl(null, false);
        b.classList.add('fan-card', 'f' + i);
        fan.appendChild(b);
      });
      const wrap = el('div', 'menu-inner');
      wrap.innerHTML =
        '<div class="brand"><span class="kicker">بازی ورقِ محبوب ایرانی</span>' +
        '<h1 class="logo">حُـکم</h1>' +
        '<p class="tag">حاکم شو، حکم بگو، هفت دست ببر</p></div>';
      const btns = el('div', 'menu-btns');
      const mk = function (id, cls, html, sub) {
        const b = el('button', 'btn big ' + cls);
        b.id = id;
        b.innerHTML = '<span class="bt">' + html + '</span>' + (sub ? '<span class="bs">' + sub + '</span>' : '');
        return b;
      };
      btns.appendChild(mk('btn-4p', 'gold', 'چهارنفره', 'با یار، روبه‌روی هم'));
      btns.appendChild(mk('btn-2p', 'emerald', 'دونفره', 'نبرد تک‌به‌تک'));
      btns.appendChild(mk('btn-online', 'sky', 'آنلاین', 'ساخت اتاق و دعوت دوست'));
      const row = el('div', 'menu-row');
      row.appendChild(mk('btn-rules', 'ghost sm', 'قوانین'));
      row.appendChild(mk('btn-set', 'ghost sm', 'تنظیمات'));
      btns.appendChild(row);
      let statLine = '';
      if (stats && (stats.w > 0 || stats.l > 0)) {
        statLine = '<div class="stat-line">برد <b>' + UI.fa(stats.w) + '</b> · باخت <b>' + UI.fa(stats.l) + '</b> · کوت <b>' + UI.fa(stats.kot || 0) + '</b></div>';
      }
      wrap.appendChild(btns);
      wrap.appendChild(el('div', 'stat-slot', statLine));
      wrap.appendChild(el('footer', 'menu-foot', 'مخصوص تلگرام · فارسی · چندنفره'));
      scr.appendChild(fan);
      scr.appendChild(wrap);
      this.root.appendChild(scr);
      this.showScreen('menu');
      return scr;
    },

    buildGame: function (cfg) {
      this.cfg = cfg;
      const mode = cfg.mode;
      this.mode = mode;
      const scr = el('section', 'screen game on');
      scr.dataset.scr = 'game';

      const hud = el('header', 'hud');
      hud.innerHTML =
        '<div class="hud-top">' +
        '<button class="icon-btn" id="g-exit" aria-label="منو">⌂</button>' +
        '<div class="pills">' +
        '<div class="pill us"><span class="pl" id="pl-us-name">ما</span><b id="pl-us">۰</b></div>' +
        '<span class="vs">✕</span>' +
        '<div class="pill them"><b id="pl-them">۰</b><span class="pl" id="pl-them-name">حریف</span></div>' +
        '</div>' +
        '<button class="icon-btn" id="g-help" aria-label="قوانین">؟</button>' +
        '</div>' +
        '<div class="hud-sub">' +
        '<span class="chip" id="chip-hand">دست —</span>' +
        '<span class="chip target" id="chip-target"></span>' +
        '<span class="chip trump-chip hidden" id="chip-trump"></span>' +
        '</div>';
      scr.appendChild(hud);

      const tw = el('div', 'table-wrap');
      const felt = el('div', 'felt');
      felt.innerHTML = '<div class="felt-ring r1"></div><div class="felt-ring r2"></div>';
      felt.id = 'felt';

      this.sealBox = el('div', 'seal-box hidden');
      this.sealBox.id = 'seal';
      felt.appendChild(this.sealBox);

      this.trickArea = el('div', 'trick-area');
      felt.appendChild(this.trickArea);

      this.coinsUs = el('div', 'coins coins-us');
      this.coinsThem = el('div', 'coins coins-them');
      felt.appendChild(this.coinsUs);
      felt.appendChild(this.coinsThem);

      this.piles = el('div', 'piles hidden');
      this.piles.innerHTML =
        '<div class="pile stock" id="pile-stock"><span class="pc" id="stock-n"></span></div>' +
        '<div class="pile burn" id="pile-burn"><span class="pc" id="burn-n"></span></div>';
      felt.appendChild(this.piles);

      this.ceremonyRow = el('div', 'ceremony-row hidden');
      felt.appendChild(this.ceremonyRow);

      tw.appendChild(felt);

      for (let s = 1; s <= 3; s++) {
        if (mode === 2 && s !== 2) continue;
        const seat = el('div', 'seat pos-' + s);
        seat.dataset.seat = String(s);
        seat.innerHTML =
          '<div class="avatar"><span class="av-in"></span><i class="ring"></i></div>' +
          '<div class="sname"></div>' +
          '<div class="badges"></div>';
        tw.appendChild(seat);
      }
      const meSeat = el('div', 'seat me pos-0');
      meSeat.dataset.seat = '0';
      meSeat.innerHTML =
        '<div class="badges"></div><div class="sname"></div>' +
        '<div class="avatar"><span class="av-in"></span><i class="ring"></i></div>';
      tw.appendChild(meSeat);
      scr.appendChild(tw);

      const hz = el('div', 'hand-zone');
      this.dock = el('div', 'dock', '');
      this.dock.id = 'dock';
      this.handBox = el('div', 'hand');
      this.handBox.id = 'hand';
      hz.appendChild(this.dock);
      hz.appendChild(this.handBox);
      scr.appendChild(hz);

      this.root.appendChild(scr);
      this.screenEl = scr;

      for (let s = 0; s < mode; s++) {
        this.setSeatName(s, cfg.names[s].name, cfg.names[s].initial);
      }
      this.renderCoins([0, 0]);
      this.setTrumpChip(null);
      this.setDockText('');
      return scr;
    },

    destroyGame: function () {
      if (this.screenEl) { this.screenEl.remove(); this.screenEl = null; }
    },

    seatNode: function (seat) {
      return this.screenEl.querySelector('.seat[data-seat="' + seat + '"]');
    },

    setSeatName: function (seat, name, initial) {
      const n = this.seatNode(seat);
      if (!n) return;
      n.querySelector('.sname').textContent = name;
      n.querySelector('.av-in').textContent = initial || name.slice(0, 1);
    },

    setRoles: function (hakem, dealer) {
      const map = {};
      for (let s = 0; s < this.mode; s++) map[s] = [];
      if (map[hakem]) map[hakem].push('<span class="badge crown">حاکم</span>');
      if (dealer != null && dealer !== hakem && map[dealer]) map[dealer].push('<span class="badge dl">دیلر</span>');
      for (const sStr in map) {
        const n = this.seatNode(+sStr);
        if (!n) continue;
        n.querySelector('.badges').innerHTML = map[sStr].join('');
      }
    },

    setTurn: function (seat) {
      this.screenEl.querySelectorAll('.seat').forEach(function (n) {
        n.classList.toggle('turn', n.dataset.seat === String(seat));
      });
      this.handZoneActive(seat === 0);
    },

    handZoneActive: function (on) {
      const hz = this.screenEl.querySelector('.hand-zone');
      if (hz) hz.classList.toggle('my-turn', !!on);
    },

    updateScores: function (us, them) {
      document.getElementById('pl-us').textContent = this.fa(us);
      document.getElementById('pl-them').textContent = this.fa(them);
      [['pl-us', us], ['pl-them', them]].forEach(function (p) {
        const n = document.getElementById(p[0]);
        n.classList.remove('pop');
        void n.offsetWidth;
        n.classList.add('pop');
      });
    },

    setHandNo: function (n) {
      const c = document.getElementById('chip-hand');
      if (c) c.textContent = 'دست ' + this.fa(n);
    },

    setTarget: function (t) {
      const c = document.getElementById('chip-target');
      if (c) c.textContent = 'تا ' + this.fa(t) + ' امتیاز';
    },

    setTrumpChip: function (suit) {
      this.trump = suit || null;
      const chip = document.getElementById('chip-trump');
      if (!chip) return;
      if (!suit) { chip.classList.add('hidden'); return; }
      chip.classList.remove('hidden');
      chip.innerHTML = 'حکم <b class="' + (Cards.RED[suit] ? 'rs' : 'bs') + '">' + Cards.SUIT_SYM[suit] + ' ' + Cards.SUIT_FA[suit] + '</b>';
    },

    sealStamp: async function (suit) {
      const box = this.sealBox;
      box.classList.remove('hidden');
      box.innerHTML =
        '<div class="seal"><div class="seal-ring"></div>' +
        '<span class="seal-suit ' + (Cards.RED[suit] ? 'red' : 'blk') + '">' + Cards.SUIT_SYM[suit] + '</span>' +
        '<span class="seal-word">حُکم</span></div>' +
        '<i class="ripple"></i>';
      this.setTrumpChip(suit);
      root.HokmSound.play('stamp');
      this.haptic('heavy');
      await this.wait(620);
    },

    renderCoins: function (tricks) {
      const draw = function (box, count) {
        box.innerHTML = '';
        for (let i = 0; i < 7; i++) {
          const d = el('i', 'coin' + (i < count ? ' on' : ''));
          box.appendChild(d);
        }
        const lbl = el('span', 'coin-lbl', UI.fa(count));
        box.appendChild(lbl);
      };
      if (this.coinsUs) draw(this.coinsUs, tricks[this.cfg.usSide]);
      if (this.coinsThem) draw(this.coinsThem, tricks[1 - this.cfg.usSide]);
    },

    bumpCoin: function (sideIdx, tricks) {
      this.renderCoins(tricks);
      const box = sideIdx === this.cfg.usSide ? this.coinsUs : this.coinsThem;
      const lastOn = box.querySelectorAll('.coin.on');
      const target = lastOn[lastOn.length - 1];
      if (target) {
        target.classList.add('fresh');
        root.HokmSound.play('star');
      }
    },

    layoutHand: function () {
      const box = this.handBox;
      if (!box) return;
      const cards = Array.prototype.slice.call(box.querySelectorAll('.hcard'));
      const n = cards.length;
      if (!n) return;
      const W = box.clientWidth || 340;
      const cw = cards[0].offsetWidth || 64;
      const step = Math.min(cw * 0.62, n > 1 ? (W - cw) / (n - 1) : 0);
      const c = (n - 1) / 2;
      cards.forEach(function (node, i) {
        const off = i - c;
        const x = off * step;
        const y = Math.pow(Math.abs(off), 1.55) * 2.4;
        const rot = Math.max(-14, Math.min(14, off * 3.2));
        node.style.setProperty('--tx', x.toFixed(1) + 'px');
        node.style.setProperty('--ty', y.toFixed(1) + 'px');
        node.style.setProperty('--rr', rot.toFixed(1) + 'deg');
        node.style.zIndex = String(i + 1);
      });
    },

    renderHand: function (cardsArr, legalIds, enabled, onPlay) {
      const box = this.handBox;
      box.innerHTML = '';
      this._handCb = onPlay || null;
      const sorted = Cards.sortHand(cardsArr, this.trump);
      sorted.forEach(function (c) {
        const w = el('div', 'hcard');
        const ce = UI.cardEl(c, true);
        w.appendChild(ce);
        if (legalIds && !legalIds.has(c.id)) w.classList.add('dim');
        else w.classList.add('ok');
        if (!enabled) w.classList.add('locked');
        w.addEventListener('click', function () {
          if (w.classList.contains('locked') || w.classList.contains('dim')) {
            w.classList.add('nope');
            root.HokmSound.play('click');
            UI.haptic('error');
            setTimeout(function () { w.classList.remove('nope'); }, 320);
            return;
          }
          if (UI._discardMode) {
            const sel = box.querySelectorAll('.hcard.sel');
            const maxN = UI._discardNeed;
            if (w.classList.contains('sel')) {
              w.classList.remove('sel');
            } else if (sel.length < maxN) {
              w.classList.add('sel');
              root.HokmSound.play('select');
              UI.haptic('light');
            } else {
              UI.haptic('error');
            }
            if (UI._discardRefresh) UI._discardRefresh(box.querySelectorAll('.hcard.sel').length);
            return;
          }
          if (UI._handCb) {
            root.HokmSound.play('place');
            UI.haptic('medium');
            UI._handCb(c.id, w);
          }
        });
        box.appendChild(w);
      });
      this.layoutHand();
      requestAnimationFrame(function () {
        box.querySelectorAll('.hcard').forEach(function (n, i) {
          n.style.animationDelay = (i * 26) + 'ms';
          n.classList.add('dealt');
        });
      });
    },

    removeHandCard: function (id) {
      const node = this.handBox.querySelector('.card[data-id="' + id + '"]');
      if (node) node.parentElement.remove();
      this.layoutHand();
    },

    selectedDiscardIds: function () {
      return Array.from(this.handBox.querySelectorAll('.hcard.sel .card')).map(function (c) { return c.dataset.id; });
    },

    enterDiscardMode: function (count, refresh) {
      this._discardMode = true;
      this._discardNeed = count;
      this._discardRefresh = refresh;
      this.handBox.querySelectorAll('.hcard').forEach(function (n) {
        n.classList.remove('locked', 'ok', 'dim');
        n.classList.add('pickable');
      });
    },

    exitDiscardMode: function () {
      this._discardMode = false;
      this.handBox.querySelectorAll('.hcard').forEach(function (n) { n.classList.remove('pickable', 'sel'); });
    },

    flyFromHandToTrick: function (id, seat, cardData) {
      const srcNode = this.handBox.querySelector('[data-id="' + id + '"]');
      const fromR = srcNode ? srcNode.getBoundingClientRect() : this.rectOf(this.feltCenterAnchor());
      if (srcNode) srcNode.parentElement.remove();
      this.layoutHand();
      const placed = this.placePlayed(seat, cardData, { fromRect: fromR });
      return placed;
    },

    feltCenterAnchor: function () {
      return this.trickArea;
    },

    TSLOT_OFF: { 0: [8, 54], 1: [62, -6], 2: [0, -58], 3: [-62, -6] },
    TSLOT_ROT: { 0: 3, 1: -7, 2: -3, 3: 8 },

    placePlayed: function (seat, cardData, opts) {
      opts = opts || {};
      const off = this.TSLOT_OFF[seat] || [0, 0];
      const rot = this.TSLOT_ROT[seat] || 0;
      const dirRot = (seat === 1 ? -18 : seat === 3 ? 18 : seat === 2 ? -8 : 6);
      const slot = el('div', 'tslot tslot-' + seat);
      slot.appendChild(this.cardEl(cardData, true));
      this.trickArea.appendChild(slot);
      const toR = slot.getBoundingClientRect();
      let fromR = opts.fromRect;
      if (!fromR) {
        fromR = seat === 0
          ? this.rectOf(this.handBox)
          : this.rectOf(this.seatNode(seat) ? this.seatNode(seat).querySelector('.avatar') : this.trickArea);
      }
      const fc = center(fromR);
      const tc = center(toR);
      const dx = fc.x - tc.x;
      const dy = fc.y - tc.y;
      return this.anim(slot, [
        { transform: 'translate(' + (dx + off[0]) + 'px,' + (dy + off[1]) + 'px) rotate(' + dirRot + 'deg) scale(.72)', opacity: '.85' },
        { transform: 'translate(' + off[0] + 'px,' + off[1] + 'px) rotate(' + rot + 'deg) scale(1)', opacity: '1' }
      ], { duration: opts.dur || 330 }).then(function () { return slot; });
    },

    highlightWinner: function (winnerSeat, winId) {
      this.trickArea.querySelectorAll('.tslot').forEach(function (s) {
        if (s.querySelector('[data-id="' + winId + '"]')) s.classList.add('winning');
        else s.classList.add('losing');
      });
      const seatN = this.seatNode(winnerSeat);
      if (seatN) seatN.classList.add('won-flash');
      setTimeout(function () { if (seatN) seatN.classList.remove('won-flash'); }, 900);
    },

    sweepTrick: async function (winnerSeat) {
      const vec = winnerSeat === 0 ? [0, 240] :
        winnerSeat === 1 ? [300, 40] :
          winnerSeat === 2 ? [0, -260] : [-300, 40];
      root.HokmSound.play('sweep');
      const self = this;
      const proms = [];
      this.trickArea.querySelectorAll('.tslot').forEach(function (s, i) {
        const seatNum = +(s.className.match(/tslot-(\d)/) || [0, i])[1];
        const off = self.TSLOT_OFF[seatNum] || [0, 0];
        proms.push(self.anim(s, [
          { opacity: '1' },
          { transform: 'translate(' + (off[0] + vec[0] * 0.55) + 'px,' + (off[1] + vec[1] * 0.55) + 'px) rotate(' + ((i - 1.5) * 10) + 'deg) scale(.45)', opacity: '0' }
        ], { duration: 380, delay: i * 36 }));
      });
      await Promise.all(proms);
      this.trickArea.innerHTML = '';
    },

    clearTrick: function () { this.trickArea.innerHTML = ''; },

    showPiles: function (on) {
      this.piles.classList.toggle('hidden', !on);
      if (on) {
        const st = document.getElementById('pile-stock');
        st.querySelectorAll('.mini-back').forEach(function (b) { b.remove(); });
        for (let i = 0; i < 3; i++) {
          const b = UI.cardEl(null, false, 'mini');
          b.classList.add('mini-back');
          b.style.transform = 'rotate(' + (i * 7 - 7) + 'deg)';
          st.prepend(b);
        }
        const bu = document.getElementById('pile-burn');
        bu.querySelectorAll('.mini-back').forEach(function (b) { b.remove(); });
        const b2 = UI.cardEl(null, false, 'mini');
        b2.classList.add('mini-back');
        b2.style.transform = 'rotate(-12deg)';
        bu.prepend(b2);
      }
    },

    updatePileCounts: function (stockN, burnN) {
      document.getElementById('stock-n').textContent = this.fa(stockN);
      document.getElementById('burn-n').textContent = this.fa(burnN);
    },

    pileCenter: function (which) {
      return center(document.getElementById(which === 'stock' ? 'pile-stock' : 'pile-burn').getBoundingClientRect());
    },

    avatarCenter: function (seat) {
      const n = seat === 0
        ? this.handBox
        : this.seatNode(seat) ? this.seatNode(seat).querySelector('.avatar') : this.trickArea;
      return center(n.getBoundingClientRect());
    },

    dealWave: async function (perSeatCounts) {
      const deckC = center(this.rectOf(this.trickArea));
      const jobs = [];
      perSeatCounts.forEach(function (pc) {
        for (let i = 0; i < pc.count; i++) {
          (function (seat, k) {
            jobs.push(UI.wait(k * 70).then(function () {
              root.HokmSound.play('deal');
              const to = UI.avatarCenter(seat);
              return UI.flyGhost(null, deckC, to, {
                faceUp: false, dur: 300,
                rot0: -30 + Math.random() * 20, rot1: 0,
                scale0: 0.9, scale1: 0.75, fadeOut: true
              });
            }));
          })(pc.seat, i);
        }
      });
      await Promise.all(jobs);
    },

    ceremonyStart: function () {
      this.ceremonyRow.classList.remove('hidden');
      this.ceremonyRow.innerHTML = '';
    },

    ceremonyReveal: async function (idx, card, total) {
      const row = this.ceremonyRow;
      const maxW = Math.min(row.clientWidth || 300, window.innerWidth * 0.8);
      const spacing = Math.min(38, maxW / Math.max(total, 8));
      const holder = el('div', 'cer-card');
      const ce = this.cardEl(card, false);
      holder.appendChild(ce);
      holder.style.setProperty('--cx', ((idx - (total - 1) / 2) * spacing) + 'px');
      row.appendChild(holder);
      requestAnimationFrame(function () { holder.classList.add('in'); });
      await UI.wait(180);
      root.HokmSound.play('flip');
      await UI.anim(ce, [
        { transform: 'rotateY(0deg)' },
        { transform: 'rotateY(90deg)', offset: 0.5 },
        { transform: 'rotateY(0deg)' }
      ], { duration: 260 });
      const fresh = UI.cardEl(card, true);
      ce.replaceWith(fresh);
      if (card.rank === 14) {
        fresh.classList.add('ace-glow');
        root.HokmSound.play('star');
        UI.haptic('medium');
      }
      await UI.wait(card.rank === 14 ? 700 : 380);
      return holder;
    },

    ceremonyFlash: function (seat) {
      const n = this.seatNode(seat);
      if (!n) return;
      n.classList.add('ace-flash');
      setTimeout(function () { n.classList.remove('ace-flash'); }, 1400);
    },

    ceremonyClear: async function () {
      const holders = Array.from(this.ceremonyRow.children);
      await Promise.all(holders.map(function (h, i) {
        return UI.anim(h, [
          { transform: 'translateX(var(--cx)) translateY(0)', opacity: '1' },
          { transform: 'translateX(var(--cx)) translateY(-60px)', opacity: '0' }
        ], { duration: 260, delay: i * 24 });
      }));
      this.ceremonyRow.classList.add('hidden');
      this.ceremonyRow.innerHTML = '';
    },

    banner: function (html, tone, dur) {
      tone = tone || 'gold';
      dur = dur || 1500;
      const layer = document.getElementById('banner-layer');
      const b = el('div', 'bnr ' + tone, html);
      layer.appendChild(b);
      requestAnimationFrame(function () { b.classList.add('show'); });
      return new Promise(function (res) {
        setTimeout(function () {
          b.classList.remove('show');
          setTimeout(function () { b.remove(); }, 320);
          res();
        }, dur * UI.speed);
      });
    },

    setDockText: function (txt) {
      this.dock.className = 'dock';
      this.dock.innerHTML = txt ? '<div class="dock-msg">' + txt + '</div>' : '';
    },

    dockButtons: function (defs) {
      this.dock.className = 'dock has-btns';
      this.dock.innerHTML = '';
      const row = el('div', 'dock-btns');
      defs.forEach(function (d) {
        const b = el('button', 'btn ' + (d.cls || ''), d.label);
        if (d.disabled) b.disabled = true;
        b.addEventListener('click', function () {
          if (b.disabled) return;
          root.HokmSound.play('click');
          UI.haptic('light');
          d.cb();
        });
        row.appendChild(b);
      });
      this.dock.appendChild(row);
    },

    dockCustom: function (node) {
      this.dock.className = 'dock has-btns';
      this.dock.innerHTML = '';
      this.dock.appendChild(node);
    },

    hideDock: function () { this.setDockText(''); },

    trumpPicker: function (fiveCards, recommendSuit) {
      return new Promise(function (resolve) {
        const ov = el('div', 'ov');
        const panel = el('div', 'panel tp-panel pop');
        panel.innerHTML = '<h2>حکم را اعلام کن</h2><p class="sub">بر اساس پنج کارت اولت</p>';
        const grid = el('div', 'suit-grid');
        const counts = {};
        fiveCards.forEach(function (c) { counts[c.suit] = (counts[c.suit] || 0) + 1; });
        Cards.SUITS.forEach(function (s) {
          const t = el('button', 'suit-tile s-' + s);
          t.innerHTML =
            (s === recommendSuit ? '<span class="rec">پیشنهاد</span>' : '') +
            '<span class="sg">' + Cards.SUIT_SYM[s] + '</span>' +
            '<span class="sn">' + Cards.SUIT_FA[s] + '</span>' +
            '<span class="sc">' + UI.fa(counts[s] || 0) + ' برگه</span>';
          t.addEventListener('click', function () {
            root.HokmSound.play('kot');
            UI.haptic('success');
            ov.classList.add('out');
            setTimeout(function () { ov.remove(); resolve(s); }, 220);
          });
          grid.appendChild(t);
        });
        panel.appendChild(grid);
        ov.appendChild(panel);
        document.body.appendChild(ov);
      });
    },

    discardPrompt: function (count) {
      const self = this;
      return new Promise(function (resolve) {
        let btn = null;
        const refresh = function (nSel) {
          if (!btn) return;
          btn.textContent = 'دور بریز (' + UI.fa(nSel) + '/' + UI.fa(count) + ')';
          btn.disabled = nSel !== count;
        };
        self.enterDiscardMode(count, refresh);
        self.setDockText('');
        const wrap = el('div', 'discard-wrap');
        const msg = el('div', 'dock-msg', count === 3
          ? '۳ کارت بی‌ارزش را انتخاب کن'
          : '۲ کارت بی‌ارزش را انتخاب کن');
        btn = el('button', 'btn text-gold', 'دور بریز (۰/' + UI.fa(count) + ')');
        btn.disabled = true;
        btn.addEventListener('click', function () {
          const ids = self.selectedDiscardIds();
          if (ids.length !== count) return;
          root.HokmSound.play('flip');
          UI.haptic('medium');
          self.exitDiscardMode();
          resolve(ids);
        });
        wrap.appendChild(msg);
        wrap.appendChild(btn);
        self.dockCustom(wrap);
        refresh(0);
      });
    },

    drawChoice: function (card, ctxInfo) {
      const self = this;
      return new Promise(async function (resolve) {
        const wrap = el('div', 'draw-wrap');
        const info = el('div', 'draw-info',
          '<div class="di-row"><span class="di-k">برگه</span><b>' + UI.fa(ctxInfo.stock) + '</b></div>' +
          '<div class="di-row"><span class="di-k">دست تو</span><b>' + UI.fa(ctxInfo.myHand) + '</b></div>' +
          '<div class="di-row"><span class="di-k">نیاز</span><b>' + UI.fa(ctxInfo.need) + '</b></div>');
        const btns = el('div', 'draw-btns');
        const keep = el('button', 'btn text-gold', 'نگه می‌دارم');
        const drop = el('button', 'btn ghost', 'رد می‌کنم');
        const hint = el('div', 'draw-hint', 'اگر رد کنی، دومی اجباری است');
        btns.appendChild(drop);
        btns.appendChild(keep);
        wrap.appendChild(info);
        wrap.appendChild(btns);
        wrap.appendChild(hint);

        const revealSlot = el('div', 'draw-reveal');
        document.body.appendChild(revealSlot);
        const rc = center(revealSlot.getBoundingClientRect());
        revealSlot.remove();

        const g = self.ghostCard(card, self.pileCenter('stock'), false, 1.15);
        await self.anim(g, [
          { transform: 'translate(0,0) rotate(0deg) scale(1.15)' },
          { transform: 'translate(' + (rc.x - self.pileCenter('stock').x) + 'px,' + (rc.y - self.pileCenter('stock').y) + 'px) rotate(0deg) scale(1.25)' }
        ], { duration: 300 });
        root.HokmSound.play('flip');
        const face = self.cardEl(card, true);
        face.classList.add('ghost');
        face.style.position = 'fixed';
        face.style.left = (rc.x - (face.offsetWidth || 66) / 2) + 'px';
        face.style.top = (rc.y - (face.offsetHeight || 92) / 2) + 'px';
        face.style.zIndex = '61';
        document.body.appendChild(face);
        g.remove();

        let done = false;
        function finish(kept) {
          if (done) return;
          done = true;
          root.HokmSound.play('select');
          const dest = kept ? self.avatarCenter(0) : self.pileCenter('burn');
          const dx = dest.x - rc.x;
          const dy = dest.y - rc.y;
          const p = self.anim(face, [
            { transform: 'translate(0,0) rotate(0deg) scale(1.25)', opacity: '1' },
            { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (kept ? 0 : 160) + 'deg) scale(.7)', opacity: '0' }
          ], { duration: 380 });
          wrap.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
          p.then(function () { face.remove(); });
          resolve(kept);
        }
        keep.addEventListener('click', function () { finish(true); });
        drop.addEventListener('click', function () { finish(false); });
        self.dockCustom(wrap);
      });
    },

    aiDrawVisual: async function (seat, outcome) {
      const stockC = this.pileCenter('stock');
      const avC = this.avatarCenter(seat);
      const burnC = this.pileCenter('burn');
      if (outcome === 'keep') {
        await this.flyGhost(null, stockC, avC, { faceUp: false, dur: 280, scale1: 0.8, fadeOut: true });
      } else {
        await this.flyGhost(null, stockC, burnC, { faceUp: false, dur: 250, rot1: 140, fadeOut: true });
      }
    },

    overlayPanel: function (cls, html) {
      const ov = el('div', 'ov center');
      const panel = el('div', 'panel pop ' + (cls || ''));
      panel.innerHTML = html;
      ov.appendChild(panel);
      document.body.appendChild(ov);
      return { ov: ov, panel: panel };
    },

    handEndOverlay: function (view) {
      const self = this;
      return new Promise(function (resolve) {
        let head;
        let sub;
        if (view.label === 'kot' && view.won) { head = 'کـــوت!'; sub = 'هفت دست پیاپی، حریف صفر'; }
        else if (view.label === 'hakemKot' && view.won) { head = 'حاکم‌کوت!'; sub = 'حاکم را کوتیدی — سه امتیازی'; }
        else if (view.label === 'kot') { head = 'کوت شدید'; sub = 'هفت دست پیاپی به حریف رسید'; }
        else if (view.label === 'hakemKot') { head = 'حاکم‌کوت شدید'; sub = 'حریف سه امتیاز گرفت'; }
        else if (view.won) { head = 'دست را بردید'; sub = view.pts === 1 ? 'یک امتیاز گرفتید' : ''; }
        else { head = 'دست را باختید'; sub = ''; }

        const o = self.overlayPanel('end-panel',
          '<div class="end-head ' + (view.won ? 'good' : 'bad') + '">' + head + '</div>' +
          (sub ? '<p class="sub">' + sub + '</p>' : '') +
          '<div class="score-line"><span class="sl-us">' + UI.fa(view.tricksUs) + '</span><span class="sl-dash">—</span><span class="sl-them">' + UI.fa(view.tricksThem) + '</span></div>' +
          '<div class="pts-delta ' + (view.won ? 'up' : '') + '">+' + UI.fa(view.ptsDelta) + ' امتیاز به ' + (view.won ? 'شما' : 'حریف') + '</div>' +
          '<div class="match-score">' + view.usName + ' <b>' + UI.fa(view.scoreUs) + '</b> · حریف <b>' + UI.fa(view.scoreThem) + '</b></div>' +
          '<button class="btn text-gold wide" id="ov-go">' + (view.matchOver ? 'پایان بازی' : 'دست بعدی') + '</button>');
        o.panel.querySelector('#ov-go').addEventListener('click', function () {
          root.HokmSound.play('click');
          o.ov.classList.add('out');
          setTimeout(function () { o.ov.remove(); resolve(); }, 200);
        });
        if (view.kot && view.won) {
          root.HokmSound.play('kot');
          self.confetti(110);
        } else if (view.won) {
          root.HokmSound.play('win');
          self.confetti(45);
        } else {
          root.HokmSound.play('lose');
        }
        self.haptic(view.won ? 'success' : 'error');
      });
    },

    matchEndOverlay: function (view) {
      const self = this;
      return new Promise(function (resolve) {
        const o = self.overlayPanel('end-panel final-panel',
          '<div class="trophy">' + (view.won ? '♛' : '✦') + '</div>' +
          '<div class="end-head big ' + (view.won ? 'good' : 'bad') + '">' + (view.won ? 'قهرمان شدی!' : 'باختی…') + '</div>' +
          '<div class="score-line xl"><span class="sl-us">' + UI.fa(view.scoreUs) + '</span><span class="sl-dash">—</span><span class="sl-them">' + UI.fa(view.scoreThem) + '</span></div>' +
          '<div class="match-score">' + view.usName + ' در برابر حریف</div>' +
          '<div class="final-btns">' +
          '<button class="btn text-gold wide" id="ov-again">بازی دوباره</button>' +
          '<button class="btn ghost wide" id="ov-menu">بازگشت به منو</button>' +
          '</div>');
        if (view.won) {
          self.confetti(170);
          root.HokmSound.play('win');
        } else {
          root.HokmSound.play('lose');
        }
        o.panel.querySelector('#ov-again').addEventListener('click', function () {
          o.ov.remove();
          resolve('again');
        });
        o.panel.querySelector('#ov-menu').addEventListener('click', function () {
          o.ov.remove();
          resolve('menu');
        });
      });
    },

    confirmExit: function () {
      return new Promise(function (resolve) {
        const o = UI.overlayPanel('mini-panel',
          '<h3>خروج از بازی؟</h3><p class="sub">پیشرفت این دست از بین می‌رود.</p>' +
          '<div class="row-btns">' +
          '<button class="btn ghost" id="ex-no">می‌مانم</button>' +
          '<button class="btn danger" id="ex-yes">خروج</button></div>');
        o.panel.querySelector('#ex-no').addEventListener('click', function () { o.ov.remove(); resolve(false); });
        o.panel.querySelector('#ex-yes').addEventListener('click', function () { o.ov.remove(); resolve(true); });
      });
    },

    rulesModal: function () {
      const tabs = {
        four: '<ul class="rules-list">' +
          '<li><b>یارگیری:</b> ورق‌ها رو می‌شوند؛ اولین آس → <b>حاکم</b>، دومین آس → یار او. دیلر = سمت چپِ حاکم.</li>' +
          '<li><b>پخش:</b> ۵–۴–۴؛ دسته را یارِ حاکم برمی‌دارد. حاکم فقط با ۵ کارت اولش خال حکم را اعلام می‌کند.</li>' +
          '<li><b>بازی:</b> حاکم شروع می‌کند؛ خال زمینه لازم است. بی‌خال؟ هر کارتی — حتی بریدن با حکم.</li>' +
          '<li><b>بردن دست:</b> حکم از همه بالاتر است؛ وگرنه بزرگ‌ترین کارتِ زمینه. برندهٔ هر دست، دست بعد را می‌آورد.</li>' +
          '<li><b>۷ دست</b> یک تیم = بردن دست.</li></ul>',
        two: '<ul class="rules-list">' +
          '<li><b>یارگیری:</b> اولین آس → حاکم؛ نفر دیگر دیلر.</li>' +
          '<li><b>پخش:</b> ۵ کارت به هر کدام؛ حاکم حکم را اعلام می‌کند.</li>' +
          '<li><b>دورریز:</b> حاکم ۳ کارت و حریف ۲ کارت دور می‌اندازند.</li>' +
          '<li><b>برداشت:</b> نوبتی از برگه‌ها: کارت اول را ببین — نگه دار یا رد کن. اگر رد کنی، دومی اجباری است. اگر نگه داری، دومی دور ریخته می‌شود. تا ۱۳ کارت.</li>' +
          '<li><b>بقیهٔ قوانین</b> مثل چهارنفره است؛ حاکم دست اول را می‌آورد.</li></ul>',
        score: '<ul class="rules-list">' +
          '<li><b>بردن دست:</b> ۱ امتیاز</li>' +
          '<li><b>کوت (۷–۰):</b> ۲ امتیاز</li>' +
          '<li><b>حاکم‌کوت (۷–۰ علیه تیم حاکم):</b> ۳ امتیاز</li>' +
          '<li>اولین تیم/نفری که به <b>۷ امتیاز</b> برسد برندهٔ کل بازی است.</li>' +
          '<li>اگر تیم حاکم ببرد، همان حاکم می‌ماند؛ اگر ببازد، حاکم قبلی دیلر می‌شود و نفر سمت راستش حاکم جدید است.</li></ul>'
      };
      const o = this.overlayPanel('rules-panel',
        '<h2>قوانین حکم</h2>' +
        '<div class="tabs"><button class="tab on" data-t="four">چهارنفره</button>' +
        '<button class="tab" data-t="two">دونفره</button>' +
        '<button class="tab" data-t="score">امتیازها</button></div>' +
        '<div class="tab-body" id="tab-body">' + tabs.four + '</div>' +
        '<button class="btn text-gold wide" id="rl-close">فهمیدم</button>');
      const body = o.panel.querySelector('#tab-body');
      o.panel.querySelectorAll('.tab').forEach(function (t) {
        t.addEventListener('click', function () {
          o.panel.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          body.innerHTML = tabs[t.dataset.t];
          root.HokmSound.play('click');
        });
      });
      o.panel.querySelector('#rl-close').addEventListener('click', function () { o.ov.remove(); });
      o.ov.addEventListener('click', function (e) { if (e.target === o.ov) o.ov.remove(); });
    },

    settingsModal: function (prefs, onSave) {
      const o = this.overlayPanel('mini-panel',
        '<h2>تنظیمات</h2>' +
        '<label class="set-row">صدا<input type="checkbox" id="st-snd" ' + (prefs.sound ? 'checked' : '') + '><i class="sw"></i></label>' +
        '<label class="set-row">سرعت بازی<input type="checkbox" id="st-spd" ' + (prefs.fast ? 'checked' : '') + '><i class="sw"></i></label>' +
        '<button class="btn text-gold wide" id="st-ok">ذخیره</button>');
      o.panel.querySelector('#st-ok').addEventListener('click', function () {
        onSave({
          sound: o.panel.querySelector('#st-snd').checked,
          fast: o.panel.querySelector('#st-spd').checked
        });
        o.ov.remove();
      });
      o.ov.addEventListener('click', function (e) { if (e.target === o.ov) o.ov.remove(); });
    },

    confetti: function (n) {
      if (this.reduced) return;
      const colors = ['#ffd97a', '#e9c46a', '#f05a5a', '#57d9a3', '#f7f1df'];
      const frag = document.createDocumentFragment();
      for (let i = 0; i < n; i++) {
        const p = el('i', 'cf');
        p.style.left = (Math.random() * 100) + 'vw';
        p.style.background = colors[i % colors.length];
        p.style.setProperty('--cd', (0.9 + Math.random() * 1.4) + 's');
        p.style.setProperty('--cx', (Math.random() * 80 - 40) + 'px');
        p.style.setProperty('--cr', (Math.random() * 720 - 360) + 'deg');
        p.style.animationDelay = (Math.random() * 0.35) + 's';
        frag.appendChild(p);
      }
      const layer = document.getElementById('fx');
      layer.appendChild(frag);
      setTimeout(function () {
        layer.querySelectorAll('.cf').forEach(function (c) { c.remove(); });
      }, 2600);
    },

    flashBig: function (text, cls) {
      const layer = document.getElementById('banner-layer');
      const b = el('div', 'bigflash ' + (cls || ''), text);
      layer.appendChild(b);
      setTimeout(function () { b.classList.add('show'); }, 10);
      setTimeout(function () {
        b.classList.remove('show');
        setTimeout(function () { b.remove(); }, 500);
      }, 1300);
    },

    haptic: function (kind) {
      const tg = root.Telegram && root.Telegram.WebApp;
      if (!tg || !tg.HapticFeedback) return;
      try {
        if (kind === 'light' || kind === 'medium' || kind === 'heavy' || kind === 'soft' || kind === 'rigid') {
          tg.HapticFeedback.impactOccurred(kind);
        } else {
          tg.HapticFeedback.notificationOccurred(kind);
        }
      } catch (e) {}
    },

    closeModal: function (silent) {
      document.querySelectorAll('.ov').forEach(function (o) { o.remove(); });
      void silent;
    }
  };

  root.HokmUI = UI;
})(typeof window !== 'undefined' ? window : globalThis);

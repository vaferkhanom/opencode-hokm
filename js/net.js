(function (root) {
  'use strict';

  const RECONNECT_BASE_MS = 800;
  const RECONNECT_MAX_MS = 5000;

  function HokmNet(opts) {
    opts = opts || {};
    this.ws = null;
    this.open = false;
    this.queue = [];
    this.handlers = {};
    this._closedByUs = false;
    this._tries = 0;
    this._reconnecting = false;
    this.onStateChange = opts.onStateChange || function () {};
    this.getLastActivity = opts.lastActivity || function () { return Date.now(); };
    this._watchdog = setInterval(() => {
      if (!this.open || !this.ws) return;
      // No inbound traffic + socket dead-ish -> probe
      if (Date.now() - this.getLastActivity() > 25000) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
      }
      if (Date.now() - this.getLastActivity() > 45000 && !this._probing) {
        // assume dead: force-close so close handler triggers a reconnect
        this._probing = true;
        try { this.ws.close(); } catch (e) {}
        setTimeout(() => { this._probing = false; }, 1000);
      }
    }, 5000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !this.open && !this._closedByUs) this._scheduleReconnect();
      });
    }
  }

  HokmNet.prototype.destroy = function () {
    clearInterval(this._watchdog);
    this._closedByUs = true;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  };

  HokmNet.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  };
  HokmNet.prototype.emit = function (type, data) {
    (this.handlers[type] || []).forEach(function (f) { f(data); });
  };
  HokmNet.prototype.connect = function () {
    this._closedByUs = false;
    const p = this._openSocket();
    return p.catch(err => { throw err; });
  };
  HokmNet.prototype._openSocket = function () {
    const self = this;
    return new Promise(function (resolve, reject) {
      if (self.open && self.ws) { resolve(); return; }
      let proto = 'wss:';
      try { proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; } catch (e) {}
      let url;
      try { url = proto + '//' + location.host + '/ws'; } catch (e) { reject(e); return; }
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      self.ws = ws;
      ws.onopen = function () {
        self.open = true;
        self._lastMsg = Date.now();
        self._tries = 0;
        self.queue.forEach(function (m) { try { ws.send(JSON.stringify(m)); } catch (e) {} });
        self.queue = [];
        self.onStateChange(true);
        resolve();
      };
      ws.onmessage = function (ev) {
        self._lastMsg = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.type === 'pong') return;
        if (m && m.type) self.emit(m.type, m);
      };
      ws.onclose = function () {
        const wasOpen = self.open;
        self.open = false;
        self.ws = null;
        self.onStateChange(false);
        if (wasOpen || !self._closedByUs) self.emit('close', {});
        self._scheduleReconnect();
      };
      ws.onerror = function () { /* close will follow */ };
    });
  };
  HokmNet.prototype._scheduleReconnect = function () {
    if (this._closedByUs || this._reconnecting) return;
    this._reconnecting = true;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.6, this._tries++), RECONNECT_MAX_MS);
    setTimeout(() => {
      this._reconnecting = false;
      if (this.open || this._closedByUs) return;
      this._openSocket().catch(function () {});
    }, delay);
  };
  HokmNet.prototype.send = function (obj) {
    if (obj !== Object(obj)) return;
    if (this.open && this.ws) { try { this.ws.send(JSON.stringify(obj)); } catch (e) { this.queue.push(obj); this._scheduleReconnect(); } }
    else {
      this.queue.push(obj);
      // Lazy connect on demand instead of silently swallowing messages
      this._openSocket().catch(function () {});
    }
  };
  HokmNet.prototype.isLive = function () { return !!this.open; };

  root.HokmNet = HokmNet;
})(typeof window !== 'undefined' ? window : globalThis);

(function (root) {
  'use strict';

  function HokmNet() {
    this.ws = null;
    this.open = false;
    this.queue = [];
    this.handlers = {};
  }
  HokmNet.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  };
  HokmNet.prototype.emit = function (type, data) {
    (this.handlers[type] || []).forEach(function (f) { f(data); });
  };
  HokmNet.prototype.connect = function () {
    const self = this;
    return new Promise(function (resolve, reject) {
      let proto = 'wss:';
      try { proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; } catch (e) {}
      let url;
      try { url = proto + '//' + location.host + '/ws'; } catch (e) { reject(e); return; }
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      self.ws = ws;
      ws.onopen = function () {
        self.open = true;
        self.queue.forEach(function (m) { try { ws.send(JSON.stringify(m)); } catch (e) {} });
        self.queue = [];
        resolve();
      };
      ws.onmessage = function (ev) {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.type) self.emit(m.type, m);
      };
      ws.onclose = function () { self.open = false; self.emit('close', {}); };
      ws.onerror = function (e) { self.emit('error', e); };
    });
  };
  HokmNet.prototype.send = function (obj) {
    if (this.open && this.ws) { try { this.ws.send(JSON.stringify(obj)); } catch (e) {} }
    else this.queue.push(obj);
  };

  root.HokmNet = HokmNet;
})(typeof window !== 'undefined' ? window : globalThis);

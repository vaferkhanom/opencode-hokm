const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Rooms } = require('./server/rooms');
const store = require('./server/store');
const { validateInitData } = require('./server/auth');
const { createBot } = require('./server/tgbot');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
let CFG = {};
try { CFG = require('./server/config.production.json'); } catch (e) {}
const BOT_TOKEN = process.env.BOT_TOKEN || CFG.botToken || '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || CFG.webhookSecret || ('whsec-' + crypto.randomBytes(12).toString('hex'));

const rooms = new Rooms();
rooms.onMatchOver = function (payload) {
  store.recordMatch(payload.seats, payload.winSide).catch(function () {});
  // Game finished: release each participant's room membership.
  payload.seats.forEach(function (s) {
    if (s && s.tgId && !s.isBot) store.clearRoom(s.tgId, payload.code).catch(function () {});
  });
};

// ---- Telegram bot (enabled when BOT_TOKEN is set) ----
let bot = null;
if (BOT_TOKEN) {
  bot = createBot({ token: BOT_TOKEN, rooms, store, webhookSecret: WEBHOOK_SECRET, appUsername: process.env.TELEGRAM_BOT_USERNAME || CFG.botUsername });
  bot.boot().then(function (me) {
    console.log('[tg] bot @' + me.username + ' ready');
    const appUrl = process.env.APP_PUBLIC_URL || CFG.appPublicUrl || '';
    if (appUrl) {
      bot.setWebhook(appUrl + '/tg/webhook').then(function (r) {
        console.log('[tg] webhook set: ' + (r ? 'ok' : 'failed'));
      }).catch(function () { console.log('[tg] webhook set failed'); });
    } else {
      console.log('[tg] APP_PUBLIC_URL not set — webhook not registered');
    }
  }).catch(function () {
    console.log('[tg] getMe failed (offline?); using fallback username');
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, function (err, data) {
    if (err) return sendIndex(res);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(data);
  });
}
function sendIndex(res) {
  fs.readFile(path.join(ROOT, 'index.html'), function (err2, index) {
    if (err2) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(index);
  });
}
function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', function (c) {
    size += c.length;
    if (size > limit) { req.destroy(); cb(null); return; }
    chunks.push(c);
  });
  req.on('end', function () { cb(Buffer.concat(chunks)); });
  req.on('error', function () { cb(null); });
}

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }
  // Telegram webhook
  if (bot && urlPath === '/tg/webhook') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if ((req.headers['x-telegram-bot-api-secret-token'] || '') !== WEBHOOK_SECRET) {
      res.writeHead(401);
      return res.end();
    }
    readBody(req, 1048576, function (buf) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      if (!buf) return;
      try {
        const update = JSON.parse(buf.toString('utf8'));
        bot.handleUpdate(update);
      } catch (e) {}
    });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // Never expose server internals, tests or runtime data over HTTP.
  if (/^\/(server|tests|data)(\/|$)/.test(urlPath)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  sendFile(res, filePath);
});

async function boot() {
  let r;
  try {
    r = await store.init();
  } catch (e) {
    console.error('[store] init failed:', String(e && e.message ? e.message : e));
    r = { mode: 'memory' };
  }
  console.log('[store] ' + r.mode + (store.isPersisted ? ' (postgres)' : ' (memory)'));
  rooms.setPersister(function (serialized) { store.saveRoom(serialized).catch(function () {}); });
  try {
    const saved = await store.loadRooms();
    rooms.loadFrom(saved);
    for (const room of rooms.map.values()) {
      if (room.state === 'playing' || room.state === 'handEnd') {
        // Re-arm timers, and give disconnected humans a grace window to reclaim.
        room.seats.forEach(function (s, i) { if (s && !s.isBot) room.onDisconnect(i, false); });
        room.advance();
      }
    }
    console.log('[rooms] restored ' + rooms.map.size + ' room(s)');
  } catch (e) {
    console.error('[rooms] restore failed:', String(e && e.message ? e.message : e));
  }

  // Accept real-time connections only once persistence is fully loaded, so
  // restored rooms are present before any client can join them.
  const wss = new WebSocketServer({ server: server, path: '/ws' });

  wss.on('connection', function (ws) {
    ws.room = null;
    ws.seat = -1;
    ws.isAlive = true;
    ws.lastSeen = Date.now();
    ws.on('pong', function () { ws.isAlive = true; ws.lastSeen = Date.now(); });

    ws.on('message', function (data) {
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      handleWs(ws, m);
    });

    ws.on('close', function () {
      if (ws.room) {
        const r = ws.room;
        ws.room = null;
        r.onDisconnect(ws.seat, false);
      }
    });
    ws.on('error', function () {});
  });

  // Keepalive: evict dead sockets so proxies cannot silently strand players.
  setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 25000).unref();

  setInterval(function () { rooms.prune(); }, 600000).unref();

  server.listen(PORT, function () {
    console.log('[hokm] serving on port ' + PORT +
      (process.env.NODE_ENV ? ' (' + process.env.NODE_ENV + ')' : ''));
  });
}

boot();

// Identity resolution for an inbound WS action.
function resolveIdentity(msg) {
  const user = validateInitData(msg.initData || '', BOT_TOKEN);
  if (user) {
    const name = String(user.first_name || '').trim().split(/\s+/)[0] || '\u0628\u0627\u0632\u06cc\u06a9\u0646';
    return { playerId: 'tg:' + user.id, name: name.slice(0, 24), tgUser: user, verified: true };
  }
  const pid = String(msg.playerId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || ('anon' + crypto.randomBytes(3).toString('hex'));
  const nm = String(msg.name || '').replace(/[<>]/g, '').trim().slice(0, 24) || '\u0645\u0647\u0645\u0627\u0646';
  return { playerId: pid, name: nm, tgUser: null, verified: false };
}

function handleWs(ws, m) {
  if (!m || typeof m.type !== 'string') return;
  ws.lastSeen = Date.now();

  if (m.type === 'ping') { safeSend(ws, { type: 'pong' }); return; }

  if (m.type === 'create') {
    const idn = resolveIdentity(m);
    if (idn.verified && idn.tgUser) store.upsertUser(idn.tgUser).catch(function () {});
    const mode = (m.mode === 4 || m.mode === 2) ? m.mode : 2;
    const made = rooms.create(mode, idn.playerId, idn.name, ws);
    const room = made.room;
    // lobby options
    const th = Number(m.targetHands);
    if (th === 3 || th === 5 || th === 7) room.targetHands = th;
    if (m.teamAssignMode === 'random' || m.teamAssignMode === 'manual') room.teamAssignMode = m.teamAssignMode;
    markSeat(room, made.seat, idn);
    ws.room = room;
    ws.seat = made.seat;
    if (idn.verified) store.setRoom(idn.tgUser.id, room.code).catch(function () {});
    safeSend(ws, { type: 'welcome', seat: made.seat, code: room.code, mode: mode, isHost: room.creatorId === idn.playerId, botUsername: bot ? bot.me.username : null });
    room.broadcastState();
    return;
  }

  if (m.type === 'join') {
    const idn = resolveIdentity(m);
    if (idn.verified && idn.tgUser) store.upsertUser(idn.tgUser).catch(function () {});
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room) { safeSend(ws, { type: 'error', message: '\u0627\u062a\u0627\u0642 \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f' }); return; }
    const seat = room.addPlayer(idn.playerId, idn.name, ws);
    if (seat < 0) { safeSend(ws, { type: 'error', message: '\u0627\u062a\u0627\u0642 \u067e\u0631 \u0627\u0633\u062a' }); return; }
    markSeat(room, seat, idn);
    ws.room = room;
    ws.seat = seat;
    if (idn.verified) store.setRoom(idn.tgUser.id, room.code).catch(function () {});
    safeSend(ws, { type: 'welcome', seat: seat, code: room.code, mode: room.mode, isHost: room.creatorId === idn.playerId, botUsername: bot ? bot.me.username : null });
    room.broadcastState();
    return;
  }

  if (m.type === 'invite') {
    if (!ws.room) return;
    const code = ws.room.code;
    const username = bot ? bot.me.username : (process.env.TELEGRAM_BOT_USERNAME || null);
    safeSend(ws, {
      type: 'inviteInfo',
      code: code,
      tgUrl: username ? ('https://t.me/' + username + '?startapp=' + code) : null,
      webUrl: (process.env.APP_PUBLIC_URL || CFG.appPublicUrl || '') + '/?room=' + code
    });
    return;
  }

  if (m.type === 'start') {
    if (ws.room) ws.room.start(m.playerId);
    return;
  }
  if (m.type === 'rename') {
    if (ws.room) {
      const s = ws.room.seats[ws.seat];
      // Verified Telegram users keep their Telegram names.
      if (s && !s.tgId && m.name) { s.name = String(m.name).replace(/[<>]/g, '').slice(0, 24); ws.room.broadcastState(); }
    }
    return;
  }
  if (m.type === 'setTeamAssign') {
    const idn2 = resolveIdentity(m);
    if (ws.room && ws.room.creatorId === idn2.playerId && ws.room.state === 'lobby') {
      const mode = m.mode;
      if (mode === 'random' || mode === 'manual') {
        ws.room.teamAssignMode = mode;
        ws.room.broadcastState();
      }
    }
    return;
  }
  if (m.type === 'setTargetHands') {
    const idn3 = resolveIdentity(m);
    if (ws.room && ws.room.creatorId === idn3.playerId && ws.room.state === 'lobby') {
      const th = Number(m.targetHands);
      if (th === 3 || th === 5 || th === 7) {
        ws.room.targetHands = th;
        ws.room.broadcastState();
      }
    }
    return;
  }
  if (m.type === 'leave') {
    if (ws.room) {
      const r = ws.room;
      ws.room = null;
      r.onDisconnect(ws.seat, true);
    }
    return;
  }
  if (m.type === 'trump' || m.type === 'discard' || m.type === 'draw' || m.type === 'play') {
    if (ws.room) ws.room.handleAction(ws.seat, m);
    return;
  }
}

function markSeat(room, seat, idn) {
  const s = room.seats[seat];
  if (!s) return;
  s.name = idn.name;
  if (idn.verified) {
    s.tgId = Number(idn.tgUser.id);
    s.playerId = idn.playerId;
  }
}

function safeSend(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) {}
}

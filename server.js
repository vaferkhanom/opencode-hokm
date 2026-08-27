const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Rooms } = require('./server/rooms');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const rooms = new Rooms();

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
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), function (err2, index) {
        if (err2) {
          res.writeHead(404);
          return res.end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(index);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('[hokm] serving on port ' + PORT + (process.env.NODE_ENV ? ' (' + process.env.NODE_ENV + ')' : ''));
});

// ---- Real-time multiplayer over WebSocket ----
const wss = new WebSocketServer({ server: server, path: '/ws' });

wss.on('connection', function (ws) {
  ws.room = null;
  ws.seat = -1;

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

function handleWs(ws, m) {
  if (!m || typeof m.type !== 'string') return;

  if (m.type === 'create') {
    const mode = (m.mode === 4 || m.mode === 2) ? m.mode : 2;
    const { room, seat } = rooms.create(mode, m.playerId, m.name, ws);
    ws.room = room;
    ws.seat = seat;
    room.send(seat, {
      type: 'welcome', seat: seat, code: room.code, mode: mode,
      isHost: room.creatorId === m.playerId
    });
    room.broadcastState();
    return;
  }

  if (m.type === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'اتاق پیدا نشد' })); return; }
    const seat = room.addPlayer(m.playerId, m.name, ws);
    if (seat < 0) { ws.send(JSON.stringify({ type: 'error', message: 'اتاق پر است' })); return; }
    ws.room = room;
    ws.seat = seat;
    room.send(seat, {
      type: 'welcome', seat: seat, code: room.code, mode: room.mode,
      isHost: room.creatorId === m.playerId
    });
    room.broadcastState();
    return;
  }

  if (m.type === 'start') {
    if (ws.room) ws.room.start(m.playerId);
    return;
  }
  if (m.type === 'rename') {
    if (ws.room) {
      const s = ws.room.seats[ws.seat];
      if (s) { s.name = m.name || s.name; ws.room.broadcastState(); }
    }
    return;
  }
  if (m.type === 'leave') {
    // explicit quit: room releases/replaces the seat immediately
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

setInterval(function () { rooms.prune(); }, 600000).unref();

'use strict';
const https = require('https');

function makeApi(token) {
  return function api(method, payload) {
    return new Promise(function (resolve) {
      const body = JSON.stringify(payload || {});
      const req = https.request({
        hostname: 'api.telegram.org', path: '/bot' + token + '/' + method,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000
      }, function (res) {
        let buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () {
          try { const j = JSON.parse(buf); resolve(j && j.ok ? j.result : null); } catch (e) { resolve(null); }
        });
      });
      req.on('error', function () { resolve(null); });
      req.on('timeout', function () { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  };
}

function fa(n) {
  const map = { 0: '\u06f0', 1: '\u06f1', 2: '\u06f2', 3: '\u06f3', 4: '\u06f4', 5: '\u06f5', 6: '\u06f6', 7: '\u06f7', 8: '\u06f8', 9: '\u06f9' };
  return String(n).replace(/[0-9]/g, function (d) { return map[d]; });
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const MSG = {
  welcome: '<b>\u062d\u064f\u06a9\u0645 \u0622\u0646\u0644\u0627\u06cc\u0646</b> \ud83c\udccf',
  openGameBtn: '\ud83c\udcb3 \u0628\u0627\u0632 \u06a9\u0631\u062f\u0646 \u0628\u0627\u0632\u06cc',
  joinLobbyBtn: '\ud83c\udcb3 \u0648\u0631\u0648\u062f \u0628\u0647 \u0644\u0627\u0628\u06cc',
  roomGone: '\u274c \u0627\u06cc\u0646 \u0644\u0627\u0628\u06cc \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f \u06cc\u0627 \u062e\u0627\u062a\u0645\u0647 \u0634\u062f\u0647.',
  newRoomBtn: '\ud83c\udcb3 \u0633\u0627\u062e\u062a \u0627\u062a\u0627\u0642 \u062c\u062f\u06cc\u062f'
};

function describeRoom(room) {
  if (!room) return null;
  const seated = room.seats.filter(function (s) { return s; });
  const free = room.seats.length - seated.length;
  const playing = !!room.engine;
  let text;
  if (playing) text = '\u0628\u0627\u0632\u06cc \u062f\u0631 \u062c\u0631\u06cc\u0627\u0646\u0647 \u2014 \u0645\u06cc\u200f\u062a\u0648\u0646\u06cc \u0645\u0644\u062d\u063c \u0634\u06cc \u0648 \u062c\u0627\u06cc\u062a \u0631\u0648 \u0627\u0632 \u0631\u0628\u0627\u062a \u067e\u0633 \u0628\u06af\u06cc\u0631\u06cc!';
  else text = '\u0628\u0627\u0632\u06cc\u06a9\u0646\u200f\u0647\u0627: ' + (seated.map(function (s) { return s.name; }).join('\u060c ') || '\u2014');
  return { mode: room.mode, free: free, playing: playing, text: text };
}

function createBot(opts) {
  const api = opts.api || makeApi(opts.token);
  const rooms = opts.rooms;
  const store = opts.store;
  const me = { id: 0, username: opts.appUsername || 'Echohokmbot' };

  function appOpenUrl(startParam) {
    let u = 'https://t.me/' + me.username + '?startapp=' + encodeURIComponent(startParam || '');
    return u;
  }
  function lobbyKeyboard(code) {
    return { inline_keyboard: [[{ text: MSG.joinLobbyBtn, url: appOpenUrl(code) }]] };
  }

  async function boot() {
    const r = await api('getMe');
    if (r && r.username) { me.id = r.id; me.username = r.username; }
    return me;
  }

  async function send(chatId, text, markup) {
    return api('sendMessage', {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: markup ? JSON.stringify(markup) : undefined
    });
  }

  async function handleMessage(msg) {
    const from = msg.from || {};
    try { await store.upsertUser(from); } catch (e) {}
    const chatId = msg.chat.id;
    const text = String(msg.text || '').trim();
    if (!text.startsWith('/')) return;
    const parts = text.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    const arg = parts[1] || '';

    if (cmd === '/start') {
      const m = /^room_([A-Z0-9]{4,8})$/i.exec(arg);
      if (!m) {
        await send(chatId, MSG.welcome + '\n\u0633\u0644\u0627\u0645 ' + esc(from.first_name || '') + '! \u0622\u0645\u0627\u062f\u0647\u200f\u0627\u06cc\u061f', { inline_keyboard: [[{ text: MSG.openGameBtn, url: appOpenUrl('') }]] });
        return;
      }
      const code = m[1].toUpperCase();
      const info = describeRoom(rooms.get(code));
      if (!info) {
        await send(chatId, MSG.roomGone, { inline_keyboard: [[{ text: MSG.newRoomBtn, url: appOpenUrl('') }]] });
        return;
      }
      const kind = info.mode === 4 ? '4 \u0646\u0641\u0631\u0647 (\u062f\u0648 \u062a\u06cc\u0645\u06cc)' : '2 \u0646\u0641\u0631\u0647';
      const body = '<b>\u062f\u0639\u0648\u062a \u0628\u0647 \u0644\u0627\u0628\u06cc</b> \ud83d\udd25' +
        '\n\u0627\u062a\u0627\u0642 <code>' + code + '</code> \u2022 ' + kind +
        '\n' + esc(info.text);
      await send(chatId, body, lobbyKeyboard(code));
      return;
    }

    if (cmd === '/stats') {
      const u = await store.getUser(from.id);
      if (!u) { await send(chatId, '\u0622\u0645\u0627\u0631\u06cc \u0646\u062f\u0627\u0631\u06cc \u2014 \u06cc\u0647 \u0628\u0627\u0632\u06cc \u0628\u06a9\u0646!'); return; }
      await send(chatId, '\ud83c\udfc6 \u0622\u0645\u0627\u0631 ' + esc(u.first_name || '') +
        '\n\u0628\u0627\u0632\u06cc: ' + fa(u.games) + '\n\u0628\u0631\u062f: ' + fa(u.wins));
      return;
    }

    if (cmd === '/help') {
      await send(chatId, '\u0631\u0627\u0647\u0646\u0645\u0627:\n/start \u2014 \u0645\u0646\u0648\n/stats \u2014 \u0622\u0645\u0627\u0631\n\u0644\u06cc\u0646\u06a9 \u062f\u0639\u0648\u062a \u0631\u0648 \u0627\u0632 \u062f\u0631\u0648\u0646 \u0628\u0627\u0632\u06cc \u0628\u06af\u06cc\u0631.');
      return;
    }
  }

  async function handleUpdate(update) {
    try {
      if (update.message && update.message.text && update.message.chat) {
        await handleMessage(update.message);
        return;
      }
      if (update.callback_query) {
        await api('answerCallbackQuery', { callback_query_id: update.callback_query.id });
      }
    } catch (e) { /* never throw into webhook */ }
  }

  function setWebhook(url) {
    return api('setWebhook', {
      url: url,
      secret_token: opts.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
  }

  return { api, boot, me, handleUpdate, setWebhook, appOpenUrl };
}

module.exports = { createBot };

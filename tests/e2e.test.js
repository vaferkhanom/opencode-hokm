'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8191;
const PG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hokm-e2e-'));
fs.rmSync(PG_DIR, { recursive: true, force: true }); // start from a clean PostgreSQL
const TOKEN = '123:TESTTOKEN';

const env = Object.assign({}, process.env, {
  DATABASE_URL: 'pglite:' + PG_DIR,
  BOT_TOKEN: TOKEN,
  PORT: String(PORT),
  NODE_ENV: 'test',
  APP_PUBLIC_URL: 'https://example.test'
});

let passed = 0;
function ok(n) { passed++; console.log('  ok -', n); }
const children = [];
function cleanup() { children.forEach(c => { try { c.kill('SIGKILL'); } catch (e) {} }); }

function makeInitData(id, name) {
  const uobj = { id: id, first_name: name, username: 'u' + id };
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('user', JSON.stringify(uobj));
  const dcs = [...params.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function waitHealth() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const req = http.get('http://127.0.0.1:' + PORT + '/healthz', r => { r.resume(); clearInterval(iv); res(); });
      req.on('error', () => { if (Date.now() - t0 > 20000) { clearInterval(iv); rej(new Error('server never became healthy')); } });
    }, 250);
  });
}
function startServer(tag) {
  const child = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write('[' + tag + '] ' + d));
  child.stderr.on('data', d => process.stderr.write('[' + tag + '!] ' + d));
  children.push(child);
  return child;
}
function stopServer(child) {
  return new Promise(r => { child.kill('SIGKILL'); setTimeout(r, 300); });
}
function client(id, name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    const st = { id: id, name: name, ws: ws, code: null, seat: -1, isHost: false, last: null, errors: [], invites: [] };
    ws.on('message', buf => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      if (m.type === 'welcome') { st.code = m.code; st.seat = m.seat; st.isHost = m.isHost; }
      else if (m.type === 'state') { st.last = m; }
      else if (m.type === 'inviteInfo') { st.invites.push(m); }
      else if (m.type === 'error') { st.errors.push(m.message); }
    });
    ws.on('open', () => res(st));
    ws.on('error', e => rej(e));
  });
}
function send(st, msg) {
  st.ws.send(JSON.stringify(Object.assign({ playerId: 'tg:' + st.id, name: st.name, initData: makeInitData(st.id, st.name) }, msg)));
}
function waitFor(st, pred, ms) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout waiting')); }
    }, 50);
  });
}

(async function () {
  // -------- Server A --------
  const A = startServer('A');
  await waitHealth();

  // 2-player create + join
  const c1 = await client(201, 'Ali');
  send(c1, { type: 'create', mode: 2 });
  await waitFor(c1, () => c1.code, 4000);
  const code2 = c1.code;
  assert.strictEqual(c1.isHost, true);
  const c2 = await client(202, 'Bob');
  send(c2, { type: 'join', code: code2 });
  await waitFor(c2, () => c2.code === code2, 4000);
  await waitFor(c1, () => c1.last && c1.last.state === 'playing', 8000);
  assert.strictEqual(c1.last.mode, 2, '2p room is mode 2');
  ok('e2e: 2-player create + join + auto-start (real WebSocket)');

  // invite link format
  send(c1, { type: 'invite' });
  await waitFor(c1, () => c1.invites.length > 0, 4000);
  const inv = c1.invites[0];
  assert.ok(inv.tgUrl && inv.tgUrl.startsWith('https://t.me/') && inv.tgUrl.includes('start=room_' + code2), 'Telegram Mini App deep link');
  assert.ok(inv.webUrl && inv.webUrl.includes('?room=' + code2), 'web fallback link');
  ok('e2e: invite link is a valid t.me Mini App URL + web URL');

  // 4-player create + 4 joins
  const c3 = await client(203, 'C1');
  send(c3, { type: 'create', mode: 4 });
  await waitFor(c3, () => c3.code, 8000);
  const code4 = c3.code;
  for (const [id, name] of [[204, 'C2'], [205, 'C3'], [206, 'C4']]) {
    const cc = await client(id, name);
    send(cc, { type: 'join', code: code4 });
    await waitFor(cc, () => cc.code === code4, 8000);
  }
  // Belt-and-suspenders: make sure the game actually starts (auto-start is
  // timer/deterministic, so nudge it explicitly and poll until it does).
  let started = false;
  for (let i = 0; i < 10 && !started; i++) {
    send(c3, { type: 'start', playerId: c3.playerId });
    await new Promise(r => setTimeout(r, 300));
    if (c3.last && c3.last.state === 'playing') started = true;
  }
  await waitFor(c3, () => c3.last && c3.last.state === 'playing', 8000);
  assert.strictEqual(c3.last.mode, 4, '4p room is mode 4');
  ok('e2e: 4-player create + join + auto-start (real WebSocket)');

  // rejoin within the same server reclaims the seat
  c2.ws.close();
  await new Promise(r => setTimeout(r, 300));
  const c2b = await client(202, 'Bob');
  send(c2b, { type: 'join', code: code2 });
  await waitFor(c2b, () => c2b.code === code2, 4000);
  assert.strictEqual(c2b.seat, 1, 'rejoining player reclaims their seat (1)');
  ok('e2e: same account rejoins and reclaims its seat');

  // let the debounced persistence flush, then restart the server
  await new Promise(r => setTimeout(r, 800));
  await stopServer(A);

  // -------- Server B (same PostgreSQL data dir) --------
  const B = startServer('B');
  await waitHealth();
  const c1b = await client(201, 'Ali');
  send(c1b, { type: 'join', code: code2 });
  await waitFor(c1b, () => c1b.code === code2, 8000);
  assert.strictEqual(c1b.seat, 0, 'room + seat membership survived a full server restart (Postgres)');
  ok('e2e: room + membership persisted in PostgreSQL across a restart');

  await stopServer(B);
  cleanup();
  console.log('\nAll ' + passed + ' e2e tests passed.');
  process.exit(0);
})().catch(e => { console.error('E2E TEST FAILED:', e); cleanup(); process.exit(1); });

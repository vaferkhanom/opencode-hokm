'use strict';

// Account + room persistence.
// Driver precedence: DATABASE_URL            -> postgres:// (remote PG) | pglite:<dir> (embedded PG)
//                   RAILWAY_PROJECT_ID       -> embedded PGlite (persists for the deployment lifetime)
//                   otherwise                -> memory (tests)
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'hokm-db.json');

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms)),
  ]);
}

const ON_RAILWAY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT);

function resolveMode() {
  const url = process.env.DATABASE_URL;
  if (url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))) return { mode: 'postgres', url };
  if (url && url.startsWith('pglite:')) return { mode: 'pglite', url };
  if (ON_RAILWAY) return { mode: 'pglite', url: 'pglite:' + path.join(DATA_DIR, 'hokm.pglite') };
  return { mode: 'memory', url: '' };
}

const cfg = resolveMode();
const MODE = cfg.mode;

let pool = null;       // pg
let pglite = null;     // PGlite
let driver = null;     // { query(sql, params) -> Promise<rows[]> }

const mem = new Map();        // tg_id -> user row (memory/file mode)
let roomsMem = new Map();     // code  -> room serialized (memory mode)
let dirty = false;
let flushTimer = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  tg_id BIGINT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  games INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  kot INT NOT NULL DEFAULT 0,
  room_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  mode INT NOT NULL,
  state TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
`;

function loadFile() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const rows = JSON.parse(raw);
    if (Array.isArray(rows)) rows.forEach(r => mem.set(Number(r.tg_id), r));
  } catch (e) { /* nothing persisted yet */ }
}
function persistNow() {
  if (MODE !== 'file' || !dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...mem.values()]));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { /* best-effort */ }
}
function schedulePersist() {
  if (MODE !== 'file') return;
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(function () { flushTimer = null; persistNow(); }, 300);
}
process.on('exit', function () { if (flushTimer) { clearTimeout(flushTimer); persistNow(); } });

async function init() {
  if (MODE === 'postgres') {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: cfg.url, max: 5 });
    driver = { query: async (s, p) => (await pool.query(s, p)).rows };
    await migrate();
    return { mode: MODE };
  }
  if (MODE === 'pglite') {
    try {
      const { PGlite } = require('@electric-sql/pglite');
      const dir = cfg.url.replace(/^pglite:/, '') || path.join(DATA_DIR, 'hokm.pglite');
      try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch (e) { /* ok */ }
      pglite = new PGlite(dir);
      await withTimeout(pglite.waitReady, 8000);
      driver = { query: async (s, p) => (await pglite.query(s, p)).rows };
      await withTimeout(migrate(), 8000);
      return { mode: MODE, dir };
    } catch (e) {
      console.error('[store] pglite init failed, falling back to memory:', e && e.message);
      MODE = 'memory';
      pglite = null;
    }
  }
  // memory
  return { mode: 'memory' };
}

async function migrate() {
  const stmts = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
  for (const st of stmts) {
    await driver.query(st, []);
  }
}

function normTgId(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? Math.trunc(n) : null;
}

async function upsertUser(u) {
  const id = normTgId(u && u.id);
  if (!id) return null;
  const prev = mem.get(id) || {};
  const row = {
    tg_id: id,
    first_name: u.first_name || prev.first_name || '',
    last_name: u.last_name || prev.last_name || '',
    username: u.username || prev.username || '',
    lang: u.language_code || prev.lang || '',
    games: prev.games || 0, wins: prev.wins || 0, kot: prev.kot || 0,
    room_code: prev.room_code || null
  };
  mem.set(id, row);
  schedulePersist();
  if (!driver) return row;
  const r = await driver.query(
    `INSERT INTO users (tg_id, first_name, last_name, username, lang, last_seen)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (tg_id) DO UPDATE SET
       first_name=COALESCE(EXCLUDED.first_name,users.first_name),
       last_name=COALESCE(EXCLUDED.last_name,users.last_name),
       username=COALESCE(EXCLUDED.username,users.username),
       lang=COALESCE(EXCLUDED.lang,users.lang), last_seen=now()
     RETURNING *`,
    [id, row.first_name, row.last_name, row.username, row.lang]
  );
  return r[0] || row;
}

async function getUser(tgId) {
  const id = normTgId(tgId);
  if (!id) return null;
  if (!driver) return mem.get(id) || null;
  const r = await driver.query('SELECT * FROM users WHERE tg_id=$1', [id]);
  return r[0] || null;
}

async function recordMatch(seats, winSide) {
  if (!Array.isArray(seats)) return;
  for (const s of seats) {
    const id = normTgId(s && s.tgId);
    if (!id || s.isBot) continue;
    const won = s.side === winSide;
    const row = mem.get(id);
    if (row) {
      row.games = (row.games || 0) + 1;
      if (won) row.wins = (row.wins || 0) + 1;
      if (s.maker) row.kot = (row.kot || 0) + 1;
    }
    if (driver) {
      await driver.query(
        'UPDATE users SET games=games+1, wins=wins+$2' + (s.maker ? ', kot=kot+1' : '') + ', last_seen=now() WHERE tg_id=$1',
        [id, won ? 1 : 0]
      );
    }
  }
  schedulePersist();
}

async function setRoom(tgId, code) {
  const id = normTgId(tgId);
  if (!id) return;
  const row = mem.get(id);
  if (row) row.room_code = code || null;
  schedulePersist();
  if (driver) await driver.query('UPDATE users SET room_code=$2, last_seen=now() WHERE tg_id=$1', [id, code || null]);
}

async function clearRoom(tgId, code) {
  const id = normTgId(tgId);
  if (!id) return;
  const row = mem.get(id);
  if (row && (!code || row.room_code === code)) row.room_code = null;
  schedulePersist();
  if (driver) {
    await driver.query('UPDATE users SET room_code=NULL WHERE tg_id=$1' + (code ? ' AND room_code=$2' : ''), code ? [id, code] : [id]);
  }
}

async function getRoom(tgId) {
  const id = normTgId(tgId);
  if (!id) return null;
  if (!driver) return (mem.get(id) || {}).room_code || null;
  const r = await driver.query('SELECT room_code FROM users WHERE tg_id=$1', [id]);
  return (r[0] && r[0].room_code) || null;
}

async function saveRoom(room) {
  if (!room) return;
  const data = JSON.stringify(room.data || room);
  roomsMem.set(room.code, { code: room.code, mode: room.mode, state: room.state, data: room.data || room });
  if (!driver) return;
  await driver.query(
    `INSERT INTO rooms (code, mode, state, data, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,now())
     ON CONFLICT (code) DO UPDATE SET mode=EXCLUDED.mode, state=EXCLUDED.state, data=EXCLUDED.data, updated_at=now()`,
    [room.code, room.mode, room.state, data]
  );
}

async function loadRooms() {
  if (!driver) return [...roomsMem.values()];
  const r = await driver.query('SELECT code, mode, state, data FROM rooms ORDER BY updated_at', []);
  return r.map(row => {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return { code: row.code, mode: row.mode, state: row.state, data };
  });
}

async function deleteRoom(code) {
  roomsMem.delete(code);
  if (driver) await driver.query('DELETE FROM rooms WHERE code=$1', [code]);
}

module.exports = {
  init, upsertUser, getUser, recordMatch,
  setRoom, clearRoom, getRoom,
  saveRoom, loadRooms, deleteRoom,
  MODE,
  get MEMORY() { return MODE === 'memory'; },
  get isPersisted() { return MODE === 'postgres' || MODE === 'pglite'; },
  get isMemory() { return MODE === 'memory'; }
};

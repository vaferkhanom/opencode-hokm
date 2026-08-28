'use strict';

// Account persistence: postgres (DATABASE_URL) > file (Railway runtime) > memory (tests)
const fs = require('fs');
const path = require('path');

const ON_RAILWAY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT);
const MODE = process.env.DATABASE_URL ? 'postgres' : (ON_RAILWAY ? 'file' : 'memory');

let pool = null;
if (MODE === 'postgres') {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'hokm-db.json');

const SCHEMA = `CREATE TABLE IF NOT EXISTS users (
  tg_id BIGINT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, lang TEXT,
  games INT NOT NULL DEFAULT 0, wins INT NOT NULL DEFAULT 0, kot INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now());`;

const mem = new Map(); // backing store for both memory and file modes
let dirty = false;
let flushTimer = null;

function loadFile() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const rows = JSON.parse(raw);
    if (Array.isArray(rows)) rows.forEach(r => mem.set(Number(r.tg_id), r));
    return true;
  } catch (e) { return false; }
}
function persistNow() {
  if (MODE !== 'file' || !dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...mem.values()]));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { /* best-effort persistence */ }
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
    await pool.query(SCHEMA);
    return { mode: MODE };
  }
  if (MODE === 'file') {
    loadFile();
    return { mode: 'file', file: DB_FILE, users: mem.size };
  }
  return { mode: 'memory' };
}

function normTgId(v) {
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.trunc(n) : null;
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
    games: prev.games || 0, wins: prev.wins || 0, kot: prev.kot || 0
  };
  mem.set(id, row);
  schedulePersist();
  if (MODE !== 'postgres') return row;
  const r = await pool.query(
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
  return r.rows[0];
}

async function getUser(tgId) {
  const id = normTgId(tgId);
  if (!id) return null;
  if (MODE !== 'postgres') return mem.get(id) || null;
  const r = await pool.query('SELECT * FROM users WHERE tg_id=$1', [id]);
  return r.rows[0] || null;
}

async function recordMatch(seats, winSide) {
  if (!Array.isArray(seats)) return;
  for (const s of seats) {
    const id = normTgId(s && s.tgId);
    if (!id || s.isBot) continue;
    const won = s.side === winSide;
    const row = mem.get(id);
    if (row) { row.games = (row.games || 0) + 1; if (won) row.wins = (row.wins || 0) + 1; }
    if (MODE === 'postgres') {
      await pool.query('UPDATE users SET games=games+1, wins=wins+$2, last_seen=now() WHERE tg_id=$1', [id, won ? 1 : 0]);
    }
  }
  schedulePersist();
}

module.exports = { init, upsertUser, getUser, recordMatch, MODE, get MEMORY() { return MODE === 'memory'; } };

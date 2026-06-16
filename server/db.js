// Durable storage for the online game: the lifetime leaderboard (players) and each table's 锅
// snapshot (seats + standings). Backed by SQLite (better-sqlite3) at a single file under Azure's
// persistent /home mount, so it survives both restarts AND redeploys (the app directory is wiped on
// each deploy; /home is not). On first open, a legacy JSON file sitting at that path — the pre-database
// format — is migrated in and moved aside. If the native module can't load on the host, it degrades to
// an atomic JSON file at the same path, so the server always starts and never silently drops writes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const onAzure = (() => { try { return fs.existsSync('/home'); } catch { return false; } })();
// SCORES_FILE keeps the existing env name (tests + the Azure app setting already use it).
export const DB_FILE = process.env.SCORES_FILE
  || (onAzure ? '/home/data/mahjong.db' : fileURLToPath(new URL('./data/mahjong.db', import.meta.url)));
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// Read a pre-database JSON file (if the file at DB_FILE isn't already a SQLite database) so its data
// can be recovered. Handles both the current shape ({scoreBook, tables}) and the bare-scoreBook legacy.
function readLegacyJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    if (buf.slice(0, 15).toString('latin1') === 'SQLite format 3') return null; // already a DB — nothing to migrate
    const raw = JSON.parse(buf.toString('utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const scoreBook = raw.scoreBook || (!raw.tables ? raw : {}); // bare object = the old scoreBook
    return { scoreBook: scoreBook || {}, tables: Array.isArray(raw.tables) ? raw.tables : [] };
  } catch { return null; }
}

const legacy = readLegacyJson(DB_FILE); // captured BEFORE any rename, so it's safe for either backend
let impl = null;

try {
  const { default: Database } = await import('better-sqlite3');
  if (legacy) fs.renameSync(DB_FILE, DB_FILE + '.legacy.bak'); // move the old JSON aside so SQLite opens a fresh DB
  const sdb = new Database(DB_FILE);
  sdb.pragma('journal_mode = DELETE'); // single-file DB — no -wal/-shm sidecars (simpler ops + test cleanup)
  sdb.exec('CREATE TABLE IF NOT EXISTS players (uid TEXT PRIMARY KEY, name TEXT, total INTEGER DEFAULT 0, pots INTEGER DEFAULT 0);'
    + 'CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY, seats TEXT, pot TEXT);');
  const qUpsertPlayer = sdb.prepare('INSERT INTO players (uid,name,total,pots) VALUES (@uid,@name,@total,@pots) '
    + 'ON CONFLICT(uid) DO UPDATE SET name=@name, total=@total, pots=@pots');
  const qPlayers = sdb.prepare('SELECT uid,name,total,pots FROM players');
  const qUpsertTable = sdb.prepare('INSERT INTO tables (id,seats,pot) VALUES (@id,@seats,@pot) '
    + 'ON CONFLICT(id) DO UPDATE SET seats=@seats, pot=@pot');
  const qTables = sdb.prepare('SELECT id,seats,pot FROM tables');
  impl = {
    backend: 'sqlite',
    loadScoreBook() { const o = {}; for (const r of qPlayers.all()) o[r.uid] = { name: r.name, total: r.total, pots: r.pots }; return o; },
    savePlayer(uid, rec) { qUpsertPlayer.run({ uid, name: rec.name || '', total: rec.total | 0, pots: rec.pots | 0 }); },
    loadTables() { const out = []; for (const r of qTables.all()) out[r.id] = { seats: JSON.parse(r.seats || 'null'), pot: JSON.parse(r.pot || 'null') }; return out; },
    saveTable(id, seats, pot) { qUpsertTable.run({ id, seats: JSON.stringify(seats ?? null), pot: JSON.stringify(pot ?? null) }); },
  };
  if (legacy) {
    const tx = sdb.transaction(() => {
      for (const [uid, rec] of Object.entries(legacy.scoreBook)) impl.savePlayer(uid, rec);
      legacy.tables.forEach((t, i) => { if (t) impl.saveTable(i, t.seats, t.pot); });
    });
    tx();
    console.log(`[db] migrated ${Object.keys(legacy.scoreBook).length} player(s) + ${legacy.tables.filter(Boolean).length} table(s) from legacy JSON → ${DB_FILE}`);
  }
  console.log(`[db] SQLite ready at ${DB_FILE}`); // informational → stdout (stderr is reserved for real warnings/errors)
} catch (e) {
  console.warn('[db] better-sqlite3 unavailable — falling back to a JSON file:', e && e.message);
}

if (!impl) {
  // Fallback: an atomic JSON file (write-temp-then-rename) at DB_FILE, seeded from the legacy data we
  // already read. Still on the persistent path; a clean write never loses data.
  const state = legacy || { scoreBook: {}, tables: [] };
  const flush = () => {
    const tmp = DB_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, DB_FILE); }
    catch (err) { console.error('[db] JSON write failed:', err && err.message); }
  };
  flush();
  impl = {
    backend: 'json',
    loadScoreBook() { return state.scoreBook; },
    savePlayer(uid, rec) { state.scoreBook[uid] = { name: rec.name || '', total: rec.total | 0, pots: rec.pots | 0 }; flush(); },
    loadTables() { return state.tables; },
    saveTable(id, seats, pot) { state.tables[id] = { seats: seats ?? null, pot: pot ?? null }; flush(); },
  };
  console.log(`[db] JSON file at ${DB_FILE}`); // informational; the fallback itself was already warned above
}

export default impl;

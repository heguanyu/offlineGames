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
    + 'CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY, seats TEXT, pot TEXT);'
    + 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);'); // small key/value blobs (e.g. the polled weather forecast)
  const qUpsertPlayer = sdb.prepare('INSERT INTO players (uid,name,total,pots) VALUES (@uid,@name,@total,@pots) '
    + 'ON CONFLICT(uid) DO UPDATE SET name=@name, total=@total, pots=@pots');
  const qPlayers = sdb.prepare('SELECT uid,name,total,pots FROM players');
  const qUpsertTable = sdb.prepare('INSERT INTO tables (id,seats,pot) VALUES (@id,@seats,@pot) '
    + 'ON CONFLICT(id) DO UPDATE SET seats=@seats, pot=@pot');
  const qTables = sdb.prepare('SELECT id,seats,pot FROM tables');
  const qSetMeta = sdb.prepare('INSERT INTO meta (key,value) VALUES (@k,@v) ON CONFLICT(key) DO UPDATE SET value=@v');
  const qGetMeta = sdb.prepare('SELECT value FROM meta WHERE key=?');
  impl = {
    backend: 'sqlite',
    saveWeather(json) { qSetMeta.run({ k: 'weather', v: JSON.stringify(json) }); },
    loadWeather() { const r = qGetMeta.get('weather'); return r ? JSON.parse(r.value) : null; },
    // Per-game leaderboards share the players table via a composite "game|uid" key. loadScoreBook
    // returns a nested book { game: { uid: {name,total,pots} } }; legacy bare-uid rows (pre per-game,
    // all 天津) read as the 'tianjin' board.
    loadScoreBook() {
      const o = {};
      for (const r of qPlayers.all()) {
        const i = r.uid.indexOf('|');
        const game = i >= 0 ? r.uid.slice(0, i) : 'tianjin';
        const uid = i >= 0 ? r.uid.slice(i + 1) : r.uid;
        // The SQLite columns `pots`/`pot` are legacy STORAGE names (renaming them would need a
        // migration that breaks the live DB); the app-level field is `matches`/`match`.
        (o[game] || (o[game] = {}))[uid] = { name: r.name, total: r.total, matches: r.pots };
      }
      return o;
    },
    // `pots` is the legacy column/key (kept for the live DB); accept a legacy `rec.pots` too so the
    // JSON→DB migration and any old in-memory record still record the match count.
    savePlayer(game, uid, rec) { qUpsertPlayer.run({ uid: game + '|' + uid, name: rec.name || '', total: rec.total | 0, pots: (rec.matches ?? rec.pots) | 0 }); },
    loadTables() { const out = []; for (const r of qTables.all()) out[r.id] = { seats: JSON.parse(r.seats || 'null'), match: JSON.parse(r.pot || 'null') }; return out; },
    saveTable(id, seats, match) { qUpsertTable.run({ id, seats: JSON.stringify(seats ?? null), pot: JSON.stringify(match ?? null) }); },
  };
  if (legacy) {
    const tx = sdb.transaction(() => {
      for (const [uid, rec] of Object.entries(legacy.scoreBook)) impl.savePlayer('tianjin', uid, rec); // legacy JSON predates per-game → 天津 board
      legacy.tables.forEach((t, i) => { if (t) impl.saveTable(i, t.seats, t.pot); });
    });
    tx();
    console.log(`[db] migrated ${Object.keys(legacy.scoreBook).length} player(s) + ${legacy.tables.filter(Boolean).length} table(s) from legacy JSON → ${DB_FILE}`);
  }
  // One-time: re-key pre-per-game rows (bare uid, all 天津) to the 'tianjin|uid' composite key, so the
  // existing leaderboard lands on the 天津 board instead of an ambiguous legacy bucket.
  const bare = qPlayers.all().filter((r) => !r.uid.includes('|'));
  if (bare.length) {
    const qDel = sdb.prepare('DELETE FROM players WHERE uid = ?');
    sdb.transaction(() => { for (const r of bare) { impl.savePlayer('tianjin', r.uid, r); qDel.run(r.uid); } })();
    console.log(`[db] re-keyed ${bare.length} legacy player row(s) → 天津 board`);
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
  // legacy bare-uid keys (pre per-game) → the 天津 board, so they survive into the nested model
  for (const k of Object.keys(state.scoreBook)) { if (!k.includes('|')) { state.scoreBook['tianjin|' + k] = state.scoreBook[k]; delete state.scoreBook[k]; } }
  impl = {
    backend: 'json',
    saveWeather(json) { state.weather = json; flush(); },
    loadWeather() { return state.weather || null; },
    loadScoreBook() {
      const o = {};
      for (const [k, rec] of Object.entries(state.scoreBook)) {
        const i = k.indexOf('|');
        const game = i >= 0 ? k.slice(0, i) : 'tianjin';
        const uid = i >= 0 ? k.slice(i + 1) : k;
        // stored under the legacy `pots`/`pot` keys (shared with the SQLite columns); surfaced to the
        // app as `matches`/`match`.
        (o[game] || (o[game] = {}))[uid] = { name: rec.name, total: rec.total, matches: rec.pots };
      }
      return o;
    },
    savePlayer(game, uid, rec) { state.scoreBook[game + '|' + uid] = { name: rec.name || '', total: rec.total | 0, pots: (rec.matches ?? rec.pots) | 0 }; flush(); },
    loadTables() { return (state.tables || []).map((t) => t && { seats: t.seats ?? null, match: t.pot ?? null }); },
    saveTable(id, seats, match) { state.tables[id] = { seats: seats ?? null, pot: match ?? null }; flush(); },
  };
  console.log(`[db] JSON file at ${DB_FILE}`); // informational; the fallback itself was already warned above
}

export default impl;

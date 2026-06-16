// server/db.js: durable storage survives a process restart, and a legacy JSON file is migrated in.
// Usage: node test/mahjong-db-test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_JS = pathToFileURL(path.join(ROOT, 'server', 'db.js')).href;
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.error('  ✗', m); } };
const cleanup = (f) => { for (const ext of ['', '.legacy.bak', '.tmp', '-journal']) { try { fs.unlinkSync(f + ext); } catch {} } };

// Run a snippet of module code with db.js imported as `db`, against a given SCORES_FILE.
function run(file, code) {
  const src = `const db = (await import(${JSON.stringify(DB_JS)})).default; ${code}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src],
    { env: { ...process.env, SCORES_FILE: file }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('subprocess failed: ' + (r.stderr || r.stdout));
  return r.stdout.split('\n').pop().trim(); // db.js prints diagnostics on earlier lines; the snippet's output is last
}

try {
  // ---- 1) cross-process persistence (simulates a server restart) ----
  console.log('persistence across a restart:');
  const f1 = path.join(os.tmpdir(), `mj-db-${process.pid}-a.db`); cleanup(f1);
  const backend = run(f1, `db.savePlayer('tianjin', 'u1', { name: '阿强', total: 42, pots: 3 });
    db.savePlayer('guobiao', 'u1', { name: '阿强', total: 5, pots: 1 });
    db.saveTable(0, [{ kind:'human', uid:'u1', name:'阿强' }, { kind:'bot' }, { kind:'bot' }, { kind:'bot' }], { scores:[1,2,3,4], dealer:2, prevailingWind:1 });
    process.stdout.write(db.backend);`);
  console.log('  backend:', backend);
  const out1 = JSON.parse(run(f1, `const sb = db.loadScoreBook(); const t = db.loadTables();
    process.stdout.write(JSON.stringify({ sb, t }));`));
  ok(out1.sb.tianjin && out1.sb.tianjin.u1 && out1.sb.tianjin.u1.total === 42 && out1.sb.tianjin.u1.pots === 3 && out1.sb.tianjin.u1.name === '阿强', 'leaderboard player survived the restart');
  ok(out1.sb.guobiao && out1.sb.guobiao.u1 && out1.sb.guobiao.u1.total === 5, 'per-game boards are separate (same uid, different games kept apart)');
  ok(out1.t[0] && out1.t[0].pot && out1.t[0].pot.scores[3] === 4 && out1.t[0].pot.dealer === 2, '锅 snapshot survived the restart');
  ok(out1.t[0].seats[0].uid === 'u1' && out1.t[0].seats[1].kind === 'bot', 'table seats survived the restart');
  cleanup(f1);

  // ---- 2) updates accumulate (a second 锅 adds to the lifetime total) ----
  console.log('lifetime totals accumulate:');
  const f2 = path.join(os.tmpdir(), `mj-db-${process.pid}-b.db`); cleanup(f2);
  run(f2, `db.savePlayer('tianjin', 'u1', { name:'阿强', total:10, pots:1 });`);
  run(f2, `db.savePlayer('tianjin', 'u1', { name:'阿强', total:25, pots:2 });`); // server keeps a running total in memory; here we just verify the latest sticks
  const out2 = JSON.parse(run(f2, `process.stdout.write(JSON.stringify(db.loadScoreBook()));`));
  ok(out2.tianjin && out2.tianjin.u1 && out2.tianjin.u1.total === 25 && out2.tianjin.u1.pots === 2, 'updated lifetime total persisted');
  cleanup(f2);

  // ---- 3) migrate a legacy JSON file into the database ----
  console.log('legacy JSON migration:');
  const f3 = path.join(os.tmpdir(), `mj-db-${process.pid}-c.db`); cleanup(f3);
  fs.writeFileSync(f3, JSON.stringify({
    scoreBook: { uLegacy: { name: '老玩家', total: 77, pots: 5 } },
    tables: [{ seats: [{ kind:'human', uid:'uLegacy', name:'老玩家' }, { kind:'bot' }, { kind:'bot' }, { kind:'bot' }], pot: { scores: [8, -3, -3, -2], dealer: 1, prevailingWind: 2 } }],
  }));
  const out3 = JSON.parse(run(f3, `process.stdout.write(JSON.stringify({ sb: db.loadScoreBook(), t: db.loadTables() }));`));
  ok(out3.sb.tianjin && out3.sb.tianjin.uLegacy && out3.sb.tianjin.uLegacy.total === 77 && out3.sb.tianjin.uLegacy.pots === 5, 'legacy leaderboard recovered onto the 天津 board');
  ok(out3.t[0] && out3.t[0].pot && out3.t[0].pot.scores[0] === 8 && out3.t[0].pot.prevailingWind === 2, 'legacy 锅 snapshot recovered into the DB');
  ok(fs.existsSync(f3 + '.legacy.bak'), 'the legacy JSON was moved aside (.legacy.bak)');
  // and it persists on the next open (now a real DB, no re-migration)
  const out3b = JSON.parse(run(f3, `process.stdout.write(JSON.stringify(db.loadScoreBook()));`));
  ok(out3b.tianjin && out3b.tianjin.uLegacy && out3b.tianjin.uLegacy.total === 77, 'migrated data persists on the next open');
  cleanup(f3); cleanup(f3 + '.legacy.bak'.replace(/\.db/, ''));
  try { fs.unlinkSync(f3 + '.legacy.bak'); } catch {}

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('DB TEST ERROR:', e.message);
  process.exit(1);
}

// Tests shared/audio-revive.js: the AudioContext keeper must hand back a working context
// after the old one dies (what iOS does to backgrounded pages — the "no sound until app
// restart" bug). Usage: node test/audio-revive-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8143;
const server = await startServer(PORT);
const browser = await launchBrowser();
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

const r = await page.evaluate(async () => {
  const { createAudioKeeper } = await import('/shared/audio-revive.js');
  const out = {};
  let rebuilt = 0;
  const keeper = createAudioKeeper({ onRebuild: () => rebuilt++ });

  const c1 = keeper.ensure();
  out.created = !!c1;
  out.sameOnSecondCall = keeper.ensure() === c1;
  out.rebuiltAfterFirst = rebuilt;                 // must be 0 — first creation isn't a rebuild

  await c1.close();                                // simulate iOS killing the context
  const c2 = keeper.ensure();
  out.newAfterClose = !!c2 && c2 !== c1;
  out.rebuildFired = rebuilt === 1;
  out.state2 = c2 && c2.state;

  // a wedged context (resume never reaches 'running' while visible) must also be replaced
  const stuck = keeper.ensure();
  stuck.resume = () => Promise.resolve();          // resume() that never un-suspends
  Object.defineProperty(stuck, 'state', { get: () => 'suspended' });
  keeper.ensure();                                 // triggers the watchdog
  await new Promise((res) => setTimeout(res, 700));      // watchdog marks it wedged
  await new Promise((res) => setTimeout(res, 3000));     // rebuild rate-limit window
  const c3 = keeper.ensure();
  out.newAfterWedge = !!c3 && c3 !== stuck;
  out.rebuild2 = rebuilt === 2;
  return out;
});

await browser.close();
server.close();

let failed = 0;
for (const [k, v] of Object.entries(r)) {
  const want = k === 'rebuiltAfterFirst' ? 0 : k === 'state2' ? ['running', 'suspended'].includes(r.state2) : true;
  const pass = k === 'rebuiltAfterFirst' ? v === 0 : k === 'state2' ? want : v === true;
  if (!pass) { failed++; console.error(`  FAIL: ${k} = ${JSON.stringify(v)}`); }
  else console.log(`  ok: ${k} = ${JSON.stringify(v)}`);
}
console.log(failed ? `${failed} FAILED` : 'audio-revive: all passed');
process.exit(failed ? 1 : 0);

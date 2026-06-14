// Capture the bot-discard fly mid-animation (2D flat + 3D), non-fast. Drives the human
// by pressing Enter (discards the auto-selected tile / confirms) so bots take turns.
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';
const dir = path.join(root, 'test');
const PORT = 8154;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
async function run(url, vp, shot, flat) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', e => errors.push(url+' '+e.message));
  page.on('console', m => { if (m.type()==='error') errors.push(url+' console: '+m.text()); });
  // fast mode is on by default now — turn it off so the discard animation runs.
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('mahjong-fast', '0'); localStorage.setItem('guobiao-fast', '0'); } catch {} });
  await page.goto(`http://localhost:${PORT}${url}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn'); await page.click('#start-btn');
  let done = false;
  for (let i=0;i<60 && !done;i++){
    await page.keyboard.press('Enter');
    await new Promise(r=>setTimeout(r,140));
    if (flat) {
      const flying = await page.evaluate(()=>!!document.querySelector('.b2-fly'));
      if (flying) { await new Promise(r=>setTimeout(r,420)); await page.screenshot({path:path.join(dir,shot)}); console.log(shot,'mid-fly captured'); done=true; }
    }
    await new Promise(r=>setTimeout(r,160));
  }
  if (!flat) { await page.screenshot({path:path.join(dir,shot)}); console.log(shot,'captured'); }
  await page.close();
}
try {
  await run('/games/mahjong/?flat=1', {width:844,height:390,deviceScaleFactor:2}, 'mahjong-flat-discard.png', true);
  await run('/games/guobiao/?flat=1', {width:844,height:390,deviceScaleFactor:2}, 'guobiao-flat-discard.png', true);
  console.log(errors.length?('ERRORS:\n  '+errors.join('\n  ')):'no page errors');
} catch(e){ console.error('FAIL:',e.message); process.exitCode=1; }
finally { await browser.close(); server.close(); }

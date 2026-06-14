import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';
const PORT = 8149;
const server = await startServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 });
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1&flat=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn'); await page.click('#start-btn');
  await new Promise(r=>setTimeout(r,500));
  await page.evaluate(()=>window.__mj.debugWin());
  await new Promise(r=>setTimeout(r,300));
  await page.screenshot({ path: path.join(root,'test','mahjong-flat-result.png') });
  const s = await page.evaluate(()=>{const p=document.querySelector('#result-overlay .panel');return {c:p.clientHeight,sh:p.scrollHeight,over:p.scrollHeight>p.clientHeight+1};});
  console.log('result panel', s.c, 'content', s.sh, s.over?'SCROLLS':'fits', errs.length?('ERR:'+errs.join()):'no errors');
} finally { await browser.close(); server.close(); }

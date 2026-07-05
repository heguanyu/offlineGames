// Keeps a Web Audio context usable across long background stays (shared by the mahjong /
// card / billiards sound modules). iOS Safari/PWA can silently CLOSE or wedge a page's
// AudioContext after it sits in the background long enough — after that, resume() never
// returns it to 'running' and every sound call fails forever until a full page reload.
//
// createAudioKeeper() owns the context: call ensure() wherever the old code lazily created
// or resumed one (i.e. before every play). It
//   · lazily creates the context (first call should be gesture-driven, as before),
//   · resumes it whenever it isn't 'running' (covers iOS's non-standard 'interrupted'),
//   · watches each resume attempt — if the context is still not running ~½s later while the
//     page is visible, it's WEDGED, and the next ensure() closes + rebuilds it,
//   · re-checks on visibilitychange so returning to the app revives audio without a tap.
// AudioBuffers (decoded voice sprites etc.) are context-independent, so they survive a
// rebuild; per-context nodes (gain buses, oscillators) do not — pass onRebuild to restart
// anything long-lived you had wired to the old context.
export function createAudioKeeper({ onRebuild } = {}) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, wedged = false, everCreated = false, lastRebuild = 0, checkT = 0;

  function ensure() {
    if (!AC) return null;
    if (ctx && ctx.state === 'closed') ctx = null;
    // rebuild a wedged context (rate-limited so repeated non-gesture calls can't churn)
    if (ctx && wedged && performance.now() - lastRebuild > 3000) {
      try { ctx.close(); } catch {}
      ctx = null;
    }
    if (!ctx) {
      try { ctx = new AC(); } catch { return null; }
      wedged = false;
      lastRebuild = performance.now();
      if (everCreated && onRebuild) { try { onRebuild(ctx); } catch {} }
      everCreated = true;
    }
    if (ctx.state !== 'running') {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch {}
      clearTimeout(checkT);
      checkT = setTimeout(() => {
        if (ctx && ctx.state !== 'running' && document.visibilityState === 'visible') wedged = true;
      }, 500);
    } else {
      wedged = false;
    }
    return ctx;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // iOS also freezes SpeechSynthesis in the background; nudge it back too.
    try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch {}
    if (ctx) ensure();
  });

  return { ensure, current: () => ctx };
}

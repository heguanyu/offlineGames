// app-nav.js — neutralize the iOS/iPadOS edge-swipe (and Android equivalent).
//
// The edge-swipe is just the browser walking its history (back/forward). The hub, the online lobby
// and each game are SEPARATE pages, so normal navigation pushes history entries the swipe can jump
// between — which feels like an accidental "go back / go forward" mid-game. We keep the history stack
// shallow by turning every same-origin navigation into a history REPLACE instead of a push, so there
// is nothing to swipe to. The app's own on-screen buttons (返回大厅, hub cards, lobby links) still move
// between pages; only the OS swipe gesture is neutered. (We also disable overscroll/rubber-band, which
// stops the gesture outright on Android/desktop Chrome — it has no effect on iOS but is harmless.)
//
// Programmatic `location.href = …` jumps in the games' own scripts are converted to `location.replace`
// at their call sites; this file only handles <a> clicks + the overscroll CSS.
(function () {
  try { document.documentElement.style.overscrollBehavior = 'none'; } catch (e) {}
  addEventListener('DOMContentLoaded', function () { try { document.body.style.overscrollBehavior = 'none'; } catch (e) {} });

  // --- history PIN (kills the iPhone standalone-PWA edge-swipe outright) -------------------------
  // Turning link clicks into REPLACE keeps history shallow, but it can't stop the gesture once ANY
  // entry exists — e.g. after tapping an external (target=_blank) link in the NGA reader, which on
  // an installed iPhone PWA (no tabs) navigates in-place and leaves an entry to swipe back to. iPhone
  // standalone PWAs expose the interactive edge-swipe-back; iPad ones effectively don't (why iPad
  // "looked fine"). So we PIN: seed a trap entry and re-arm it on every popstate, so a back/forward
  // swipe always lands right back here. Gated to installed standalone PWAs only — a normal browser tab
  // keeps its working Back button (nothing in the app uses history.back(); on-screen 返回 uses replace).
  // A page that manages its own history (e.g. the NGA reader, which turns a back-swipe into
  // thread→list) sets window.__ownsHistory before this script runs — then we stay out of its way.
  try {
    var standalone = (navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (standalone && !window.__ownsHistory) {
      history.pushState(null, '', location.href);
      addEventListener('popstate', function () { history.pushState(null, '', location.href); });
    }
  } catch (e) {}

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;            // in-page anchor — leave alone
    var url;
    try { url = new URL(a.href, location.href); } catch (e2) { return; }
    if (url.origin !== location.origin) return;             // external link — leave alone
    e.preventDefault();
    location.replace(url.href);                             // REPLACE → no back/forward entry to swipe to
  }, true);

  // --- keep EVERY page on the latest deployed app version (see sw.js) -----------------------------
  // The service worker serves cached pages, so a sub-page entered directly (or kept alive by the iOS
  // PWA) would otherwise stay on an OLD version until the hub happened to trigger an update — the cause
  // of stale sub-pages after a deploy. Since app-nav.js loads on every page, we centralize the fix here:
  // on entry, ask the SW to check for a new version; and when a NEW worker takes control, reload to swap
  // in the fresh page + assets. Two escape hatches keep it from interrupting anything:
  //   • window.__appHandlesUpdate — the page owns its own update UX (the hub) → app-nav stays out.
  //   • the page is mid-activity → defer the reload. Detected generically (an emulator ROM running, or a
  //     mahjong/斗地主/掼蛋 hand past its start screen) or via an explicit window.appBusy() hook.
  function pageBusy() {
    if (typeof window.appBusy === 'function') { try { return !!window.appBusy(); } catch (e) {} }
    var gw = document.getElementById('game-wrap');                 // emulator: a ROM is running
    if (gw && !gw.hidden) return true;
    var so = document.getElementById('start-overlay');             // card/tile games: hidden once a hand is in play
    if (so) { try { if (getComputedStyle(so).display === 'none') return true; } catch (e) {} }
    return false;
  }
  try {
    if ('serviceWorker' in navigator) {
      var hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController) { hadController = true; return; }       // first-ever claim isn't an update (no reload loop on first visit)
        if (window.__appHandlesUpdate || pageBusy()) return;       // hub owns updates / don't reload mid-game
        location.reload();
      });
      addEventListener('DOMContentLoaded', function () {
        if (window.__appHandlesUpdate) return;
        try { navigator.serviceWorker.getRegistration().then(function (r) { return r && r.update(); }).catch(function () {}); } catch (e) {}
      });
    }
  } catch (e) {}
})();

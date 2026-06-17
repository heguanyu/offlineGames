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
})();

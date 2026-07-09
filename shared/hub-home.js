// Sub-hub "home" override. A scoped mini-hub landing page (e.g. /mj/ — a shareable hub that
// exposes only one game; see tools/gen-subhub.js) plants sessionStorage['hub-home'] with its own
// path. Game pages call homeHref() instead of hardcoding '../../' for their 返回大厅/主页
// navigations, so someone who entered through a sub-hub stays inside it and never lands on the
// full hub. sessionStorage scopes the override to the tab / PWA launch: entering a game directly
// (no marker) behaves exactly as before.
export function homeHref() {
  try { return sessionStorage.getItem('hub-home') || '../../'; } catch { return '../../'; }
}

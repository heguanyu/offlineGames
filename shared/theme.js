// shared/theme.js — repo-wide theme registry + per-module persistence.
//
// Load this as a PLAIN (non-module) script in <head>, BEFORE the body renders:
//     <script src="../shared/theme.js"></script>
// It runs synchronously and sets <html data-theme="…"> on first paint, so pages
// never flash the wrong palette. Palettes themselves live in shared/theme.css.
//
// Per-module selection: give <html> a `data-theme-scope` attribute (e.g.
// data-theme-scope="reader"); the choice is stored under `og-theme:<scope>` so
// each tool remembers its own theme. Omit it to share the "app" scope.
// A module's out-of-box palette can be set with `data-theme-default="midnight"`
// (defaults to "mocha") — used until the user picks one, which then persists.
//
// API (window.Theme):
//   .themes        → [{ id, label, color }, …]
//   .scope         → this page's scope string
//   .current       → active theme id
//   .set(id)       → switch + persist + notify
//   .onChange(fn)  → subscribe (returns an unsubscribe fn)
//   .buildPicker() → a ready-made segmented control (mount it anywhere)
(function () {
  var THEMES = [
    { id: 'mocha', label: '深色 · 摩卡', color: '#1e1e2e' },
    { id: 'latte', label: '浅色 · 拿铁', color: '#eff1f5' },
    { id: 'midnight', label: '午夜蓝', color: '#1a1a2e' },
    { id: 'sepia', label: '书卷 · 米黄', color: '#f4ecd8' },
  ];
  var root = document.documentElement;
  var scope = root.getAttribute('data-theme-scope') || 'app';
  var DEFAULT = root.getAttribute('data-theme-default') || 'mocha';
  var KEY = 'og-theme:' + scope;

  function byId(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  var current = byId(stored() || DEFAULT).id;
  var listeners = [];

  function setMetaColor(id) {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'theme-color');
      (document.head || root).appendChild(m);
    }
    m.setAttribute('content', byId(id).color);
  }
  function apply(id) {
    current = byId(id).id;
    root.setAttribute('data-theme', current);
    setMetaColor(current);
  }
  function set(id) {
    if (byId(id).id === current) return;
    apply(id);
    try { localStorage.setItem(KEY, current); } catch (e) { /* private mode */ }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](current); } catch (e) { /* isolate */ }
    }
  }
  function onChange(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  // Apply immediately, before <body> paints, so there is no flash of the default.
  apply(current);

  window.Theme = {
    themes: THEMES.slice(),
    scope: scope,
    get current() { return current; },
    set: set,
    onChange: onChange,
    buildPicker: function () {
      var wrap = document.createElement('div');
      wrap.className = 'theme-picker';
      THEMES.forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-opt' + (t.id === current ? ' on' : '');
        b.setAttribute('data-theme-id', t.id);
        b.textContent = t.label;
        b.addEventListener('click', function () { set(t.id); });
        wrap.appendChild(b);
      });
      onChange(function () {
        var opts = wrap.querySelectorAll('.theme-opt');
        for (var i = 0; i < opts.length; i++) {
          opts[i].classList.toggle('on', opts[i].getAttribute('data-theme-id') === current);
        }
      });
      return wrap;
    },
  };
})();

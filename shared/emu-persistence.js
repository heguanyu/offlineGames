// Makes emulator progress and settings survive page refresh / app close:
//  - quick-save states (RT / "1") are copied into IndexedDB and restored
//    into the emulator filesystem on the next game start, so quick load
//    works across sessions;
//  - battery saves (in-game saving) are flushed to persistent storage on
//    every quick save and whenever the page is hidden or closed, instead
//    of only on EmulatorJS's periodic timer;
//  - EmulatorJS keeps settings (control bindings, core options, volume) in
//    localStorage, which iOS treats as disposable for home-screen PWAs
//    (writes are flushed to disk lazily, so a force-quit can drop them, and
//    storage pressure purges localStorage while IndexedDB survives). Every
//    settings write is mirrored into IndexedDB and localStorage is re-seeded
//    from that mirror before the emulator boots. Control bindings are also
//    kept as a single shared profile applied to every game on the page —
//    EmulatorJS scopes its settings per game, so a rebind would otherwise
//    only affect the ROM it was made in.
//
// Usage (inside play(), after the EJS_* globals are set):
//   setupEmuPersistence({ dbName, gameName: window.EJS_gameName, system: 'gba' })
//     .then(() => { /* inject loader.js */ });
// Returns a promise that resolves once settings are back in localStorage
// (never rejects); inject loader.js after it so the emulator sees them.
// The page's database must already define 'states' and 'settings' object
// stores (both keyPath 'key').
function setupEmuPersistence({ dbName, gameName, system }) {
  const SHARED_CONTROLS = '__shared-controls__';
  // The key EmulatorJS reads this game's settings from (getLocalStorageKey):
  // gameId defaults to 1; the core part is the generic system name ('gba'
  // covers both the mGBA and VBA-M cores).
  const gameSettingsKey = 'ejs-1-' + system + '-' + gameName + '-settings';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName); // existing version; page created stores
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllRows(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putRows(store, rows) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      for (const row of rows) t.objectStore(store).put(row);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }

  function putState(slot, data) {
    return putRows('states', [{ key: gameName + '|' + slot, slot: String(slot), game: gameName, data }]);
  }

  async function statesForGame() {
    return (await getAllRows('states')).filter((s) => s.game === gameName);
  }

  // Re-seed localStorage from the IndexedDB mirror — the mirror is the
  // durable copy; whatever iOS left in localStorage is equal or older.
  // Then overlay the shared controls profile onto this game's record so a
  // rebind made in any game applies here too.
  async function restoreSettings() {
    let sharedControls = null;
    for (const row of await getAllRows('settings')) {
      if (row.key === SHARED_CONTROLS) sharedControls = row.value;
      else localStorage.setItem(row.key, row.value);
    }
    if (!sharedControls) return;
    let record;
    try { record = JSON.parse(localStorage.getItem(gameSettingsKey)); } catch (e) { /* corrupt */ }
    if (!(record instanceof Object) || Array.isArray(record)) record = {};
    record.controlSettings = sharedControls;
    // loadSettings discards the record unless all three fields are present.
    if (!(record.settings instanceof Object)) record.settings = {};
    if (!Array.isArray(record.cheats)) record.cheats = [];
    localStorage.setItem(gameSettingsKey, JSON.stringify(record));
  }

  // Mirror the localStorage keys EmulatorJS just wrote, and publish this
  // game's control bindings as the shared profile.
  function mirrorSettings(emulator) {
    let key = gameSettingsKey;
    try { key = emulator.getLocalStorageKey(); } catch (e) { /* use computed key */ }
    const rows = [];
    const globals = localStorage.getItem('ejs-settings'); // volume / mute
    if (globals !== null) rows.push({ key: 'ejs-settings', value: globals });
    const record = localStorage.getItem(key);
    if (record !== null) {
      rows.push({ key: key, value: record });
      try {
        const controls = JSON.parse(record).controlSettings;
        if (controls instanceof Object) rows.push({ key: SHARED_CONTROLS, value: controls });
      } catch (e) { /* unreadable record; skip the profile */ }
    }
    if (rows.length) putRows('settings', rows).catch((e) => console.warn('settings mirror failed:', e));
  }

  window.EJS_onGameStart = async () => {
    const em = window.EJS_emulator;
    const gm = em.gameManager;

    // EmulatorJS saves settings to localStorage on every change; mirror
    // each write into IndexedDB.
    const origSaveSettings = em.saveSettings.bind(em);
    em.saveSettings = () => {
      origSaveSettings();
      mirrorSettings(em);
    };

    // Restore quick states from previous sessions into the emulator FS.
    try {
      for (const s of await statesForGame()) {
        gm.FS.writeFile('/' + s.slot + '-quick.state', new Uint8Array(s.data));
      }
    } catch (e) {
      console.warn('quick state restore failed:', e);
    }

    // Force the IDBFS mount (/data/saves) to commit to IndexedDB on EVERY battery-save write.
    // EmulatorJS's saveSaveFiles() only writes the in-memory FS and leaves persistence to emscripten
    // IDBFS autoPersist — a debounced syncfs that on iOS frequently doesn't run before a home-screen
    // swipe / force-quit freezes the PWA, so the in-game save is silently dropped (the game comes back
    // fresh). Wrapping saveSaveFiles covers EVERY caller — the 30s interval, the exit handler, the
    // quick-save flush and the page-hide flush below — so a save is durable the moment it's written.
    const origSaveSaveFiles = gm.saveSaveFiles.bind(gm);
    gm.saveSaveFiles = () => {
      origSaveSaveFiles();
      try { if (gm.FS && gm.FS.syncfs) gm.FS.syncfs(false, (e) => { if (e) console.warn('save syncfs failed:', e); }); } catch (e) { /* fs gone */ }
    };

    // Quick save also persists the state and flushes the battery save.
    const origQuickSave = gm.quickSave.bind(gm);
    gm.quickSave = (slot) => {
      const ok = origQuickSave(slot);
      if (ok) {
        try {
          const data = gm.FS.readFile('/' + (slot || 1) + '-quick.state');
          putState(slot || 1, data).catch((e) => console.warn('state persist failed:', e));
          gm.saveSaveFiles(); // (wrapped above → writes SRAM + syncfs to IndexedDB)
        } catch (e) {
          console.warn('state persist failed:', e);
        }
      }
      return ok;
    };

    // Flush battery saves when the page is hidden (tab switch, going to
    // home screen, refresh) — the periodic timer alone loses recent saves.
    const flush = () => {
      try { gm.saveSaveFiles(); } catch (e) { /* emulator already gone */ }
    };
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });

    // EmulatorJS's exit button fires "exit" and aborts its WASM module,
    // leaving a dead screen. Flush saves and reload to return to the ROM
    // list cleanly (offline-safe — files come from the service worker).
    em.on('exit', () => {
      flush();
      location.reload();
    });

    // iOS reports stale viewport dimensions during rotation and doesn't
    // resize the emulator canvas, leaving the game in half the screen. Once
    // the orientation settles, recompute layout and re-fire resize so the
    // core re-reads the new dimensions. (Desktop handles real resize fine.)
    addEventListener('orientationchange', () => {
      setTimeout(() => {
        try { em.handleResize(); } catch (e) { /* gone */ }
        dispatchEvent(new Event('resize'));
      }, 300);
    });
  };

  return restoreSettings().catch((e) => console.warn('settings restore failed:', e));
}

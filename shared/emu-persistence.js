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
function setupEmuPersistence({ dbName, gameName, system, variant }) {
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
    // Tag each state with the core build that produced it. RetroArch states are
    // binary-incompatible across core variants (e.g. threaded vs single-thread
    // melonDS, or mGBA vs VBA-M); loading a foreign state hard-freezes the WASM
    // module. The variant lets the restore step skip mismatched states.
    return putRows('states', [{ key: gameName + '|' + slot, slot: String(slot), game: gameName, variant, data }]);
  }

  async function statesForGame() {
    return (await getAllRows('states')).filter((s) => s.game === gameName);
  }

  // Battery (.sav) saves get their OWN durable copy in IndexedDB, written on
  // every save event — the same explicit-blob path quick states use. This does
  // NOT rely on emscripten's IDBFS autoPersist (a debounced syncfs that iOS
  // routinely drops on a home-screen swipe / force-quit), which is why in-game
  // saves were being lost on melonDS. The 'saves' store may not exist on older
  // page DB versions, so both helpers degrade gracefully.
  async function getSave() {
    const db = await openDB();
    if (!db.objectStoreNames.contains('saves')) return null;
    return new Promise((resolve) => {
      const req = db.transaction('saves', 'readonly').objectStore('saves').get(gameName);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function putSave(data) {
    const db = await openDB();
    if (!db.objectStoreNames.contains('saves')) return;
    return new Promise((resolve) => {
      const t = db.transaction('saves', 'readwrite');
      t.objectStore('saves').put({ key: gameName, game: gameName, data });
      t.oncomplete = resolve;
      t.onerror = resolve;
    });
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

    // Restore quick states from previous sessions into the emulator FS — but
    // ONLY states made by the core build now running. Writing a foreign state's
    // file would let quickLoad feed it to the core and freeze the WASM module.
    // Legacy rows (saved before variant tagging) carry no variant and are
    // restored as before. A skipped state's file simply doesn't exist, so a
    // later quickLoad on that slot is a harmless no-op.
    try {
      for (const s of await statesForGame()) {
        if (variant && s.variant != null && s.variant !== variant) continue;
        gm.FS.writeFile('/' + s.slot + '-quick.state', new Uint8Array(s.data));
      }
    } catch (e) {
      console.warn('quick state restore failed:', e);
    }

    // Restore the battery save from our durable copy if the FS came up without
    // one (IDBFS autoPersist dropped it). Cartridge saves are read when the
    // player picks "Continue", which is after this runs, so the restored bytes
    // are picked up this session. Seeding the FS path also re-persists it via
    // syncfs so the next boot has it even if IDBFS stays flaky.
    try {
      const saved = await getSave();
      if (saved && saved.data) {
        const path = gm.getSaveFilePath();
        let cur = null;
        try { cur = gm.FS.readFile(path); } catch (e) { /* no save file yet */ }
        if (!cur || cur.length === 0) {
          gm.FS.writeFile(path, new Uint8Array(saved.data));
          if (gm.FS.syncfs) gm.FS.syncfs(false, (e) => { if (e) console.warn('save syncfs failed:', e); });
        }
      }
    } catch (e) {
      console.warn('battery save restore failed:', e);
    }

    // Mirror every battery save into our durable copy. EmulatorJS fires this
    // event from saveSaveFiles() with the .sav bytes (getSaveFile) — the 30s
    // timer, quick-save flush, page-hide flush and exit handler all route
    // through it, so the copy is current the moment a save is written.
    em.on('saveSaveFiles', (file) => {
      if (file && file.length) putSave(file.slice()).catch((e) => console.warn('save mirror failed:', e));
    });

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

    // Cheap insurance: never let a quick load throw out of the input handler.
    // (Variant-skipping above is the real guard against foreign states; this
    // just keeps an unexpected error from killing the controls.)
    const origQuickLoad = gm.quickLoad.bind(gm);
    gm.quickLoad = (slot) => {
      try { return origQuickLoad(slot); } catch (e) { console.warn('quick load failed:', e); }
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

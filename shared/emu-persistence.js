// Makes emulator progress survive page refresh / app close:
//  - quick-save states (RT / "1") are copied into IndexedDB and restored
//    into the emulator filesystem on the next game start, so quick load
//    works across sessions;
//  - battery saves (in-game saving) are flushed to persistent storage on
//    every quick save and whenever the page is hidden or closed, instead
//    of only on EmulatorJS's periodic timer.
//
// Usage (inside play(), before injecting loader.js):
//   setupEmuPersistence({ dbName: DB_NAME, gameName: window.EJS_gameName });
// The page's database must already define a 'states' object store
// (keyPath 'key').
function setupEmuPersistence({ dbName, gameName }) {
  const STORE = 'states';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName); // existing version; page created stores
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putState(slot, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put({ key: gameName + '|' + slot, slot: String(slot), game: gameName, data });
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }

  async function statesForGame() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result.filter((s) => s.game === gameName));
      req.onerror = () => reject(req.error);
    });
  }

  window.EJS_onGameStart = async () => {
    const gm = window.EJS_emulator.gameManager;

    // Restore quick states from previous sessions into the emulator FS.
    try {
      for (const s of await statesForGame()) {
        gm.FS.writeFile('/' + s.slot + '-quick.state', new Uint8Array(s.data));
      }
    } catch (e) {
      console.warn('quick state restore failed:', e);
    }

    // Quick save also persists the state and flushes the battery save.
    const origQuickSave = gm.quickSave.bind(gm);
    gm.quickSave = (slot) => {
      const ok = origQuickSave(slot);
      if (ok) {
        try {
          const data = gm.FS.readFile('/' + (slot || 1) + '-quick.state');
          putState(slot || 1, data).catch((e) => console.warn('state persist failed:', e));
          gm.saveSaveFiles();
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
    window.EJS_emulator.on('exit', () => {
      flush();
      location.reload();
    });

    // iOS reports stale viewport dimensions during rotation and doesn't
    // resize the emulator canvas, leaving the game in half the screen. Once
    // the orientation settles, recompute layout and re-fire resize so the
    // core re-reads the new dimensions. (Desktop handles real resize fine.)
    addEventListener('orientationchange', () => {
      setTimeout(() => {
        try { window.EJS_emulator.handleResize(); } catch (e) { /* gone */ }
        dispatchEvent(new Event('resize'));
      }, 300);
    });
  };
}

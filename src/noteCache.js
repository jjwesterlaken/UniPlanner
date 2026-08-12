/* ==================================================================
   noteCache.js — AI note content, readable offline

   Moving note content to its own row costs offline reading: a note you
   haven't opened needs a connection. Students read lecture notes on
   trains, in concrete buildings and underground, so that regression is
   not acceptable on its own.

   This caches opened notes in IndexedDB — outside the synced blob, so
   it costs nothing against the 1MB budget, and against a quota measured
   in hundreds of megabytes rather than five.

   THE DESIGN RULE THAT KEEPS THIS SMALL: a cache is allowed to fail.

   Every method resolves; none reject. If IndexedDB is missing (Electron
   on file://), blocked (Safari private browsing), or the quota is full,
   the note simply isn't available offline — which is exactly the state
   we would be in with no cache at all. That is why there is no error
   surface here and no retry logic: the failure mode is the baseline.
   ================================================================== */

const DB_NAME = "uni-planner-notes";
const STORE = "notes";

/* Bumping this drops and recreates the store. Cached data is disposable
   by definition, so a migration path for the cache itself is exactly the
   complexity not to build. */
const DB_VERSION = 1;

/* ---------- the ceiling ----------

   Derived, not picked. Two heavy semesters is 120 notes, and at
   MAX_AI_NOTE_BYTES (20KB) that is 2.3MB — so 10MB is roughly four times
   the worst case anyone can produce in a year, and 300 notes is about
   two and a half times the same. Both sit far below any plausible
   IndexedDB quota, which is the point: the app bounds itself rather than
   waiting to be bounded and then failing at whatever moment the browser
   chooses.

   LRU alone is a slower leak, not a bound. */
export const MAX_CACHE_BYTES = 10 * 1024 * 1024;
export const MAX_CACHE_NOTES = 300;

const sizeOf = (content) => {
  try {
    return JSON.stringify(content).length;
  } catch (e) {
    return 0;
  }
};

/**
 * Open the database, or resolve null when there isn't one to open.
 *
 * `factory` is injected so the tests can supply a fake and so the
 * absent-IndexedDB path is exercised rather than assumed.
 */
function openDb(factory) {
  return new Promise((resolve) => {
    if (!factory) return resolve(null);
    let req;
    try {
      req = factory.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

const run = (db, mode, fn) =>
  new Promise((resolve) => {
    if (!db) return resolve(null);
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (e) {
      return resolve(null);
    }
    const store = tx.objectStore(STORE);
    let out = null;
    try {
      out = fn(store);
    } catch (e) {
      return resolve(null);
    }
    tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });

const request = (store, method, ...args) =>
  new Promise((resolve) => {
    try {
      const r = store[method](...args);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });

export function createNoteCache({ factory = typeof indexedDB !== "undefined" ? indexedDB : null } = {}) {
  let dbPromise = null;
  const db = () => {
    if (!dbPromise) dbPromise = openDb(factory);
    return dbPromise;
  };

  const api = {
    /** The content, or null when it isn't cached or the cache is unavailable. */
    async get(id) {
      const d = await db();
      if (!d || !id) return null;
      const row = await run(d, "readonly", (s) => request(s, "get", id));
      const value = await row;
      if (!value) return null;
      // Touch for LRU. Failing to record the read is not worth failing a read.
      await run(d, "readwrite", (s) => request(s, "put", { ...value, readAt: Date.now() }));
      return value.content;
    },

    async put(id, content) {
      const d = await db();
      if (!d || !id) return false;
      const ok = await run(d, "readwrite", (s) =>
        request(s, "put", { id, content, bytes: sizeOf(content), readAt: Date.now() })
      );
      await api.evict();
      return ok !== null;
    },

    async remove(id) {
      const d = await db();
      if (!d || !id) return false;
      const ok = await run(d, "readwrite", (s) => request(s, "delete", id));
      return ok !== null;
    },

    /** Which notes are readable offline, for the list's indicator. */
    async keys() {
      const d = await db();
      if (!d) return new Set();
      const keys = await run(d, "readonly", (s) => request(s, "getAllKeys"));
      const list = await keys;
      return new Set(Array.isArray(list) ? list : []);
    },

    /** Everything. Called on sign-out and on account deletion. */
    async purgeAll() {
      const d = await db();
      if (!d) return false;
      const ok = await run(d, "readwrite", (s) => request(s, "clear"));
      return ok !== null;
    },

    /** Bring the cache back under both ceilings, oldest read first. */
    async evict() {
      const d = await db();
      if (!d) return { removed: 0 };
      const all = await run(d, "readonly", (s) => request(s, "getAll"));
      const rows = (await all) || [];
      if (!Array.isArray(rows) || rows.length === 0) return { removed: 0 };

      let bytes = rows.reduce((a, r) => a + (r.bytes || 0), 0);
      let count = rows.length;
      if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_NOTES) return { removed: 0 };

      const oldestFirst = [...rows].sort((a, b) => (a.readAt || 0) - (b.readAt || 0));
      let removed = 0;
      for (const row of oldestFirst) {
        if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_NOTES) break;
        await run(d, "readwrite", (s) => request(s, "delete", row.id));
        bytes -= row.bytes || 0;
        count--;
        removed++;
      }
      return { removed };
    },
  };

  return api;
}

/* The app's one cache. A module-level instance rather than a hook or a
   context because it is genuinely global state outside React — the
   viewer, the save path and sign-out all reach for the same store, and
   passing it through four layers of props would buy nothing. Tests build
   their own with an injected factory instead. */
export const noteCache = createNoteCache();

/* AI note content in its own row, plus the offline cache.

   Two assertions in here matter more than the rest, because both guard
   against destroying a user's notes:

     - reconciliation acts on TOMBSTONES, never on absence. The
       restore-from-backup case is the one that proves it, and an
       absence-based implementation passes every other test in this file.

     - a stub is tombstoned only on a DEFINITIVE not-found. Anything that
       merely looks like "no data" — a 500, a dropped connection, an
       expired token — must leave it alone, and this path runs precisely
       when the network is already misbehaving.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStub,
  KEPT_META_KEYS,
  buildContent,
  buildPreviews,
  previewFor,
  isRemote,
  isAiNote,
  pagesNeedingMigration,
  migrateNote,
  fetchNote,
  deleteNote,
  reconcilePlan,
  reconcile,
  PREVIEW_CHARS,
} from "../src/aiNotesStore.js";
import { createNoteCache, MAX_CACHE_BYTES, MAX_CACHE_NOTES } from "../src/noteCache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const S = (n) => "x".repeat(n);
const summary = (overview = "An overview of the lecture.") => ({
  overview,
  keyPoints: ["A point."],
  assessable: ["Assessable."],
  openQuestions: ["Unclear."],
});

const aiPage = (over = {}) => ({
  id: over.id || "p1",
  title: "PSYC2001 — Week 7 notes",
  body: "",
  html: "",
  strokes: [],
  style: "lined",
  kind: "text",
  font: "sans",
  folderId: null,
  updatedAt: "2026-08-12T00:00:00.000Z",
  aiMeta: {
    course: "PSYC2001",
    week: "7",
    generatedAt: "2026-08-12T00:00:00.000Z",
    activeLanguage: "en",
    translations: { en: summary() },
    ...(over.aiMeta || {}),
  },
  ...over,
});

/* A Supabase stand-in that records what was asked of it. */
function fakeClient({ insertError, upsertError, selectError, selectRows, deleteError, single } = {}) {
  const calls = [];
  const table = (name) => ({
    /* A PLAIN insert is what migrateNote makes now: an upsert would
       need the UPDATE privilege PostgREST demands for either flavour,
       on a table this app never updates. `insertError` carries a `code`
       so the 23505 branch can be exercised for real. */
    insert(row) {
      calls.push(`insert:${name}:${row.id}`);
      return Promise.resolve({ error: insertError || null });
    },
    upsert(row, opts) {
      calls.push(`upsert:${name}:${row.id}:${(opts || {}).onConflict || ""}`);
      return Promise.resolve({ error: upsertError || null });
    },
    select() {
      calls.push(`select:${name}`);
      const q = {
        eq(col, val) {
          calls.push(`eq:${col}=${val}`);
          return q;
        },
        maybeSingle() {
          return Promise.resolve(single || { data: null, error: selectError || null });
        },
        then(res) {
          return Promise.resolve({ data: selectRows || [], error: selectError || null }).then(res);
        },
      };
      return q;
    },
    delete() {
      calls.push(`delete:${name}`);
      return {
        eq(col, val) {
          calls.push(`delete-eq:${col}=${val}`);
          return Promise.resolve({ error: deleteError || null });
        },
      };
    },
  });
  return { calls, from: (n) => table(n) };
}

const fakeCache = () => {
  const removed = [];
  return { removed, remove: async (id) => removed.push(id) };
};

async function run() {
  /* ---------- the stub ---------- */

  await test("the stub keeps the list working and drops the body", () => {
    const stub = buildStub(aiPage());
    assert.equal(stub.body, "");
    assert.equal(stub.aiMeta.remote, true);
    assert.equal(stub.aiMeta.translations, undefined, "the content is still in the blob");
    assert.ok(stub.aiMeta.previews.en.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(stub)) < 900, "the stub is not small enough to be worth it");
  });

  await test("activeLanguage lives in the stub, not the row", () => {
    // A reading preference that changes often and must work offline
    // belongs in the blob -- and keeping it out is what leaves the row
    // immutable, so there is no client update path and no update policy.
    const page = aiPage();
    assert.equal(buildStub(page).aiMeta.activeLanguage, "en");
    assert.equal(buildContent(page).activeLanguage, undefined, "activeLanguage leaked into the row");
    assert.ok(buildContent(page).translations.en);
  });

  await test("there is a preview per language, so the list matches what's being read", () => {
    const page = aiPage({ aiMeta: { translations: { en: summary("English overview"), vi: summary("Tổng quan") } } });
    const stub = buildStub(page);
    assert.equal(Object.keys(stub.aiMeta.previews).sort().join(","), "en,vi");
    assert.match(previewFor({ aiMeta: { ...stub.aiMeta, activeLanguage: "vi" } }), /Tổng quan/);
    assert.match(previewFor({ aiMeta: { ...stub.aiMeta, activeLanguage: "en" } }), /English overview/);
  });

  /* ---------- the whitelist, and the two fields it had already lost ----------

     buildStub rebuilds aiMeta from a fixed list, so a key that a later
     feature put on the object is dropped the moment the note migrates
     — silently, with nothing erroring, on the one path every signed-in
     student takes. Two live features were already broken by it when
     this was written, and the tests below are named for them because
     "the whitelist works" is not a claim anybody can act on. */

  await test("sourceReadingId SURVIVES MIGRATION — the Textbook tab's Summarised link reads it off the stub", () => {
    const page = aiPage({ aiMeta: { translations: { en: summary() }, sourceReadingId: "reading-42" } });
    assert.equal(page.aiMeta.sourceReadingId, "reading-42", "the fixture itself must carry it, or this proves nothing");
    assert.equal(
      buildStub(page).aiMeta.sourceReadingId,
      "reading-42",
      "the link from a reading to its summary is lost on the first sync after summarising"
    );
  });

  /* THE RENDER HALF IS IN test-app-smoke.mjs, deliberately not here.
     An earlier draft reproduced Textbook's summaries map in this file
     and asserted over it — which is a restatement of the reader, and a
     restatement of the reader is what let this bug live behind a green
     suite in the first place. The real claim ("THE SUMMARISED LINK
     RENDERS FOR A MIGRATED NOTE") mounts the real Textbook over a page
     built by the real buildStub, and it goes red when the key stops
     being carried. What belongs here is the data claim above. */

  await test("partsMerged SURVIVES, and FALSE is the value that matters", () => {
    /* A merged-locally reading records partsMerged:false so it still
       says next month that it is sections put end to end. A carry
       written as `if (meta[key])` keeps every other field and drops
       exactly this one. */
    const page = aiPage({ aiMeta: { translations: { en: summary() }, partsMerged: false, parts: 4 } });
    const stub = buildStub(page);
    assert.equal(stub.aiMeta.partsMerged, false);
    assert.equal(stub.aiMeta.parts, 4);
  });

  await test("THE WHITELIST IS SWEPT AGAINST THE SOURCE — a key the app writes onto aiMeta is kept or excused BY NAME", () => {
    /* The guard the two fields above needed. Without it the fix is
       two entries in a list and the third feature drops out the same
       way; the ledger's own rule is that a rule written beside one
       caller is not a guard. */
    const EXCUSED = {
      translations: "it IS the content the row exists to hold — previews replace it",
      remote: "written BY buildStub, never carried into it",
      previews: "built BY buildStub from the translations",
    };

    /* A BRACE SCANNER, NOT A REGEX. The first version matched
       `aiMeta:` alone and therefore read NOTHING out of
       PlannerApp.jsx — the one file where both dropped keys are
       written, because that file ASSIGNS (`pageItem.aiMeta = {...}`).
       Its "the sweep found something" check passed on keys from the
       other files while it was blind to its own subject. */
    const literalsIn = (src) => {
      const out = [];
      const re = /aiMeta\s*[:=]\s*\{/g;
      let m;
      while ((m = re.exec(src))) {
        let depth = 0;
        let k = m.index + m[0].length - 1;
        const start = k + 1;
        for (; k < src.length; k++) {
          if (src[k] === "{") depth++;
          else if (src[k] === "}" && --depth === 0) break;
        }
        if (depth === 0) out.push(src.slice(start, k));
      }
      return out;
    };
    /* `name:` and bare shorthand `name` alike — shorthand is how
       sourceReadingId is written, so a pattern taking only `name:`
       would miss the very key this exists for. A `...spread` is
       preceded by a dot and a `meta.course` value is followed by one,
       so neither is picked up. */
    const keysIn = (lit) =>
      [...lit.matchAll(/(?:^|[,{]|\n)\s*([A-Za-z_$][\w$]*)\s*(?=[:,}\n]|$)/g)].map((m) => m[1]);

    const files = ["src/PlannerApp.jsx", "src/aiNotes.jsx", "src/aiNotesLogic.js", "src/aiNotesStore.js", "src/aiNoteConvert.js"];
    const written = new Set();
    const perFile = new Map();
    for (const f of files) {
      /* Comments name what they forbid — the ledger's own rule, five
         instances deep — so strip them before matching. */
      const src = fs
        .readFileSync(path.join(rootDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const keys = [];
      for (const lit of literalsIn(src)) keys.push(...keysIn(lit));
      for (const m of src.matchAll(/aiMeta\.([A-Za-z_$][\w$]*)\s*=/g)) keys.push(m[1]);
      perFile.set(f, keys);
      for (const k of keys) written.add(k);
    }

    /* NON-VACUITY, PER FILE. "the sweep found something" is satisfied
       by one file out of four, which is the state the first version of
       this guard shipped in. */
    const witness = {
      "src/PlannerApp.jsx": "sourceReadingId",
      "src/aiNotes.jsx": "activeLanguage",
      "src/aiNotesLogic.js": "translations",
      "src/aiNotesStore.js": "course",
      "src/aiNoteConvert.js": "convertedAt",
    };
    for (const [f, key] of Object.entries(witness)) {
      assert.ok(
        (perFile.get(f) || []).includes(key),
        `the sweep read nothing useful out of ${f} — it never found "${key}", so the pattern is blind to that file`
      );
    }

    const kept = new Set(KEPT_META_KEYS);
    const orphans = [...written].filter((k) => !kept.has(k) && !EXCUSED[k]);
    assert.deepEqual(
      orphans,
      [],
      `these aiMeta keys are written by the app and silently dropped by buildStub: ${orphans.join(", ")}. ` +
        "Add each to KEPT_META_KEYS, or excuse it in this test with the reason it need not survive."
    );
  });

  await test("a preview falls back rather than rendering blank", () => {
    const stub = buildStub(aiPage());
    assert.ok(previewFor({ aiMeta: { ...stub.aiMeta, activeLanguage: "zz" } }).length > 0);
    assert.equal(previewFor({}), "");
    assert.equal(previewFor(null), "");
  });

  await test("a long overview is cut for the preview, with an ellipsis", () => {
    const p = buildPreviews({ en: summary(S(2000)) });
    assert.ok(p.en.length <= PREVIEW_CHARS + 1);
    assert.ok(p.en.endsWith("…"));
  });

  /* ---------- migration ---------- */

  await test("only un-migrated AI notes are picked up", () => {
    const pages = [
      aiPage({ id: "a" }),
      { id: "b", title: "typed note" },
      { ...buildStub(aiPage({ id: "c" })) },
      { ...aiPage({ id: "d" }), deletedAt: "2026-01-01" },
    ];
    assert.deepEqual(pagesNeedingMigration(pages).map((p) => p.id), ["a"]);
    assert.equal(isAiNote(pages[1]), false);
    assert.equal(isRemote(pages[2]), true);
  });

  await test("migration writes the row BEFORE shrinking the blob", async () => {
    // The reverse would lose a note whenever the insert failed.
    const c = fakeClient();
    const out = await migrateNote({ supabaseClient: c, userId: "u1", page: aiPage() });
    assert.equal(out.ok, true);
    assert.ok(c.calls.some((x) => x.startsWith("insert:ai_notes:p1")));
    assert.equal(out.stub.aiMeta.remote, true);
  });

  await test("a failed insert leaves the blob untouched", async () => {
    const c = fakeClient({ insertError: { message: "offline" } });
    const out = await migrateNote({ supabaseClient: c, userId: "u1", page: aiPage() });
    assert.equal(out.ok, false);
    assert.equal(out.stub, null, "a stub was produced despite the row never being written");
  });

  await test("a row that is already there reads as already-migrated, so an interrupted run completes", async () => {
    /* The retry case an upsert used to cover. 23505 is DEFINITIVE — the
       id is on the server, holding content this same function wrote —
       so the caller may shrink the blob. This is the migration's half
       of the missing-vs-failed rule. */
    const c = fakeClient({ insertError: { code: "23505", message: "duplicate key value violates unique constraint" } });
    const out = await migrateNote({ supabaseClient: c, userId: "u1", page: aiPage() });
    assert.equal(out.ok, true, "a retried migration reported failure, so the note never leaves the blob");
    assert.equal(out.existed, true);
    assert.equal(out.stub.aiMeta.remote, true);
  });

  await test("any OTHER error stays a failure, so silence never shrinks the blob", async () => {
    for (const error of [
      { code: "42501", message: "permission denied for table ai_notes" },
      { code: "PGRST204", message: "column not found" },
      { message: "Failed to fetch" },
      { code: "23503", message: "foreign key violation" },
    ]) {
      const out = await migrateNote({ supabaseClient: fakeClient({ insertError: error }), userId: "u1", page: aiPage() });
      assert.equal(out.ok, false, `${error.code || "no code"} was treated as already-migrated`);
      assert.equal(out.stub, null);
    }
  });

  await test("migrateNote never upserts — the privilege that breaks is one it must not need", async () => {
    // The production break: 0008 revoked update on ai_notes and every
    // write 400'd, because PostgREST requires INSERT and UPDATE for any
    // upsert. Asking for one verb is what makes the three-verb table work.
    const c = fakeClient();
    await migrateNote({ supabaseClient: c, userId: "u1", page: aiPage() });
    assert.ok(!c.calls.some((x) => x.startsWith("upsert:")), "migrateNote is upserting again");
  });

  /* ---------- reading, and the three distinct outcomes ---------- */

  await test("a found note returns its content", async () => {
    const c = fakeClient({ single: { data: { content: { translations: { en: summary() } } }, error: null } });
    const out = await fetchNote({ supabaseClient: c, id: "p1" });
    assert.ok(out.content.translations.en);
    assert.equal(out.missing, undefined);
    assert.equal(out.failed, undefined);
  });

  await test("a definitively absent row reads as missing", async () => {
    const c = fakeClient({ single: { data: null, error: null } });
    const out = await fetchNote({ supabaseClient: c, id: "p1" });
    assert.equal(out.missing, true);
    assert.equal(out.failed, undefined);
  });

  await test("an error reads as failed, NOT as missing", async () => {
    /* The distinction that stops a transient failure becoming a
       deletion. A 500, a dropped connection, an expired token and a rate
       limit all look like "no data" to a caller that only checks for a
       row -- and this path runs when the network is already misbehaving,
       because it is the self-healing route for an interrupted delete. */
    for (const error of [{ message: "500" }, { message: "JWT expired" }, { code: "429" }]) {
      const out = await fetchNote({ supabaseClient: fakeClient({ single: { data: null, error } }), id: "p1" });
      assert.equal(out.failed, true, `${JSON.stringify(error)} was not treated as a failure`);
      assert.notEqual(out.missing, true, `${JSON.stringify(error)} was treated as a missing row`);
    }
  });

  await test("a client that throws reads as failed rather than propagating", async () => {
    const thrower = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => { throw new Error("boom"); } }) }) }) };
    assert.equal((await fetchNote({ supabaseClient: thrower, id: "p1" })).failed, true);
    assert.equal((await fetchNote({ supabaseClient: null, id: "p1" })).failed, true);
  });

  /* ---------- deleting ---------- */

  await test("deleting removes the row before the caller tombstones", async () => {
    const c = fakeClient();
    const cache = fakeCache();
    const out = await deleteNote({ supabaseClient: c, id: "p1", cache });
    assert.equal(out.ok, true);
    assert.equal(out.tombstone, true);
    assert.ok(c.calls.includes("delete:ai_notes"));
    assert.ok(c.calls.includes("delete-eq:id=p1"));
    assert.deepEqual(cache.removed, ["p1"]);
  });

  await test("a failed remote delete does NOT authorise a tombstone", async () => {
    /* The privacy failure this whole ordering exists to prevent: the
       stub gone, the full transcript and summary still on the server for
       a lecture the student believes they deleted. */
    const c = fakeClient({ deleteError: { message: "500" } });
    const out = await deleteNote({ supabaseClient: c, id: "p1", cache: fakeCache() });
    assert.equal(out.ok, false);
    assert.equal(out.tombstone, false);
  });

  await test("an offline delete tombstones locally and defers the row", async () => {
    const cache = fakeCache();
    const out = await deleteNote({ supabaseClient: null, id: "p1", cache });
    assert.equal(out.tombstone, true);
    assert.equal(out.deferred, true);
    assert.deepEqual(cache.removed, ["p1"], "the cached copy outlived the delete");
  });

  /* ---------- reconciliation: tombstones only ---------- */

  await test("a tombstoned note's row is deleted", () => {
    const plan = reconcilePlan({
      remoteIds: ["a", "b"],
      pages: [aiPage({ id: "a" }), { ...aiPage({ id: "b" }), deletedAt: "2026-08-12" }],
    });
    assert.deepEqual(plan.toDelete, ["b"]);
  });

  await test("RESTORING AN OLD BACKUP DOES NOT DELETE NOTES MADE SINCE", () => {
    /* The case that killed the absence-based rule.

       A student restores a two-month-old backup in replace mode. The
       sync succeeds, so every other guard passes. Every note created
       after that backup now has a row and no stub at all -- not a
       tombstone, no trace. Absence-based reconciliation deletes all of
       them, permanently, and "a live note isn't deleted" passes
       throughout, because from the restored blob's point of view those
       notes were never live.

       Positive evidence of deletion, never inferred from a gap. */
    const restored = [aiPage({ id: "old1" }), aiPage({ id: "old2" })];
    const plan = reconcilePlan({ remoteIds: ["old1", "old2", "new1", "new2", "new3"], pages: restored });
    assert.deepEqual(plan.toDelete, [], "notes created after the backup were deleted by a restore");
    assert.equal(plan.orphanCount, 3, "the unreferenced rows should be counted, not deleted");
  });

  await test("a note absent from the blob entirely is counted, never deleted", () => {
    const plan = reconcilePlan({ remoteIds: ["ghost"], pages: [] });
    assert.deepEqual(plan.toDelete, []);
    assert.equal(plan.orphanCount, 1);
  });

  await test("a note both tombstoned and live is kept", () => {
    // Two devices disagreeing mid-merge. Keeping it is the safe read.
    const plan = reconcilePlan({
      remoteIds: ["a"],
      pages: [aiPage({ id: "a" }), { ...aiPage({ id: "a" }), deletedAt: "2026-08-12" }],
    });
    assert.deepEqual(plan.toDelete, []);
  });

  await test("reconciliation does not run after a failed sync", async () => {
    const c = fakeClient({ selectRows: [{ id: "a" }] });
    const out = await reconcile({ supabaseClient: c, userId: "u1", pages: [], syncSucceeded: false });
    assert.equal(out.skipped, true);
    assert.equal(out.deleted, 0);
    assert.equal(c.calls.length, 0, "it queried despite the sync having failed");
  });

  await test("reconciliation is skipped with no client, which covers demo mode", async () => {
    const out = await reconcile({ supabaseClient: null, userId: "u1", pages: [], syncSucceeded: true });
    assert.equal(out.skipped, true);
  });

  await test("reconciliation deletes the tombstoned row and clears its cache entry", async () => {
    const c = fakeClient({ selectRows: [{ id: "a" }, { id: "b" }] });
    const cache = fakeCache();
    const out = await reconcile({
      supabaseClient: c,
      userId: "u1",
      pages: [aiPage({ id: "a" }), { ...aiPage({ id: "b" }), deletedAt: "2026-08-12" }],
      syncSucceeded: true,
      cache,
    });
    assert.equal(out.deleted, 1);
    assert.deepEqual(cache.removed, ["b"]);
  });

  /* ---------- the cache ---------- */

  /* A minimal in-memory IndexedDB. Enough to exercise the real code
     paths without pretending to be a browser. */
  function fakeIndexedDb({ failOpen = false } = {}) {
    const rows = new Map();
    const req = (result) => {
      const r = { result };
      queueMicrotask(() => r.onsuccess && r.onsuccess());
      return r;
    };
    const store = {
      get: (id) => req(rows.get(id)),
      put: (v) => { rows.set(v.id, v); return req(true); },
      delete: (id) => { rows.delete(id); return req(true); },
      clear: () => { rows.clear(); return req(true); },
      getAllKeys: () => req([...rows.keys()]),
      getAll: () => req([...rows.values()]),
    };
    return {
      rows,
      open() {
        const r = {};
        queueMicrotask(() => {
          if (failOpen) return r.onerror && r.onerror();
          r.result = {
            objectStoreNames: { contains: () => false },
            createObjectStore: () => store,
            transaction: () => {
              const tx = { objectStore: () => store };
              queueMicrotask(() => tx.oncomplete && tx.oncomplete());
              return tx;
            },
          };
          if (r.onupgradeneeded) r.onupgradeneeded();
          r.onsuccess && r.onsuccess();
        });
        return r;
      },
    };
  }

  await test("a note put in the cache comes back out", async () => {
    const cache = createNoteCache({ factory: fakeIndexedDb() });
    await cache.put("p1", { translations: { en: summary() } });
    const got = await cache.get("p1");
    assert.ok(got.translations.en);
    assert.deepEqual([...(await cache.keys())], ["p1"]);
  });

  await test("every method resolves when there is no IndexedDB at all", async () => {
    // Electron loads over file://, where there is none. The note is
    // simply not available offline, which is the baseline anyway.
    const cache = createNoteCache({ factory: null });
    assert.equal(await cache.get("p1"), null);
    assert.equal(await cache.put("p1", {}), false);
    assert.equal(await cache.remove("p1"), false);
    assert.equal(await cache.purgeAll(), false);
    assert.deepEqual([...(await cache.keys())], []);
  });

  await test("every method resolves when opening the database fails", async () => {
    const cache = createNoteCache({ factory: fakeIndexedDb({ failOpen: true }) });
    assert.equal(await cache.get("p1"), null);
    assert.equal(await cache.put("p1", {}), false);
    assert.deepEqual([...(await cache.keys())], []);
  });

  await test("purgeAll empties the cache", async () => {
    const db = fakeIndexedDb();
    const cache = createNoteCache({ factory: db });
    await cache.put("a", { x: 1 });
    await cache.put("b", { x: 2 });
    await cache.purgeAll();
    assert.deepEqual([...(await cache.keys())], []);
  });

  await test("the cache is bounded by note count, not just by LRU", async () => {
    // LRU with no ceiling is a slower leak, not a bound.
    const db = fakeIndexedDb();
    const cache = createNoteCache({ factory: db });
    for (let i = 0; i < MAX_CACHE_NOTES + 15; i++) await cache.put(`n${i}`, { i });
    assert.ok(db.rows.size <= MAX_CACHE_NOTES, `cache holds ${db.rows.size} notes, over the ${MAX_CACHE_NOTES} ceiling`);
  });

  await test("the cache is bounded by bytes as well as count", async () => {
    const db = fakeIndexedDb();
    const cache = createNoteCache({ factory: db });
    const big = { blob: S(600 * 1024) };
    for (let i = 0; i < 30; i++) await cache.put(`b${i}`, big);
    const total = [...db.rows.values()].reduce((a, r) => a + (r.bytes || 0), 0);
    assert.ok(total <= MAX_CACHE_BYTES, `cache holds ${(total / 1024 / 1024).toFixed(1)}MB, over the ceiling`);
  });

  await test("eviction takes the least recently read first", async () => {
    const db = fakeIndexedDb();
    const cache = createNoteCache({ factory: db });
    for (let i = 0; i < MAX_CACHE_NOTES; i++) await cache.put(`n${i}`, { i });
    await cache.get("n0"); // touch the oldest so it is no longer the oldest
    await cache.put("newcomer", { i: -1 });
    assert.ok(db.rows.has("n0"), "a recently read note was evicted before older ones");
  });

  /* ---------- the wiring these depend on ---------- */

  await test("the row has no update policy, because it is never updated", () => {
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0005_ai_notes.sql"), "utf8");
    assert.match(sql, /ai_notes_select_own/);
    assert.match(sql, /ai_notes_insert_own/);
    assert.match(sql, /ai_notes_delete_own/);
    assert.doesNotMatch(sql, /for update/, "an update policy widens the surface for a row that is never updated");
    assert.match(sql, /enable row level security/);
  });

  await test("account deletion removes the notes too", () => {
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0005_ai_notes.sql"), "utf8");
    assert.match(sql, /delete from public\.ai_notes where user_id = uid/);
    assert.match(sql, /on delete cascade/);
  });

  await test("npm test still runs the storage-move tests", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-ai-store\.mjs/, "the storage-move tests were dropped from `npm test`");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();

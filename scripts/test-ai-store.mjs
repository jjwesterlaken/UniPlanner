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
function fakeClient({ upsertError, selectError, selectRows, deleteError, single } = {}) {
  const calls = [];
  const table = (name) => ({
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
    assert.ok(c.calls.some((x) => x.startsWith("upsert:ai_notes:p1")));
    assert.equal(out.stub.aiMeta.remote, true);
  });

  await test("a failed insert leaves the blob untouched", async () => {
    const c = fakeClient({ upsertError: { message: "offline" } });
    const out = await migrateNote({ supabaseClient: c, userId: "u1", page: aiPage() });
    assert.equal(out.ok, false);
    assert.equal(out.stub, null, "a stub was produced despite the row never being written");
  });

  await test("migrating twice is a no-op, so an interrupted run is safe to repeat", async () => {
    const c = fakeClient();
    await migrateNote({ supabaseClient: c, userId: "u1", page: aiPage() });
    assert.ok(c.calls.some((x) => x.endsWith(":id")), "the upsert doesn't conflict on id");
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

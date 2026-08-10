/* Ownership tests for the ai-notes Edge Function.

   These run the real handler — bundled by esbuild, with the supabase-js
   import and Deno's globals stubbed — against a fake database that models
   row ownership. They exist because the function talks to the database
   with the SERVICE-ROLE client, which bypasses RLS entirely: the policy
   `ai_notes_requests_select_own` is correct and would have caught this,
   and it never runs. Every ownership check has to be written in the
   query, so every ownership check needs a test.

   The bug this pins down: the idempotency lookup filtered on the key
   alone. `result` holds the finished transcript and summary, so anyone
   presenting a key that already had a completed row was handed another
   user's lecture.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const tmpDir = path.join(rootDir, ".fn-test-tmp");

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

/* ---------- build the function with its imports stubbed ---------- */

fs.mkdirSync(tmpDir, { recursive: true });
const stubPath = path.join(tmpDir, "supabase-stub.js");
fs.writeFileSync(
  stubPath,
  `export function createClient(url, key) {
     if (!url) throw new Error("supabaseUrl is required.");
     if (!key) throw new Error("supabaseKey is required.");
     return globalThis.__FAKE_CLIENT__;
   }
   export class SupabaseClient {}\n`
);

const bundle = await build({
  entryPoints: [path.join(rootDir, "supabase/functions/ai-notes/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  plugins: [
    {
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: stubPath }));
      },
    },
  ],
});
const fnPath = path.join(tmpDir, "fn.mjs");
fs.writeFileSync(fnPath, bundle.outputFiles[0].text);

/* ---------- a fake database that knows who owns what ---------- */

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEY = "3f9a1c2e-7b4d-4e6f-9a1b-2c3d4e5f6a7b";

function makeDb(rows, missingObject = false) {
  // Every filter applied to a request-row query is recorded, so a test can
  // assert that writes are scoped even where the effect isn't observable
  // (the key is a primary key, so a mis-scoped update can't hit another
  // row -- but the scope still has to be there).
  const writes = [];

  const matches = (row, filters) => filters.every(([col, val]) => row[col] === val);

  const table = (name) => {
    const filters = [];
    let pending = null;
    const chain = {
      select: () => chain,
      eq: (col, val) => {
        filters.push([col, val]);
        return chain;
      },
      lt: (col, val) => {
        filters.push(["__lt__" + col, val]);
        return chain;
      },
      maybeSingle: async () => ({ data: rows.find((r) => r._t === name && matches(r, filters)) || null, error: null }),
      single: async () => {
        const found = rows.find((r) => r._t === name && matches(r, filters));
        return found ? { data: found, error: null } : { data: null, error: { code: "PGRST116" } };
      },
      insert: async (row) => {
        if (rows.some((r) => r._t === name && r.idempotency_key === row.idempotency_key)) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows.push({ _t: name, created_at: new Date().toISOString(), ...row });
        return { error: null };
      },
      update: (patch) => {
        pending = patch;
        const done = {
          eq: (col, val) => {
            filters.push([col, val]);
            return done;
          },
          lt: (col, val) => {
            filters.push(["__lt__" + col, val]);
            return done;
          },
          select: async () => {
            const hit = apply();
            return { data: hit, error: null };
          },
          then: (resolve) => {
            apply();
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        const apply = () => {
          if (name === "ai_notes_requests") writes.push({ patch: pending, filters: [...filters] });
          const plain = filters.filter(([c]) => !c.startsWith("__lt__"));
          const hit = rows.filter((r) => r._t === name && matches(r, plain));
          for (const r of hit) Object.assign(r, pending);
          return hit;
        };
        return done;
      },
      upsert: async () => ({ error: null }),
      delete: () => ({ lt: async () => ({ error: null }) }),
      then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return chain;
  };

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: OWNER } }, error: null }) },
    from: (name) => {
      if (name === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tier: "ai" }, error: null }) }) }),
        };
      }
      return table(name);
    },
    storage: {
      from: () => ({
        list: async () => ({ data: missingObject ? [] : [{ name: `${KEY}.webm`, metadata: { size: 1000 } }], error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://groq.test/audio" }, error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  };
  return { client, rows, writes };
}

/* ---------- invoke the handler ---------- */

async function invoke({ rows = [], key = KEY, callerId = OWNER, missingObject = false } = {}) {
  const db = makeDb(rows, missingObject);
  db.client.auth.getUser = async () => ({ data: { user: { id: callerId } }, error: null });

  let handler = null;
  const logs = [];
  globalThis.Deno = {
    serve: (h) => {
      handler = h;
    },
    env: {
      get: (n) =>
        ({
          SUPABASE_URL: "https://p.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "svc",
          GROQ_API_KEY: "gsk_test",
          OPENAI_API_KEY: "sk-test",
        })[n],
    },
  };
  globalThis.__FAKE_CLIENT__ = db.client;
  // Groq succeeds; the summariser is left to fail, which the function
  // already handles by returning the transcript with summaryFailed.
  globalThis.fetch = async (url) => {
    if (String(url).includes("groq")) return { ok: true, json: async () => ({ text: "a lecture", duration: 60 }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  await import(`${fnPath}?v=${Math.random()}`);
  const res = await handler(
    new Request("https://x/ai-notes", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ path: `${callerId}/${key}.webm`, mimeType: "audio/webm", idempotencyKey: key }),
    })
  );
  const bodyText = await res.text();
  console.log = origLog;
  console.error = origErr;

  return { status: res.status, bodyText, body: JSON.parse(bodyText), rows: db.rows, writes: db.writes, logs };
}

const doneRow = (userId) => ({
  _t: "ai_notes_requests",
  idempotency_key: KEY,
  user_id: userId,
  status: "done",
  result: { transcript: "PRIVATE LECTURE CONTENT", summaryFailed: false },
  created_at: "2020-01-01T00:00:00.000Z",
});

const staleRow = (userId, status) => ({
  _t: "ai_notes_requests",
  idempotency_key: KEY,
  user_id: userId,
  status,
  result: null,
  created_at: "2020-01-01T00:00:00.000Z", // far older than PROCESSING_STALE_MINUTES
});

async function run() {
  await test("a completed row belonging to another user is never returned", async () => {
    // The disclosure. Before scoping, this returned `result` verbatim.
    const r = await invoke({ rows: [doneRow(OTHER)] });
    assert.equal(r.status, 400, "must not be a 200 carrying someone else's lecture");
    assert.ok(!r.bodyText.includes("PRIVATE LECTURE CONTENT"), "another user's transcript was disclosed");
    assert.equal(r.body.code, "bad_idempotency_key");
  });

  await test("a completed row belonging to the caller is still returned", async () => {
    // The scoping must not break the idempotency it exists for.
    const r = await invoke({ rows: [doneRow(OWNER)] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.transcript, "PRIVATE LECTURE CONTENT");
  });

  await test("a stale processing row belonging to another user cannot be taken over", async () => {
    const rows = [staleRow(OTHER, "processing")];
    const r = await invoke({ rows });
    assert.equal(r.status, 400);
    assert.equal(rows[0].user_id, OTHER, "the row changed owner");
    assert.equal(rows[0].status, "processing", "another user's in-flight request was reclaimed");
  });

  await test("a failed row belonging to another user cannot be taken over", async () => {
    const rows = [staleRow(OTHER, "failed")];
    const r = await invoke({ rows });
    assert.equal(r.status, 400);
    assert.equal(rows[0].status, "failed", "another user's failed request was reclaimed");
  });

  await test("the caller's own stale row is still reclaimable", async () => {
    const rows = [staleRow(OWNER, "processing")];
    const r = await invoke({ rows });
    assert.notEqual(r.status, 400, "scoping must not block a user reclaiming their own abandoned row");
  });

  await test("'key belongs to someone else' is indistinguishable from 'key is malformed'", async () => {
    // If these differ in any observable way, the endpoint answers
    // "does this key exist?" for any key an attacker cares to try.
    const notOwner = await invoke({ rows: [doneRow(OTHER)] });
    const malformed = await invoke({ key: "msn0duf5-hk684" });
    assert.equal(notOwner.status, malformed.status, "status codes differ");
    assert.equal(notOwner.bodyText, malformed.bodyText, `response bodies differ:\n  ${notOwner.bodyText}\n  ${malformed.bodyText}`);
  });

  await test("the two rejections are still told apart in the logs", async () => {
    // Identical to the client, distinguishable to us -- otherwise the fix
    // trades one blind spot for another.
    const notOwner = await invoke({ rows: [doneRow(OTHER)] });
    const malformed = await invoke({ key: "msn0duf5-hk684" });
    assert.ok(notOwner.logs.some((l) => l.includes("not_owner")), "a rejected non-owner must be identifiable server-side");
    assert.ok(malformed.logs.some((l) => l.includes("not a UUID")), "a malformed key must be identifiable server-side");
  });

  await test("every write to a request row is scoped by user_id, not the key alone", async () => {
    /* Covers the writes whose mis-scoping isn't observable through
       behaviour. Once the SELECT is scoped, a non-owner is rejected before
       reaching the reclaim paths at all, so those scopes are defence in
       depth and can only be checked by driving the owner down each path
       and inspecting the filters the query actually used. */
    const runs = [
      await invoke({ rows: [] }),                                   // success -> final update
      await invoke({ rows: [staleRow(OWNER, "processing")] }),      // reclaim a stale row
      await invoke({ rows: [staleRow(OWNER, "failed")] }),          // reclaim a failed row
      await invoke({ rows: [], missingObject: true }),              // recording_missing -> markFailed
    ];
    const writes = runs.flatMap((r) => r.writes);
    assert.ok(writes.length >= 4, `expected every write path to be exercised, saw ${writes.length}`);
    for (const w of writes) {
      const cols = w.filters.map(([c]) => c);
      assert.ok(cols.includes("idempotency_key"), "a write reached the table without keying on the request");
      assert.ok(
        cols.includes("user_id"),
        `a write filtered on ${JSON.stringify(cols)} without user_id — service-role writes bypass RLS`
      );
    }
  });

  await test("no query in the source filters on idempotency_key without user_id", async () => {
    /* A source-level invariant, because a scope removed from a path that
       a non-owner can no longer reach would otherwise be invisible: the
       select already rejects them. This fails if ANY of the five is
       dropped, which is the property that matters. */
    const src = fs.readFileSync(path.join(rootDir, "supabase/functions/ai-notes/index.ts"), "utf8");
    // Split into statements and keep the ones addressing a request row.
    const statements = src.split(/;\s*\n/);
    const touching = statements.filter((st) => st.includes('eq("idempotency_key"'));
    assert.ok(touching.length >= 5, `expected at least 5 request-row queries, found ${touching.length}`);
    for (const st of touching) {
      assert.ok(
        st.includes('eq("user_id"'),
        `a query filters on idempotency_key without user_id — the service-role client bypasses RLS:\n${st.trim().slice(0, 240)}`
      );
    }
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

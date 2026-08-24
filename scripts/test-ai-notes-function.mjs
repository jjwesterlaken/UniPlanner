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
import {
  RESUMMARISE_BILLED_CREDITS,
  MINIMUM_BILLED_CREDITS,
  TYPICAL_SUMMARY_INPUT_TOKENS,
  TYPICAL_SUMMARY_OUTPUT_TOKENS,
  USD_PER_1M_SUMMARY_INPUT,
  USD_PER_1M_SUMMARY_OUTPUT,
  USD_PER_TRANSCRIBED_MINUTE,
} from "../supabase/functions/ai-notes/config.ts";
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

// The function keys usage by UTC YYYY-MM; the fake has to agree or a
// seeded row is invisible to it and every billing test starts from zero.
const monthNow = () => new Date().toISOString().slice(0, 7);

function makeDb(rows, missingObject = false, storedExt = "webm", trial = { used: 0 }) {
  // Every filter applied to a request-row query is recorded, so a test can
  // assert that writes are scoped even where the effect isn't observable
  // (the key is a primary key, so a mis-scoped update can't hit another
  // row -- but the scope still has to be there).
  const writes = [];
  const storageCalls = [];
  /* Billing is an RPC now (migration 0011's add_ai_credits), not an
     upsert, so the fake has to model one -- and modelling it as ADDING
     is what lets a test see the difference between a bill that landed
     and one that overwrote. The old fake's `upsert: async () => ({})`
     swallowed the whole thing and returned success, which is the
     "a fake that returns nothing makes everything downstream agree"
     trap this project has already been bitten by once. */
  const rpcCalls = [];

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
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "add_trial_credits") {
        /* The LIFETIME counter, modelled as a separate store because it
           is one: a column on profiles with no month in it. A fake that
           folded it into ai_usage would hide exactly the bug worth
           fearing — a trial allowance that refills every month. */
        trial.used += Number(args.p_credits || 0);
        return { data: [{ new_trial_credits: trial.used }], error: null };
      }
      if (name !== "add_ai_credits") return { data: null, error: { message: `no such function: ${name}` } };
      let row = rows.find((r) => r._t === "ai_usage" && r.user_id === args.p_user_id && r.month === args.p_month);
      if (!row) {
        row = { _t: "ai_usage", user_id: args.p_user_id, month: args.p_month, credits_used: 0 };
        rows.push(row);
      }
      // ADDS, exactly as the SQL does. A fake that assigned would let a
      // regression to the read-modify-write pass.
      row.credits_used += Number(args.p_credits || 0);
      return { data: [{ new_credits: row.credits_used }], error: null };
    },
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
        // Records exactly which folder and paths the function asked for,
        // so a test can prove the request body never influenced them.
        list: async (folder, opts) => {
          storageCalls.push({ op: "list", folder, search: opts && opts.search });
          /* Named after the key that was SEARCHED for, not a fixed one:
             real storage lists the caller's own folder filtered by the
             key, so a fake that always answers with the same name makes
             two different recordings indistinguishable — and a test
             billing twice in one month then silently bills once. */
          const named = (opts && opts.search) || KEY;
          return { data: missingObject ? [] : [{ name: `${named}.${storedExt}`, metadata: { size: 1000 } }], error: null };
        },
        createSignedUrl: async (p) => {
          storageCalls.push({ op: "sign", path: p });
          return { data: { signedUrl: "https://groq.test/audio" }, error: null };
        },
        remove: async (paths) => {
          storageCalls.push({ op: "remove", paths });
          return { error: null };
        },
      }),
    },
  };
  return { client, rows, writes, storageCalls, rpcCalls };
}

/* ---------- invoke the handler ---------- */

async function invoke({ rows = [], key = KEY, callerId = OWNER, missingObject = false, storedExt = "webm", bodyPath, tier = "ai", trialCreditsUsed = 0, estimatedDurationSeconds, mode, summariserOk = false, usage } = {}) {
  if (usage) rows = [...rows, { _t: "ai_usage", user_id: callerId, month: usage.month, credits_used: usage.creditsUsed || 0 }];
  /* One object, shared between the profiles fake and the RPC fake, so
     a trial bill is VISIBLE to a later read in the same run — which is
     what makes "the trial does not refill" testable at all. */
  const trial = { used: trialCreditsUsed };
  const db = makeDb(rows, missingObject, storedExt, trial);
  db.client.auth.getUser = async () => ({ data: { user: { id: callerId } }, error: null });
  const baseFrom = db.client.from;
  db.client.from = (name) => {
    if (name === "profiles") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { tier, trial_credits_used: trial.used }, error: null }) }),
        }),
      };
    }
    return baseFrom(name);
  };

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
  const providerCalls = [];
  globalThis.fetch = async (url) => {
    providerCalls.push(String(url));
    if (String(url).includes("groq")) return { ok: true, json: async () => ({ text: "a lecture", duration: 60 }) };
    /* The summariser is left failing by default (the function handles
       it by returning the transcript with summaryFailed). `summariserOk`
       flips it, which is what the re-summarise success path needs. */
    if (summariserOk) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overview: "An overview.",
                  keyPoints: ["A point."],
                  terms: [{ term: "T", content: "M" }],
                  assessable: [],
                  openQuestions: [],
                }),
              },
            },
          ],
        }),
      };
    }
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
      body: JSON.stringify(
        mode
          ? { mode, idempotencyKey: key }
          : {
              path: bodyPath !== undefined ? bodyPath : `${callerId}/${key}.webm`,
              mimeType: "audio/webm",
              idempotencyKey: key,
              ...(estimatedDurationSeconds === undefined ? {} : { estimatedDurationSeconds }),
            }
      ),
    })
  );
  const bodyText = await res.text();
  console.log = origLog;
  console.error = origErr;

  return {
    status: res.status, bodyText, body: JSON.parse(bodyText),
    rows: db.rows, writes: db.writes, storageCalls: db.storageCalls, rpcCalls: db.rpcCalls, trial, logs, providerCalls,
  };
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

  await test("the storage path is derived from the caller, not from the request body", async () => {
    // A path naming another user's folder must have no effect at all --
    // not be rejected, simply be irrelevant.
    const hostile = `${OTHER}/${KEY}.webm`;
    const r = await invoke({ bodyPath: hostile });

    // No storage call anywhere may mention the other user -- that is the
    // security property, and it covers the housekeeping sweep too.
    for (const c of r.storageCalls) {
      const target = String(c.folder ?? c.path ?? (c.paths || []).join(","));
      assert.ok(!target.includes(OTHER), `storage was addressed with the body's path: ${JSON.stringify(c)}`);
    }

    /* The calls made on behalf of THIS request must all sit in the
       caller's own folder. scheduleCleanup's orphan sweep is excluded: it
       deliberately lists the whole bucket with no search term, which is
       what makes it a sweep, and it is not driven by request input. */
    const requestCalls = r.storageCalls.filter((c) => c.search || c.op === "sign");
    assert.ok(requestCalls.length >= 2, `expected the request to list and sign, saw ${JSON.stringify(r.storageCalls)}`);
    for (const c of requestCalls) {
      const target = String(c.folder ?? c.path);
      assert.ok(target.startsWith(OWNER), `storage target did not start with the caller's id: ${JSON.stringify(c)}`);
    }
  });

  await test("a traversal in the supplied path cannot escape the caller's folder", async () => {
    for (const evil of [
      `${OWNER}/../${OTHER}/${KEY}.webm`,
      `../../${OTHER}/${KEY}.webm`,
      `${OTHER}/${KEY}.webm`,
      "", null, 42, { nested: true },
    ]) {
      const r = await invoke({ bodyPath: evil });
      for (const c of r.storageCalls) {
        const target = String(c.folder ?? c.path ?? (c.paths || []).join(","));
        assert.ok(!target.includes(".."), `traversal reached storage: ${target}`);
        assert.ok(!target.includes(OTHER), `another user's folder reached storage: ${target}`);
      }
    }
  });

  await test("the extension is discovered from storage, not assumed to be webm", async () => {
    // iOS Safari records mp4/aac, so a hardcoded .webm would make every
    // iPhone recording look missing.
    for (const ext of ["webm", "m4a", "aac"]) {
      const r = await invoke({ storedExt: ext });
      const signed = r.storageCalls.find((c) => c.op === "sign");
      assert.ok(signed, `nothing was signed for a .${ext} recording`);
      assert.equal(signed.path, `${OWNER}/${KEY}.${ext}`);
    }
  });

  await test("an object with an extension outside the allowlist is not signed", async () => {
    // Only the formats the recorder can produce are accepted, so a stray
    // object in the folder can't be fed to the transcription provider.
    const r = await invoke({ storedExt: "exe" });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "recording_missing");
    assert.ok(!r.storageCalls.some((c) => c.op === "sign"), "an unexpected file type was signed");
  });

  await test("AN EXHAUSTED ALLOWANCE SPENDS NOTHING: refused before any provider call, before any billing", async () => {
    /* THIS TEST USED TO ASSERT THAT A FREE TIER WAS REFUSED. It is not
       any more: every tier has an allowance, and a free account records
       against the 60-credit lifetime trial, because a trial that cannot
       produce one set of lecture notes cannot sell lecture notes.

       What it was really guarding is unchanged and is what it now
       asserts: a REFUSAL costs nothing. The allowance read is step 7
       and transcription is step 9 — reverse them and a student out of
       credits has their recording transcribed (money spent) and is then
       told no. The traced fetch is what makes that ordering a fact
       rather than a comment. */
    const out = await invoke({ tier: "free", trialCreditsUsed: 60, estimatedDurationSeconds: 600 });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, "usage_exceeded");
    assert.deepEqual(out.providerCalls, [], "a provider was called for a free-tier request — money was spent on a refusal");
    assert.ok(!out.storageCalls.some((c) => c.op === "sign"), "the audio was signed for a request that was refused");
    assert.deepEqual(out.rpcCalls, [], "usage was billed on a refused request");
    /* And the refusal precedes the idempotency claim, so the upload is a
       clean orphan: no request row points at it, and the sweep removes
       it once it is over ORPHAN_SWEEP_HOURS old. */
    assert.ok(
      out.rows.every((r) => r._t !== "ai_notes_requests" || r.status === "failed"),
      "a live request row was left behind by a refused request"
    );
  });

  await test("THE CAP IS SOFT BY EXACTLY ONE RECORDING, and the client's estimate is why", async () => {
    /* NOT A BUG BEING FIXED — a bounded hole being pinned, because the
       tier work made it the only thing between an exhausted account and
       a paid transcription. The pre-flight guard projects using the
       CLIENT's estimatedDurationSeconds; a client that sends nothing
       projects zero and passes. Billing afterwards is honest — it uses
       the provider's reported duration — so the account simply ends up
       over its limit by one recording.
       COST-MODEL.md section 5(c) has the reasoning for leaving it.
       This test exists so that "the cap holds" is never claimed. */
    const out = await invoke({ tier: "free", trialCreditsUsed: 60 }); // no estimate sent
    assert.equal(out.status, 200, "the estimate-less path stopped getting through — if that is deliberate, delete this test");
    assert.ok(out.trial.used > 60, "the overshoot must still be BILLED honestly, or it is a free ride rather than an overshoot");
  });

  await test("a free account with an untouched trial CAN record", async () => {
    /* The other half, and the reason the test above changed shape. The
       trial exists to demonstrate the thing being sold; a gate that
       refuses every free account refuses the demonstration. */
    const out = await invoke({ tier: "free", trialCreditsUsed: 0 });
    assert.equal(out.status, 200, out.bodyText.slice(0, 200));
    const bills = out.rpcCalls.filter((c) => c.name === "add_trial_credits");
    assert.equal(bills.length, 1, "a trial recording billed the wrong counter, or none");
    assert.equal(bills[0].args.p_credits, MINIMUM_BILLED_CREDITS);
    assert.equal(
      out.rpcCalls.filter((c) => c.name === "add_ai_credits").length,
      0,
      "a trial tier wrote to the MONTHLY counter — that allowance would refill every month"
    );
  });

  await test("the source never reads a path from the request body", async () => {
    // The property that makes this stronger than a guard: there is no
    // client-supplied path for a future code path to forget to check.
    const src = fs.readFileSync(path.join(rootDir, "supabase/functions/ai-notes/index.ts"), "utf8");
    const destructure = src.match(/const \{[^}]*\} = body \|\| \{\};/);
    assert.ok(destructure, "could not find the request body destructure");
    assert.ok(!/\bpath\b/.test(destructure[0]), `path is still read from the body: ${destructure[0]}`);
  });

  /* ---------- re-summarise: the retry that reads a row by id ----------

     This is the task ai-text was deliberately designed to avoid: it
     reads a stored row, so every obligation that comes with reading one
     applies. The failure it prevents cost a real lecture — transcription
     billed, summary failed, no way to retry. */

  const failedRow = (uid) => ({
    _t: "ai_notes_requests",
    idempotency_key: KEY,
    user_id: uid,
    status: "done",
    summary_failed: true,
    result: { transcript: "the lecture transcript", summaryFailed: true },
    created_at: new Date().toISOString(),
  });

  await test("re-summarising someone else's lecture is refused IDENTICALLY to a malformed key", async () => {
    /* The row holds a whole lecture, so a lookup by key alone is how one
       student receives another's. Byte-identical rejection, or the
       endpoint answers "does this key exist?" for any key tried. */
    const notOwner = await invoke({ mode: "resummarise", rows: [failedRow(OTHER)] });
    const malformed = await invoke({ mode: "resummarise", key: "msn0duf5-hk684" });
    assert.equal(notOwner.status, malformed.status, "status codes differ");
    assert.equal(notOwner.body.code, malformed.body.code, "codes differ");
    assert.equal(notOwner.body.error, malformed.body.error, "messages differ");
    assert.equal(JSON.stringify(notOwner.body), JSON.stringify(malformed.body), "bodies differ");
  });

  await test("a non-owner's re-summarise never reaches the provider", async () => {
    const r = await invoke({ mode: "resummarise", rows: [failedRow(OTHER)], summariserOk: true });
    assert.equal(r.status, 400);
    assert.ok(
      !r.providerCalls.some((u) => u.includes("openai")),
      "a refused request still called the summariser — money spent answering someone else's key"
    );
  });

  await test("a swept transcript is 'expired', definitively, and bills nothing", async () => {
    const row = { ...failedRow(OWNER), result: { summaryFailed: true } }; // sweep took the transcript
    const r = await invoke({ mode: "resummarise", rows: [row], summariserOk: true });
    assert.equal(r.body.code, "transcript_expired");
    assert.ok(!r.providerCalls.some((u) => u.includes("openai")), "it summarised nothing and called the provider anyway");
    assert.match(r.body.error, /Nothing has been charged/i, "the student must be told this attempt was free");
  });

  await test("a failed retry bills nothing, and says so", async () => {
    const r = await invoke({ mode: "resummarise", rows: [failedRow(OWNER)], summariserOk: false });
    assert.equal(r.body.code, "summary_failed");
    assert.match(r.body.error, /Nothing has been charged/i);
    assert.match(r.body.error, /transcript is still here|try again/i, "a retry that failed must not read as the end of the road");
  });

  await test("a successful retry charges the summary only, and the figure is derived", async () => {
    const rows = [failedRow(OWNER)];
    const r = await invoke({ mode: "resummarise", rows, summariserOk: true });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.result.summaryFailed, false);
    assert.equal(r.body.creditsBilled, RESUMMARISE_BILLED_CREDITS);
    // Derived from the measured constants, never typed: the same
    // arithmetic the floor uses, rounded up to a whole minute.
    const derived = Math.max(
      1,
      Math.ceil(
        ((TYPICAL_SUMMARY_INPUT_TOKENS / 1_000_000) * USD_PER_1M_SUMMARY_INPUT +
          (TYPICAL_SUMMARY_OUTPUT_TOKENS / 1_000_000) * USD_PER_1M_SUMMARY_OUTPUT) /
          USD_PER_TRANSCRIBED_MINUTE
      )
    );
    assert.equal(RESUMMARISE_BILLED_CREDITS, derived, "the retry price stopped being derived from the measured cost");
    assert.ok(
      RESUMMARISE_BILLED_CREDITS < MINIMUM_BILLED_CREDITS,
      "a retry must cost less than a fresh recording — the transcription was already paid for"
    );
  });

  await test("the retry never re-transcribes: no audio, no transcription call", async () => {
    const r = await invoke({ mode: "resummarise", rows: [failedRow(OWNER)], summariserOk: true });
    assert.ok(!r.providerCalls.some((u) => u.includes("groq")), "the retry called the transcription provider");
    assert.ok(!r.providerCalls.some((u) => u.includes("/storage/")), "the retry went looking for audio that was deleted at step 10");
  });

  await test("a lecture whose summary SUCCEEDED cannot be re-summarised", async () => {
    /* THE PRECONDITION. Without it this branch required only that the
       row exists, is yours, and holds a transcript -- so a successful
       three-hour lecture could be re-summarised for the whole retention
       window at RESUMMARISE_BILLED_CREDITS a go, which COST-MODEL.md
       prices at 5x what a real recording costs per billed minute and
       the most expensive legal way to spend an allowance.

       MUTATION CHECK: delete the `summary_failed !== true` guard in
       index.ts and this test goes red on the status line. */
    const done = {
      ...failedRow(OWNER),
      summary_failed: false,
      result: { transcript: "the lecture transcript", summaryFailed: false },
    };
    const r = await invoke({ mode: "resummarise", rows: [done], summariserOk: true });
    assert.equal(r.status, 409, `a successful lecture was re-summarised: ${r.bodyText.slice(0, 200)}`);
    assert.equal(r.body.code, "already_summarised");
    assert.ok(
      !r.providerCalls.some((u) => u.includes("openai")),
      "the summariser ran for a lecture that already had a summary — that is the spend this precondition exists to stop"
    );
    assert.deepEqual(r.rpcCalls, [], "a refused retry billed the student");
    assert.match(r.body.error, /Nothing has been charged/i, "every sentence about this lecture's cost says what was charged");
  });

  await test("the precondition is checked BEFORE the transcript, so a successful note never reads as 'expired'", async () => {
    /* Both facts are true of this row and only one answers the question
       that was asked. "We no longer have the transcript" is a true
       sentence about the wrong thing, and it invites a student to
       believe they lost something they did not. */
    const doneAndSwept = { ...failedRow(OWNER), summary_failed: false, result: { summaryFailed: false } };
    const r = await invoke({ mode: "resummarise", rows: [doneAndSwept], summariserOk: true });
    assert.equal(r.body.code, "already_summarised", "the swept-transcript answer won over the real one");
  });

  await test("one retry per failure: a successful retry closes the door behind it", async () => {
    /* Falls out of the precondition for free -- the success path writes
       summary_failed = false -- and it is what turns the retry from a
       door into a remedy. Asserted rather than assumed, because it
       hangs on that one field in the success write. */
    const rows = [failedRow(OWNER)];
    const first = await invoke({ mode: "resummarise", rows, summariserOk: true });
    assert.equal(first.status, 200, first.bodyText.slice(0, 200));
    const second = await invoke({ mode: "resummarise", rows, summariserOk: true });
    assert.equal(second.status, 409, "the same lecture was re-summarised twice");
    assert.equal(second.body.code, "already_summarised");
  });

  /* ---------- billing is atomic, and it is atomic IN THE DATABASE ---------- */

  await test("a fresh recording bills through add_ai_credits, scoped and in minutes only", async () => {
    const r = await invoke({ usage: { month: monthNow(), creditsUsed: 12 } });
    assert.equal(r.status, 200, r.bodyText.slice(0, 200));
    const bills = r.rpcCalls.filter((c) => c.name === "add_ai_credits");
    assert.equal(bills.length, 1, "a recording billed something other than once through the RPC");
    assert.equal(bills[0].args.p_user_id, OWNER, "the bill was not scoped to the caller");
    assert.equal(bills[0].args.p_credits, MINIMUM_BILLED_CREDITS, "the 60-second fake recording should bill the floor");
    assert.equal(typeof bills[0].args.p_credits, "number", "the bill must be a number of credits");
  });

  await test("the RPC ADDS to the month, so a second recording does not overwrite the first", async () => {
    /* The whole point of 0011, seen from the caller. The fake models
       add_ai_credits as ADDING because the SQL does; if the function went
       back to writing a sum computed here from a read taken before the
       provider call, the second recording in a month would replace the
       first rather than add to it. */
    // ONE row object, carried across two invocations, so the second
    // bill lands on the month the first one wrote.
    const usageRow = { _t: "ai_usage", user_id: OWNER, month: monthNow(), credits_used: 0 };
    await invoke({ rows: [usageRow] });
    const before = usageRow.credits_used;
    await invoke({ rows: [usageRow], key: "4f9a1c2e-7b4d-4e6f-9a1b-2c3d4e5f6a7c" });
    assert.equal(before, MINIMUM_BILLED_CREDITS, "the first recording did not bill the floor");
    assert.equal(
      usageRow.credits_used,
      MINIMUM_BILLED_CREDITS * 2,
      "the second recording overwrote the month instead of adding to it"
    );
  });

  await test("nothing in the source upserts ai_usage any more — the addition happens in the database", async () => {
    /* NARROW ON PURPOSE, and deliberately NOT comment-stripped:
       `.from("ai_usage")` appears in no comment in either file, so
       matching the call itself reads exactly the thing it is about and
       cannot be confused by the prose around it. Six instances of a
       strip pattern eating what it was checking say that is the better
       trade.

       The third assertion is what stops this passing for the wrong
       reason: remove the allowance READ as well and the upsert guard
       would go green while the ordering that makes a refusal free had
       been destroyed. */
    /* THE READ AND THE WRITE BOTH MOVED to _shared/allowance.ts when
       tiers arrived, because which counter a credit lands in depends on
       the tier and two copies of that branch is two chances to refill a
       lifetime allowance every month. So the guard reads the helper for
       the RPCs, and each endpoint for the absence of an upsert. */
    const shared = fs.readFileSync(path.join(rootDir, "supabase/functions/_shared/allowance.ts"), "utf8");
    assert.ok(/\.rpc\(\s*["']add_ai_credits["']/.test(shared), "the monthly counter is no longer billed through add_ai_credits");
    assert.ok(/\.rpc\(\s*["']add_trial_credits["']/.test(shared), "the lifetime counter is no longer billed through add_trial_credits");
    assert.ok(
      /\.from\(\s*["']ai_usage["']\s*\)[\s\S]{0,200}?\.select\(/.test(shared),
      "the allowance is no longer READ — that read must still precede the provider call"
    );
    assert.ok(
      !/\.from\(\s*["']ai_usage["']\s*\)[\s\S]{0,300}?\.upsert\(/.test(shared),
      "the helper upserts ai_usage from a value it computed itself — the lost update, back"
    );
    for (const rel of ["supabase/functions/ai-notes/index.ts", "supabase/functions/ai-text/index.ts"]) {
      const src = fs.readFileSync(path.join(rootDir, rel), "utf8");
      assert.ok(
        !/\.from\(\s*["']ai_usage["']\s*\)/.test(src),
        `${rel} talks to ai_usage directly again — the tier branch belongs in one place`
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

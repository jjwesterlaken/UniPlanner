/* The daily error digest — the server half of what 0010 built for the
 * client.
 *
 * THE CLAIM THAT MATTERS MOST IS NOT THE EMAIL. It is that recording a
 * failure cannot make the failure worse. Every one of the ~87
 * `logFailure` call sites in this repository is already inside a
 * failure path, most of them one line before a `return`, so a recorder
 * that throws replaces a diagnosed failure with an undiagnosed one —
 * the response changes, and the line explaining the original failure
 * becomes the last thing anybody sees about it.
 *
 * So the first section drives `recordFailure` with a database that
 * refuses, a database that throws, and no database at all, and requires
 * the printed line to be byte-identical to what `failureLine` produced
 * before this existed.
 *
 * WHAT THIS CANNOT SEE, said here rather than implied by a pass: Resend
 * (whether the key is live, whether the sending domain is verified,
 * whether a plain-text body lands in a spam folder), pg_cron (whether
 * the schedule exists on the live project, and whether the Vault
 * secrets it reads are set), and the migration in production. The first
 * two are dashboard steps in SUPABASE-SETUP.md; the third is the
 * apply-and-verify ritual, and 0022's own self-check is what refuses to
 * report success having done nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-digest-"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  - ${name}\n        ${err.message}`);
  }
}

const load = (p) => import(pathToFileURL(path.join(rootDir, p)).href);
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

const digest = await load("supabase/functions/error-digest/digest.js");
const diagnostics = await load("supabase/functions/ai-notes/diagnostics.js");

/* ---------- the recorder, from a real bundle ----------

   THE SPLIT IS FORCED, NOT CHOSEN, and it is the `purchases.js` shape
   one runtime over. `digest.js` is plain JS with no Deno globals and no
   platform imports, so it is imported DIRECTLY and every claim about
   grouping and wording is made against the module that ships.
   `failureLog.ts` reaches the service-role client, which imports from
   `https://esm.sh/`, and Node's ESM loader refuses an https specifier
   outright — so the half that talks to a database is exercised through
   an esbuild bundle with the platform stubbed, the arrangement
   test-stripe uses for the handlers.

   It is bundled rather than skipped because the claims that matter most
   here are BEHAVIOURAL: that a recorder inside a failure path cannot
   throw, and that the printed line is unchanged. A source grep can say
   neither. */

const stubDir = path.join(tmpDir, "stubs");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, "supabase.js"),
  `export function createClient() { return globalThis.__FAKE_CLIENT__; }
   export class SupabaseClient {}\n`
);

const built = await build({
  entryPoints: [path.join(rootDir, "supabase/functions/_shared/failureLog.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  plugins: [{ name: "stub", setup: (b) => b.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: path.join(stubDir, "supabase.js") })) }],
});
const recorderFile = path.join(tmpDir, "failureLog.mjs");
fs.writeFileSync(recorderFile, built.outputFiles[0].text);

/* A FRESH MODULE PER WORLD, and this is not tidiness — `supabaseAdmin`
   CACHES its client on first use, so a second world's fake would never
   be reached and, worse, the no-platform world would return the cached
   client instead of throwing. The premise of that world would be
   silently false while its assertion passed for the wrong reason. */
const freshRecorder = () => import(`${pathToFileURL(recorderFile).href}?v=${Math.random()}`);
const recorder = await freshRecorder();

/* A fake environment and a fake database. `insert` records what it was
   given and answers however the world was set up, so "it wrote the row"
   and "it survived a refusal" are separate claims. */
function makeWorld({ env = { SUPABASE_URL: "https://x.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, insert = null, noDeno = false } = {}) {
  const inserts = [];
  const origDeno = globalThis.Deno;
  const origClient = globalThis.__FAKE_CLIENT__;
  if (noDeno) delete globalThis.Deno;
  else globalThis.Deno = { env: { get: (k) => env[k] } };
  globalThis.__FAKE_CLIENT__ = {
    from(table) {
      return {
        insert(row) {
          inserts.push({ table, row });
          if (insert === "throw") throw new Error("the connection went away");
          if (insert === "refuse") return Promise.resolve({ data: null, error: { code: "42P01", message: 'relation "public.function_errors" does not exist' } });
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
  };
  return {
    inserts,
    restore: () => {
      if (origDeno === undefined) delete globalThis.Deno;
      else globalThis.Deno = origDeno;
      globalThis.__FAKE_CLIENT__ = origClient;
    },
  };
}

/** One microtask turn, so a fire-and-forget insert has landed. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function captureConsole() {
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  return {
    lines: out,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

const row = (over = {}) => ({
  fn: "ai-notes",
  stage: "summarise",
  name: "Error",
  message: "the provider answered 500",
  detail: { id: "evt_1" },
  occurred_at: "2026-09-17T09:00:00.000Z",
  ...over,
});

async function run() {
  /* ---------- 1. recording a failure cannot make it worse ---------- */

  await test("THE PRINTED LINE IS UNCHANGED, byte for byte, by the recording", async () => {
    /* THE NON-VACUITY ASSERTION FOR EVERYTHING ELSE. Six functions had
       their `logFailure` rewritten to call `recordFailure`, and every
       existing test that reads a log line reads those bytes — so if
       this drifts, the claim "nothing about logging changed" is false
       and dozens of assertions elsewhere are measuring something new.

       Compared against `failureLine` itself rather than against a typed
       string: the expected value has to come from the function that
       produced it before, or this is a restatement of the format. */
    const err = new Error("boom");
    const extra = { id: "evt_9", status: 500 };

    const w = makeWorld();
    const { recordFailure } = await freshRecorder();
    const cap = captureConsole();
    try {
      recordFailure("stripe-webhook", "apply", err, extra);
      await settle();
    } finally {
      cap.restore();
      w.restore();
    }

    const expected = diagnostics.failureLine("apply", err, extra, "stripe-webhook");
    assert.equal(cap.lines[0], expected, "the failure line no longer matches what failureLine produces");
    assert.match(cap.lines[0], /^stripe-webhook FAILURE /, "the greppable prefix is gone");

    /* AND THE ROW REALLY GOES IN. A recorder that printed and wrote
       nothing would satisfy every "it cannot make things worse" claim
       below and report an empty digest for ever. */
    assert.equal(w.inserts.length, 1, "nothing was written, so the digest would be empty whatever failed");
    assert.equal(w.inserts[0].table, "function_errors");
    assert.equal(w.inserts[0].row.fn, "stripe-webhook");
    assert.equal(w.inserts[0].row.stage, "apply");
    assert.deepEqual(w.inserts[0].row.detail, extra);
    assert.equal(cap.lines.length, 1, `the healthy path printed something extra: ${cap.lines.slice(1).join(" | ")}`);
  });

  await test("A DATABASE THAT REFUSES, ONE THAT THROWS, AND NONE AT ALL — none of them changes the failure", async () => {
    /* THE CLAIM THIS FILE EXISTS FOR. Every caller is already inside a
       failure path, most of them one line before a `return`, so a
       recorder that throws replaces a diagnosed failure with an
       undiagnosed one: the response changes, and the line explaining
       the original failure becomes the last thing anybody sees.

       Three worlds, because they fail at three different points and a
       catch around one of them would look like a catch around all
       three. The third is the env_check world — `getSupabaseAdmin()`
       throws by design with SUPABASE_URL unset, and env_check is
       exactly the stage at which that is true. */
    const worlds = [
      { name: "the table does not exist", opts: { insert: "refuse" } },
      { name: "the insert throws", opts: { insert: "throw" } },
      { name: "there is no platform at all", opts: { noDeno: true } },
    ];

    for (const world of worlds) {
      const w = makeWorld(world.opts);
      const { recordFailure } = await freshRecorder();
      const cap = captureConsole();
      try {
        assert.doesNotThrow(
          () => recordFailure("ai-notes", "summarise", new Error("the provider answered 500")),
          `${world.name}: recording threw, which would replace the real failure with this one`
        );
        await settle();
      } finally {
        cap.restore();
        w.restore();
      }

      assert.match(cap.lines[0] ?? "", /ai-notes FAILURE .*summarise/, `${world.name}: the original failure was not printed`);
      /* AND THE RECORDER'S OWN FAILURE IS PRINTED, NOT SWALLOWED. A
         catch that says nothing turns an empty digest into evidence
         that nothing is wrong — the `fetchNote` rule, one table over:
         a failed write is not an absence of failures. */
      assert.ok(
        cap.lines.some((l) => l.includes("function_errors_insert")),
        `${world.name}: the recorder's own failure was swallowed, so a broken digest would look like a quiet week`
      );
    }
  });

  await test("A MISSING CLIENT IS ONE LINE, and a database that answers is still explained in full", async () => {
    /* THE NOISE THIS REMOVES, and why it is worth a test rather than a
       tidy-up. With the platform stubbed, `getSupabaseAdmin()` hands
       back nothing usable and the old code found that out by reading
       `.from` off it — a TypeError, caught, and printed with its whole
       stack. `npm test` carried pages of them, all saying the same
       thing about a fake environment.

       A wall of identical stacks is not harmless: it is how the one
       line that IS worth reading gets scrolled past, which is the
       failure the digest exists to prevent, arriving in the terminal
       instead of the inbox.

       BOTH HALVES, because quietening the wrong one would be worse
       than the noise. An absent client is a one-line fact; a database
       that answered and REFUSED is a real event and keeps everything
       it had. The two are asserted to differ before either is checked
       on its own. */
    const readLines = async (opts) => {
      const w = makeWorld(opts);
      const { recordFailure } = await freshRecorder();
      const cap = captureConsole();
      try {
        recordFailure("ai-text", "provider", new Error("upstream 500"), { task: "explain" });
        await settle();
      } finally {
        cap.restore();
        w.restore();
      }
      return cap.lines;
    };

    const absent = (await readLines({ noDeno: true })).filter((l) => l.includes("function_errors_insert"));
    const refused = (await readLines({ insert: "refuse" })).filter((l) => l.includes("function_errors_insert"));

    assert.equal(absent.length, 1, `an absent client printed ${absent.length} recorder lines: ${absent.join(" | ")}`);
    assert.equal(refused.length, 1, `a refusing database printed ${refused.length} recorder lines`);
    assert.notEqual(
      absent[0],
      refused[0],
      "an absent client and a refusing database print the same line, so neither tells you which happened"
    );

    /* THE ONE-LINER CARRIES NO STACK. Matched on the frame marker
       rather than on a length, because a long provider message is not
       the thing being complained about. */
    assert.doesNotMatch(absent[0], /\n\s+at /, `the absent-client line still carries a stack: ${absent[0]}`);
    assert.match(absent[0], /recorder unavailable/, "the absent-client line does not say what happened");
    assert.match(absent[0], /^ai-text FAILURE /, "the greppable prefix is gone, so one grep no longer finds every missing row");

    /* AND THE INFORMATIVE ONE IS UNTOUCHED: a real refusal still names
       the postgres code, which is the thing somebody would act on. */
    assert.match(refused[0], /42P01/, "a refused insert no longer reports what the database said");
  });

  await test("`EdgeRuntime.waitUntil` IS USED, AND IS GUARDED — a free variable here would be the worst place for one", () => {
    /* A floating promise in an Edge Function is not a promise that
       completes: the worker may be torn down the moment the response
       returns, and `recordFailure` is called one line before a return
       almost everywhere. waitUntil is the platform's primitive for it.

       AND THE GUARD IS THE HALF THAT COULD NOT BE LEFT OUT. The
       identifier does not exist under Node, so an unguarded reference
       would throw ReferenceError inside the one module whose entire job
       is to never make things worse — and the catch around the insert
       would mask it as a quiet digest. That is the class
       `freeVariables()` was written for after `allowanceForTier`
       blanked the AI tab.

       Asserted at the SOURCE because the behaviour under Node is the
       absence of the call, which is indistinguishable from the call
       never having been written. The behavioural half is the test
       above: no throw, with no platform present. */
    const src = read("supabase/functions/_shared/failureLog.ts");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    assert.match(code, /EdgeRuntime/, "nothing keeps the insert alive past the response");
    assert.match(code, /waitUntil/, "waitUntil is not called");
    assert.match(
      code,
      /typeof\s+rt\.waitUntil\s*===\s*"function"/,
      "waitUntil is called without checking it exists — under Node that is a ReferenceError inside a failure path"
    );
    assert.ok(/globalThis as any\)\.EdgeRuntime/.test(code), "EdgeRuntime is read as a bare identifier rather than off globalThis");
  });

  await test("THE PRINT COMES BEFORE THE WRITE, which is what makes the log independent of the table", async () => {
    /* ORDER, not presence. A recorder that inserted first and printed
       afterwards would lose the log line on any teardown between them —
       and the log is the mechanism that has always worked. Asserted on
       the source position inside the function body, the way the
       verify-before-parse rule is. */
    const src = read("supabase/functions/_shared/failureLog.ts");
    const body = src.slice(src.indexOf("export function recordFailure"));
    const printAt = body.indexOf("console.error(failureLine(");
    const insertAt = body.indexOf('from("function_errors")');
    assert.ok(printAt >= 0, "recordFailure does not print the failure line");
    assert.ok(insertAt >= 0, "recordFailure does not write the row");
    assert.ok(printAt < insertAt, "the row is written before the line is printed");
  });

  /* ---------- 2. what is stored, and what is not ---------- */

  await test("THE ROW IS WHAT THE LOG SAYS, REDACTED THE SAME WAY", () => {
    /* The stored name/message/stack come from `describeError`, which is
       what the printed line uses — so the table cannot hold something
       the logs would not. Demonstrated on the one realistic leak the
       redactor was written for: a provider error quoting the signed
       audio URL, whose query string carries an access token. */
    const { failureRow } = recorder;
    const leaky = new Error("upload failed for https://x.supabase.co/object/lecture-audio/a.webm?token=eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop");
    const stored = failureRow("ai-notes", "signed_url", leaky, { id: "req_1" });
    assert.ok(!stored.message.includes("token=eyJ"), "the stored message carries a signed URL's access token");
    assert.match(stored.message, /\[redacted\]/, "nothing was redacted, so this proves nothing about the redactor");
    assert.equal(stored.fn, "ai-notes");
    assert.equal(stored.stage, "signed_url");
  });

  await test("`app_user_id` IS DROPPED, and everything else in the extras is kept", () => {
    /* THE ONE FIELD THAT MUST NOT BE STORED. `function_errors` has
       deliberately no user_id column and no deletion coverage (0022's
       header has the reasoning), so an account identifier in `detail`
       would be a student's id in a table no deletion reaches. The same
       id is already in `billing_events.app_user_id`, which IS covered,
       so nothing is lost by dropping it here.

       The list is asserted from the module's own constant AND the
       behaviour, so a key added to the constant without being dropped
       goes red. */
    const { detailForStorage, DETAIL_DROPPED_KEYS } = recorder;
    assert.deepEqual(DETAIL_DROPPED_KEYS, ["app_user_id"], "the dropped-key list changed — decide what the documents say before widening it");

    const kept = detailForStorage({ id: "evt_1", status: 500, missing: true, app_user_id: "e4c9b0de-0000-4000-8000-000000000001" });
    assert.deepEqual(kept, { id: "evt_1", status: 500, missing: true });

    for (const key of DETAIL_DROPPED_KEYS) {
      assert.equal(detailForStorage({ [key]: "x" }), null, `${key} survived into a stored detail`);
    }

    /* NULL RATHER THAN {}: a row with nothing to add is visibly empty
       instead of holding an object that says nothing. */
    assert.equal(detailForStorage({}), null);
    assert.equal(detailForStorage(), null);
  });

  await test("EVERY FUNCTION'S logFailure GOES THROUGH THE RECORDER — derived, not listed", () => {
    /* A LIST WOULD DRIFT. The claim is about every Edge Function that
       has a failure path, so the set is read from the folder: any
       function defining a `logFailure` must define it in terms of
       `recordFailure`, or its failures are printed and never recorded
       and the digest is silently partial.

       `failureLine` must be GONE from those files too, because a second
       spelling of the same line is how one function quietly stops being
       covered. */
    const dir = path.join(rootDir, "supabase/functions");
    const fns = fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, "index.ts")))
      .filter((d) => !d.startsWith("_"));
    assert.ok(fns.length >= 6, `only ${fns.length} functions found, so this sweep is guarding almost nothing`);

    const definers = [];
    const gated = [];
    for (const fn of fns) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      if (!/const logFailure/.test(code)) continue;
      definers.push(fn);
      assert.match(
        code,
        new RegExp(`recordFailure\\(\\s*"${fn}"`),
        `${fn}/index.ts defines logFailure without calling recordFailure("${fn}", …) — its failures would never reach the digest`
      );
      /* A SECOND SPELLING IS ALLOWED IN EXACTLY ONE SHAPE, and the two
         webhooks need it. They are deployed without JWT verification,
         so anybody can POST to them, and a failure BEFORE the signature
         verifies must be printed and not recorded — otherwise an
         unauthenticated caller inserts a row per request and the digest
         drowns. So a direct `failureLine` is permitted only as the
         unrecorded half of that gate, and the gate itself is what is
         asserted. A bare `failureLine` with no gate would be a function
         whose failures silently never reach the digest. */
      if (/failureLine\(/.test(code)) {
        assert.match(
          code,
          new RegExp(`verified \\? recordFailure\\(\\s*"${fn}"[\\s\\S]{0,120}?: printFailure\\(`),
          `${fn}/index.ts calls failureLine directly without the verified-only gate, so some of its failures may never reach the digest`
        );
        /* AND THE FLAG IS PER REQUEST. Module-level state would be
           shared across concurrent requests in one isolate, which is
           how a forged delivery would come to be recorded because a
           real one happened to be in flight. */
        const handleBody = code.slice(code.indexOf("export async function handle"));
        assert.match(handleBody, /let verified = false;/, `${fn}/index.ts does not reset its verified flag per request`);
        gated.push(fn);
      }
    }
    assert.ok(definers.length >= 6, `only ${definers.length} functions define logFailure, so the sweep read the wrong thing`);
    /* NON-VACUITY FOR THE GATE. If no function took that branch the
       assertion inside it would never run, and a webhook that lost its
       gate would be reported as a function that simply does not print. */
    assert.ok(gated.length >= 2, `only ${gated.length} functions gate their recording, so that branch is untested`);
  });

  /* ---------- 3. the grouping ---------- */

  await test("GROUPED BY (function, stage, name) and never by message", () => {
    /* A provider error quotes an id, a status or a timestamp, so
       grouping by message turns one broken thing into forty lines and
       buries whatever else failed. Demonstrated with forty distinct
       messages that must collapse to one line. */
    const rows = Array.from({ length: 40 }, (_, i) => row({ message: `the provider answered 500 for request ${i}` }));
    const d = digest.buildDigest(rows, { total: 40, windowHours: 24 });
    assert.equal(d.groups.length, 1, "distinct messages split one failure into several groups");
    assert.equal(d.groups[0].count, 40);

    /* AND THE THREE FIELDS IT DOES GROUP BY EACH SPLIT. Otherwise
       "grouped by three things" would be satisfied by grouping by one. */
    for (const field of ["fn", "stage", "name"]) {
      const split = digest.buildDigest([row(), row({ [field]: "different" })], { total: 2 });
      assert.equal(split.groups.length, 2, `${field} does not split a group, so it is not part of the key`);
    }
  });

  await test("THE COUNT IS OF WHAT HAPPENED, NOT OF WHAT WAS READ", () => {
    /* The read is bounded at 500, because a loop in one function could
       write tens of thousands of rows in a day and a digest that tries
       to read all of them runs out of memory instead of reporting the
       loop — the one thing it most needs to report.

       So `total` comes from a separate COUNT, and `truncated` says
       which number is which. A digest that quietly reported 500 when
       40,000 happened would be the most reassuring possible lie. */
    const rows = Array.from({ length: 500 }, () => row());
    const d = digest.buildDigest(rows, { total: 40000, windowHours: 24 });
    assert.equal(d.total, 40000);
    assert.equal(d.read, 500);
    assert.equal(d.truncated, true);

    const text = digest.digestText(d);
    assert.match(text, /40000 failed requests/, "the body does not say how many really failed");
    assert.match(text, /Showing the 500 most recent/, "the body does not say that it is truncated");
    assert.match(digest.digestSubject(d), /40000 failure/, "the subject reports the truncated count");

    /* AND AN UNTRUNCATED DIGEST MUST NOT SAY IT IS TRUNCATED, or the
       warning means nothing. */
    const whole = digest.buildDigest([row()], { total: 1 });
    assert.equal(whole.truncated, false);
    assert.ok(!digest.digestText(whole).includes("Showing the"), "an untruncated digest claims to be truncated");
  });

  await test("LOUDEST FIRST, and the most recent occurrence is the one quoted", () => {
    /* `billing` is FIRST in the rows and SMALLER, so insertion order and
       count order disagree — without which "loudest first" would be
       satisfied by not sorting at all. */
    const rows = [
      row({ stage: "billing", message: "newest", occurred_at: "2026-09-17T10:00:00.000Z" }),
      row({ stage: "summarise" }),
      row({ stage: "summarise" }),
      row({ stage: "summarise" }),
      row({ stage: "billing", message: "older", occurred_at: "2026-09-17T08:00:00.000Z" }),
    ];
    const d = digest.buildDigest(rows, { total: 5 });
    assert.equal(d.groups[0].stage, "summarise", "the bigger group is not first");
    const billing = d.groups.find((g) => g.stage === "billing");
    /* The read is newest-first, so the first row seen for a group is
       its most recent — kept rather than overwritten by the older one
       that follows. */
    assert.equal(billing.message, "newest", "the group quotes an older occurrence than the one it timestamps");
    assert.equal(billing.latest, "2026-09-17T10:00:00.000Z");
  });

  await test("A QUIET DAY PRODUCES NO GROUPS, which is what makes silence the healthy signal", () => {
    const d = digest.buildDigest([], { total: 0 });
    assert.deepEqual(d.groups, []);
    assert.equal(d.total, 0);
  });

  await test("A PROVIDER MESSAGE IS EXCERPTED, so one runaway error cannot be the whole email", () => {
    const long = "x".repeat(5000);
    const d = digest.buildDigest([row({ message: long })], { total: 1 });
    assert.equal(d.groups[0].message.length, digest.MESSAGE_EXCERPT_CHARS);
    assert.ok(digest.MESSAGE_EXCERPT_CHARS > 0 && digest.MESSAGE_EXCERPT_CHARS < 2000, "the excerpt is not an excerpt");
  });

  /* ---------- 4. the endpoint's refusals and its orderings ---------- */

  await test("NO SECRET IS THE OFF STATE, and a wrong one is not told apart from a missing one", () => {
    /* The flag IS the configuration, the arrangement all three Stripe
       functions use: there is no boolean to drift out of step with
       whether the secret is set.

       AND THE TWO 401s ARE IDENTICAL. An endpoint answering "that
       secret exists but is wrong" differently from "you sent none" is
       one that can be probed — the same rule as not-found versus
       not-yours, on an endpoint that reads a table no client may read. */
    const src = read("supabase/functions/error-digest/index.ts");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    assert.match(code, /ERROR_DIGEST_SECRET/, "the digest is not gated on a secret at all");
    assert.match(code, /digest_disabled/, "a missing secret does not refuse");
    const unauth = code.match(/code:\s*"unauthenticated"/g) || [];
    assert.equal(unauth.length, 1, "there is more than one unauthenticated answer, so the two cases can be told apart");
    assert.match(code, /!bearer \|\| bearer !== secret/, "a missing bearer and a wrong bearer are handled separately");
  });

  await test("THE SERVICE ROLE KEY IS NOT WHAT AUTHENTICATES THE JOB", () => {
    /* pg_net stores each outbound request — headers included — in
       net.http_request_queue until its TTL expires, so whatever
       authenticates the cron job sits at rest in a database table for
       hours. The sweep secret rule, one job over. Asserted on the
       MIGRATION, because that is where the header is written. */
    const sql = read("supabase/migrations/0022_function_errors.sql");
    assert.match(sql, /error_digest_secret/, "the cron job does not read a dedicated secret");
    assert.ok(
      !/service_role_key|SUPABASE_SERVICE_ROLE_KEY/.test(sql),
      "the migration names the service role key, which would put a full-database credential in pg_net's queue table"
    );
  });

  await test("THE PURGE RUNS BEFORE THE SEND, and on a quiet day too", () => {
    /* Nothing else reads this table, so nothing else would ever tidy
       it — CLAUDE.md's rule that anything pruning on its own schedule
       has to clean up after itself. A purge placed after the send would
       be skipped on exactly the two days it matters: a quiet one (no
       email) and a broken-mailer one (an early return). */
    const src = read("supabase/functions/error-digest/index.ts");
    const body = src.slice(src.indexOf("export async function handle"));
    const purgeAt = body.indexOf('stage = "purge"');
    const quietAt = body.indexOf("nothing_to_report");
    const sendAt = body.indexOf('stage = "send"');
    assert.ok(purgeAt > 0 && quietAt > 0 && sendAt > 0, "one of the three stages is missing");
    assert.ok(purgeAt < quietAt, "a quiet day returns before the purge, so a quiet week never tidies anything");
    assert.ok(purgeAt < sendAt, "the purge is after the send, so a mail failure skips it");
  });

  await test("A FAILED READ IS NOT A QUIET DAY", () => {
    /* The rule this whole codebase keeps relearning: absence must be
       proven, never inferred from a failed request. A read error
       answered `ok` would make a broken digest indistinguishable from
       a healthy morning — for as long as nobody checked. */
    const src = read("supabase/functions/error-digest/index.ts");
    const body = src.slice(src.indexOf('stage = "read"'), src.indexOf('stage = "count"'));
    assert.match(body, /if \(readErr\)/, "a read error is not handled at all");
    assert.match(body, /ok: false/, "a read error does not refuse");
    assert.ok(!/nothing_to_report/.test(body), "a read error is answered as a quiet day");
  });

  await test("A BUILT DIGEST WITH NO MAILER IS ITS OWN OUTCOME, never a success", () => {
    /* A cron run reporting ok over an unconfigured mailer is how a
       digest is believed to be arriving for a month. Three outcomes
       again: sent, nothing to send, and could not send. */
    const src = read("supabase/functions/error-digest/index.ts");
    assert.match(src, /mail_not_configured/, "an unconfigured mailer is not reported");
    assert.match(src, /mail_failed/, "a Resend failure is not reported");
    const codes = ["sent", "nothing_to_report", "mail_not_configured", "mail_failed"];
    for (const c of codes) assert.ok(src.includes(c), `the outcome ${c} does not exist`);
  });

  await test("RESEND IS THE ONLY HOST IT TALKS TO, and the body it sends is the digest's own", () => {
    const src = read("supabase/functions/error-digest/index.ts");
    const hosts = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    assert.deepEqual([...new Set(hosts)], ["api.resend.com"], `it reaches other hosts: ${[...new Set(hosts)].join(", ")}`);
    assert.match(src, /subject: digestSubject\(digest\)/, "the subject is not the digest's");
    assert.match(src, /text: digestText\(digest\)/, "the body is not the digest's");
    /* NO HTML, deliberately: this is read on a phone at seven in the
       morning and the content is provider messages and JSON. */
    assert.ok(!/\bhtml:/.test(src), "the digest sends HTML, which the wording decision rules out");
  });

  /* ---------- 5. the migration's own claims ---------- */

  await test("THE TABLE HAS NO ACCOUNT COLUMN, and the migration refuses if one is added", () => {
    /* THE DECISION THIS RESTS ON. A nullable user_id would have two
       meanings for null — "no account was known" and "this call site
       does not pass one", since none of the ~87 call sites does — which
       is the confusion `fetchNote`'s three outcomes exist to refuse, in
       a data column where nothing downstream could tell them apart.

       Adding one later means covering it in delete_my_account_data()
       and changing both published documents, so the migration's own
       self-check is where somebody finds that out. */
    const sql = read("supabase/migrations/0022_function_errors.sql");
    const create = sql.slice(sql.indexOf("create table if not exists public.function_errors"), sql.indexOf("alter table public.function_errors"));
    assert.ok(!/user_id/.test(create), "the table has a user_id column after all");
    assert.match(sql, /function_errors' and column_name = 'user_id'/, "nothing refuses if a user_id column is added");
    assert.match(sql, /0022 FAILED: function_errors has a user_id column/, "the refusal does not say what has to change");
  });

  await test("NO CLIENT ROLE MAY READ OR WRITE IT, insert included", () => {
    /* The mirror image of 0010 rather than a copy: a client has no
       business writing here, because every row comes from a function's
       own failure path through the service-role client. So unlike
       client_errors, INSERT is refused too. */
    const sql = read("supabase/migrations/0022_function_errors.sql");
    assert.match(sql, /revoke all on public\.function_errors from anon, authenticated;/, "the platform's default grants are not cleared");
    assert.ok(!/grant \w+ on public\.function_errors/.test(sql), "something is granted on function_errors");
    assert.match(sql, /'public\.function_errors', 'insert'/, "the self-check does not verify that insert is refused");
    assert.match(sql, /enable row level security/, "RLS is not enabled");
  });

  await test("IT WIDENS, so its own header says it goes before the deploy", () => {
    /* 0003/0004's direction, not 0008's. A function deployed first has
       every insert rejected with "relation does not exist" — logged,
       harmless to the request, and the digest reports nothing for a
       week while looking healthy. */
    const sql = read("supabase/migrations/0022_function_errors.sql");
    assert.match(sql, /WIDENS/, "the migration does not say which direction it goes");
    assert.match(sql, /BEFORE the deploy/i, "the migration does not say when to apply it");
  });

  await test("THE RETENTION PERIOD IS ONE CONSTANT, read by the purge and quoted in the comment", () => {
    /* The mirror rule: a period that appears twice is one that drifts,
       and here the two copies would be the code that deletes and the
       comment that claims. */
    const { FUNCTION_ERROR_RETENTION_DAYS } = recorder;
    assert.equal(typeof FUNCTION_ERROR_RETENTION_DAYS, "number");
    assert.ok(FUNCTION_ERROR_RETENTION_DAYS >= 7, "a week is the least that is useful for a daily digest");
    const src = read("supabase/functions/error-digest/index.ts");
    assert.match(src, /FUNCTION_ERROR_RETENTION_DAYS \* 86400_000/, "the purge does not use the shared constant");
    const sql = read("supabase/migrations/0022_function_errors.sql");
    assert.match(sql, new RegExp(`Purged after ${FUNCTION_ERROR_RETENTION_DAYS} days`), "the table comment names a different retention period from the code");
  });

  /* ---------- 6. the deploy names it ---------- */

  /* ---------- must-report codes ---------- */

  await test("A CONFIGURATION FAILURE IS NOT BURIED UNDER A NOISY TRANSIENT ONE", () => {
    /* THE ORDERING IS THE WHOLE PROBLEM. The digest is sorted loudest
       first, which is right for the usual case and exactly wrong for
       these two: one `stripe_permission_denied` sinks below forty
       upstream 500s, and it is the single line that means somebody has
       to go and change a setting. */
    const noisy = Array.from({ length: 40 }, () =>
      row({ fn: "ai-text", stage: "provider", name: "Error", detail: { status: 500 } })
    );
    const one = row({
      fn: "stripe-webhook",
      stage: "refund_charge_read",
      name: "Error",
      detail: { id: "evt_1", code: "stripe_permission_denied", status: 403 },
    });
    const d = digest.buildDigest([...noisy, one], { total: 41, windowHours: 24 });

    assert.equal(d.groups.length, 2);
    assert.equal(d.groups[0].mustReport, "stripe_permission_denied", "the 1x group is first, above the 40x one");
    assert.equal(d.groups[0].count, 1);
    assert.equal(d.groups[1].count, 40, "and the noisy group is still there, not displaced");

    /* THE CONTROL: without the code, count alone decides — otherwise
       this test cannot tell the new ordering from the old one. */
    const plain = digest.buildDigest([...noisy, row({ fn: "stripe-webhook", stage: "refund_charge_read" })], { total: 41 });
    assert.equal(plain.groups[0].count, 40, "with no must-report code the loudest group leads");
  });

  await test("the code is read from detail, never from the message text", () => {
    /* A message quotes ids, statuses and timestamps, so a substring
       match on it would be a guess that fires on a provider echoing the
       words back. Both fields the endpoints really use are read — `code`
       and `reason` — and nothing else is. */
    assert.equal(digest.mustReportCode({ detail: { code: "stripe_permission_denied" } }), "stripe_permission_denied");
    assert.equal(digest.mustReportCode({ detail: { reason: "not_an_invoice" } }), "not_an_invoice");
    assert.equal(digest.mustReportCode({ detail: { code: "upstream_unavailable" } }), "", "an ordinary code is not flagged");
    assert.equal(
      digest.mustReportCode({ message: "stripe_permission_denied", detail: null }),
      "",
      "the message is not searched"
    );
    assert.equal(digest.mustReportCode({ detail: "stripe_permission_denied" }), "", "a detail that is not an object has none");
    assert.equal(digest.mustReportCode({}), "");
  });

  await test("ANY row in a group carrying one is enough to flag the group", () => {
    /* A group is (fn, stage, name), and the same stage can fail for a
       transient reason forty times and a configuration reason once. The
       once is the one that matters, and the rows arrive newest-first so
       it can be anywhere in the group. */
    const rows = [
      ...Array.from({ length: 5 }, () => row({ stage: "refund_charge_read", detail: { status: 500 } })),
      row({ stage: "refund_charge_read", detail: { code: "stripe_permission_denied" } }),
    ];
    const d = digest.buildDigest(rows, { total: 6 });
    assert.equal(d.groups.length, 1, "same key, so one group");
    assert.equal(d.groups[0].mustReport, "stripe_permission_denied");
  });

  await test("the subject names it, and the body says it will not clear itself", () => {
    const d = digest.buildDigest([row({ detail: { reason: "not_an_invoice" } })], { total: 1, windowHours: 24 });
    assert.match(digest.digestSubject(d), /not_an_invoice/, "the subject is what gets read without opening anything");
    const text = digest.digestText(d);
    assert.match(text, /!!/, "the group is marked in the body");
    assert.match(text, /setting to change, not a failure that will clear itself/);

    /* AND A QUIET DIGEST SAYS NONE OF IT, so the marker means something
       when it appears. */
    const quiet = digest.buildDigest([row({ detail: { status: 500 } })], { total: 1, windowHours: 24 });
    assert.doesNotMatch(digest.digestSubject(quiet), /not_an_invoice|stripe_permission_denied/);
    assert.doesNotMatch(digest.digestText(quiet), /setting to change/);
  });

  await test("EVERY MUST-REPORT CODE IS ONE THE FUNCTIONS REALLY PRODUCE", () => {
    /* DERIVED, so the list cannot drift into a vocabulary nothing
       emits. A code nobody returns is a flag that can never fire, which
       is the vacuous-pass shape wearing a constant. */
    const sources = ["_shared/stripe.ts", "stripe-webhook/index.ts", "billing-checkout/index.ts", "billing-portal/index.ts"]
      .map((f) => path.join(rootDir, "supabase/functions", f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    assert.ok(sources.length > 0, "no function sources were read — this guard checked nothing");
    for (const code of digest.MUST_REPORT_CODES) {
      assert.ok(sources.includes(`"${code}"`), `${code} is flagged but no function produces it`);
    }
  });

  await test("STRIPE'S CODE REACHES THE TABLE, not only the HTTP response", () => {
    /* It did not. `stripeFailureCode(X)` was computed for the response
       body and the matching `logFailure` recorded the raw error, so
       `stripe_permission_denied` never entered function_errors and the
       flag above could never have fired on it. Paired rather than
       counted: every response that carries the code must have a logged
       twin over the SAME variable. */
    const src = fs.readFileSync(path.join(rootDir, "supabase/functions/stripe-webhook/index.ts"), "utf8");
    const answered = [...src.matchAll(/jsonResponse\(\{ ok: false, code: stripeFailureCode\((\w+)\)/g)].map((m) => m[1]);
    assert.ok(answered.length > 0, "no stripeFailureCode response was found — this guard is reading the wrong file");
    const logged = new Set([...src.matchAll(/logFailure\([^;]*?code: stripeFailureCode\((\w+)\)/g)].map((m) => m[1]));
    const missing = answered.filter((v) => !logged.has(v));
    assert.deepEqual(
      missing,
      [],
      `these answer with a stripe failure code that never reaches function_errors: ${missing.join(", ")}`
    );
  });

  await test("THE DEPLOY IS DERIVED, so a new function is deployed without anybody adding it", () => {
    /* `deploy-functions.yml` finds every function's index.ts rather
       than naming functions, which is what makes this new one ship.
       That derivation is the fix for the enumeration that once left
       ai-text undeployed for a batch — asserted here because a new
       function is exactly when a regression in it would bite.

       THE CLAIM IS ABOUT WHAT IS DEPLOYED, NOT ABOUT WHICH NAMES
       APPEAR. An earlier version of this asserted the workflow does not
       mention `error-digest` at all, and that was a proxy: the function
       has to be named in the case label that decides JWT verification,
       because it is called by pg_net and cannot be handed a JWT. Which
       functions get that flag is derived and asserted in
       test-ai-notes.mjs, from each function's own source. What matters
       here is that no `functions deploy` command names a literal
       function, so the SET being deployed is still the directory's. */
    const yml = read(".github/workflows/deploy-functions.yml");
    assert.match(yml, /-name index\.ts/, "the deploy no longer finds functions by looking for index.ts");
    assert.match(yml, /for fn in \$\{\{ steps\.functions\.outputs\.functions \}\}/, "the deploy loop does not iterate the derived list");
    const named = [...yml.matchAll(/functions deploy\s+("?)([a-z][a-z0-9-]+)\1/g)].map((m) => m[2]);
    assert.deepEqual(named, [], `the deploy names functions literally: ${named.join(", ")}`);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

await run();

/* Tests for the published documents, the deletion flow, and consent.

   The governing rule for all of this was: every claim must describe what
   the code actually does. These assertions are how that survives the
   next change — a document is the one artifact where being quietly wrong
   costs the most and shows the least.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deleteAccount,
  removeOwnAudio,
  confirmationMatches,
  DELETE_CONFIRMATION_PHRASE,
  LECTURE_AUDIO_BUCKET,
} from "../src/accountDeletion.js";
import { PRIVACY_URL, DELETE_ACCOUNT_URL, PRIVACY_EMAIL, SUPPORT_EMAIL, SITE_URL } from "../src/legalLinks.js";
import { CONSENT_TEXT, AI_CONSENT_VERSION } from "../src/aiNotesLogic.js";
import { RESULT_RETENTION_DAYS, FAILED_RESULT_RETENTION_DAYS } from "../src/aiNotesRetention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const page = (f) => fs.readFileSync(path.join(rootDir, "public", f), "utf8");
/* Prose assertions run against the rendered text with whitespace
   collapsed: HTML wraps lines wherever it likes, and a sentence that
   happens to break across two lines is still the same sentence. */
const prose = (f) =>
  page(f)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&rarr;/g, "->")
    .replace(/\s+/g, " ")
    .trim();

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

/* A Supabase stand-in that records the order things happened in, which
   is the property that actually matters here. */
function fakeClient({ listResult, removeError, rpcError, removeDenied } = {}) {
  const calls = [];
  return {
    calls,
    storage: {
      from(bucket) {
        calls.push(`storage.from:${bucket}`);
        return {
          async list(prefix) {
            calls.push(`list:${prefix}`);
            return listResult || { data: [], error: null };
          },
          async remove(paths) {
            calls.push(`remove:${paths.join(",")}`);
            if (removeError) return { data: null, error: removeError };
            // The real client returns the objects it actually removed.
            return { data: removeDenied ? [] : paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
    async rpc(name) {
      calls.push(`rpc:${name}`);
      return { error: rpcError || null };
    },
  };
}

const SESSION = { user: { id: "user-1", email: "a@b.com" } };

async function run() {
  /* ---------- the deletion flow ---------- */

  await test("the audio is removed BEFORE the account, because the RPC invalidates the session", () => {
    // delete_my_account() ends by deleting the auth.users row, so every
    // authenticated call after it fails. Anything needing the session has
    // to happen first. This ordering IS the design.
    const c = fakeClient({ listResult: { data: [{ name: "k1.webm" }, { name: "k2.webm" }], error: null } });
    return deleteAccount({ supabaseClient: c, session: SESSION }).then(() => {
      const removeAt = c.calls.findIndex((x) => x.startsWith("remove:"));
      const rpcAt = c.calls.findIndex((x) => x === "rpc:delete_my_account");
      assert.ok(removeAt > -1, "the audio was never removed");
      assert.ok(rpcAt > -1, "the deletion RPC was never called");
      assert.ok(removeAt < rpcAt, "the RPC ran before the audio removal, so the removal would have failed");
    });
  });

  await test("only the caller's own folder is listed and removed", async () => {
    const c = fakeClient({ listResult: { data: [{ name: "k1.webm" }], error: null } });
    await deleteAccount({ supabaseClient: c, session: SESSION });
    assert.ok(c.calls.includes(`storage.from:${LECTURE_AUDIO_BUCKET}`));
    assert.ok(c.calls.includes("list:user-1"), "listed something other than the caller's folder");
    assert.ok(c.calls.includes("remove:user-1/k1.webm"), "removed a path outside the caller's folder");
  });

  await test("an empty audio folder still deletes the account", async () => {
    const c = fakeClient({ listResult: { data: [], error: null } });
    const out = await deleteAccount({ supabaseClient: c, session: SESSION });
    assert.equal(out.audioRemoved, 0);
    assert.ok(c.calls.includes("rpc:delete_my_account"));
  });

  await test("audio that can't be removed does not abort the deletion", async () => {
    // Audio is transient and swept by age anyway. A user who asked to be
    // deleted and got an error because of a leftover temp file has been
    // failed twice.
    const c = fakeClient({ listResult: { data: [{ name: "k1.webm" }], error: null }, removeError: { message: "nope" } });
    const out = await deleteAccount({ supabaseClient: c, session: SESSION });
    assert.equal(out.audioFailed, true);
    assert.ok(c.calls.includes("rpc:delete_my_account"), "a storage failure stopped the account being deleted");
  });

  await test("a failed RPC throws, because the account still exists", async () => {
    const c = fakeClient({ rpcError: { message: "boom" } });
    await assert.rejects(() => deleteAccount({ supabaseClient: c, session: SESSION }), /boom/);
  });

  await test("deleting without a session is refused rather than silently doing nothing", async () => {
    await assert.rejects(() => deleteAccount({ supabaseClient: fakeClient(), session: null }), /signed in/i);
    await assert.rejects(() => deleteAccount({ supabaseClient: null, session: SESSION }), /server connection/i);
  });

  await test("a storage policy that silently denies the delete is reported, not counted as success", async () => {
    // Supabase returns an empty result rather than an error when an RLS
    // policy denies a storage delete. Before 0004 added the delete
    // policy, that is exactly what would have happened -- and reporting
    // success would have made the deletion page's promise false.
    const c = fakeClient({ listResult: { data: [{ name: "k1.webm" }], error: null }, removeDenied: true });
    const out = await deleteAccount({ supabaseClient: c, session: SESSION });
    assert.equal(out.audioFailed, true, "a denied delete was reported as a successful one");
    assert.ok(c.calls.includes("rpc:delete_my_account"), "the account should still be deleted");
  });

  await test("a listing failure is reported but not thrown", async () => {
    const r = await removeOwnAudio({ supabaseClient: fakeClient({ listResult: { data: null, error: { message: "x" } } }), userId: "user-1" });
    assert.deepEqual(r, { removed: 0, failed: true });
  });

  await test("the confirmation is deliberate but not a spelling test", () => {
    assert.equal(confirmationMatches(DELETE_CONFIRMATION_PHRASE), true);
    assert.equal(confirmationMatches("  delete  "), true, "whitespace and case should not block a deliberate user");
    assert.equal(confirmationMatches("delete my account"), false);
    assert.equal(confirmationMatches(""), false);
    assert.equal(confirmationMatches(null), false);
  });

  await test("the local wipe happens only after the server confirms", () => {
    // A failed deletion must leave the user with their planner intact,
    // not an empty app and an account that still exists.
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    const body = src.slice(src.indexOf("const handleDeleteAccount"), src.indexOf("/* ---- automatic syncing ----"));
    const awaitAt = body.indexOf("await deleteAccount(");
    const wipeAt = body.indexOf("store.del(STORAGE_KEY)");
    assert.ok(awaitAt > -1 && wipeAt > -1, "couldn't find both steps");
    assert.ok(awaitAt < wipeAt, "the device is wiped before the server confirms the deletion");
  });

  /* ---------- the published documents ---------- */

  for (const file of ["privacy.html", "delete-account.html"]) {
    await test(`${file} is a complete static page that needs no JavaScript`, () => {
      const html = page(file);
      assert.match(html, /^<!doctype html>/i, "not a complete document");
      assert.match(html, /<title>/, "no title");
      assert.doesNotMatch(html, /<script/i, "a legal page must render with no JavaScript at all");
      /* No external hosts: an off-site resource would break the page
         offline and leak a request from a privacy policy of all things.
         The allowed host is read from SITE_URL rather than hardcoded, so
         moving the canonical domain can't quietly widen this. */
      const allowed = new Set([new URL(SITE_URL).host, "www.oaic.gov.au"]);
      const hosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
      const external = [...new Set(hosts)].filter((h) => !allowed.has(h));
      assert.deepEqual(external, [], `links to ${external.join(", ")} — an external resource leaks a request`);
    });

    await test(`${file} carries no unfilled placeholder`, () => {
      const html = page(file);
      for (const token of ["TODO", "TBD", "PLACEHOLDER", "__", "example.com", "netlify"]) {
        assert.ok(!html.toLowerCase().includes(token.toLowerCase()), `${file} still contains "${token}"`);
      }
    });
  }

  await test("the canonical URLs are the extensionless form Pages actually serves", () => {
    assert.equal(PRIVACY_URL, `${SITE_URL}/privacy`);
    assert.equal(DELETE_ACCOUNT_URL, `${SITE_URL}/delete-account`);
  });

  await test("the documents link to the exact URLs the app and the store listings use", () => {
    /* Compares FULL URLs, not hosts.

       The earlier version of this compared hosts only, which meant it
       passed while the thing it guarded was half-broken: legalLinks.js
       could point at /privacy while the documents still cross-linked
       /privacy.html, and nothing would notice. That is the third guard on
       this project to have been weaker than it looked — see the rule in
       CLAUDE.md about deriving a guard from its source of truth rather
       than restating it. */
    const canonical = new Set([`${SITE_URL}/`, PRIVACY_URL, DELETE_ACCOUNT_URL]);
    for (const file of ["privacy.html", "delete-account.html"]) {
      const urls = [...new Set([...page(file).matchAll(/https?:\/\/[^"'\s<>]+/g)].map((m) => m[0]))]
        .filter((u) => u.includes("uniplannerapp.com"));
      for (const u of urls) {
        assert.ok(
          canonical.has(u),
          `${file} links to ${u}, which is not one of the canonical URLs (${[...canonical].join(", ")})`
        );
      }
    }
    assert.ok(page("privacy.html").includes(DELETE_ACCOUNT_URL), "the policy doesn't link to the deletion page");
    assert.ok(page("delete-account.html").includes(PRIVACY_URL), "the deletion page doesn't link to the policy");
  });

  await test("both documents give the contact address", () => {
    for (const file of ["privacy.html", "delete-account.html"]) {
      assert.ok(page(file).includes(PRIVACY_EMAIL), `${file} has no privacy contact`);
    }
    assert.ok(page("delete-account.html").includes(SUPPORT_EMAIL), "the deletion page should offer support too");
  });

  await test("the policy states the retention periods the server actually enforces", () => {
    const text = prose("privacy.html");
    assert.ok(text.includes(`${RESULT_RETENTION_DAYS} days`), "the 7-day period is missing or wrong");
    assert.ok(text.includes(`${FAILED_RESULT_RETENTION_DAYS} days`), "the 30-day period is missing or wrong");
    /* Checking the numbers appear isn't enough -- both already appear
       twice, so one of them could drift and the other occurrence would
       keep the assertion green. Every day-count in the document must be
       one the server actually enforces. */
    const allowed = new Set([String(RESULT_RETENTION_DAYS), String(FAILED_RESULT_RETENTION_DAYS)]);
    const quoted = [...text.matchAll(/(\d+)\s+days?/g)].map((m) => m[1]);
    assert.ok(quoted.length > 0, "the policy quotes no retention period at all");
    for (const n of quoted) {
      assert.ok(allowed.has(n), `the policy promises "${n} days", which the server does not enforce`);
    }
  });

  await test("the policy names the region rather than implying it vaguely", () => {
    const text = prose("privacy.html");
    assert.match(text, /Sydney/);
    assert.match(text, /ap-southeast-2/);
  });

  await test("the policy separates where data is stored from where it is processed", () => {
    // The distinction privacy documents most often get quietly wrong.
    // Storage is in Australia; audio and transcripts are processed in the
    // United States, and saying only the first would be misleading.
    const text = prose("privacy.html");
    assert.match(text, /United States/, "the overseas processing is not disclosed");
    assert.match(text, /Groq/, "the transcription provider is not named");
    assert.match(text, /OpenAI/, "the summarisation provider is not named");
  });

  await test("the policy states the three uncomfortable things plainly", () => {
    const text = prose("privacy.html");
    assert.match(text, /second copy of every transcript/i, "the server-side duplicate is not disclosed");
    assert.match(text, /not end-to-end encrypted/i, "the lack of end-to-end encryption is not disclosed");
    assert.match(text, /does not check passwords/i, "demo mode's missing password check is not disclosed");
  });

  await test("the policy does not claim analytics it would have to be running to deny", () => {
    // Safe to state only because there is genuinely none in the bundle;
    // the assertion is that the claim and the code stay in step.
    const text = prose("privacy.html");
    assert.match(text, /No analytics and no tracking/i);
    const bundle = fs.readFileSync(path.join(rootDir, "dist-web/app.js"), "utf8");
    for (const tracker of ["google-analytics", "googletagmanager", "plausible.io", "posthog", "mixpanel", "sentry.io", "hotjar"]) {
      assert.ok(!bundle.includes(tracker), `the policy denies tracking but the bundle contains ${tracker}`);
    }
  });

  await test("the deletion page tells someone who can't sign in what to do", () => {
    // Google Play requires this to be answerable without a login.
    const text = prose("delete-account.html");
    assert.match(text, /cannot sign in/i);
    assert.ok(page("delete-account.html").includes(PRIVACY_EMAIL));
    assert.match(text, /30 days/, "no timeframe is given for an emailed request");
  });

  await test("the deletion page says what is NOT deleted, rather than only what is", () => {
    const text = prose("delete-account.html");
    assert.match(text, /Backup files you downloaded/i);
    assert.match(text, /Other devices/i);
    assert.match(text, /logs/i);
  });

  await test("the deletion page's list matches what the code deletes", () => {
    // Every row here must correspond to something actually removed by
    // delete_my_account_data(), the cascade, or the client-side audio step.
    const text = prose("delete-account.html");
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0002_account_deletion.sql"), "utf8");
    for (const table of ["ai_notes_requests", "ai_usage", "profiles", "planner_data"]) {
      assert.ok(sql.includes(table), `0002 no longer deletes ${table}, but the page still implies it`);
    }
    assert.match(text, /lecture audio still being processed/i, "the audio step isn't listed");
    assert.match(sql, /delete from auth\.users/, "the auth user is no longer deleted");
  });

  /* ---------- consent ---------- */

  await test("consent v3 links the published policy and names where the server is", () => {
    assert.equal(AI_CONSENT_VERSION, 3);
    assert.equal(CONSENT_TEXT.privacyUrl, PRIVACY_URL);
    const all = CONSENT_TEXT.bullets.join(" ");
    assert.match(all, /Sydney/, "the consent text doesn't say where the server is");
    assert.match(all, /deleted as soon as it has been transcribed/, "the audio promise changed");
    assert.match(all, /overseas/, "the consent text doesn't mention overseas processing");
  });

  await test("the consent retention numbers are read from the code, not typed", () => {
    const all = CONSENT_TEXT.bullets.join(" ");
    assert.ok(all.includes(`${RESULT_RETENTION_DAYS} days`));
    assert.ok(all.includes(`${FAILED_RESULT_RETENTION_DAYS} days`));
    const src = fs.readFileSync(path.join(rootDir, "src/aiNotesLogic.js"), "utf8");
    assert.match(src, /\$\{RESULT_RETENTION_DAYS\}/, "the retention number is hardcoded in the consent text");
  });

  /* ---------- the storage policy the flow depends on ---------- */

  await test("the bucket has a delete policy, or the deletion flow silently does nothing", () => {
    // 0001 deliberately shipped insert/select/update and NO delete. Without
    // 0004 adding one, removeOwnAudio() fails and "deleted immediately"
    // in the page would be false.
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0004_deletion_and_retention.sql"), "utf8");
    assert.match(sql, /lecture_audio_own_folder_delete/, "the delete policy is gone");
    assert.match(sql, /for delete to authenticated/);
    assert.match(sql, /auth\.uid\(\)::text/, "the delete policy isn't scoped to the caller's own folder");
  });

  await test("the scheduled sweep requires a dedicated secret, not a user token or the service role key", () => {
    // The sweep runs unscoped by design, so anything that can trigger it
    // is deleting other people's rows.
    const src = fs.readFileSync(path.join(rootDir, "supabase/functions/ai-notes/index.ts"), "utf8");
    const branch = src.slice(src.indexOf("if (sweepOnly)"), src.indexOf("// 3. Tier check"));
    assert.ok(branch.length > 0, "couldn't find the sweep branch");
    assert.match(branch, /AI_NOTES_SWEEP_SECRET/, "the sweep isn't gated on a secret");
    assert.match(branch, /jwt !== sweepSecret/, "the sweep doesn't compare the secret");
    /* Deliberately NOT the service role key: pg_net stores outbound
       request headers in net.http_request_queue, so whatever
       authenticates this job sits at rest in a database table. A
       full-database credential does not belong there. */
    assert.doesNotMatch(branch, /SUPABASE_SERVICE_ROLE_KEY/, "the sweep authenticates with the service role key");
    assert.doesNotMatch(branch, /console\.log\([^)]*[sS]ecret/, "the secret must never be logged");
  });

  await test("npm test still runs the legal tests", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.test, /test-legal\.mjs/, "the legal tests were dropped from `npm test`");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();

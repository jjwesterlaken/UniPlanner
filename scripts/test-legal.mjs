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

  /* ---------- the documents against the schema ----------

     Both published documents enumerate where a student's data lives, so
     a table added without touching them makes them quietly wrong — which
     is the failure a legal document shows least and costs most.

     The list of tables is READ FROM THE MIGRATIONS rather than typed
     here. Three times now a guard has been weaker than it looked because
     it restated the thing it was guarding (see CLAUDE.md), and a
     hardcoded list is exactly that: it would have gone on passing when
     `ai_notes` was added and the policy still described the planner as
     holding everything a student writes.

     Table names are not user-facing words, so what each one must produce
     in the documents is declared below. That declaration is the part a
     human has to think about; the enumeration is what forces them to. */

  const migrationSql = () =>
    fs
      .readdirSync(path.join(rootDir, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => fs.readFileSync(path.join(rootDir, "supabase/migrations", f), "utf8"))
      .join("\n");

  /* Every table the migrations create in `public`. `planner_data` is
     documented in SUPABASE-SETUP.md rather than created by a migration,
     so it is named here for the same reason it is in the setup doc:
     nothing in this repo creates it. */
  const schemaTables = () => {
    const found = new Set(["planner_data"]);
    for (const m of migrationSql().matchAll(/create table if not exists public\.(\w+)/g)) found.add(m[1]);
    for (const m of migrationSql().matchAll(/create table public\.(\w+)/g)) found.add(m[1]);
    return [...found].sort();
  };

  /* What each table must be visible as, in words a student would use.
     A table whose contents a student never sees would still need a line
     here saying so — "nothing, and why" is a decision, silence isn't. */
  const DOCUMENTED_AS = {
    planner_data: { privacy: /your planner syncs so it follows you between devices/i, deletion: /Your planner/i },
    profiles: { privacy: /plan level/i, deletion: /plan level and account record/i },
    ai_usage: { privacy: /monthly AI allowance/i, deletion: /record of AI minutes used/i },
    ai_notes_requests: {
      privacy: /Our copy of the transcript and generated notes/i,
      deletion: /temporary copy of any AI transcripts/i,
    },
    ai_notes: {
      privacy: /full text of a\s+saved AI lecture note/i,
      deletion: /saved AI lecture notes/i,
    },
  };

  await test("every table in the schema is accounted for in both published documents", () => {
    const privacy = prose("privacy.html");
    const deletion = prose("delete-account.html");
    for (const table of schemaTables()) {
      const entry = DOCUMENTED_AS[table];
      assert.ok(
        entry,
        `public.${table} exists in the schema but no document text is declared for it. ` +
          "Both published documents enumerate where a student's data lives, so decide what they say " +
          "about this table and add it here."
      );
      assert.match(privacy, entry.privacy, `the privacy policy no longer describes public.${table}`);
      assert.match(deletion, entry.deletion, `the deletion page no longer lists public.${table}`);
    }
  });

  /* ---------- the same question, on the device ----------

     A store on the user's device is the same class of change as a new
     table: somewhere their content lives that the documents have to
     account for. The IndexedDB note cache was exactly this and neither
     document covered it.

     Derived the same way, from the naming convention every store here
     already follows: `uni-planner-*`. Each name found in src/ or public/
     must be declared below with what it holds, and either a document
     phrase that covers it or an explicit reason it needs none.

     BE HONEST ABOUT THE HOLE: this catches a store named to the
     convention. Someone who invents `myNotesDB` slips past it, and the
     IndexedDB check below is the only backstop — it counts databases,
     not names. That is a partial guard, and a partial guard that says so
     is worth more than a thorough-looking one that doesn't. */

  const clientSources = () =>
    ["src", "public"].flatMap((dir) =>
      fs
        .readdirSync(path.join(rootDir, dir))
        .filter((f) => /\.(js|jsx)$/.test(f))
        .map((f) => ({ file: `${dir}/${f}`, text: fs.readFileSync(path.join(rootDir, dir, f), "utf8") }))
    );

  const storeNames = () => {
    const found = new Set();
    for (const { text } of clientSources()) {
      /* Comments are stripped first. sw.js quotes the OLD hardcoded cache
         name in its warning comment, and a guard that counted that would
         be reporting history as a live store. */
      const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      for (const m of code.matchAll(/"(uni-planner-[^"]*)"/g)) found.add(m[1]);
    }
    return [...found].sort();
  };

  /* `documented` is a phrase that must appear in the named document.
     `noUserContent` is the other legitimate answer, and it has to give a
     reason — "it holds nothing of theirs" is a decision, silence isn't. */
  const CLIENT_STORES = {
    "uni-planner-v1": { documented: { privacy: /A copy of your planner/i, deletion: /copy of your planner stored on the device/i } },
    "uni-planner-notes": {
      documented: {
        privacy: /Lecture notes you have opened, kept for offline reading/i,
        deletion: /Lecture notes stored on that device for offline reading/i,
      },
    },
    "uni-planner-demo-users": { noUserContent: "demo sign-in bookkeeping; the policy covers demo mode wholesale" },
    "uni-planner-demo-session": { noUserContent: "demo sign-in bookkeeping; the policy covers demo mode wholesale" },
    "uni-planner-demo-cloud": { documented: { privacy: /stores everything locally and syncs nothing/i, deletion: /local copy/i } },
    "uni-planner-device-id": { noUserContent: "a random id distinguishing devices during merge; not derived from the device or the user" },
    "uni-planner-audio-input": {
      noUserContent:
        "which microphone to record from, by the browser's own device id and its label. Device-local by design — it is never synced and never uploaded — and holds none of the student's work; nothing recorded, transcribed or written passes through it",
    },
    "uni-planner-__BUILD_ID__": { noUserContent: "the service worker's asset cache: the app's own files, none of the user's" },
  };

  await test("every store the app keeps on a device is accounted for", () => {
    const privacy = prose("privacy.html");
    const deletion = prose("delete-account.html");
    for (const name of storeNames()) {
      const entry = CLIENT_STORES[name];
      assert.ok(
        entry,
        `"${name}" is a new store on the user's device and nothing is declared for it. ` +
          "Both published documents describe what the app keeps on a device, so decide whether this " +
          "holds any of the student's content and record the answer here."
      );
      if (entry.noUserContent) {
        assert.ok(entry.noUserContent.length > 20, `"${name}" is excused without a reason`);
        continue;
      }
      assert.match(privacy, entry.documented.privacy, `the privacy policy no longer describes "${name}"`);
      assert.match(deletion, entry.documented.deletion, `the deletion page no longer describes "${name}"`);
    }
  });

  await test("there is exactly one IndexedDB database, so an unconventionally named one still shows up", () => {
    // The backstop for a store that doesn't follow the naming convention.
    // IndexedDB is the only device store big enough to hold note text, so
    // a second `open` is worth stopping on whatever it is called.
    const opens = clientSources().flatMap(({ file, text }) =>
      [...text.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/\.open\s*\(\s*DB_NAME|indexedDB\.open\s*\(/g)].map(() => file)
    );
    assert.deepEqual(
      opens,
      ["src/noteCache.js"],
      "a second IndexedDB database appeared. It is the only device store large enough to hold note " +
        "text, so decide what the published documents say about it before adding one."
    );
  });

  await test("neither document implies device content lives only in the planner copy", () => {
    /* The specific wrong sentence, which both documents used to carry:
       deleting erases "the copy of your planner on that device", full
       stop, when there is now a second store holding whole lectures. */
    const deletion = prose("delete-account.html");
    assert.match(deletion, /and the copy of any lecture notes kept there so you can read them offline/i);
    assert.match(
      prose("privacy.html"),
      /cleared when you sign out, and when you delete your account/i,
      "the policy must say the note cache is cleared, since it is and that is the strong claim"
    );
  });

  await test("the saved lecture note reads as the student's, not as the 7/30-day copy", () => {
    /* These are two different records with two genuinely different
       promises, and conflating them is the specific way this section
       could be misleading while every phrase in it is technically
       present. */
    const text = prose("privacy.html");
    assert.match(text, /stays until you delete the note or delete your\s+account/i);
    assert.match(text, /Deleting the note deletes both halves; deleting your account deletes all of it/i);
  });

  await test("the deletion page's list matches what the code deletes", () => {
    // Every row must correspond to something actually removed by
    // delete_my_account_data(), the cascade, or the client-side audio step.
    const text = prose("delete-account.html");
    const sql = migrationSql();
    for (const table of schemaTables()) {
      if (table === "planner_data") continue; // deleted dynamically, guarded in test-migrations.mjs
      assert.match(
        sql,
        new RegExp(`delete from public\\.${table} where user_id = uid`),
        `nothing deletes public.${table}, but the deletion page promises it`
      );
    }
    assert.match(text, /lecture audio still being processed/i, "the audio step isn't listed");
    assert.match(sql, /delete from auth\.users/, "the auth user is no longer deleted");
  });

  /* ---------- consent ---------- */

  await test("consent covers text features, not only lecture recording", () => {
    /* Batch 4 sends text the student already wrote to the same overseas
       summariser. That is a different promise from "we send your
       recording", and v3 would have become quietly untrue the moment any
       of those features shipped. */
    const all = CONSENT_TEXT.bullets.join(" ");
    assert.ok(AI_CONSENT_VERSION >= 4, "the consent version wasn't bumped for the text features");
    /* Asserts the CATEGORY, not a phrase -- this line used to pin "text
       is sent overseas" and correcting the wording for v6 failed the
       test that existed to keep it true, the same trap as the "your own
       writing" literal before it. What must be true: supplied material
       is named, and it goes overseas un-stored. */
    assert.match(all, /(text|photos|what you supplied).{0,80}sent overseas/i, "supplied material going overseas isn't covered");
    assert.match(all, /study cards|explanation you type/i, "the consent doesn't say what kind of text");
  });

  await test("consent v6 covers photographed pages, in the same category as text and audio", () => {
    /* The reading summariser takes photos of pages. A photo is an IMAGE
       of text, and reading "text you supply" to cover it is the
       wordsmithing the category naming exists to prevent -- so v6 must
       name photos, promise they are not stored, and the POLICY must
       agree, because a promise made in one document and absent from the
       other is the drift this file exists to catch. */
    const all = CONSENT_TEXT.bullets.join(" ");
    assert.ok(AI_CONSENT_VERSION >= 6, "photographed pages shipped without a consent bump");
    assert.match(all, /photos/i, "the consent never mentions photos");
    assert.match(all, /not stored: not in your planner and not on our server/i, "the never-stored promise is gone");

    const policy = prose("privacy.html");
    assert.match(policy, /photo/i, "the policy never mentions photos while the app sends them overseas");
  });

  await test("the policy covers text features too, or it becomes untrue when they ship", () => {
    const text = prose("privacy.html");
    assert.match(text, /text you (supply|give|paste|chose|choose)/i, "the policy still describes audio only");
    assert.match(text, /practice questions/i, "the policy doesn't name what the text is used for");
    // The old wording promised nothing left the country unless you used
    // AI LECTURE NOTES specifically. That is the clause that breaks.
    assert.doesNotMatch(text, /none of this happens unless you use the AI notes feature/i);
  });

  /* THE SEVENTH RESTATEMENT, and it was in a test rather than in code.
     This assertion used to require the literal phrase "your own
     writing" -- so widening the policy to cover text of ANY origin, the
     correction the policy needed, failed the test that existed to keep
     the policy true. A guard that pins the wording cannot survive the
     wording being wrong.

     What is actually being claimed is a CATEGORY: whatever a student
     supplies, however they came by it, is relayed and not stored. So
     that is what is asserted, and the two documents that make the
     promise are checked against each other rather than against a
     phrase typed in here. */
  await test("supplied text is described by what it is, not by who wrote it", () => {
    const text = prose("privacy.html");
    const consent = CONSENT_TEXT.bullets.join(" ");

    /* The narrow framing is now FALSE and must not come back. It was
       false before readings existed, too: a lecture recording captures
       a lecturer's copyrighted delivery, so the app has always worked
       on material the student did not write. */
    assert.doesNotMatch(text, /your own writing/i, "the policy is back to describing only what the student wrote");
    assert.doesNotMatch(consent, /writing you have already done/i, "the consent text narrowed again");

    /* The new promise, in both places. This is the one that changed
       what happens to the content, which is why consent was bumped. */
    assert.match(text, /(is )?not stored|never stored|no server-side copy/i, "the policy doesn't say supplied text isn't kept");
    assert.match(consent, /not stored/i, "the consent text doesn't say supplied text isn't kept");

    /* And the distinction that makes it meaningful: a lecture DOES have
       a server-side copy for a window. If both read the same, the
       stronger promise is not being made -- it is being blurred. */
    assert.match(text, /transcript/i);
  });

  await test("consent was bumped for the change in what happens to the content", () => {
    /* v5 covers text the student supplies of any origin. The rule for a
       bump is a change in what happens to the content -- where it goes,
       who sees it, how long it is kept -- not a change in which table
       holds it. This one qualifies twice: a new kind of material leaves
       the country, and a new promise is made about it. */
    assert.ok(AI_CONSENT_VERSION >= 5, "consent was not bumped for the supplied-text category");
  });

  await test("the consent text says a summary sits alongside the material, not instead of it", () => {
    /* The same rule the feature copy is held to in test-readings.mjs,
       applied to the document a store reviewer reads. What makes this
       defensible is that it is a private-study tool pointed at material
       the student already has. */
    const consent = CONSENT_TEXT.bullets.join(" ");
    assert.match(consent, /right to use|responsib/i, "consent doesn't put the rights question to the student");
    assert.doesNotMatch(consent, /(don't|do not) (have to|need to) read|instead of reading|skip the reading/i);
  });

  await test("consent links the published policy and names where the server is", () => {
    assert.ok(AI_CONSENT_VERSION >= 3);
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

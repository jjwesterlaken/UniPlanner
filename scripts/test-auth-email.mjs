/* test-auth-email.mjs — we find out when Supabase Auth cannot send
   email, from two directions (27 September 2026, EMAIL-SETUP.md).

   1. THE CANARY (auth-email-canary): the decisions in canary.js as a
      table, then the real handler, bundled, over a fake Auth, a fake
      Resend and a fake state row. The claims that matter are about
      SEQUENCES — one alert when it starts, silence while it holds, one
      when it recovers, a retry when the alert itself failed — so the
      handler is driven run by run against the same state.

   2. THE APP: a signup or reset whose email could not be sent reaches
      the reporter as a fixed sentence, through the REAL sync.js
      (bundled over a fake Supabase client), and the digest turns that
      report into a flagged line.

   WHAT IT CANNOT SEE: whether Auth really answers an SMTP failure with
   a 5xx (observed on 27 September as the student-facing error; not
   reproducible here), and whether pg_cron runs the job. The first is
   one run of the canary against a broken key on a scratch project; the
   second is cron.job_run_details. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-email-"));
const load = (p) => import(pathToFileURL(path.join(rootDir, p)).href);

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

const canary = await load("supabase/functions/auth-email-canary/canary.js");
const digest = await load("supabase/functions/error-digest/digest.js");
const client = await load("src/authEmailFailure.js");

/* ---------- the handler, bundled over stubs ---------- */
const stubDir = path.join(tmpDir, "stubs");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "supabase.js"), "export function createClient() { return globalThis.__FAKE_CLIENT__; }\nexport class SupabaseClient {}\n");
globalThis.Deno = { serve() {}, env: { get: () => undefined } };
const bundled = await build({
  entryPoints: [path.join(rootDir, "supabase/functions/auth-email-canary/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  plugins: [{ name: "stub", setup: (b) => b.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: path.join(stubDir, "supabase.js") })) }],
});
const handlerFile = path.join(tmpDir, "canary.mjs");
fs.writeFileSync(handlerFile, bundled.outputFiles[0].text);
const { handle } = await import(pathToFileURL(handlerFile).href);

const ENV = {
  AUTH_CANARY_SECRET: "canary-secret",
  AUTH_CANARY_EMAIL: "canary@send.uniplannerapp.com",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  RESEND_API_KEY: "re_test",
  ERROR_DIGEST_TO: "support@uniplannerapp.com",
  ERROR_DIGEST_FROM: "digest@send.uniplannerapp.com",
};

/** A world whose state row persists across runs, like the real table. */
function world({ createError = null, stateReadError = null } = {}) {
  const w = { state: null, recovers: [], alerts: [], failures: [], upserts: [] };
  w.admin = {
    auth: { admin: { createUser: async () => ({ data: {}, error: createError }) } },
    from(table) {
      assert.equal(table, "auth_email_canary", `the canary touched ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => (stateReadError ? { data: null, error: stateReadError } : { data: w.state ? { status: w.state.status, since: w.state.since } : null, error: null }) }),
        }),
        upsert: async (row) => {
          w.upserts.push(row);
          w.state = { ...row };
          return { error: null };
        },
      };
    },
  };
  return w;
}

let clock = Date.parse("2026-09-27T04:17:00Z");
async function runHour(w, { recover = 200, recoverThrows = false, resend = 200, env = ENV, secret = ENV.AUTH_CANARY_SECRET } = {}) {
  clock += 3600_000;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/auth/v1/recover")) {
      w.recovers.push({ url, init });
      if (recoverThrows) throw new Error("getaddrinfo ENOTFOUND");
      return { ok: recover < 300, status: recover, text: async () => (recover >= 500 ? '{"msg":"Error sending recovery email"}' : "") };
    }
    if (url === "https://api.resend.com/emails") {
      w.alerts.push(JSON.parse(init.body));
      return { ok: resend < 300, status: resend, text: async () => "domain is not verified" };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const req = new Request("https://fn.test/auth-email-canary", { method: "POST", headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  const res = await handle(req, {
    env: (k) => env[k],
    fetch: fetchImpl,
    now: () => new Date(clock),
    supabaseAdmin: w.admin,
    logFailure: (stage, err, extra) => w.failures.push({ stage, message: err && err.message, extra }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await test("PROBE CLASSIFICATION: 2xx ok, 5xx failed, and everything else is UNKNOWN rather than either", () => {
    const table = [
      [200, "ok"],
      [204, "ok"],
      [500, "failed"],
      [502, "failed"],
      [429, "unknown"],
      [400, "unknown"],
      [401, "unknown"],
      [null, "unknown"],
      [undefined, "unknown"],
    ];
    for (const [status, want] of table) assert.equal(canary.classifyProbe(status), want, `${status}`);
  });

  await test("THE DECISION TABLE: alert on each change, never while it holds, and unknown moves nothing", () => {
    const H = { status: "healthy" };
    const F = { status: "failing" };
    const rows = [
      [null, "ok", null, "healthy"],
      [null, "failed", "failing", "failing"],
      [H, "ok", null, "healthy"],
      [H, "failed", "failing", "failing"],
      [F, "failed", null, "failing"],
      [F, "ok", "recovered", "healthy"],
      [H, "unknown", null, "healthy"],
      [F, "unknown", null, "failing"],
    ];
    for (const [prev, probe, alert, status] of rows) {
      const d = canary.decide(prev, probe);
      assert.equal(d.alert, alert, `${prev && prev.status} + ${probe}`);
      assert.equal(d.status, status, `${prev && prev.status} + ${probe}`);
    }
  });

  await test("AN OUTAGE IS TWO EMAILS: one when it starts, silence for three failing runs, one when it recovers", async () => {
    const w = world();
    const sequence = [200, 500, 500, 500, 500, 200, 200];
    for (const recover of sequence) await runHour(w, { recover });
    assert.deepEqual(
      w.alerts.map((a) => a.subject),
      ["UniPlanner: sign-up and password emails are FAILING", "UniPlanner: sign-up and password emails are working again"],
      "not exactly one failing alert and one recovery alert"
    );
    assert.equal(w.recovers.length, sequence.length, "a probe was skipped");
    /* EVERY failing hour is still recorded for the digest, flagged. */
    const flagged = w.failures.filter((f) => f.extra && f.extra.code === canary.AUTH_EMAIL_FAILED);
    assert.equal(flagged.length, 4, "the digest would not count every failing hour");
    assert.equal(w.state.status, "healthy");
    assert.match(w.alerts[1].text, /failing since 2026-09-27T/, "the recovery does not say how long it was broken");
    assert.equal(w.alerts[0].to[0], ENV.ERROR_DIGEST_TO);
  });

  await test("AN ALERT THAT FAILED TO SEND IS RETRIED ON THE NEXT RUN, because the state did not move", async () => {
    const w = world();
    await runHour(w, { recover: 500, resend: 403 });
    assert.equal(w.alerts.length, 1, "the control: an alert was attempted");
    assert.equal(w.state.status, "healthy", "the state recorded a failing alert that was never delivered");
    await runHour(w, { recover: 500, resend: 200 });
    assert.equal(w.alerts.length, 2, "the next run did not retry the alert");
    assert.equal(w.state.status, "failing");
    await runHour(w, { recover: 500 });
    assert.equal(w.alerts.length, 2, "a third failing run alerted again");
  });

  await test("UNKNOWN IS NOT A RECOVERY AND NOT AN OUTAGE: a rate limit or an unreachable Auth moves nothing", async () => {
    const w = world();
    await runHour(w, { recover: 500 });
    assert.equal(w.state.status, "failing");
    await runHour(w, { recover: 429 });
    await runHour(w, { recoverThrows: true });
    assert.equal(w.state.status, "failing", "an unknown probe changed the state");
    assert.equal(w.alerts.length, 1, "an unknown probe sent an alert");
    assert.ok(w.failures.some((f) => f.extra && f.extra.code === "canary_unknown"), "an unknown probe was not recorded for the digest");
  });

  await test("NO CANARY ACCOUNT MEANS UNKNOWN: /recover is never trusted over an address with no account", async () => {
    /* Auth answers a reset for an unknown address with success WITHOUT
       sending — so a missing account would read as healthy forever. */
    const w = world({ createError: { code: "unexpected_failure", message: "database error" } });
    const r = await runHour(w, { recover: 200 });
    assert.equal(w.recovers.length, 0, "the probe ran without knowing the account exists");
    assert.equal(r.body.probe, "unknown");
    const exists = world({ createError: { code: "email_exists", message: "A user with this email address has already been registered" } });
    await runHour(exists, { recover: 200 });
    assert.equal(exists.recovers.length, 1, "the control: an existing account is probed");
  });

  await test("THE PROBE IS WHAT THE APP SENDS: the public endpoint, the anon key, the canary address, nothing else", async () => {
    const w = world();
    await runHour(w, { recover: 200 });
    const { url, init } = w.recovers[0];
    assert.equal(url, `${ENV.SUPABASE_URL}/auth/v1/recover`);
    assert.equal(init.headers.apikey, ENV.SUPABASE_ANON_KEY);
    assert.deepEqual(JSON.parse(init.body), { email: ENV.AUTH_CANARY_EMAIL });
  });

  await test("A FAILED STATE READ ALERTS NOBODY, but the probe is still recorded", async () => {
    const w = world({ stateReadError: { message: "relation does not exist" } });
    const r = await runHour(w, { recover: 500 });
    assert.equal(r.status, 500);
    assert.equal(w.alerts.length, 0, "an alert went out on a state nobody could read");
    assert.ok(w.failures.some((f) => f.extra && f.extra.code === canary.AUTH_EMAIL_FAILED), "the failed probe was lost with the state");
  });

  await test("THE SECRET: missing and wrong are refused alike, before any probe; unconfigured refuses whole", async () => {
    for (const secret of ["", "wrong"]) {
      const w = world();
      const r = await runHour(w, { secret });
      assert.equal(r.status, 401);
      assert.equal(w.recovers.length, 0);
    }
    const w = world();
    const r = await runHour(w, { env: { ...ENV, AUTH_CANARY_EMAIL: "" } });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "canary_disabled");
    assert.equal(w.recovers.length, 0);
  });

  /* ---------- the app half ---------- */

  await test("THE APP'S DETECTION: a send failure is recognised, and a wrong password, a rate limit or another 5xx is not", () => {
    const yes = [
      { status: 500, message: "Error sending recovery email" },
      { status: 500, message: "Error sending confirmation email" },
      { message: "Error sending recovery email" },
      { status: 502, message: "email provider unavailable" },
    ];
    const no = [
      { status: 400, message: "Invalid login credentials" },
      { status: 429, message: "email rate limit exceeded" },
      { status: 500, message: "Database error saving new user" },
      null,
    ];
    for (const e of yes) assert.equal(client.isAuthEmailSendFailure(e), true, JSON.stringify(e));
    for (const e of no) assert.equal(client.isAuthEmailSendFailure(e), false, JSON.stringify(e));
    assert.equal(client.authEmailFailureReport("reset").message, "auth_email_failed: reset");
    assert.equal(client.authEmailFailureReport("anything").message, "auth_email_failed: unknown");
  });

  await test("THROUGH THE REAL sync.js: the error the student sees is unchanged, and it carries the flow, never the address", async () => {
    const out = await build({
      entryPoints: [path.join(rootDir, "src/sync.js")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      write: false,
      plugins: [{ name: "stub", setup: (b) => b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: path.join(stubDir, "supabase.js") })) }],
    });
    const f = path.join(tmpDir, "sync.mjs");
    fs.writeFileSync(f, out.outputFiles[0].text);
    const EMAIL = "student@example.com";
    let answer = { error: { status: 500, message: "Error sending recovery email" } };
    globalThis.__FAKE_CLIENT__ = {
      auth: {
        resetPasswordForEmail: async () => answer,
        signUp: async () => answer,
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => ({ data: { session: null } }),
      },
      from: () => ({}),
    };
    const sync = await import(pathToFileURL(f).href);
    const backend = sync.supabaseBackend;
    assert.ok(backend && typeof backend.resetPassword === "function", "no supabaseBackend.resetPassword to drive");
    for (const [flow, call] of [
      ["reset", () => backend.resetPassword({ email: EMAIL })],
      ["signup", () => backend.signUp({ email: EMAIL, password: "secret123" })],
    ]) {
      let thrown = null;
      try {
        await call();
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown, `${flow}: no error reached the screen`);
      assert.equal(thrown.authEmailFailed, flow, `${flow}: the failure was not marked for reporting`);
      assert.equal(thrown.message, "Error sending recovery email", `${flow}: the student's wording changed`);
      assert.ok(!client.authEmailFailureReport(thrown.authEmailFailed).message.includes(EMAIL), "the report carries the address");
    }
    /* The control: a wrong password is shown and NOT marked. */
    answer = { error: { status: 400, message: "Invalid login credentials" } };
    try {
      await backend.resetPassword({ email: EMAIL });
    } catch (e) {
      assert.equal(e.authEmailFailed, undefined, "an ordinary refusal was marked as an email failure");
    }
  });

  await test("PlannerApp REPORTS BOTH FLOWS before showing the error, through the ordinary reporter", () => {
    const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
    for (const handler of ["handleSignUp", "handleResetPassword"]) {
      const start = src.indexOf(`const ${handler} = async`);
      assert.ok(start > 0, `${handler} not found`);
      const body = src.slice(start, src.indexOf("\n  };", start));
      assert.match(body, /catch \(e\) \{\s*reportAuthEmailFailure\(e\);\s*throw e;/, `${handler} does not report an email failure, or swallows the error`);
    }
    assert.match(src, /reportErrorRef\.current\(authEmailFailureReport\(e\.authEmailFailed\)\)/);
  });

  await test("THE DIGEST FLAGS IT from either direction, and an app report never carries the user", () => {
    const d = digest.buildDigest([{ fn: "auth-email-canary", stage: "recover", name: "Error", message: "Auth /recover answered 500", detail: { code: "auth_email_failed", status: 500 }, occurred_at: "2026-09-27T05:17:00Z" }], {
      total: 1,
      windowHours: 24,
      clientRows: [
        { message: "auth_email_failed: reset", build_id: "bc8d90c1321a", url: "/app/", created_at: "2026-09-27T05:20:00Z", user_id: "11111111-1111-4111-8111-111111111111" },
        { message: "auth_email_failed: reset", build_id: "bc8d90c1321a", url: "/app/", created_at: "2026-09-27T05:10:00Z" },
        { message: "TypeError: x is undefined\n    at foo", build_id: "bc8d90c1321a", url: "/app/", created_at: "2026-09-27T05:00:00Z" },
      ],
      clientTotal: 3,
    });
    assert.deepEqual(digest.MUST_REPORT_CODES.includes(client.AUTH_EMAIL_FAILED), true, "the app's code is not one the digest flags");
    assert.equal(digest.MUST_REPORT_CODES.includes(canary.AUTH_EMAIL_FAILED), true, "the canary's code is not one the digest flags");
    assert.deepEqual(d.mustReport, ["auth_email_failed"]);
    assert.ok(d.groups[0].mustReport && d.groups[1].mustReport, "a flagged group sank below an unflagged one");
    const appGroup = d.groups.find((g) => g.fn === "app" && g.name === "auth_email_failed: reset");
    assert.equal(appGroup.count, 2, "the two identical app reports were not grouped");
    const text = digest.digestText(d);
    assert.match(text, /3 error reports from the app itself/);
    assert.match(digest.digestSubject(d), /4 failures .*auth_email_failed/);
    assert.ok(!text.includes("11111111-1111"), "the digest printed a user id");
    assert.match(text, /TypeError: x is undefined/);
    assert.ok(!text.includes("at foo"), "an app report's stack reached the email");
  });

  await test("A FAILED READ OF client_errors IS SAID, not read as a quiet day", async () => {
    const d = digest.buildDigest([], { total: 0, windowHours: 24, notes: ["The app's own error reports (client_errors) could not be read, so this email says nothing about them."] });
    assert.equal(d.groups.length, 0, "the control: nothing to group");
    assert.match(digest.digestText(d), /NOTE: The app's own error reports/);
    const src = fs.readFileSync(path.join(rootDir, "supabase/functions/error-digest/index.ts"), "utf8");
    assert.match(src, /digest\.groups\.length === 0 && digest\.notes\.length === 0/, "a digest with only a note would be treated as a quiet day and never sent");
    assert.match(src, /\.from\("client_errors"\)\s*\.select\("message, build_id, url, created_at"\)/, "the digest does not read client_errors, or reads more than it prints");
  });

  await test("THE SCHEDULE AND THE QUOTA THE DOCS STATE ARE ONE NUMBER, read from 0025's cron line", () => {
    /* Every run sends a real email through Resend, so the documented
       daily and monthly counts are a cost statement. They are derived
       from the schedule 0025 actually creates, never typed beside it. */
    const sql = fs.readFileSync(path.join(rootDir, "supabase/migrations/0025_auth_email_canary.sql"), "utf8");
    const cron = sql.match(/cron\.schedule\(\s*'auth-email-canary',\s*'([^']+)'/);
    assert.ok(cron, "0025 schedules no auth-email-canary job");
    const [minute, hour, dom, month, dow] = cron[1].split(/\s+/);
    assert.ok(/^\d+$/.test(minute) && dom === "*" && month === "*" && dow === "*", `a schedule this guard cannot count: ${cron[1]}`);
    const step = hour === "*" ? 1 : Number((hour.match(/^\*\/(\d+)$/) || [])[1]);
    assert.ok(Number.isInteger(step) && 24 % step === 0, `an hour field this guard cannot count: ${hour}`);
    const perDay = 24 / step;
    assert.equal(perDay, 6, "the canary no longer runs every four hours, which is the ruled cadence");
    const setup = fs.readFileSync(path.join(rootDir, "SUPABASE-SETUP.md"), "utf8");
    assert.match(setup, new RegExp(`${perDay} emails a day, about ${perDay * 30} a month`), "SUPABASE-SETUP states a different Resend cost from the schedule 0025 creates");
    assert.ok(setup.includes(`'${cron[1]}'`), "SUPABASE-SETUP quotes a different schedule from the one 0025 creates");
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) process.exit(1);
}

await main();

/* Error reporting: bounded, deduped, six fields, never in the way.

   The reporter sends breakage reports to OUR OWN client_errors table
   (migration 0010) — no third party. The rules under test here are the
   ones the privacy position rests on:

   - a row is EXACTLY the six declared fields plus user_id, so nothing
     new can ride along unnoticed
   - the page path is location.pathname alone — never the query, never
     the hash, because the hash is where recovery tokens ride
   - at most MAX_REPORTS_PER_SESSION rows a session, duplicates
     dropped, one attempt with no retry
   - report() cannot throw and cannot reject, whatever the transport
     does — an error in the error reporter must be silence

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_REPORTS_PER_SESSION,
  MESSAGE_MAX,
  STACK_MAX,
  describeThrown,
  buildRow,
  pathOnly,
  createReporter,
  installGlobalHandlers,
} from "../src/errorReport.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const collectRows = () => {
  const rows = [];
  return { rows, send: (row) => (rows.push(row), Promise.resolve()) };
};
const settle = () => new Promise((r) => setTimeout(r, 10));

console.log("\nerror reporting");

test("a row is EXACTLY the six fields plus user_id, by name", () => {
  const row = buildRow({ message: "m", stack: "s", buildId: "b", path: "/p", userAgent: "ua", userId: "u" });
  assert.deepEqual(Object.keys(row).sort(), ["build_id", "message", "stack", "url", "user_agent", "user_id"].sort());
});

test("the path NEVER carries a query or a hash — that is where recovery tokens ride", () => {
  assert.equal(pathOnly("https://www.uniplannerapp.com/app?foo=1#access_token=SECRET"), "/app");
  assert.equal(pathOnly("/app?x=1#y"), "/app");
  assert.equal(pathOnly("/plain"), "/plain");
  assert.equal(pathOnly(null), null);
  // An unparseable string keeps the invariant even when it keeps some
  // text: whatever survives, nothing after ? or # does.
  assert.ok(!/[?#]/.test(pathOnly("::::not a url::::#tok") || ""), "a hash survived an odd path");
});

test("message and stack are capped at the column limits", () => {
  const row = buildRow({ message: "x".repeat(MESSAGE_MAX + 500), stack: "y".repeat(STACK_MAX + 500) });
  assert.equal(row.message.length, MESSAGE_MAX);
  assert.equal(row.stack.length, STACK_MAX);
});

test("signed out reports with user_id null", () => {
  assert.equal(buildRow({ message: "m" }).user_id, null);
});

test("Errors, strings, rejection reasons and nulls all become a message", () => {
  assert.equal(describeThrown(new Error("boom")).message, "boom");
  assert.ok(describeThrown(new Error("boom")).stack.length > 0);
  assert.equal(describeThrown("plain string").message, "plain string");
  assert.equal(describeThrown(null).message, "Unknown error");
  assert.equal(describeThrown({ reason: new Error("inner") }).message, "inner");
});

test("duplicates within a session are dropped by message + first stack line", async () => {
  const { rows, send } = collectRows();
  const report = createReporter({ send });
  const err = new Error("same");
  assert.equal(report(err), true);
  assert.equal(report(err), false);
  assert.equal(report(new Error("same")), false, "an identical message from the same code path re-reported");
  await settle();
  assert.equal(rows.length, 1);
});

test("the session cap holds, and the cap counts sends rather than attempts", async () => {
  const { rows, send } = collectRows();
  const report = createReporter({ send, max: 3 });
  for (let i = 0; i < 10; i++) report(new Error(`e${i}`));
  await settle();
  assert.equal(rows.length, 3);
});

test("a transport that REJECTS is silence — nothing throws, nothing retries", async () => {
  let attempts = 0;
  const report = createReporter({
    send: () => {
      attempts++;
      return Promise.reject(new Error("network down"));
    },
  });
  assert.equal(report(new Error("boom")), true);
  await settle();
  assert.equal(attempts, 1, "a failed report was retried — a failed report is a dropped report");
});

test("a transport that THROWS SYNCHRONOUSLY is also silence", async () => {
  const report = createReporter({
    send: () => {
      throw new Error("sync throw");
    },
  });
  assert.doesNotThrow(() => report(new Error("boom")));
  await settle();
});

test("getUserId is read at REPORT time, so a mid-session sign-in is reflected", async () => {
  const { rows, send } = collectRows();
  let uid = null;
  const report = createReporter({ send, getUserId: () => uid });
  report(new Error("before"));
  uid = "user-1";
  report(new Error("after"));
  await settle();
  assert.equal(rows[0].user_id, null);
  assert.equal(rows[1].user_id, "user-1");
});

test("the global handlers cover BOTH channels and the remover removes both", () => {
  const listeners = new Map();
  const target = {
    addEventListener: (k, fn) => listeners.set(k, fn),
    removeEventListener: (k) => listeners.delete(k),
  };
  const got = [];
  const remove = installGlobalHandlers((e) => got.push(describeThrown(e).message), target);
  assert.ok(listeners.has("error") && listeners.has("unhandledrejection"), "a channel is missing — a leak through the other is how a spy on one goes blind");
  listeners.get("error")({ error: new Error("boom") });
  listeners.get("unhandledrejection")({ reason: new Error("rejected") });
  assert.deepEqual(got, ["boom", "rejected"]);
  remove();
  assert.equal(listeners.size, 0, "the remover left a listener behind — a re-mount would double-report");
});

test("the degenerate shapes still behave — the branches nobody hits until the worst day", async () => {
  /* Errors arrive at the reporter precisely when things are already
     going wrong, so the malformed shapes are the expected input, not
     the edge: an Error with no message and no stack, an object with a
     message and no reason, a rejection whose reason is a string or
     null, a URL that parses as a scheme and then fails. Each of these
     is a real branch in describeThrown/buildRow, and the coverage
     gate is what flagged them as untested — this block is the gate
     working. */
  const blank = new Error("");
  blank.stack = "";
  assert.equal(describeThrown(blank).message, "Error");
  assert.equal(describeThrown(blank).stack, "");
  assert.equal(describeThrown({ message: "just a message" }).message, "just a message");
  assert.equal(describeThrown({ reason: "a string reason" }).message, "a string reason");
  const blankInner = new Error("");
  assert.equal(describeThrown({ reason: blankInner }).message, "Error", "an empty-message Error inside a reason lost its String() fallback");
  assert.equal(describeThrown({ reason: null, message: "" }).message, "Unknown error");
  assert.equal(buildRow({}).message, "Unknown error");
  assert.equal(pathOnly("https://"), null, "a scheme that fails URL parsing must yield null");

  // Dedupe on stackless errors exercises the null-stack key path.
  const { rows, send } = collectRows();
  const report = createReporter({ send });
  assert.equal(report("stackless string error"), true);
  assert.equal(report("stackless string error"), false);
  await settle();
  assert.equal(rows.length, 1);
});

test("a helper that THROWS mid-report is silence, and supplied getters are used", async () => {
  const bad = createReporter({
    send: async () => {},
    getUserId: () => {
      throw new Error("session store exploded");
    },
  });
  assert.doesNotThrow(() => bad(new Error("boom")));
  assert.equal(bad(new Error("boom2")), false, "a throwing getter must read as silence, not success");

  const { rows, send } = collectRows();
  const report = createReporter({ send, getPath: () => "/somewhere?x=1#tok", getUserAgent: () => "TestBrowser/1.0" });
  report(new Error("with getters"));
  await settle();
  assert.equal(rows[0].url, "/somewhere", "the supplied path was not stripped");
  assert.equal(rows[0].user_agent, "TestBrowser/1.0");
});

test("handler events with no error object, and a null target, still behave", () => {
  const listeners = new Map();
  const target = { addEventListener: (k, fn) => listeners.set(k, fn), removeEventListener: (k) => listeners.delete(k) };
  const got = [];
  installGlobalHandlers((e) => got.push(describeThrown(e).message), target);
  listeners.get("error")({ message: "message-only event" });
  listeners.get("error")("bare value");
  listeners.get("unhandledrejection")({ notReason: true });
  assert.equal(got.length, 3, "a shape was dropped instead of reported");
  const remove = installGlobalHandlers(() => {}, null);
  assert.doesNotThrow(remove, "the no-target remover must be callable");
});

test("the app wires the reporter through supabase and the runSync catch", () => {
  /* Wiring greps, comments stripped first (the recurring trap). */
  const raw = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.match(code, /from\("client_errors"\)\.insert/, "the transport no longer targets client_errors");
  assert.match(code, /installGlobalHandlers/, "the global handlers are no longer installed");
  assert.match(code, /reportErrorRef\.current\(e\)/, "the runSync catch no longer reports");
});

test("npm test runs this file", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /test-error-report\.mjs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

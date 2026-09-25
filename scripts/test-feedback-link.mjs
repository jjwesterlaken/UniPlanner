/* The feedback link's rule, as a table. The rendered half (what the
   Account tab really shows on each faked shell) is in
   test-rendered-tabs.mjs; this file covers the cases a mount does not
   reach cheaply: an unrecognised shell, a native flag with a web
   platform, and exactly what the pre-filled mail says. */
import assert from "node:assert/strict";
import { feedbackLink, platformName, FEEDBACK_COPY } from "../src/feedbackLink.js";
import { SUPPORT_URL, SUPPORT_EMAIL } from "../src/legalLinks.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("async test handed to a sync runner");
    console.log(`  ok  - ${name}`); passed++;
  } catch (e) { console.log(`FAIL  - ${name}\n        ${e.message}`); failed++; }
}

const base = { build: "0123456789ab", supportUrl: SUPPORT_URL, supportEmail: SUPPORT_EMAIL };

test("only a native iOS shell gets the mail route; every other shape gets the support page", () => {
  const rows = [
    [{ isNative: true, platform: "ios" }, "mail"],
    [{ isNative: true, platform: "android" }, "page"],
    [{ isNative: false, platform: "web" }, "page"],
    [{ isNative: false, platform: "ios" }, "page"],
    [{ isNative: true, platform: "web" }, "page"],
    [{ isNative: true, platform: undefined }, "page"],
    [{ isNative: "yes", platform: "ios" }, "page"],
  ];
  const kinds = new Set();
  for (const [env, want] of rows) {
    const got = feedbackLink({ ...base, ...env });
    kinds.add(got.kind);
    assert.equal(got.kind, want, `${JSON.stringify(env)} -> ${got.kind}`);
    if (got.kind === "page") {
      assert.equal(got.href, SUPPORT_URL);
      assert.equal(got.quoteVersion, true, "the page route must still ask for the version");
    }
  }
  assert.equal(kinds.size, 2, "the table never exercised both routes");
});

test("the pre-filled mail carries the build id and platform, and nothing else", () => {
  const { href, quoteVersion } = feedbackLink({ ...base, isNative: true, platform: "ios" });
  assert.equal(quoteVersion, false);
  assert.ok(!href.includes("+"), "spaces must be %20 in a mailto, never +");
  const url = new URL(href);
  assert.equal(url.pathname, SUPPORT_EMAIL);
  const subject = url.searchParams.get("subject");
  const body = url.searchParams.get("body");
  assert.equal(subject, `UniPlanner feedback (${base.build}, iOS)`);
  const filled = body.split("\n").filter((l) => l.trim() && l !== "---");
  assert.deepEqual(filled, [`Version: ${base.build}`, "Platform: iOS"], "the body carries more than the two facts");
  assert.ok(body.startsWith("\n"), "the student's own text should go above the facts, so the body starts blank");
});

test("an unknown platform reads as itself, never as a guess", () => {
  assert.equal(platformName("ios"), "iOS");
  assert.equal(platformName("electron"), "electron");
  assert.equal(platformName(undefined), "unknown");
});

test("the copy asks for feedback, not only for faults", () => {
  assert.match(FEEDBACK_COPY.prompt, /idea|feedback|suggest/i, "the prompt is worded for faults only");
  assert.match(FEEDBACK_COPY.prompt, /problem|wrong|not working/i, "the prompt no longer invites fault reports");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

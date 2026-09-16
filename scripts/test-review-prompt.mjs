/* Asking for a store review, once, after a lecture note has saved.

   TWO CLAIMS MATTER MORE THAN THE REST, and both are about a failure
   that repeats rather than one that happens once:

     THE PLUGIN IS NEVER SPOKEN TO OFF A NATIVE SHELL. There is no
     store to review on the web or on the desktop build, and a plugin
     call there is a call into something that is not installed. Driven
     against a traced fake, because a grep for "it checks first" passes
     on a function that checks and then calls anyway.

     RECORD FIRST, THEN ASK. An interruption between the two must
     leave "recorded, never asked" — one review request lost — and
     never "asked, no record", which prompts the student again after
     every lecture for ever. So a storage write that fails means we do
     not ask at all.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import {
  REVIEW_ASKED_KEY,
  REVIEWABLE_PLATFORMS,
  shouldAskForReview,
  hasAskedForReview,
  markAskedForReview,
  askForReviewOnce,
} from "../src/reviewPrompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

/* A storage that can be told to fail on either verb, because the two
   failures are not the same: a read that throws must read as "already
   asked", a write that throws must stop the ask happening at all. */
const fakeStorage = ({ seeded = null, throwOnGet = false, throwOnSet = false } = {}) => {
  const map = new Map();
  if (seeded !== null) map.set(REVIEW_ASKED_KEY, seeded);
  return {
    getItem(k) {
      if (throwOnGet) throw new Error("SecurityError: storage is blocked");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnSet) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    _map: map,
  };
};

const tracedRequest = () => {
  const calls = [];
  const fn = async () => {
    calls.push("requestReview");
  };
  fn.calls = calls;
  return fn;
};

const at = () => "2026-09-16T10:00:00Z";

async function run() {
  /* ---------- 1. where it may happen at all ---------- */

  await test("THE DECISION TABLE — every platform, and the reasons stay distinct", () => {
    const rows = [
      /* saved  isNative  platform    expect        reason */
      [true, true, "ios", true, null],
      [true, true, "android", true, null],
      [true, false, "web", false, "web"],
      /* A desktop Electron build reports itself as web, which is
         right: there is no store to review in. */
      [true, false, "ios", false, "web"],
      [true, true, "electron", false, "unknown-platform"],
      [true, true, "", false, "unknown-platform"],
      /* THE ONE THAT MATTERS MOST: a save that failed is the worst
         moment in the app to ask somebody to rate it. */
      [false, true, "ios", false, "not-saved"],
      [false, false, "web", false, "not-saved"],
    ];
    for (const [saved, isNative, platform, expected, reason] of rows) {
      const got = shouldAskForReview({ saved, isNative, platform, alreadyAsked: false });
      assert.equal(got.ask, expected, `saved=${saved} native=${isNative} platform=${platform} -> ${JSON.stringify(got)}`);
      assert.equal(got.reason, reason, `the reason for saved=${saved} native=${isNative} platform=${platform}`);
    }
  });

  await test("a failed save is refused BEFORE the platform is consulted, so it is one answer everywhere", () => {
    /* Otherwise a failed save on iOS and a failed save on the web give
       different reasons for the same decision, and the log stops
       telling you which thing actually stopped it. */
    assert.equal(shouldAskForReview({ saved: false, isNative: true, platform: "ios" }).reason, "not-saved");
    assert.equal(shouldAskForReview({ saved: false, isNative: false, platform: "web" }).reason, "not-saved");
  });

  await test("an already-asked device is refused, whatever else is true", () => {
    for (const platform of REVIEWABLE_PLATFORMS) {
      const got = shouldAskForReview({ saved: true, isNative: true, platform, alreadyAsked: true });
      assert.equal(got.ask, false);
      assert.equal(got.reason, "already-asked");
    }
  });

  /* ---------- 2. the flag ---------- */

  await test("the flag is DEVICE-LOCAL — it is not a key the synced blob knows about", () => {
    assert.match(REVIEW_ASKED_KEY, /^uni-planner-/);
    /* The blob is built by normalizeData out of COLLECTIONS and meta;
       a localStorage key is not part of it. The check that means
       something is that nothing in sync.js has heard of this key. */
    const sync = stripComments(read("src/sync.js"));
    assert.ok(!sync.includes("review"), "sync.js mentions the review flag — it must not travel between devices");
  });

  await test("A BLOCKED READ READS AS ALREADY-ASKED, which is the cautious direction", () => {
    /* Safari in private browsing throws on every read. Reading that as
       "not yet asked" would ask after EVERY lecture, for ever — the
       behaviour stores penalise. Not asking costs one request. */
    assert.equal(hasAskedForReview(fakeStorage({ throwOnGet: true })), true);
    assert.equal(hasAskedForReview(fakeStorage()), false, "an empty storage must read as not-yet-asked, or the above proves nothing");
    assert.equal(hasAskedForReview(fakeStorage({ seeded: at() })), true);
  });

  await test("marking reports whether the record is durable, rather than throwing", () => {
    const ok = fakeStorage();
    assert.equal(markAskedForReview(ok, at), true);
    assert.equal(ok._map.get(REVIEW_ASKED_KEY), at());
    assert.equal(markAskedForReview(fakeStorage({ throwOnSet: true }), at), false);
  });

  /* ---------- 3. the ordering ---------- */

  await test("RECORD FIRST, THEN ASK — a storage write that fails means no prompt at all", () => {
    /* The interruption this exists for leaves "recorded, never asked"
       and costs one review request. The reverse prompts the student
       again after every lecture for ever, which is unbounded. */
    const request = tracedRequest();
    return askForReviewOnce({
      isNative: true,
      platform: "ios",
      storage: fakeStorage({ throwOnSet: true }),
      request,
      nowISO: at,
    }).then((res) => {
      assert.deepEqual(request.calls, [], "the prompt was requested although the record could not be written");
      assert.equal(res.asked, false);
      assert.equal(res.reason, "not-recorded");
    });
  });

  await test("the happy path records AND asks, in that order", async () => {
    const storage = fakeStorage();
    const order = [];
    const request = async () => {
      order.push(`request:${storage._map.has(REVIEW_ASKED_KEY)}`);
    };
    const res = await askForReviewOnce({ isNative: true, platform: "ios", storage, request, nowISO: at });
    assert.deepEqual(res, { asked: true, reason: null });
    assert.deepEqual(order, ["request:true"], "the prompt was requested before the record existed");
    assert.equal(storage._map.get(REVIEW_ASKED_KEY), at());
  });

  await test("ONCE PER INSTALL — a second saved lecture asks nothing", async () => {
    const storage = fakeStorage();
    const request = tracedRequest();
    const first = await askForReviewOnce({ isNative: true, platform: "android", storage, request, nowISO: at });
    const second = await askForReviewOnce({ isNative: true, platform: "android", storage, request, nowISO: at });
    assert.equal(first.asked, true);
    assert.equal(second.asked, false);
    assert.equal(second.reason, "already-asked");
    assert.deepEqual(request.calls, ["requestReview"], "the plugin was called twice for one install");
  });

  /* ---------- 4. it never takes down what it follows ---------- */

  await test("THE PLUGIN IS NEVER SPOKEN TO OFF A NATIVE SHELL — driven, not greped", async () => {
    /* A grep for "it checks the platform first" passes on a function
       that checks and then calls anyway. The trace is the claim. */
    const request = tracedRequest();
    for (const env of [
      { isNative: false, platform: "web" },
      { isNative: false, platform: "ios" },
      { isNative: true, platform: "electron" },
    ]) {
      const res = await askForReviewOnce({ ...env, storage: fakeStorage(), request, nowISO: at });
      assert.equal(res.asked, false, `asked on ${JSON.stringify(env)}`);
    }
    assert.deepEqual(request.calls, [], `the review plugin was called off a native shell: ${request.calls.join(", ")}`);
  });

  await test("AND THE TRACE IS NOT EMPTY FOR AN UNRELATED REASON — the same fake does get called on a phone", async () => {
    /* The control the emptiness above needs. An `askForReviewOnce`
       that called nothing ever would satisfy the previous test
       completely. */
    const request = tracedRequest();
    await askForReviewOnce({ isNative: true, platform: "ios", storage: fakeStorage(), request, nowISO: at });
    assert.deepEqual(request.calls, ["requestReview"]);
  });

  await test("a plugin that throws costs the review request and NOTHING ELSE", async () => {
    /* This runs at the end of saving a lecture the student may have
       paid for. A missing plugin, an OS that refuses, a bridge that is
       not there — none of them may propagate. */
    const storage = fakeStorage();
    const res = await askForReviewOnce({
      isNative: true,
      platform: "ios",
      storage,
      request: async () => {
        throw new Error("plugin not implemented on this platform");
      },
      nowISO: at,
    });
    assert.equal(res.asked, true);
    assert.equal(res.reason, "request-failed");
    assert.ok(storage._map.has(REVIEW_ASKED_KEY), "a throwing plugin must not cause the student to be asked again");
  });

  await test("a storage that throws on BOTH verbs still cannot throw out of the call", async () => {
    const res = await askForReviewOnce({
      isNative: true,
      platform: "ios",
      storage: fakeStorage({ throwOnGet: true, throwOnSet: true }),
      request: tracedRequest(),
      nowISO: at,
    });
    assert.equal(res.asked, false);
    assert.equal(res.reason, "already-asked");
  });

  /* ---------- 5. the module stays pure ---------- */

  await test("the pure module imports NOTHING — a plain-Node test must be able to load it", () => {
    /* The purchasePlans.js split, and the reason is the same: a module
       that touches the Capacitor plugin cannot be imported by this
       file at all, so nothing decidable is allowed to live there. */
    const src = stripComments(read("src/reviewPrompt.js"));
    assert.doesNotMatch(src, /^\s*import\s/m, "reviewPrompt.js grew an import; the decisions must stay testable from Node");
    assert.doesNotMatch(src, /Capacitor|localStorage|window\./, "a browser or plugin global is baked in rather than injected");
  });

  /* ---------- 6. the SDK layer, through a real bundle ----------

     THE CLAIM CANNOT BE MADE BY READING THE SOURCE. `appReview.js`
     imports a Capacitor plugin, so this file cannot import it — the
     purchases.js split, and the same remedy: bundle it with the
     plugin and the bridge faked, then drive it and read the trace.
     A grep for "it asks the platform first" passes on a function that
     asks and then calls anyway. */

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-sdk-"));
  const stubDir = path.join(tmpDir, "stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "capacitor.js"),
    `export const Capacitor = {
       isNativePlatform: () => !!(globalThis.__FAKE_NATIVE__),
       getPlatform: () => globalThis.__FAKE_PLATFORM__ || "web",
     };\n`
  );
  /* The DEFAULT export records and then throws, so a test that meant
     to inject a plugin and forgot fails loudly instead of passing on
     a call nobody watched. */
  fs.writeFileSync(
    path.join(stubDir, "in-app-review.js"),
    `export const InAppReview = new Proxy({}, {
       get(_t, name) {
         return async () => {
           (globalThis.__DEFAULT_PLUGIN_CALLS__ ||= []).push(String(name));
           throw new Error("the default review plugin was called — a test meant to inject one did not");
         };
       },
     });\n`
  );

  const bundle = await build({
    entryPoints: [path.join(rootDir, "src/appReview.js")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    plugins: [
      {
        name: "stub-native",
        setup(b) {
          b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: path.join(stubDir, "capacitor.js") }));
          b.onResolve({ filter: /^@capacitor-community\/in-app-review$/ }, () => ({
            path: path.join(stubDir, "in-app-review.js"),
          }));
        },
      },
    ],
  });
  const sdkPath = path.join(tmpDir, "appReview.mjs");
  fs.writeFileSync(sdkPath, bundle.outputFiles[0].text);
  const sdk = await import(pathToFileURL(sdkPath).href);

  await test("THE REAL BUNDLED MODULE NEVER SPEAKS TO THE PLUGIN ON WEB — trace, not grep", async () => {
    const { plugin, trace } = (() => {
      const t = [];
      return { trace: t, plugin: { requestReview: async () => void t.push("requestReview") } };
    })();
    for (const env of [
      { isNative: false, platform: "web" },
      { isNative: false, platform: "electron" },
      { isNative: true, platform: "electron" },
    ]) {
      await sdk.maybeAskForReview({ ...env, storage: fakeStorage(), plugin });
    }
    assert.deepEqual(trace, [], `the review plugin was reached off a native shell: ${trace.join(", ")}`);
    assert.deepEqual(
      globalThis.__DEFAULT_PLUGIN_CALLS__ || [],
      [],
      "the module reached the DEFAULT plugin export rather than the injected one"
    );
  });

  await test("AND THE SAME BUNDLE DOES ASK ON A PHONE — the control the emptiness needs", async () => {
    const trace = [];
    const plugin = { requestReview: async () => void trace.push("requestReview") };
    const res = await sdk.maybeAskForReview({ isNative: true, platform: "ios", storage: fakeStorage(), plugin });
    assert.deepEqual(trace, ["requestReview"]);
    assert.equal(res.asked, true);
  });

  await test("no storage at all is refused rather than crashing — a sandboxed iframe raises on the property itself", async () => {
    const trace = [];
    const plugin = { requestReview: async () => void trace.push("requestReview") };
    const res = await sdk.maybeAskForReview({ isNative: true, platform: "ios", storage: null, plugin });
    assert.equal(res.asked, false);
    assert.equal(res.reason, "no-storage");
    assert.deepEqual(trace, [], "asked with nowhere to record that we had");
  });

  await test("THE ASK IS WIRED TO THE SAVED PATH, and is NOT REACHABLE FROM THE FAILURE BRANCH", () => {
    /* AN INDEX COMPARISON CANNOT MAKE THIS CLAIM, and the first
       version of this test tried to. It asserted the call sits after
       the `saved` dispatch and before the `saveFailed` one — and
       MOVING THE CALL INTO THE CATCH BLOCK, directly above the
       saveFailed dispatch, satisfies both comparisons. The mutation
       ran green. A guard can be correct, non-vacuous and still
       measuring the wrong thing; the tell was checking WHICH
       assertion caught the mutation and finding that none did.

       The claim is structural — "not inside the catch" — so the catch
       block's extent is found by matching its braces and the call must
       not be in it. */
    const src = stripComments(read("src/aiNotes.jsx"));

    const saved = src.indexOf('dispatch({ type: "saved" })');
    assert.ok(saved > 0, "the successful-save dispatch is gone; this test is about a shape that no longer exists");

    const asks = [...src.matchAll(/maybeAskForReview\(\)/g)].map((m) => m.index);
    assert.equal(asks.length, 1, `the ask appears ${asks.length} times; it must be wired at exactly one place`);
    assert.ok(asks[0] > saved, "the review ask does not follow the successful save");

    /* The catch that wraps the save, and its full extent. */
    const catchAt = src.indexOf("} catch (err) {", saved);
    assert.ok(catchAt > 0, "the save path no longer has a catch this test can locate");
    let depth = 0;
    let k = src.indexOf("{", catchAt);
    const bodyStart = k + 1;
    for (; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) break;
    }
    const catchBody = src.slice(bodyStart, k);
    assert.ok(
      catchBody.includes("saveFailed"),
      "the block this test believes is the failure branch does not dispatch saveFailed — it found the wrong braces"
    );
    assert.ok(
      !catchBody.includes("maybeAskForReview"),
      "THE REVIEW ASK IS IN THE FAILURE BRANCH: a student whose lecture failed to save would be asked to rate the app"
    );

    assert.match(src, /void maybeAskForReview\(\)/, "the ask is awaited; a save must not wait on a review prompt");
  });

  await test("npm test runs this file", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.match(pkg.scripts.test, /test-review-prompt\.mjs/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

run();

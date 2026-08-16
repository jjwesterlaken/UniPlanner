/* "If someone uses UniPlanner without an account, is it ONLY saving to
   their own device?"

   The privacy policy says yes. This proves it, by mounting the real app
   with every outbound channel replaced by a spy and asserting nothing
   is used.

   THE CORRECTION THAT MATTERS MOST, and the reason this file is not
   just another case in test-app-smoke.mjs: the state the question is
   about is NOT `backend.isDemo`.

     demo mode          isConfigured === false -> backend = demoBackend,
                        isDemo === true. Nobody in production is here.
                        It is the smoke test's mode, and a developer's
                        with an unfilled config.js.

     SIGNED OUT         isConfigured === true -> backend = supabaseBackend,
     ON THE REAL        isDemo === FALSE, session === null. This is every
     BUILD              user before they make an account -- the state the
                        question is actually about, and the state nothing
                        was covering.

   A test that only ran demo mode would answer a question nobody asked,
   in the mode nobody is in, and report it as a clean bill of health.
   Both are walked below; scenario B is the one Jared needs.

   WHAT COUNTS AS OUTBOUND. Every channel a bundle could plausibly use,
   not just `fetch`: a spy on one and a leak through another is exactly
   how this kind of check ends up decorative. `fetch`, `XMLHttpRequest`,
   `sendBeacon`, `WebSocket` and `EventSource` are all replaced, and any
   use of any of them is recorded with a stack so a failure names the
   caller instead of the channel. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { callAiText } from "../src/aiTextClient.js";
import { callAiNotes, uploadAudio } from "../src/aiNotesClient.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
const check = (ok, name, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`FAIL  - ${name}`);
    if (detail) console.error(`        ${detail}`);
  }
};

console.log("\nno account, no network");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-only-"));

/* ------------------------------------------------------------------ */
/*  1. The boundary refuses on its own, without a screen's help       */
/* ------------------------------------------------------------------ */

/* These are the call sites, not the components. Every AI feature is
   hidden behind `session &&` in the UI, which is right -- and is one
   refactor from being the only thing standing between a signed-out
   student's typing and the wire. */

async function refuses(name, fn) {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  let threw = null;
  try {
    await fn(spy);
  } catch (err) {
    threw = err;
  }
  check(!called, `${name}: nothing is sent without a token`, called ? "a request was made" : null);
  check(!!threw, `${name}: the caller is told, rather than getting a silent no-op`);
  check(threw && threw.code === "unauthenticated", `${name}: it reuses the server's own code, so the wording already exists`, threw && `code was ${threw.code}`);
}

await refuses("ai-text", (fetchImpl) => callAiText({ token: undefined, task: "explain", payload: {}, fetchImpl }));
await refuses("ai-notes", (fetchImpl) =>
  callAiNotes({ token: undefined, course: "PHYS1001", idempotencyKey: "k" }, fetchImpl)
);

await (async () => {
  /* uploadAudio takes a client rather than a token, and `supabase` is
     non-null for every user of the real build -- signed in or not. So
     the client check alone never fires here; the session check is what
     stops a signed-out upload. */
  let uploaded = false;
  const fakeClient = { storage: { from: () => ({ upload: async () => ((uploaded = true), { error: null }) }) } };
  let threw = null;
  try {
    await uploadAudio({ session: null, audioBlob: {}, mimeType: "audio/webm", idempotencyKey: "k", supabaseClient: fakeClient });
  } catch (err) {
    threw = err;
  }
  check(!uploaded, "audio upload: no recording leaves the device without a session");
  check(!!threw, "audio upload: the caller is told");
})();

/* ------------------------------------------------------------------ */
/*  2. The whole app, walked, with every channel spied on             */
/* ------------------------------------------------------------------ */

async function bundleWith(isConfigured) {
  const plugins = [];
  if (!isConfigured) {
    const demoConfig = path.join(tmp, "config-demo.js");
    fs.writeFileSync(
      demoConfig,
      'export const SUPABASE_URL = "PASTE_YOUR_URL";\n' +
        'export const SUPABASE_ANON_KEY = "PASTE_YOUR_KEY";\n' +
        "export const isConfigured = false;\n"
    );
    plugins.push({
      name: "force-demo-config",
      setup(b) {
        b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
      },
    });
  }
  const out = await build({
    entryPoints: [path.join(rootDir, "src/main.jsx")],
    bundle: true,
    format: "iife",
    jsx: "automatic",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins,
  });
  return out.outputFiles[0].text;
}

function spyOn(w) {
  const calls = [];
  const record = (channel, target) => {
    calls.push({ channel, target: String(target), stack: new Error().stack });
  };

  w.fetch = (input, init) => {
    record("fetch", (input && input.url) || input);
    return Promise.reject(new Error("blocked by the local-only test"));
  };
  w.navigator.sendBeacon = (url) => {
    record("sendBeacon", url);
    return false;
  };
  class SpyXHR {
    open(method, url) {
      record("XMLHttpRequest", url);
    }
    setRequestHeader() {}
    send() {}
    abort() {}
    addEventListener() {}
    removeEventListener() {}
  }
  w.XMLHttpRequest = SpyXHR;
  w.WebSocket = class {
    constructor(url) {
      record("WebSocket", url);
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
    send() {}
  };
  w.EventSource = class {
    constructor(url) {
      record("EventSource", url);
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };
  return calls;
}

/* A planner with content in it. An EMPTY one would pass this test while
   pushing nothing simply because there was nothing to push. */
const SEED = {
  semester: "Semester 1",
  semesters: {
    "Semester 1": {
      courses: [{ id: "c1", name: "Physics", code: "PHYS1001", updatedAt: "2026-08-01T00:00:00.000Z" }],
      pages: [
        {
          id: "n1",
          title: "Osmosis",
          kind: "text",
          style: "lined",
          font: "sans",
          html: "<p>private</p>",
          body: "private",
          strokes: [],
          folderId: null,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      todos: [{ id: "t1", text: "read chapter 4", done: false, updatedAt: "2026-08-01T00:00:00.000Z" }],
    },
  },
  meta: { updatedAt: "2026-08-01T00:00:00.000Z" },
};

async function walk(label, isConfigured) {
  const js = await bundleWith(isConfigured);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    runScripts: "outside-only",
    url: "https://www.uniplannerapp.com/",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const complaints = [];
  w.console.error = (...a) => complaints.push(a.join(" "));
  w.console.warn = () => {};

  const calls = spyOn(w);
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
  w.navigator.mediaDevices = {
    getUserMedia: async () => {
      throw new Error("not in this test");
    },
    enumerateDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  w.localStorage.setItem("uni-planner-v1", JSON.stringify(SEED));

  w.eval(js);
  await new Promise((r) => setTimeout(r, 400));

  const doc = w.document;
  const named = (t) => [...doc.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t);

  /* Every screen, because a leak on one screen is a leak. Calendar,
     To-do and Planner are segments inside Plan now, and Folders is a
     view toggle inside Notes, so reaching them means clicking the
     parent first — the same two-step the smoke walk does. */
  const visit = async (name, parent) => {
    if (parent) {
      const p = named(parent);
      if (p) {
        p.click();
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    const b = named(name);
    if (b) {
      b.click();
      await new Promise((r) => setTimeout(r, 120));
    }
    return b;
  };
  for (const [name, parent] of [
    ["Courses", null],
    ["Calendar", "Plan"],
    ["Planner", "Plan"],
    ["To-do", "Plan"],
    ["Study", null],
    ["Notes", null],
    ["Folders", "Notes"],
    ["AI", null],
    ["Settings", null],
  ]) {
    await visit(name, parent);
  }

  /* Then an EDIT, and a wait past the push debounce. Merely rendering
     proves nothing about the write path: the sync effects fire on a
     4000ms timer after `data.meta.updatedAt` changes, which is exactly
     the moment a signed-out planner would go up if the guard were
     missing. */
  await visit("To-do", "Plan");
  await new Promise((r) => setTimeout(r, 150));
  const input = doc.querySelector('input[type="text"], input:not([type])');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
    setter.call(input, "a private thing to do");
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    const add = named("Add");
    if (add) add.click();
  }
  check(!!input, `${label}: the walk found something to type into, so the edit really happened`);

  // Past the 4s push debounce, and past the focus/visibility sync paths.
  w.dispatchEvent(new w.Event("focus"));
  doc.dispatchEvent(new w.Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 5000));

  const describe = calls.map((c) => `${c.channel} -> ${c.target}`).join("\n          ");
  check(
    calls.length === 0,
    `${label}: nothing left the device`,
    calls.length ? `${calls.length} outbound call(s):\n          ${describe}` : null
  );

  // The planner really is on the device, which is the other half of the
  // claim -- "local only" must not be satisfied by saving nothing at all.
  const stored = w.localStorage.getItem("uni-planner-v1") || "";
  check(stored.includes("a private thing to do") || stored.includes("Osmosis"), `${label}: the planner is saved locally`);
  check(complaints.length === 0, `${label}: nothing logged a React error`, complaints[0]);

  w.close();
}

await walk("demo mode (isConfigured false)", false);
/* THE ONE THE QUESTION IS ABOUT: the real build, real Supabase details,
   no account. backend.isDemo is FALSE here. */
await walk("SIGNED OUT on the real build", true);

/* ------------------------------------------------------------------ */
/*  3. Nothing third-party is in the bundle to leak through           */
/* ------------------------------------------------------------------ */

test_thirdParty();
function test_thirdParty() {
  const bundle = fs.readFileSync(path.join(rootDir, "dist-web/app.js"), "utf8");
  const hosts = [...new Set([...bundle.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))];

  /* Derived from config and legalLinks rather than typed here, for the
     usual reason -- a restated allowlist is one host change from being
     wrong about which hosts are ours. w3.org appears as XML namespace
     STRINGS in React and SVG markup; they are identifiers, never
     fetched, which is why they are excused by name rather than
     silently. */
  const config = fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8");
  const ours = new Set();
  for (const m of config.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) ours.add(m[1].toLowerCase());
  const links = fs.readFileSync(path.join(rootDir, "src/legalLinks.js"), "utf8");
  for (const m of links.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) ours.add(m[1].toLowerCase());

  const excused = {
    "www.w3.org": "XML/SVG namespace identifiers, never fetched",
    "reactjs.org": "React's error-decoder URL, printed in a message",
    "github.com": "a comment in supabase-js pointing at a discussion",
    localhost: "the Capacitor origin check",
  };

  const unexplained = hosts.filter((h) => !ours.has(h) && !excused[h]);
  check(
    unexplained.length === 0,
    "no third-party host is in the shipped bundle",
    unexplained.length ? `unexplained: ${unexplained.join(", ")} — if one of these is analytics, the privacy policy is wrong` : null
  );

  // Named rather than pattern-matched: these are the things that would
  // make "nothing leaves your device" untrue without any code of ours.
  for (const marker of ["google-analytics", "googletagmanager", "sentry.io", "posthog", "mixpanel", "segment.io", "bugsnag", "datadoghq"]) {
    check(!bundle.includes(marker), `no ${marker} in the bundle`);
  }
}

/* ------------------------------------------------------------------ */
/*  4. The claim this file exists to back is still being made         */
/* ------------------------------------------------------------------ */

{
  /* Everything above proves a behaviour. This is what ties it to the
     sentence it is a proof OF -- otherwise the document can be reworded
     into a promise nothing checks, or this file can go on proving
     something the policy no longer says, and neither shows up as a
     failure. The published document is where being quietly wrong costs
     most. */
  const policy = fs.readFileSync(path.join(rootDir, "public/privacy.html"), "utf8").replace(/\s+/g, " ");
  check(
    /without an account/i.test(policy),
    "the policy still has a section about using the app without an account"
  );
  check(
    /never\s+leaves\s+it/i.test(policy) && /nothing reaches us/i.test(policy),
    "the policy still promises nothing leaves the device without an account",
    "the promise this whole file exists to prove has been reworded — re-point the test, or stop claiming it"
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

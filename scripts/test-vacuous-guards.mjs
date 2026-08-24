/* Guards that pass over nothing.

   SIX INSTANCES, AND THEY ARE NOT ALL THE ARTIFACT RULE — which is why
   writing that rule down did not stop them recurring. Two distinct
   classes were being filed under one heading:

   A. READ THE ARTIFACT, NOT THE SOURCE. npm test green at 20 of 21
      files; a tracked coverage directory under a correct gitignore; a
      CSS rule present in the commit and absent from the computed
      output. The guard read the wrong thing.

   B. THE CHECK NEVER EVALUATED ITS CLAIM. A derived set that came back
      empty, so `for (const x of set) assert(...)` passed vacuously; a
      light-mode colour that matched the shell's by coincidence, so the
      comparison could not discriminate; a synchronous runner calling an
      async test, so every assertion inside it ran after the summary was
      printed and the exit code decided. The guard read the right thing
      and then checked nothing.

   Class A has a written rule. Class B did not, and B is the one that
   keeps recurring — it is invisible by construction, because the
   symptom of a vacuous pass is a pass.

   THE RULE: A GREEN GUARD MUST BE ABLE TO SAY WHAT IT CHECKED, and the
   size of that must itself be asserted. An empty set satisfies every
   universal claim made about it. This file makes that mechanical for
   the two shapes a script can detect. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(rootDir, "scripts");
const suites = fs.readdirSync(SCRIPTS).filter((f) => /^test-.*\.mjs$/.test(f));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous — see below");
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}\n        ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Shape 1: a derived set, iterated, never asserted non-empty         */
/* ------------------------------------------------------------------ */

function unguardedSets() {
  const found = [];
  for (const file of suites) {
    const lines = fs.readFileSync(path.join(SCRIPTS, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/matchAll|\.filter\(|readdirSync/.test(line)) return;
      const m = /const\s+(\w+)\s*=/.exec(line);
      if (!m) return;
      const name = m[1];
      const ahead = lines.slice(i, i + 12).join("\n");
      const iterated = new RegExp(
        `for\\s*\\(const\\s+\\w+\\s+of\\s+${name}\\b|${name}\\.forEach|${name}\\.every|${name}\\.some`
      ).test(ahead);
      if (!iterated) return;
      const guarded = new RegExp(
        `assert\\.ok\\([^)]*${name}\\.length|assert\\.(equal|ok)\\([^;]*${name}\\.length\\s*[>=]|${name}\\.length\\s*[>=]{1,2}\\s*[1-9]`
      ).test(ahead);
      if (!guarded) found.push(`${file}:${name}`);
    });
  }
  return found.sort();
}

/* THE GRANDFATHERED SET, and it may only ever SHRINK.

   Twelve sites already iterate a derived set without asserting it
   found anything. They are not all wrong — some sets are legitimately
   allowed to be empty — but none of them SAYS so, and telling those
   apart means reading twelve guards, which is its own change.

   So this is the coverage-ratchet arrangement: the number is today's,
   it is asserted as a ceiling, and new code cannot add to it. Lower it
   when you fix one; a guard that gains a non-empty assertion, or an
   excuse written into its own file, drops off this list on its own. */
const GRANDFATHERED = 12;

test("no NEW guard iterates a set it never proved was non-empty", () => {
  const found = unguardedSets();
  assert.ok(
    found.length <= GRANDFATHERED,
    `${found.length} derived sets are iterated without a non-empty assertion, and the ceiling is ` +
      `${GRANDFATHERED}. An empty set satisfies every claim made about it, so a guard that finds ` +
      `nothing reports success. New:\n  ${found.join("\n  ")}`
  );
});

test("the grandfathered ceiling is not stale — lower it when you fix one", () => {
  /* A ratchet nobody tightens is a ceiling, not a ratchet. This fails
     when the real number drops below the recorded one, which is the
     moment to record the improvement rather than bank it silently. */
  const found = unguardedSets();
  assert.ok(
    found.length >= GRANDFATHERED,
    `only ${found.length} unguarded sets remain and GRANDFATHERED still says ${GRANDFATHERED} — ` +
      "lower it in scripts/test-vacuous-guards.mjs so the improvement holds"
  );
});

/* ------------------------------------------------------------------ */
/*  Shape 2: a synchronous runner handed an async test                 */
/* ------------------------------------------------------------------ */

test("no synchronous runner can report an async test green", () => {
  /* THE SIXTH INSTANCE. test-site.mjs's runner is `function test(name,
     fn) { fn(); passed++ }`. Hand it an `async () => {}` and it gets a
     promise, throws nothing, counts a pass, and every assertion inside
     runs after the summary is printed and the exit code decided — a
     failure surfaces as an unhandled rejection, if at all. Three tests
     were reported green before they could assert anything.

     A runner that awaits is fine. A runner that does not must REFUSE a
     thenable rather than ignore it. */
  const offenders = [];
  for (const file of suites) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
    /* Three safe shapes, and the detector has to know all of them or it
       flags the fix as the bug — which it did on the first run, on the
       very file that had just been repaired.

       1. `async function test` / `const test = async` — awaits its
          callee.
       2. A runner that QUEUES and something awaits later: the file
          contains `await fn(`.
       3. A synchronous runner that REFUSES a thenable.

       Anything else calls fn() and drops the promise. */
    const declaresSync = /(^|\n)\s*function\s+(test|check)\s*\(/.test(src);
    if (!declaresSync) continue;
    if (/async\s+function\s+(test|check)\s*\(/.test(src)) continue;
    if (/await\s+fn\s*\(/.test(src)) continue;
    const refuses = /typeof\s+\w+\.then\s*===\s*"function"|instanceof\s+Promise/.test(src);
    if (!refuses) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} declare a synchronous runner that would report an async test as passing ` +
      "whatever it asserts. Make it throw on a thenable, or make the runner await."
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

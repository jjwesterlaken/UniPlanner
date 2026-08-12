/* Mounts the real app in jsdom with NO backend configured and drives the
   Study tab.

   Why this exists: demo mode has shipped a null-dereference crash before,
   and it's the mode hardest to notice breaking -- the app is built and
   used with a configured backend, so a crash that only happens without
   one gets found by users rather than by us. Everything here runs against
   `isConfigured === false`, which is the code path a brand-new user with
   no account takes.

   It's a smoke test, not a UI test: it asserts the screen renders, the
   study features are present, and nothing writes to console.error. React
   reports render-time crashes there, so a null-deref in any new component
   fails this even when the surrounding markup still appears.

   Run via `npm test`. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

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

const tmp = path.join(rootDir, ".smoke-tmp");
fs.mkdirSync(tmp, { recursive: true });

/* Swap config.js for one that reports "no backend", which is what makes
   backend fall through to demoBackend in sync.js. */
const demoConfig = path.join(tmp, "config-demo.js");
fs.writeFileSync(
  demoConfig,
  'export const SUPABASE_URL = "PASTE_YOUR_URL";\n' +
    'export const SUPABASE_ANON_KEY = "PASTE_YOUR_KEY";\n' +
    "export const isConfigured = false;\n"
);

const bundle = await build({
  entryPoints: [path.join(rootDir, "src/main.jsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  write: false,
  define: { "process.env.NODE_ENV": '"development"' }, // keeps React's warnings on
  plugins: [
    {
      name: "force-demo-config",
      setup(b) {
        b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
      },
    },
  ],
});

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  runScripts: "outside-only",
  url: "https://example.test/",
  pretendToBeVisual: true,
});

// React reports render errors through console.error, so collecting it is
// what turns "it rendered something" into "it rendered without crashing".
const complaints = [];
dom.window.console.error = (...a) => complaints.push(a.join(" "));

/* Seeded BEFORE the bundle runs, because the app reads localStorage on
   mount. One AI lecture note whose content has been moved to its own row.

   That shape only exists for signed-in users -- but demo mode is exactly
   where it is most dangerous, and it is genuinely reachable: sign in on
   one device, let the notes migrate, sign out, and every stub is still in
   the local planner with no client to fetch it. The viewer then calls
   fetchNote with a null Supabase client and the cache with no IndexedDB
   worth speaking of, which is two null-dereferences waiting to happen in
   the mode that has shipped one twice.

   The stub is written by hand rather than built with buildStub() so this
   test breaks if the stored SHAPE changes, not merely if the builder
   does. */
const AI_STUB = {
  id: "ai-note-smoke-1",
  title: "PHYS1001 — Week 3 notes",
  body: "",
  html: "",
  strokes: [],
  style: "lined",
  kind: "text",
  font: "sans",
  folderId: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  aiMeta: {
    course: "PHYS1001",
    week: "3",
    generatedAt: "2026-08-01T00:00:00.000Z",
    activeLanguage: "en",
    remote: true,
    previews: { en: "Newton's second law relates force, mass and acceleration." },
  },
};

dom.window.localStorage.setItem(
  "uni-planner-v1",
  JSON.stringify({
    semester: "Semester 1",
    semesters: { "Semester 1": { pages: [AI_STUB] } },
    meta: { updatedAt: "2026-08-01T00:00:00.000Z" },
  })
);

let threw = null;
try {
  dom.window.eval(bundle.outputFiles[0].text);
} catch (err) {
  threw = err;
}
check(!threw, "the app mounts in demo mode with no backend configured", threw && threw.message);

await new Promise((r) => setTimeout(r, 300));
const doc = dom.window.document;
check((doc.body.textContent || "").length > 0, "it renders something rather than a blank page");

const findButton = (label) =>
  [...doc.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);

const studyTab = findButton("Study");
check(!!studyTab, "the Study tab is reachable");
if (studyTab) {
  studyTab.click();
  await new Promise((r) => setTimeout(r, 200));
  const text = doc.body.textContent || "";
  for (const phrase of ["Your studying", "Study timer", "Class notes", "Study cards", "Weak spots"]) {
    check(text.includes(phrase), `the Study tab shows "${phrase}"`);
  }
  // With nothing studied yet, every stat reads from empty collections --
  // the exact shape that caused the previous demo-mode crash.
  for (const phrase of ["Current streak", "Longest streak", "Cards today"]) {
    check(text.includes(phrase), `stats render from an empty semester: "${phrase}"`);
  }

  /* Batch 4's two Study-tab screens, from an EMPTY semester and signed
     OUT -- which is the state a brand-new user is in, and the state in
     which the allowance is unreadable. The allowance line must simply be
     absent rather than reading as "none left". */
  check(text.includes("Practice questions"), "the practice panel renders from an empty semester");
  check(
    text.includes("Sign in to use the AI study features"),
    "signed out, the practice panel says so rather than showing an unusable control"
  );
  check(
    !text.includes("used all of this month"),
    "an unreadable allowance must never render as an exhausted one — that is a paywall caused by being offline"
  );

  // Batch 2 lands on three tabs; each renders from an empty semester,
  // which is the shape that has crashed demo mode before.
  for (const [tabName, phrases] of [
    ["Courses", ["Grades", "Add assessment", "Semester setup"]],
    ["Planner", ["What's coming", "Assignments"]],
    ["Study", ["Exams"]],
    ["To-do", ["Nothing on the list yet"]],
  ]) {
    const tabButton = findButton(tabName);
    check(!!tabButton, `the ${tabName} tab is reachable`);
    if (tabButton) {
      tabButton.click();
      await new Promise((r) => setTimeout(r, 150));
      const text = doc.body.textContent || "";
      for (const phrase of phrases) {
        check(text.includes(phrase), `${tabName} renders "${phrase}" from an empty semester`);
      }
    }
  }

  findButton("Study").click();
  await new Promise((r) => setTimeout(r, 150));

  const start = findButton("Start");
  check(!!start, "the study timer offers a Start button");
  if (start) {
    start.click();
    await new Promise((r) => setTimeout(r, 150));
    check(!!findButton("Pause"), "starting the timer switches it to Pause");
  }
}

// Batch 3 lands on three screens. Each has to render from an EMPTY
// semester -- the shape that has crashed demo mode twice before.
for (const [tabName, phrases] of [
  // The reading planner lives inside the Planner tab rather than having
  // one of its own, which is why it is asserted here by its heading.
  ["Planner", ["Weekly reading planner", "No reading planned yet", "Assignments"]],
  ["Notes", ["New note"]],
]) {
  const tabButton = findButton(tabName);
  check(!!tabButton, `the ${tabName} tab is reachable`);
  if (tabButton) {
    tabButton.click();
    await new Promise((r) => setTimeout(r, 150));
    const text = doc.body.textContent || "";
    for (const phrase of phrases) {
      check(text.includes(phrase), `${tabName} renders "${phrase}" from an empty semester`);
    }
  }
}

/* An AI note whose content lives elsewhere, opened with no backend.

   The list must be readable without a network -- it is the first thing on
   screen -- so the preview comes from the stub. Opening it cannot reach
   the row, and the whole point of separating "missing" from "failed" is
   that this says so honestly instead of claiming the note is gone. */
{
  const notes = findButton("Notes");
  if (notes) {
    notes.click();
    await new Promise((r) => setTimeout(r, 150));
    const text = doc.body.textContent || "";
    check(text.includes("PHYS1001 — Week 3 notes"), "a moved AI note still appears in the list");
    check(
      text.includes("Newton's second law relates force, mass and acceleration."),
      "its preview reads from the stub, with no network involved"
    );

    const open = [...doc.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") || "").includes("PHYS1001")
    );
    const row = open || [...doc.querySelectorAll("li")].find((li) => (li.textContent || "").includes("PHYS1001"));
    if (row) {
      (open || row.querySelector("button") || row).click();
      await new Promise((r) => setTimeout(r, 250));
      const viewer = doc.body.textContent || "";
      /* Positive evidence first. "It doesn't say the wrong thing" passes
         just as well when the viewer never opened at all, which is how a
         test ends up asserting nothing. */
      check(viewer.includes("Couldn't load this note"), "an unreachable note says so, rather than rendering blank");
      check(!viewer.includes("was deleted on another device"), "an unreachable note is never reported as deleted");
    }
  }
}

// The reference sheet option, and its editor, from empty.
{
  const notes = findButton("Notes");
  if (notes) {
    notes.click();
    await new Promise((r) => setTimeout(r, 150));
    const newNote = findButton("New note");
    check(!!newNote, "the Notes tab offers a new note");
    if (newNote) {
      newNote.click();
      await new Promise((r) => setTimeout(r, 150));
      const text = doc.body.textContent || "";
      check(text.includes("Reference sheet"), "the note type chooser offers a reference sheet");
      const create = findButton("Create note");
      check(!!create, "the chooser offers Create note");
    }
  }
}

/* Reading a note, then choosing to edit it.

   Walked rather than asserted from source because this is precisely the
   wiring the smoke test exists for: the first attempt at it declared
   `viewId` BELOW the `showList` that reads it, so every render of the
   Notes tab threw while build:web was perfectly happy and every unit
   test passed. Third instance of that exact shape. */
{
  const notes = findButton("Notes");
  if (notes) {
    notes.click();
    await new Promise((r) => setTimeout(r, 150));

    /* The seeded AI note opens in its own read-only viewer, so a typed
       note is needed to exercise the new path. Make one.

       The chooser may already be open from the section above, so this
       tolerates either state -- and CHECKS that it got started, rather
       than skipping silently. An earlier version of this block did skip
       silently and reported nothing at all, which is the way a test ends
       up asserting nothing while looking thorough. */
    const newNote = findButton("New note");
    if (newNote) {
      newNote.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    {
      const create = findButton("Create note");
      check(!!create, "the note chooser is reachable, so the read-only walk can run at all");
      if (create) {
        create.click();
        await new Promise((r) => setTimeout(r, 150));
        const save = findButton("Save note");
        check(!!save, "a new note offers Save note, and a way to abandon it");
        if (save) {
          save.click();
          await new Promise((r) => setTimeout(r, 200));

          // Tapping it should now READ, not edit.
          /* The LAST such row: the seeded AI note is also in this list and
             is first, and it routes to its own viewer -- which would have
             made this walk silently exercise the wrong screen. */
          const rows = [...doc.querySelectorAll("button")].filter(
            (b) => (b.getAttribute("aria-label") || "") === "Edit note"
          );
          const row = rows[rows.length - 1];
          check(rows.length >= 2, "both the seeded AI note and the new typed note are in the list");
          if (row) {
            row.click();
            await new Promise((r) => setTimeout(r, 200));
            const text = doc.body.textContent || "";
            check(!text.includes("Save note"), "tapping a note opens it read-only, not straight into the editor");
            const edit = findButton("Edit");
            check(!!edit, "the read-only view offers Edit");
            check(
              !!doc.querySelector('[aria-label="Back to notes"]'),
              "the read-only view offers a way back to the list"
            );
            check(
              !!doc.querySelector('[aria-label="More options"]'),
              "the ⋯ menu is present while reading, not only while editing"
            );

            if (edit) {
              edit.click();
              await new Promise((r) => setTimeout(r, 200));
              const done = findButton("Done");
              check(!!done, "editing an existing note commits with Done");
              check(!findButton("Cancel"), "there is no discard path on an existing note");
              if (done) {
                done.click();
                await new Promise((r) => setTimeout(r, 200));
                check(
                  !!findButton("Edit"),
                  "Done returns to reading the note rather than dropping to the list"
                );
              }
            }
          }
        }
      }
    }
  }
}

// The build identifier: until this existed there was no way to answer
// "which build is this user running", which is the first question after
// any stale-cache bug. It reads "development" when unstamped, which is
// what this jsdom page is.
{
  const accountTab = findButton("Account");
  check(!!accountTab, "the Account tab is reachable");
  if (accountTab) {
    accountTab.click();
    await new Promise((r) => setTimeout(r, 150));
    const text = doc.body.textContent || "";
    check(text.includes("Version"), "the Account tab shows which build is running");
    check(!text.includes("__BUILD_ID__"), "an unstamped build shows a placeholder to the user");
  }
}

check(complaints.length === 0, "nothing logged a React error or warning", complaints.slice(0, 3).join(" | ").slice(0, 400));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
// The running timer holds an interval open, so close jsdom rather than
// waiting for an event loop that will never drain.
dom.window.close();
process.exit(failed > 0 ? 1 : 0);

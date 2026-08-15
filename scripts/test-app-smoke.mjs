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

/* ---------- faked media, so a recording can actually be driven ----------

   jsdom has no MediaRecorder and no getUserMedia, so without these the
   recording flow is untestable and the one path a real student takes --
   start, leave the tab, stop from the indicator, save -- would be
   covered by nothing.

   AudioContext is deliberately LEFT UNDEFINED. buildGraph then returns
   null and the recorder falls back to the raw stream, which is the
   documented fallback and worth exercising rather than mocking away. */
{
  const w = dom.window;
  const track = (kind) => ({
    kind,
    stop() {
      this.stopped = true;
    },
    addEventListener() {},
    removeEventListener() {},
  });
  const fakeStream = { getTracks: () => [track("audio")], getAudioTracks: () => [track("audio")], getVideoTracks: () => [] };
  w.navigator.mediaDevices = {
    getUserMedia: async () => fakeStream,
    getDisplayMedia: async () => fakeStream,
    enumerateDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = (opts && opts.mimeType) || "audio/webm";
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
      // One chunk, immediately, so stop() has something to assemble.
      setTimeout(() => this.ondataavailable && this.ondataavailable({ data: new w.Blob(["x"], { type: this.mimeType }) }), 0);
    }
    pause() {
      this.state = "paused";
    }
    resume() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      setTimeout(() => this.onstop && this.onstop(), 0);
    }
  }
  w.MediaRecorder = FakeMediaRecorder;
}

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

/* THE FOLDERS TAB, which this walk had never touched.

   It carried a second note editor with its own hand-written save path,
   and in step 4 that path would have written empty html/body/strokes
   over a block-shape note -- losing the content with no error anywhere.
   It now goes through the same NoteView, the same NoteEditor and the
   same noteFields as the Notes tab.

   Walked rather than asserted from source for the usual reason: the
   fault would be in how the screen is assembled, which is the one thing
   testing functions in isolation cannot see. */
{
  const folders = findButton("Folders");
  check(!!folders, "the Folders tab is reachable");
  if (folders) {
    folders.click();
    await new Promise((r) => setTimeout(r, 200));
    const text = doc.body.textContent || "";
    check(text.includes("folder"), "the Folders tab renders from an empty semester");
    check(!!findButton("New folder"), "the Folders tab offers a new folder");

    // Make a folder so the note-browsing half is reachable at all.
    findButton("New folder").click();
    await new Promise((r) => setTimeout(r, 150));
    const nameInput = doc.querySelector('input[placeholder="e.g. Lecture notes"]');
    check(!!nameInput, "the folder form offers a name");
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
      setter.call(nameInput, "Biology");
      nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      const create = findButton("Create folder");
      check(!!create, "the folder form offers Create folder");
      if (create) {
        create.click();
        await new Promise((r) => setTimeout(r, 200));
        check((doc.body.textContent || "").includes("Biology"), "the folder was created");
      }
    }

    /* THE DISCARD PATH IS GONE. Reading is the default and there is no
       Cancel -- both were decided for the Notes tab and this screen was
       the last holdout. A note that behaves differently depending on
       which tab you opened it from is two things to learn. */
    check(!findButton("Cancel"), "the Folders tab no longer offers a discard path on a note");
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

      /* STEP 5: two kinds, not three. Typing and handwriting stopped
         being different types of note when the editor became a stack,
         so offering the choice asks a question whose answer no longer
         constrains anything. Asserted from the rendered screen rather
         than the source, because what matters is what a student is
         shown. */
      check(text.includes("Note"), "the chooser offers a plain Note");
      check(!text.includes("Handwritten"), "the chooser NO LONGER offers Handwritten as a separate type");
      check(!text.includes("Typed"), "the chooser NO LONGER offers Typed as a separate type");
      check(text.includes("Lined page") && text.includes("Blank page"), "page style is still choosable");
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

        /* Type something first. An EMPTY new note is deliberately never
           created -- that is what stops "New note, changed my mind"
           leaving litter behind -- so a walk that saved a blank draft
           would find nothing in the list and be right to. */
        const titleInput = doc.querySelector('input[placeholder="Note title"]');
        check(!!titleInput, "the editor offers a title field");
        if (titleInput) {
          const setter = Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            "value"
          ).set;
          setter.call(titleInput, "Osmosis notes");
          titleInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 100));
        }

        const save = findButton("Save note");
        check(!!save, "a new note offers Save note, and a way to abandon it");
        if (save) {
          save.click();
          await new Promise((r) => setTimeout(r, 200));

          // Tapping it should now READ, not edit.
          /* Saving a NEW note lands straight in its read-only view --
             commit() sets viewId when it mints the id -- so there is no
             trip back to the list to make. */
          await new Promise((r) => setTimeout(r, 150));
          const text = doc.body.textContent || "";
          check(text.includes("Osmosis notes"), "the new note was created once it had content");
          check(!findButton("Save note"), "saving a new note leaves the editor");

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
            await new Promise((r) => setTimeout(r, 150));
            const done = findButton("Done");
            check(!!done, "editing an existing note commits with Done");
            check(!findButton("Cancel"), "there is no discard path on an existing note");
            check(
              !doc.querySelector('[aria-label="Back to notes"]'),
              "the back arrow is absent while editing, so Done is the only exit"
            );

            /* THE CASE AUTOSAVE EXISTS FOR: type, then leave without
               pressing anything. The debounce must have committed it. */
            const titleAgain = doc.querySelector('input[placeholder="Note title"]');
            if (titleAgain) {
              const setter2 = Object.getOwnPropertyDescriptor(
                dom.window.HTMLInputElement.prototype,
                "value"
              ).set;
              setter2.call(titleAgain, "Osmosis notes, revised");
              titleAgain.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
              // Longer than AUTOSAVE_MS, and nothing is clicked.
              await new Promise((r) => setTimeout(r, 1600));
              const saved = JSON.parse(dom.window.localStorage.getItem("uni-planner-v1") || "{}");
              const pages = ((saved.semesters || {})["Semester 1"] || {}).pages || [];
              check(
                pages.some((pg) => pg.title === "Osmosis notes, revised"),
                "content typed and then abandoned without pressing anything survives"
              );
            }

            if (findButton("Done")) {
              findButton("Done").click();
              await new Promise((r) => setTimeout(r, 200));
              check(!!findButton("Edit"), "Done returns to reading the note rather than dropping to the list");
            }
          }
        }
      }
    }
  }

  /* THE GATED AI NOTES TAB NAMES ITS TOOLS. Discoverable-but-gated:
     a signed-out or demo student must learn both tools exist, not meet
     a bare needs-account line -- a feature nobody can see is absence.
     The demo walk is exactly the state that sees this screen. */
  {
    const aiTab = findButton("AI Notes");
    check(!!aiTab, "the AI Notes tab is reachable");
    if (aiTab) {
      aiTab.click();
      await new Promise((r) => setTimeout(r, 200));
      const text = doc.body.textContent || "";
      check(text.includes("Record a lecture"), "the gated tab names the lecture recorder");
      check(text.includes("Summarise a reading"), "the gated tab names the reading summariser");
      check(text.includes("needs an account"), "and says an account is what unlocks them");
      // Back to Notes -- the accordion walk below expects its rows.
      findButton("Notes").click();
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /* THE ACCORDION. The old pattern rendered an opened note either
     instead of the list or below the whole list -- and "below the whole
     list" is off-screen on a long list, so tapping a note appeared to
     do nothing. The claims that replace it, by name: the note opens IN
     ITS ROW, the LIST STAYS VISIBLE around it, and the chevron closes
     what it opened. */
  {
    // The walk above leaves the new note expanded. Collapse everything first.
    const openChevron = doc.querySelector('[aria-label="Collapse note"]');
    if (openChevron) {
      openChevron.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    const expanders = [...doc.querySelectorAll('[aria-label="Expand note"]')];
    check(expanders.length >= 2, "the list shows rows with chevrons, not pencils", `saw ${expanders.length}`);
    check(!doc.querySelector('[aria-label="Edit note"]'), "the pen has left the row — editing is chosen inside the note");

    if (expanders.length >= 2) {
      /* Expand the TYPED note, not the AI stub -- an AI lecture note is
         read-only by design and has no Edit, so it would pass the wrong
         claim and fail the right one. */
      const typedRow = [...doc.querySelectorAll("[data-note-row]")].find((li) => (li.textContent || "").includes("Osmosis"));
      const chev = typedRow ? typedRow.querySelector('[aria-label="Expand note"]') : expanders[0];
      chev.click();
      await new Promise((r) => setTimeout(r, 200));
      const text = doc.body.textContent || "";
      check(!!doc.querySelector('[aria-label="Collapse note"]'), "an expanded note offers its collapse control");
      check(
        [...doc.querySelectorAll('[aria-label="Expand note"]')].length >= 1,
        "THE LIST STAYS VISIBLE while a note is open — other rows are still on screen"
      );
      check(!!findButton("Edit"), "the expanded note opens read-only, with Edit inside it");

      doc.querySelector('[aria-label="Collapse note"]').click();
      await new Promise((r) => setTimeout(r, 150));
      check(!doc.querySelector('[aria-label="Collapse note"]'), "the chevron collapses what it opened");
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

/* ------------------------------------------------------------------ */
/*  The audio source picker, mounted on its own                       */
/* ------------------------------------------------------------------ */

/* The tab walk cannot reach this: AiNotesPanel refuses to render
   without a real account, which demo mode by definition does not have.
   So it is mounted directly, against the capability sets that differ --
   otherwise the one new screen in this change is the only screen with
   no render coverage, which is where every wiring fault here has lived.

   The bundle is rebuilt exposing the pieces on window rather than
   importing the JSX from Node, which cannot parse it. */
{
  /* The network layer, faked. Aliased into the probe bundle the same way
     config.js is aliased for demo mode -- so the recording flow runs end
     to end without a server, and what is being tested is our own state
     machine rather than fetch. */
  const clientStub = path.join(tmp, "client-stub.js");
  fs.writeFileSync(
    clientStub,
    "export const fetchUsage = async () => ({ unavailable: true });\n" +
      /* Steerable per probe: default unknown (never gates), and a test
         flips it to the definitive no to watch the paywall replace the
         controls -- through the REAL Recorder, not a re-implementation. */
      "export const fetchRecordingAccess = async () => globalThis.__recordingAccess || { unknown: true };\n" +
      "export const uploadAudio = async () => ({ path: 'u/k.webm' });\n" +
      // Records its arguments, so the test can assert the form fields
      // reached the REQUEST rather than inferring it from the output.
      "export const callAiNotes = async (args) => {\n" +
      "  globalThis.__aiCalls = [...(globalThis.__aiCalls || []), args];\n" +
      "  return {\n" +
      "  summaryFailed: false,\n" +
      "  translated: null,\n" +
      "  original: { overview: 'What the lecture covered', keyPoints: ['a point'],\n" +
      "    terms: [{ term: 'Entropy', content: 'A measure of disorder' }], assessable: [], openQuestions: [] },\n" +
      "  };\n};\n"
  );

  const probe = path.join(tmp, "probe.jsx");
  fs.writeFileSync(
    probe,
    'import { createRoot } from "react-dom/client";\n' +
      'import { AudioSourcePicker } from "../src/aiNotes.jsx";\n' +
      'import { SummariseReading, SummariseNote } from "../src/aiText.jsx";\n' +
      'import { useState } from "react";\n' +
      'import { AiNotesPanel, useRecordingSession, RecordingIndicator } from "../src/aiNotes.jsx";\n' +
      'import { describeCapabilities } from "../src/audioSources.js";\n' +
      "window.__probe = (env, source) => {\n" +
      '  const host = document.createElement("div");\n' +
      "  document.body.appendChild(host);\n" +
      "  createRoot(host).render(\n" +
      "    <AudioSourcePicker caps={describeCapabilities(env)} source={source}\n" +
      "      setSource={() => {}} deviceId={null} setDeviceId={() => {}} />\n" +
      "  );\n" +
      "  return host;\n" +
      "};\n" +
      /* AI Notes, SIGNED IN and past consent. The tab walk cannot reach
         this: AiNotesPanel returns "needs a real signed-in account" in
         demo mode, which is the only mode the walk runs in -- so the
         whole panel, RecoveryGate and Recorder included, has never been
         rendered by anything automated. That is how a bare `folders`
         reached a real device.

         `backend` is faked to the minimum the panel reads. Nothing here
         touches the network: no session token is valid, so the usage
         badge's fetch simply fails, which is the state a phone in a
         lecture theatre is in anyway. */
      /* A miniature of the real app: a tab switcher with the session
         hoisted ABOVE it, exactly as PlannerApp holds it. That shape is
         the thing under test -- the panel must be able to unmount
         without the recording going with it. */
      "function Harness({ consented, sink }) {\n" +
      '  const [tab, setTab] = useState("ai-notes");\n' +
      "  const recording = useRecordingSession({\n" +
      '    session: { token: "t", user: { id: "u" } },\n' +
      "    folders: sink.folders,\n" +
      "    addItem: (k, item) => sink[k].push(item),\n" +
      "    setData: () => {},\n" +
      "  });\n" +
      "  sink.api = recording;\n" +
      "  return (\n" +
      "    <>\n" +
      '      <button data-t="notes" onClick={() => setTab("notes")}>Go to notes</button>\n' +
      '      {tab === "ai-notes" && (\n' +
      '        <AiNotesPanel session={{ token: "t", user: { id: "u" } }} backend={{ isDemo: false }}\n' +
      "          courses={[{ id: 'c1', name: 'PHYS1001' }]} setData={() => {}} recording={recording}\n" +
      "          data={{ meta: consented ? { aiConsent: { version: 99 } } : {} }} />\n" +
      "      )}\n" +
      '      {tab === "notes" && <p>Another tab entirely</p>}\n' +
      '      <RecordingIndicator recording={recording} onOpen={() => setTab("ai-notes")} />\n' +
      "    </>\n" +
      "  );\n" +
      "}\n" +
      "window.__probeAiNotes = (consented) => {\n" +
      '  const host = document.createElement("div");\n' +
      "  document.body.appendChild(host);\n" +
      "  const sink = { pages: [], notes: [], folders: [], api: null };\n" +
      "  host.__sink = sink;\n" +
      "  createRoot(host).render(<Harness consented={consented} sink={sink} />);\n" +
      "  return host;\n" +
      "};\n" +
      "window.__probeSummariseNote = (page) => {\n" +
      '  const host = document.createElement("div");\n' +
      "  document.body.appendChild(host);\n" +
      "  createRoot(host).render(\n" +
      '    <SummariseNote session={{ token: "t", user: { id: "u" } }} page={page}\n' +
      "      allowanceApi={{ allowance: { tier: \"free\", limit: 10, used: 0, remaining: 10, fraction: 0, isFree: true }, applyFraction: () => {} }}\n" +
      "      onSummarised={() => {}} />\n" +
      "  );\n" +
      "  return host;\n" +
      "};\n" +
      "window.__probeReading = (allowance, reading, summaryPage) => {\n" +
      '  const host = document.createElement("div");\n' +
      "  document.body.appendChild(host);\n" +
      "  createRoot(host).render(\n" +
      '    <SummariseReading session={{ token: "t", user: { id: "u" } }} reading={reading}\n' +
      "      summaryPage={summaryPage} allowanceApi={{ allowance, applyFraction: () => {} }}\n" +
      "      onSummarised={() => {}} onOpenSummary={() => {}} onAcceptConsent={() => {}} />\n" +
      "  );\n" +
      "  return host;\n" +
      "};\n"
  );

  const probeBundle = await build({
    entryPoints: [probe],
    bundle: true,
    format: "iife",
    jsx: "automatic",
    write: false,
    absWorkingDir: rootDir,
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "probe-stubs",
        setup(b) {
          b.onResolve({ filter: /(^|\/)config\.js$/ }, () => ({ path: demoConfig }));
          b.onResolve({ filter: /aiNotesClient\.js$/ }, () => ({ path: clientStub }));
        },
      },
    ],
  });

  let probeThrew = null;
  try {
    dom.window.eval(probeBundle.outputFiles[0].text);
  } catch (err) {
    probeThrew = err;
  }
  check(!probeThrew, "the audio source picker bundles and evaluates", probeThrew && probeThrew.message);

  if (!probeThrew) {
    const mac = {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      isCapacitor: false,
      hasGetDisplayMedia: true,
      hasEnumerateDevices: false,
    };
    const firefox = { ...mac, userAgent: "Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0" };

    const macHost = dom.window.__probe(mac, "system");
    const ffHost = dom.window.__probe(firefox, "microphone");
    await new Promise((r) => setTimeout(r, 200));

    const macText = macHost.textContent || "";
    check(macText.includes("Microphone"), "the picker renders its options");
    check(
      macText.includes("browser tab"),
      "macOS is warned about tab-only capture BEFORE the share dialog opens",
      macText.slice(0, 200)
    );

    const ffText = ffHost.textContent || "";
    check(
      ffText.includes("Chrome or Edge"),
      "an unavailable source is shown with its reason rather than hidden",
      ffText.slice(0, 200)
    );
    check(
      (ffHost.querySelectorAll("button[disabled]") || []).length > 0,
      "the source that cannot work is disabled, not merely explained"
    );

    /* Summarising a reading, mounted the same way and for the same
       reason: it is gated on a real session, so the demo-mode tab walk
       cannot reach it either. */
    const allowance = { tier: "free", limit: 10, used: 0, remaining: 10, fraction: 0, isFree: true };
    const reading = { id: "r1", course: "PHYS1001", week: "3", pages: "ch. 4" };

    /* Collapsed is the state that ships on every reading row, so it is
       the one that has to be one quiet line rather than a panel. */
    const collapsed = dom.window.__probeReading(allowance, reading, null);
    const summarised = dom.window.__probeReading(allowance, reading, {
      id: "note-1",
      aiMeta: { sourceReadingId: "r1" },
    });
    await new Promise((r) => setTimeout(r, 200));

    const collapsedText = collapsed.textContent || "";
    check(collapsedText.includes("Summarise this"), "an un-summarised reading offers the action", collapsedText.slice(0, 200));

    /* SUMMARISE-THIS-NOTE, probed for the first time — and the reason it
       was not probed before is the process answer to the first live
       regression: it is gated on a real session, so the demo-mode walk
       never mounted it, and step 3's reader audit was scoped to
       PlannerApp.jsx while its gate lives in aiText.jsx. When step 4b
       started writing body as "" on converted notes, the one reader
       nothing had moved to the accessors made the feature vanish for
       exactly the notes students edit.

       Both shapes, because the converted one is the shape every edited
       note now has and the legacy one is every untouched note. */
    const legacyNote = { id: "sn1", kind: "text", title: "T", body: "Water moves down its gradient.", html: "<p>Water moves down its gradient.</p>", strokes: [] };
    const convertedNote = {
      id: "sn2", kind: "text", title: "T", body: "", html: "", strokes: [],
      blocks: [{ id: "sn2:t0", type: "text", html: "<p>Water moves down its gradient.</p>", body: "Water moves down its gradient." }],
    };
    const emptyNote = { id: "sn3", kind: "text", title: "T", body: "", html: "", strokes: [], blocks: [] };
    const snLegacy = dom.window.__probeSummariseNote(legacyNote);
    const snConverted = dom.window.__probeSummariseNote(convertedNote);
    const snEmpty = dom.window.__probeSummariseNote(emptyNote);
    await new Promise((r) => setTimeout(r, 200));
    check((snLegacy.textContent || "").includes("Summarise this note"), "a legacy note with content offers Summarise this note");
    check(
      (snConverted.textContent || "").includes("Summarise this note"),
      "A CONVERTED NOTE STILL OFFERS SUMMARISE THIS NOTE",
      "the gate is reading the legacy body field, which 4b writes as empty"
    );
    check(!(snEmpty.textContent || "").includes("Summarise this note"), "a genuinely empty note offers nothing");
    check(!collapsedText.includes("Paste"), "the paste box stays shut until asked for");
    check(
      (summarised.textContent || "").includes("Summarised"),
      "a reading that already has a summary says so instead",
      (summarised.textContent || "").slice(0, 200)
    );

    /* Opened: the whole panel, in the row. */
    const opener = [...collapsed.querySelectorAll("button")][0];
    opener.click();
    await new Promise((r) => setTimeout(r, 200));
    const openText = collapsed.textContent || "";
    check(openText.includes("Summarise a reading"), "opening it reveals the panel inline", openText.slice(0, 200));
    check(
      openText.includes("isn't stored") || openText.includes("not stored"),
      "it says up front that the pasted text isn't kept",
      openText.slice(0, 250)
    );
    /* Nothing pasted yet, so nothing has been priced. The estimate must
       not appear (or read as zero) before there is anything to price. */
    check(!openText.includes("characters"), "no cost is quoted before anything is pasted");

    /* THE AI NOTES PANEL, signed in and past consent.

       Every wiring fault this repo has shipped has been caught only by
       mounting the real thing, and this is the fifth of exactly this
       shape: correct logic, wrong assembly. A bare `folders` in
       RecoveryGate crashed the whole panel for every signed-in user on
       every platform, and nothing automated could see it because the
       walk runs in demo mode, where the panel returns early. */
    const gate = dom.window.__probeAiNotes(false);
    const panel = dom.window.__probeAiNotes(true);
    await new Promise((r) => setTimeout(r, 250));

    check(
      (gate.textContent || "").includes("Before you use the AI features"),
      "signed in without consent, the panel shows the consent gate",
      (gate.textContent || "").slice(0, 200)
    );
    check(
      (panel.textContent || "").includes("Start recording"),
      "signed in and past consent, the recorder renders",
      (panel.textContent || "").slice(0, 300)
    );
    check(
      (panel.textContent || "").includes("Record from"),
      "the audio source picker is reachable through the real panel, not only on its own"
    );
    check(
      (panel.textContent || "").includes("Summarise a reading"),
      "the reading summariser has a first-class home on the panel, beside the recorder"
    );
    check(
      !!panel.querySelector("select") && (panel.textContent || "").includes("Week"),
      "a standalone launch offers course and week pickers, since no reading row pre-fills them"
    );

    /* Photographed pages, through the real panel: open the standalone
       tool and the photo controls are there, with the never-stored
       promise and the quality expectation IN VIEW before anything is
       taken. (Capture itself needs a camera; what a walk can assert is
       that the door and the promises render.) */
    {
      const openBtn = [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Summarise this"));
      check(!!openBtn, "the standalone reading tool offers its open control");
      if (openBtn) {
        openBtn.click();
        await new Promise((r) => setTimeout(r, 200));
        const t = panel.textContent || "";
        check(t.includes("Add photos of the pages"), "the reading tool offers photographed pages");
        check(t.includes("photograph the pages") || t.includes("Or photograph"), "the photos option is labelled");
        check(!!panel.querySelector("textarea"), "pasting is still offered beside photos");
      }
    }

    /* The free-tier gate, through the real Recorder. The probes above
       ran with the tier UNKNOWN, and the recorder rendered -- which is
       itself the never-gate half of the design. Now the definitive no:
       the controls go and the plan message replaces them. */
    globalThis.__recordingAccess = undefined;
    dom.window.__recordingAccess = { canRecord: false };
    const paywalled = dom.window.__probeAiNotes(true);
    await new Promise((r) => setTimeout(r, 250));
    check(
      (paywalled.textContent || "").includes("Lecture recording is part of the AI plan"),
      "a definitively free account is told BEFORE recording, not after the lecture",
      (paywalled.textContent || "").slice(0, 300)
    );
    check(
      !(paywalled.textContent || "").includes("Start recording"),
      "the record controls are gone for a definitively free account, not merely disabled"
    );
    dom.window.__recordingAccess = undefined;

    /* ---------- THE ONE THAT MATTERS ----------

       Start a recording in AI Notes, switch tabs so the panel unmounts,
       press Stop ON THE INDICATOR, and check the note lands with the
       right course, week, translation setting and folder.

       This is the path a student in a classroom actually takes, and it
       crosses everything that moved: the hoisted session, the form
       fields read at stop time, the upload driver, and Save at app
       level. If any of those still lived in the panel, the recording
       would have died with it and this would go red. */
    {
      const sink = panel.__sink;
      const btn = (label) => [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").trim().includes(label));
      const setField = (el, value) => {
        const proto = value === "" || isNaN(Number(value)) ? dom.window.HTMLSelectElement : dom.window.HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      };

      /* Fill the form through the real controls, not by poking state. */
      const selects = [...panel.querySelectorAll("select")];
      const courseSel = selects.find((el) => (el.textContent || "").includes("PHYS1001"));
      const translateSel = selects.find((el) => (el.textContent || "").includes("English only"));
      setField(courseSel, "PHYS1001");
      setField(panel.querySelector('input[type="number"]'), "7");
      setField(translateSel, "es");
      await new Promise((r) => setTimeout(r, 60));

      btn("Start recording").click();
      await new Promise((r) => setTimeout(r, 120));
      check(sink.api.state.status === "recording", "recording starts", sink.api.state.status);

      /* Leave. This is the tap that used to destroy the lecture. */
      [...panel.querySelectorAll("button")].find((b) => b.dataset.t === "notes").click();
      await new Promise((r) => setTimeout(r, 120));
      check(
        (panel.textContent || "").includes("Another tab entirely"),
        "the student can leave AI Notes while recording"
      );
      check(
        sink.api.state.status === "recording",
        "the recording survives the panel unmounting",
        sink.api.state.status
      );
      check((panel.textContent || "").includes("Recording your lecture"), "the indicator shows the state from another tab");

      /* Stop, from the indicator, without going back. */
      const stopBtn = [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Stop");
      check(!!stopBtn, "stop is one tap away from another tab");
      stopBtn.click();
      await new Promise((r) => setTimeout(r, 300));

      check(sink.api.state.status === "review", "stopping from another tab runs the upload", sink.api.state.status);

      await sink.api.onSave();
      await new Promise((r) => setTimeout(r, 120));

      const page = sink.pages[0];
      check(!!page, "the note is saved");
      if (page) {
        check(page.aiMeta.course === "PHYS1001", "the course survived the tab switch", JSON.stringify(page.aiMeta));
        check(page.aiMeta.week === "7", "the week survived the tab switch", JSON.stringify(page.aiMeta));
        /* Asserted on the REQUEST, not the note: the stub returns no
           translated copy, so activeLanguage correctly stays "en". What
           matters is that a choice made before the tab switch reached
           the call made after it. */
        const call = (dom.window.__aiCalls || [])[0];
        check(call && call.translateTo === "es", "the translation choice survived the tab switch", JSON.stringify(call));
        check(call && call.course === "PHYS1001", "the course reached the request, not just the note");
        check(!!page.folderId, "the note is filed into its course folder");
        check(sink.folders.length === 1, "the course folder was created", JSON.stringify(sink.folders));
      }
      check(sink.notes.length > 0, "the study cards are saved with it");
    }

    /* Consent is enforced at the point of use, and by showing the gate
       rather than by hiding the action -- a feature nobody can see is
       not consent, it is absence. */
    const gated = dom.window.__probeReading(allowance, reading, null);
    await new Promise((r) => setTimeout(r, 100));
    check(
      (gated.textContent || "").includes("Summarise this"),
      "the action is offered even before consent has been given"
    );
  }
}

check(complaints.length === 0, "nothing logged a React error or warning", complaints.slice(0, 3).join(" | ").slice(0, 400));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
// The running timer holds an interval open, so close jsdom rather than
// waiting for an event loop that will never drain.
dom.window.close();
process.exit(failed > 0 ? 1 : 0);

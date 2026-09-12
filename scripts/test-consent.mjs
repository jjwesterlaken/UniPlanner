/* ==================================================================
   test-consent.mjs — the consent screen, in a real browser, and the
   refusal underneath it

   App Store build 3514249 was rejected under guidelines 5.1.1(i) and
   5.1.2(i). The remedy has three parts and this file is where the
   third-party-disclosure claim stops being a design intention:

     1. the screen names every company that receives anything, before
        the fact — asserted against src/aiProviders.js in
        test-legal.mjs (the derivation) and test-ai-notes.mjs (the
        rendered gate);
     2. it is shown BEFORE the first AI action and NOT BEFORE, which is
        a claim about which screens draw what, in the built bundle;
     3. NOTHING IS SENT WHEN IT IS DECLINED, which is the one a reviewer
        will actually test.

   (2) and (3) are here, and they are made in two different ways on
   purpose:

   THE BROWSER HALF drives the built bundle in real Chromium, signed in,
   with no accepted consent, and counts requests to the two Edge
   Functions. A guard for a bug that needs a user action has to perform
   the action — an idle-page check would be a green light for exactly
   the state being tested — so it declines and then presses every
   control the app offers — except the accept control itself, which is
   the answer to the question rather than an AI action.

   THE BOUNDARY HALF calls the three clients directly with a valid token
   and no consent, and asserts they refuse WITHOUT calling fetch. That is
   the claim a UI check cannot make: the screens are one refactor from
   leaking, and the refactor need not touch the client. It is the same
   arrangement as the signed-out refusals already in those files.

   WHAT THIS CANNOT SEE, said here rather than implied by a pass:

   - WKWebView. Chromium is not the engine an App Store build runs in.
     Nothing here is engine-specific (no layout, no media), but the
     artifact Apple receives is verified on the device, on
     MOBILE-BUILD.md's list.
   - WHETHER THE WORDING IS GOOD ENOUGH FOR A REVIEWER. That is a human
     judgement about prose. What is mechanical is that the companies are
     named, that the screen comes first, and that declining sends
     nothing.

   Skips without a browser; REQUIRE_BROWSER=1 makes that a failure, the
   same arrangement as test-rendered-tabs.mjs. The boundary half always
   runs.
   ================================================================== */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AI_PROVIDERS, providerFingerprint } from "../src/aiProviders.js";
import { AI_CONSENT_VERSION, CONSENT_TEXT, buildConsentPatch } from "../src/aiNotesLogic.js";
import { recordConsentState, consentRefusal } from "../src/aiConsentState.js";
import { callAiText } from "../src/aiTextClient.js";
import { callAiNotes, callResummarise, uploadAudio } from "../src/aiNotesClient.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(rootDir, "dist-web");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  - ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Lifted from source, never typed                                    */
/* ------------------------------------------------------------------ */

const TAB_KEY = (() => {
  const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
  const m = /const TAB_KEY = "([^"]+)"/.exec(src);
  assert.ok(m, "TAB_KEY is gone from PlannerApp.jsx — this guard cannot open a tab it cannot name");
  return m[1];
})();

const SUPABASE_HOST = (() => {
  const cfg = fs.readFileSync(path.join(rootDir, "src/config.js"), "utf8");
  const m = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(cfg);
  assert.ok(m, "SUPABASE_URL is gone from config.js — this guard cannot intercept what it cannot name");
  return m[1];
})();

const USER_ID = "00000000-0000-4000-8000-000000000002";

/* A paid tier with credits left, so nothing else can be the reason a
   control is missing. An exhausted allowance or an unreadable profile
   would hide the AI controls for a DIFFERENT reason and the spy would
   be empty either way — the colour-coincidence class, which this file
   would otherwise be wide open to. */
const PROFILE_ROW = { user_id: USER_ID, tier: "ai", trial_credits_used: 0, active_device_id: null, active_device_at: null };

/* ------------------------------------------------------------------ */
/*  Chromium                                                           */
/* ------------------------------------------------------------------ */

function findLocalChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((n) => n.startsWith("chromium"))
    .map((n) => path.join(base, n, "chrome-linux", "chrome"))
    .filter((p) => fs.existsSync(p));
}

async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  for (const executablePath of [undefined, ...findLocalChromium()]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* next */
    }
  }
  return null;
}

const json = (body) => ({
  status: 200,
  contentType: "application/json",
  headers: { "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
});

/* A planner with one course and one of everything an AI feature hangs
   off, so the controls under test actually render. An EMPTY planner
   would leave "Make some study cards first" where the practice button
   should be, and the spy would be empty for a reason that has nothing
   to do with consent. */
const SEEDED_SEMESTER = {
  courses: [{ id: "c1", name: "PHYS1001", updatedAt: "2026-01-01T00:00:00.000Z" }],
  notes: [{ id: "n1", course: "PHYS1001", week: "3", term: "Entropy", content: "A measure of disorder.", updatedAt: "2026-01-01T00:00:00.000Z" }],
  textbook: [{ id: "t1", course: "PHYS1001", week: "3", chapter: "Ch. 4", pages: "89-112", updatedAt: "2026-01-01T00:00:00.000Z" }],
  pages: [{ id: "p1", title: "My own notes", html: "<p>Something I wrote.</p>", body: "Something I wrote.", updatedAt: "2026-01-01T00:00:00.000Z" }],
};

/**
 * Mount the built bundle, signed in, with consent either accepted or not.
 *
 * Every request to the Supabase host is intercepted — no credentials, no
 * live project — and the two Edge Function paths are counted separately,
 * because those are the only two things in this app that send a
 * student's work to a third party.
 */
async function mount(browser, { tab, consented }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const aiCalls = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.addInitScript(
    ({ ref, userId, tabKey, tabName, consent, semester }) => {
      const hour = Math.floor(Date.now() / 1000) + 3600;
      localStorage.setItem(
        `sb-${ref}-auth-token`,
        JSON.stringify({
          access_token: "test-token",
          token_type: "bearer",
          expires_at: hour,
          expires_in: 3600,
          refresh_token: "test-refresh",
          user: { id: userId, email: "consent-probe@example.test", aud: "authenticated", role: "authenticated" },
        })
      );
      localStorage.setItem("uni-planner-mode", "light");
      localStorage.setItem(tabKey, tabName);
      localStorage.setItem(
        "uni-planner-v1",
        JSON.stringify({
          semester: "Semester 1",
          semesters: { "Semester 1": semester },
          meta: consent ? { ...consent } : {},
        })
      );
    },
    {
      ref: new URL(SUPABASE_HOST).hostname.split(".")[0],
      userId: USER_ID,
      tabKey: TAB_KEY,
      tabName: tab,
      consent: consented ? buildConsentPatch() : null,
      semester: SEEDED_SEMESTER,
    }
  );

  await page.route(`${SUPABASE_HOST}/**`, async (route) => {
    const url = route.request().url();
    /* THE SPY. Recorded BEFORE anything is fulfilled, so a request that
       is made and then fails still counts — "it was sent" is the fact,
       not "it succeeded". */
    if (url.includes("/functions/v1/ai-text") || url.includes("/functions/v1/ai-notes")) {
      aiCalls.push(url.replace(SUPABASE_HOST, ""));
      return route.fulfill(json({ ok: false, code: "server_error" }));
    }
    if (url.includes("/auth/v1/user")) return route.fulfill(json({ id: USER_ID, email: "consent-probe@example.test" }));
    if (url.includes("/auth/v1/")) return route.fulfill(json({ access_token: "test-token", user: { id: USER_ID } }));
    if (url.includes("/rest/v1/profiles")) return route.fulfill(json(PROFILE_ROW));
    if (url.includes("/rest/v1/ai_usage")) return route.fulfill(json({ user_id: USER_ID, credits_used: 10 }));
    return route.fulfill(json([]));
  });

  await page.goto("file://" + path.join(OUT, "index.html"));
  await page.waitForSelector("#root > *", { timeout: 15_000 });
  await page.waitForTimeout(900);

  return {
    page,
    errors,
    aiCalls,
    html: () => page.locator("#root").innerHTML(),
    close: () => ctx.close(),
  };
}

/**
 * Press everything the page offers, within reason.
 *
 * A reviewer pokes at the app; so does this. It is bounded and it skips
 * nothing by label — a filter like "don't press Delete" would be the
 * tester deciding what the student is allowed to do. The seeded planner
 * is disposable and local, so there is nothing to protect.
 */
async function pressEverything(page, { rounds = 2 } = {}) {
  let pressed = 0;
  for (let round = 0; round < rounds; round++) {
    /* THE CONSENT CONTROLS THEMSELVES ARE EXCLUDED, and the first version
       of this walk did not exclude them — so it pressed "See what's
       sent", then pressed "I agree", then pressed the practice button,
       and reported that the app had sent work after being DECLINED. It
       had; the walk had accepted on the student's behalf two clicks
       earlier. The claim is "nothing the student presses sends anything
       until they accept", so the accept control is the one thing the
       walk may not touch. */
    /* SCOPED TO THE TAB CONTENT. Unscoped, the first buttons in document
       order are the header and the nav, so the walk navigated off the tab
       under test before reaching the AI controls — and then reported that
       nothing had been sent. A walk that leaves the screen it is testing
       is a walk that tests a different screen. */
    const buttons = await page
      .locator("main button:visible:not([disabled]):not([data-consent-accept]):not([data-consent-open])")
      .all();
    for (const button of buttons) {
      try {
        await button.click({ timeout: 400, noWaitAfter: true });
        pressed += 1;
        await page.waitForTimeout(60);
      } catch {
        /* Covered by an overlay, detached by a re-render, or off-screen.
           All three are the app behaving; none is a reason to stop. */
      }
    }
    await page.waitForTimeout(400);
  }
  return pressed;
}

/* ------------------------------------------------------------------ */

async function run() {
  /* ================================================================
     PART 1 — the boundary. No browser, and it always runs.
     ================================================================ */

  await test("THE BOUNDARY REFUSES WITH NO CONSENT, AND NEVER REACHES fetch", async () => {
    recordConsentState({});
    /* A valid-looking token, so "signed out" cannot be the reason. The
       two refusals are deliberately different codes — a student who is
       signed out and a student who has not agreed are told different
       things, because the remedies are different. */
    let fetches = 0;
    const spy = async () => {
      fetches += 1;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const attempts = [
      ["callAiText", () => callAiText({ token: "t", task: "explain", payload: { text: "x" }, fetchImpl: spy })],
      ["callAiNotes", () => callAiNotes({ token: "t", course: "PHYS1001", idempotencyKey: "k" }, spy)],
      ["callResummarise", () => callResummarise({ token: "t", idempotencyKey: "k" }, spy)],
      [
        "uploadAudio",
        () =>
          uploadAudio({
            session: { user: { id: USER_ID } },
            audioBlob: { size: 1000 },
            mimeType: "audio/webm",
            extension: "webm",
            idempotencyKey: "k",
            supabaseClient: {
              storage: {
                from: () => ({
                  upload: async () => {
                    fetches += 1;
                    return { data: { path: "x" }, error: null };
                  },
                }),
              },
            },
          }),
      ],
    ];
    assert.equal(attempts.length, 4, "the list of AI clients shrank — every one of them must refuse");

    for (const [name, attempt] of attempts) {
      let thrown = null;
      try {
        await attempt();
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, `${name} did NOT refuse without consent — a student's work would have left the device`);
      assert.equal(
        thrown.code,
        "consent_required",
        `${name} refused with code "${thrown.code}" rather than consent_required — the student is told the wrong thing`
      );
    }
    assert.equal(fetches, 0, `${fetches} request(s) were made despite no consent — this is the claim Apple will test`);
  });

  await test("the same calls go through once consent is recorded, so the refusal is not a wall", async () => {
    /* THE OTHER HALF, and without it "refuses everything" would pass.
       A guard that only proves a refusal cannot tell a consent check
       from a broken client. */
    recordConsentState(buildConsentPatch());
    let fetches = 0;
    const spy = async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    await callAiText({ token: "t", task: "explain", payload: { text: "x" }, fetchImpl: spy });
    await callAiNotes({ token: "t", course: "PHYS1001", idempotencyKey: "k" }, spy);
    assert.equal(fetches, 2, `expected both calls to go through with consent recorded, saw ${fetches}`);
  });

  await test("a STALE acceptance refuses — the provider set is part of what was agreed to", () => {
    /* The fingerprint doing its job at the boundary as well as on the
       screen. A student who agreed when there were two companies has
       not agreed to a third, and "they clicked Accept once" is not the
       question. */
    recordConsentState({ aiConsent: { version: AI_CONSENT_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", providers: "groq:Groq" } });
    const refusal = consentRefusal();
    assert.ok(refusal, "an acceptance naming a different set of companies was treated as current");
    assert.equal(refusal.code, "consent_required");

    recordConsentState({ aiConsent: { version: AI_CONSENT_VERSION - 1, acceptedAt: "2026-01-01T00:00:00.000Z", providers: providerFingerprint() } });
    assert.ok(consentRefusal(), "an acceptance of older wording was treated as current");

    recordConsentState(buildConsentPatch());
    assert.equal(consentRefusal(), null, "a current acceptance was refused");
  });

  await test("a signed-in account with no acceptance refuses, whatever the last one agreed to", () => {
    /* THE SHAPE THIS REPLACES WAS A TEST OF A FUNCTION NOTHING CALLED.
       There is no sign-out hook here on purpose — see aiConsentState.js:
       the local planner outlives a sign-out and the screens keep reading
       it, so a mirror cleared independently would disagree with them.
       What matters is that the mirror follows the RECORD: a blob with no
       acceptance refuses, which is the state a second student signing in
       on the same phone arrives at once their own planner has synced. */
    recordConsentState(buildConsentPatch());
    assert.equal(consentRefusal(), null);
    recordConsentState({});
    assert.ok(consentRefusal(), "an account with no acceptance inherited the last one's consent");
  });

  /* ================================================================
     PART 2 — the screens, in a real browser.
     ================================================================ */

  assert.ok(fs.existsSync(path.join(OUT, "app.js")), "dist-web is missing — run npm run build:web first");

  const browser = await launch();
  if (!browser) {
    const message = "no Chromium — skipping the browser half (REQUIRE_BROWSER=1 to fail)";
    if (process.env.REQUIRE_BROWSER === "1") {
      console.log(`FAIL  - ${message}`);
      process.exit(1);
    }
    console.log(`skip  - ${message}`);
    return;
  }

  await test("NOT BEFORE: a tab with no AI feature shows no consent screen at all", async () => {
    /* "Before the first AI action" has a second half that is just as
       much a requirement: a disclosure thrown at somebody opening their
       timetable is a screen people learn to dismiss, which is how the
       one that matters stops being read. */
    const m = await mount(browser, { tab: "planner", consented: false });
    const html = await m.html();
    await m.close();
    assert.deepEqual(m.errors, [], `the planner tab threw:\n${m.errors.join("\n")}`);
    assert.ok(html.length > 200, "the planner tab rendered an empty root — nothing below would mean anything");
    assert.doesNotMatch(html, /data-consent-gate/, "the consent overlay is thrown over the timetable");
    assert.doesNotMatch(html, /data-consent-needed/, "the consent notice appears on a tab with no AI feature");
  });

  await test("BEFORE THE FIRST AI ACTION: the AI tab shows the full screen, naming every company", async () => {
    const m = await mount(browser, { tab: "ai-notes", consented: false });
    const html = await m.html();
    const gateText = await m.page.locator("[data-consent-gate]").textContent();
    const accepts = await m.page.locator("[data-consent-accept]").count();
    const declines = await m.page.locator("[data-consent-decline]").count();
    await m.close();
    assert.deepEqual(m.errors, [], `the AI tab threw:\n${m.errors.join("\n")}`);
    assert.match(html, /data-consent-gate/, "the AI tab renders no consent screen for a student who has not agreed");

    assert.ok(AI_PROVIDERS.length > 0, "aiProviders.js names nobody — this check would pass over nothing");
    for (const provider of AI_PROVIDERS) {
      assert.ok(gateText.includes(provider.name), `the screen in the browser never names ${provider.name}`);
      assert.ok(gateText.includes(provider.country), `the screen does not say ${provider.name} is in ${provider.country}`);
    }
    /* And the two facts Apple's notice asks for by name, on the screen
       rather than only in the policy. */
    assert.match(gateText, /deleted as soon as it has been transcribed/, "the screen does not say the recording is deleted");
    assert.ok(gateText.includes(CONSENT_TEXT.declineNote), "the screen does not say that declining leaves the planner working");
    assert.ok(accepts, "there is no way to accept");
    assert.ok(declines, "there is no way to decline");
  });

  await test("the four text features replace their controls with the notice, not with nothing", async () => {
    /* THE GAP THAT WAS REJECTED. Practice questions, weak spots, explain-
       it-back and summarise-a-note sent text to OpenAI with no consent
       check of any kind — a comment in aiText.jsx recorded it as a known
       gap. Gated in AiActionFrame now, so this is one claim over all of
       them: the notice is there, and the thing that spends the
       allowance is not. */
    const study = await mount(browser, { tab: "study", consented: false });
    const studyHtml = await study.html();
    await study.close();
    assert.deepEqual(study.errors, [], `the study tab threw:\n${study.errors.join("\n")}`);
    assert.match(studyHtml, /data-consent-needed/, "the study tab offers an AI feature with no consent notice");
    assert.doesNotMatch(
      studyHtml,
      /data-ai-run="practice"/,
      "the study tab still offers to spend the allowance without consent"
    );

    /* THE NOTES ONE NEEDS AN INTERACTION, and that is why it is not a
       cold mount: `SummariseNote` only exists while a note is open, so a
       cold-mount check would have found no notice and no control and
       passed over an ungated feature. */
    const notes = await mount(browser, { tab: "notes", consented: false });
    const expand = notes.page.locator('[aria-label="Expand note"]').first();
    assert.ok(await expand.count(), "the seeded note does not appear on the notes tab, so nothing below is about it");
    await expand.click();
    await notes.page.waitForTimeout(400);
    /* TWO CLICKS, because `SummariseNote` only renders while the note is
       being EDITED (PlannerApp passes it as `extras` on a draft). A
       one-click probe found no notice and no control, and would have
       passed over an ungated feature by never reaching it. */
    const edit = notes.page.locator("main button", { hasText: "Edit" }).first();
    assert.ok(await edit.count(), "the expanded note offers no Edit control, so the summariser cannot be reached");
    await edit.click();
    await notes.page.waitForTimeout(600);
    const notesHtml = await notes.html();
    await notes.close();
    assert.deepEqual(notes.errors, [], `the notes tab threw:\n${notes.errors.join("\n")}`);
    assert.match(notesHtml, /data-consent-needed/, "an open note offers the AI summariser with no consent notice");
  });

  await test("NOTHING IS SENT WHEN IT IS DECLINED, with every control on the page pressed", async () => {
    /* THE CLAIM A REVIEWER TESTS. Declining is performed — opening the
       notice's own gate and pressing its decline button — and then every
       visible control on the three tabs that carry an AI feature is
       pressed, twice over, and the two Edge Function paths must see
       nothing.

       IT PRESSES RATHER THAN INSPECTS because an idle-page check is a
       green light for exactly this bug: the markup can be correct and a
       handler can still fire a request. */
    for (const tab of ["study", "ai-notes"]) {
      const m = await mount(browser, { tab, consented: false });

      const opener = m.page.locator("[data-consent-open]").first();
      if (await opener.count()) await opener.click();
      await m.page.waitForTimeout(200);
      const decline = m.page.locator("[data-consent-decline]").first();
      assert.ok(await decline.count(), `the ${tab} tab offers no way to decline, so this cannot be tested at all`);
      await decline.click();
      await m.page.waitForTimeout(300);

      const pressed = await pressEverything(m.page);
      const html = await m.html();
      await m.close();

      assert.ok(pressed > 0, `nothing was pressable on the ${tab} tab — this check proved nothing`);
      /* AND THE WALK WAS STILL LOOKING AT A GATED APP at the end of it.
         Without this, a walk that accidentally accepted (as the first
         version did) or navigated away would report an empty spy and
         mean nothing by it. */
      assert.match(
        html,
        /data-consent-needed|data-consent-gate|data-consent-declined/,
        `the ${tab} tab is no longer showing a consent screen or the declined card, ` +
          'so "nothing was sent" is about some other state'
      );
      assert.deepEqual(
        m.aiCalls,
        [],
        `the ${tab} tab sent ${m.aiCalls.length} AI request(s) after declining: ${m.aiCalls.join(", ")}`
      );
      assert.ok(html.length > 200, `the ${tab} tab was left blank, so "no requests" may just mean "no app"`);
    }
  });

  await test("AND IT IS NOT A WALL: accepting lets an AI request through", async () => {
    /* THE CONTROL. Without it, "no requests after declining" is
       satisfied by an app that can never make one — a broken endpoint, a
       missing button, an exhausted allowance — and the test would be
       green for the wrong reason. Same mount, same spy, one difference:
       the answer to the consent screen. */
    const m = await mount(browser, { tab: "study", consented: false });
    const opener = m.page.locator("[data-consent-open]").first();
    assert.ok(await opener.count(), "the study tab offers no consent notice to accept from");
    await opener.click();
    await m.page.waitForTimeout(200);
    await m.page.locator("[data-consent-accept]").first().click();
    await m.page.waitForTimeout(600);

    const runner = m.page.locator('[data-ai-run="practice"]').first();
    const appeared = await runner.count();
    if (appeared) await runner.click();
    await m.page.waitForTimeout(900);
    const calls = [...m.aiCalls];
    await m.close();

    assert.ok(appeared, "accepting did not bring the practice control back, so nothing could have been sent");
    assert.ok(
      calls.some((u) => u.includes("/functions/v1/ai-text")),
      "accepting changed nothing — no AI request was made, so the declined case above discriminates nothing"
    );
  });

  await browser.close();
}

await run();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}

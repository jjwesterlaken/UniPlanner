/* Shared plumbing for the three journeys: the test account, the seed,
   and the reset that keeps that account from accumulating anything.

   THE ACCOUNT. A dedicated Supabase account, nobody's real planner.
   Credentials arrive via TEST_ACCOUNT_EMAIL / TEST_ACCOUNT_PASSWORD —
   GitHub repo secrets in CI, a local .env for a developer who has
   them. Missing credentials SKIP the journeys locally and FAIL them in
   CI (REQUIRE_E2E=1), the same arrangement as the migration tests and
   for the same reason: a suite that quietly stops running is worse
   than none.

   WHY THE DATA CANNOT ACCUMULATE. Every run starts by resetting the
   account to the seed below — reset at the START, not the end, so a
   crashed run cannot leave residue for the next one to trip over:

   - planner_data is ONE row per user, upserted. Overwritten each run.
   - ai_notes rows for the user are deleted, then exactly one is
     recreated by the app itself during journey 2.
   - semester_archives rows are deleted; journey 3 creates one.
   - ai_notes_requests is never written: the journeys call no Edge
     Function, so nothing is billed and no transcript rows exist.
   - Auth sessions accumulate refresh-token rows server-side; those
     expire on Supabase's own schedule and are not ours to manage.

   The one deliberate divergence from production data: ids minted here
   use the app's own base36 shape (see uidish), because journey 2
   exists to walk the exact path that was broken for eleven days — a
   client-minted base36 id crossing into the ai_notes id column. */

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../src/config.js";

export const EMAIL = process.env.TEST_ACCOUNT_EMAIL || "";
export const PASSWORD = process.env.TEST_ACCOUNT_PASSWORD || "";
export const REQUIRED = process.env.REQUIRE_E2E === "1";

export const haveCreds = () => Boolean(EMAIL && PASSWORD);

/* The strings the journeys type and then look for. Distinctive enough
   that a match can only be our own write. */
export const NOTE_TEXT = "E2E persistence check typed in a real browser against the real backend.";
export const NOTE_TITLE = "E2E journey note";
export const TODO_TEXT = "E2E seeded todo, restored with the semester";
export const AI_NOTE_TITLE = "BIOL120 — Week 3 lecture (e2e)";
export const AI_OVERVIEW =
  "This lecture walked through the Krebs cycle step by step, naming each intermediate and why it is examinable.";

/* The app's own id shape (uid() in PlannerApp) — base36, NOT a UUID.
   That format crossing into ai_notes.id is the eleven-day bug; the
   journey re-walks it on purpose, so this must not become a UUID. */
const uidish = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

export function buildSeed() {
  const at = new Date().toISOString();
  const aiNoteId = `e2e${uidish()}`;
  const item = (extra) => ({ id: uidish(), updatedAt: at, ...extra });
  return {
    aiNoteId,
    data: {
      semester: "Semester 1",
      meta: { updatedAt: at },
      semesters: {
        "Semester 1": {
          courses: [item({ name: "BIOL120" })],
          todos: [item({ text: TODO_TEXT, done: false })],
          notes: [item({ course: "BIOL120", week: "3", term: "Krebs cycle", content: "The cycle that yields NADH and FADH2." })],
          pages: [
            /* A PRE-MOVE AI lecture note: content still in aiMeta, no
               `remote` flag. The app's own sync migrates it — insert
               into ai_notes (base36 id), stub written back, content
               fetched by row thereafter. Journey 2 asserts each step
               from the outside. */
            {
              id: aiNoteId,
              title: AI_NOTE_TITLE,
              kind: "text",
              style: "lined",
              font: "sans",
              folderId: null,
              body: "",
              html: "",
              strokes: [],
              updatedAt: at,
              aiMeta: {
                course: "BIOL120",
                week: "3",
                generatedAt: at,
                activeLanguage: "en",
                translations: {
                  en: {
                    overview: AI_OVERVIEW,
                    keyPoints: [
                      "Each turn of the cycle releases two carbons as CO2, which is why acetyl-CoA input matters.",
                      "The lecturer flagged the succinate to fumarate step as examinable, with the FAD reasoning.",
                    ],
                    terms: [{ term: "Oxaloacetate", definition: "The four-carbon acceptor that starts each turn." }],
                    openQuestions: [],
                  },
                },
              },
            },
          ],
          settings: [{ id: "settings-1", start: "", breaks: [], rounding: "half-up", updatedAt: at }],
        },
        "Semester 2": {},
      },
    },
  };
}

export function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Sign the test account in and return {client, userId}. Throws with a
    one-line diagnosis, because "the wall of trace" for a dead account
    helps nobody. */
export async function signedInClient() {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !data || !data.user) {
    throw new Error(
      `test account sign-in failed (${(error && error.message) || "no user"}). ` +
        "Check the TEST_ACCOUNT_EMAIL / TEST_ACCOUNT_PASSWORD secrets, and that the account's email is confirmed."
    );
  }
  return { client, userId: data.user.id };
}

/** The reset: the account back to the seed, rows cleared. Returns the
    seed so the journeys know the ids and strings in play. */
export async function resetAccount() {
  const { client, userId } = await signedInClient();
  const seed = buildSeed();

  const del = async (table) => {
    const { error } = await client.from(table).delete().eq("user_id", userId);
    if (error) throw new Error(`reset: clearing ${table} failed: ${error.message}`);
  };
  await del("ai_notes");
  await del("semester_archives");

  const { error } = await client
    .from("planner_data")
    .upsert({ user_id: userId, data: seed.data, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(`reset: seeding planner_data failed: ${error.message}`);

  await client.auth.signOut();
  return { seed, userId };
}

/** Poll the database until `check` returns truthy. The journeys wait on
    real network effects (a 4s push debounce, a sync-triggered
    migration), so waiting on the DATA beats guessing at a sleep. */
export async function pollDb(label, check, { timeoutMs = 60_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  for (;;) {
    try {
      const out = await check();
      if (out) return out;
    } catch (e) {
      lastErr = e && e.message ? ` (last error: ${e.message})` : "";
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${lastErr}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

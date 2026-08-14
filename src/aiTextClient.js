/* ==================================================================
   aiTextClient.js — calling ai-text, and knowing the cost beforehand

   Two jobs, and the first one is the interesting half.

   `fetchTextAllowance` reads the student's tier and this month's usage
   DIRECTLY, under RLS, with no Edge Function call and no cost. Both
   tables have select-own policies (migration 0001), so this is a plain
   scoped read — which is what makes "show what's left before the work"
   free rather than a round trip per screen.

   That is the whole reason it isn't a `task: "status"` on the endpoint:
   an endpoint call to ask a question the database already answers is a
   cold start and a network hop for every screen that mounts.
   ================================================================== */

import { supabase, backend } from "./sync.js";
import { SUPABASE_URL } from "./config.js";
import { allowanceState } from "./aiTextLimits.js";

const currentMonthKey = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Where this account stands, before anything is typed.
 *
 * `unavailable` rather than an error on failure: this drives an
 * informational line, and a student who is offline should see the
 * feature without a scary banner about a number. The server re-checks
 * the allowance regardless, so being wrong here costs nothing but a
 * rejection they would have got anyway.
 */
export async function fetchTextAllowance(session, { supabaseClient = supabase, isDemo = backend.isDemo } = {}) {
  if (!session || isDemo || !supabaseClient) return { unavailable: true };

  const month = currentMonthKey();
  const [{ data: profile }, { data: usage }] = await Promise.all([
    supabaseClient.from("profiles").select("tier").eq("user_id", session.user.id).maybeSingle(),
    supabaseClient
      .from("ai_usage")
      .select("text_units_used")
      .eq("user_id", session.user.id)
      .eq("month", month)
      .maybeSingle(),
  ]);

  if (!profile) return { unavailable: true };
  return {
    unavailable: false,
    ...allowanceState({ tier: profile.tier, unitsUsed: (usage && usage.text_units_used) || 0 }),
  };
}

/** Call the ai-text endpoint. Throws with `code` set, so copy can be looked up. */
export async function callAiText({ token, task, payload = {}, fetchImpl = fetch }) {
  /* THE GATE IS HERE, not only on the screen that calls this.
     Every text feature is hidden behind `session &&` in the UI, which
     is correct and is also one refactor away from being wrong: a
     signed-out student's typing would leave the device before anything
     rejected it, and "nothing leaves your device without an account" is
     a claim in the privacy policy, not a preference.

     `unauthenticated` deliberately reuses the server's own code, so the
     student sees the wording that already exists for being signed out
     rather than a new sentence nobody has read. */
  if (!token) {
    const err = new Error("You need to be signed in to use the AI study features.");
    err.code = "unauthenticated";
    err.stage = "client";
    throw err;
  }
  const res = await fetchImpl(`${SUPABASE_URL}/functions/v1/ai-text`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task, ...payload }),
  });

  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* a non-JSON body is a gateway problem, handled below */
  }

  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && json.error) || "Something went wrong.");
    // The CODE is what the app renders copy from, so a missing one
    // becomes server_error rather than an empty message.
    err.code = (json && json.code) || "server_error";
    err.stage = json && json.stage;
    throw err;
  }
  return json;
}

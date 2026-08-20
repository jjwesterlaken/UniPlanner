// ai-text — one endpoint, five tasks, no user content read from the
// database.
//
// See config.ts for why that last clause is the security posture rather
// than a simplification. In short: `ai-notes` shipped a cross-user
// disclosure because it looked up a row by a caller-supplied identifier
// and the service-role client bypasses RLS. This function never looks
// anything up by a caller-supplied identifier. The client sends the
// text — it already has it — and the only user table touched is
// `ai_usage`, only ever the caller's own row.
//
// The stage sequence is deliberate and one ordering is load-bearing:
//
//   env_check -> client_init -> auth_user -> tier_lookup -> validate
//     -> allowance   <- READS the database
//     -> provider    <- SPENDS money
//     -> billing     <- WRITES the database
//
// `allowance` reads `ai_usage.credits_used` BEFORE `provider` runs.
// That is what makes migration 0006 fail free: if the column is missing,
// the read fails and the request errors having spent nothing. Reordering
// these two turns a clean error into "the student is charged for work
// they were then told failed." A test asserts the order.

import { corsHeaders, jsonResponse } from "../ai-notes/_shared/cors.ts";
import { supabaseAdmin, getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { failureLine, stageLine } from "../ai-notes/diagnostics.js";
import { validateRequest, checkTextAllowance, allowanceFraction } from "./guards.js";
import { buildMessages, parseTaskResult } from "./prompts.js";
import { openaiTextAdapter } from "./openai.ts";
import {
  TASKS,
  MAX_TOKENS,
  MAX_INPUT_CHARS,
  PHOTOS_PER_CHUNK,
  MAX_IMAGE_BASE64_CHARS,
  PRACTICE_MAX_CARDS,
  WEAKSPOTS_MAX_TOPICS,
  TASK_CREDITS,
  TEXT_TIERS,
  MAX_READING_CHUNKS,
  creditsForTier,
} from "./config.ts";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "ai-text"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  console.error(failureLine(stage, err, extra, "ai-text"));

const errorResponse = (stage: string, code: string, error: string, status: number) =>
  jsonResponse({ ok: false, code, stage, error }, status);

function currentMonthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"];

/**
 * The handler, exported so scripts/test-ai-text-function.mjs can drive
 * the real thing against fakes rather than reimplementing it. Same
 * arrangement as ai-notes, and it is what caught the IDOR there.
 */
export async function handle(req: Request, deps: Record<string, unknown> = {}) {
  const admin = (deps.supabaseAdmin as typeof supabaseAdmin) || supabaseAdmin;
  const summarizer = (deps.summarizer as typeof openaiTextAdapter) || openaiTextAdapter;
  const env = (deps.env as (n: string) => string | undefined) || ((n: string) => Deno.env.get(n));
  const now = (deps.now as () => Date) || (() => new Date());

  let stage = "env_check";
  try {
    const missing = REQUIRED_ENV.filter((n) => !env(n));
    if (missing.length) {
      // Names which are absent, never their values.
      logFailure(stage, new Error(`missing env: ${missing.join(", ")}`));
      return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
    }

    stage = "client_init";
    if (!deps.supabaseAdmin) {
      try {
        getSupabaseAdmin();
      } catch (err) {
        logFailure(stage, err);
        return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
      }
    }

    stage = "auth_user";
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return errorResponse(stage, "unauthenticated", "Please sign in again.", 401);

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      logFailure(stage, userErr || new Error("no user on a token that verified"));
      return errorResponse(stage, "unauthenticated", "Please sign in again.", 401);
    }
    const userId = userData.user.id;

    stage = "tier_lookup";
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("tier")
      .eq("user_id", userId)
      .maybeSingle();
    // A broken query and an absent row are told apart, so a database
    // fault doesn't get reported to everyone as "your account isn't
    // enabled" and send them looking in the wrong place.
    if (profileErr) {
      logFailure(stage, profileErr);
      return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
    }
    // One constant, deliberately: see TEXT_TIERS in config.ts. Which
    // tiers get these features is a product decision, and nothing in the
    // four screens branches on it, so changing it is one line here.
    if (!profile || !TEXT_TIERS.includes(profile.tier)) {
      logStage(stage, { outcome: "not_entitled" });
      return errorResponse(stage, "no_access", "AI study help isn't enabled for your account yet.", 403);
    }

    stage = "validate";
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (e) {
      return errorResponse(stage, "bad_request", "That request wasn't valid.", 400);
    }
    const valid = validateRequest({
      body,
      tasks: TASKS as unknown as string[],
      maxInputChars: MAX_INPUT_CHARS,
      practiceMaxCards: PRACTICE_MAX_CARDS,
      weakspotsMaxTopics: WEAKSPOTS_MAX_TOPICS,
      maxReadingChunks: MAX_READING_CHUNKS,
      photosPerChunk: PHOTOS_PER_CHUNK,
      maxImageBase64Chars: MAX_IMAGE_BASE64_CHARS,
    });
    if (!valid.ok) {
      // `detail` says which rule failed, in the LOG only. The response
      // carries one message for every rejection, so the endpoint never
      // becomes an oracle about what shape it expects.
      logStage(stage, { rejected: valid.code, detail: valid.detail });
      return errorResponse(stage, valid.code, valid.error, valid.code === "too_long" ? 413 : 400);
    }
    const task = valid.task;

    /* ---- allowance: the read that must precede the spend ---- */
    stage = "allowance";
    const month = currentMonthKey(now());
    const { data: usageRow, error: usageErr } = await admin
      .from("ai_usage")
      .select("credits_used")
      .eq("user_id", userId)
      .eq("month", month)
      .maybeSingle();
    if (usageErr) {
      /* This is where a missing `credits_used` column lands — the
         whole reason this read is here and not after the provider call.
         Nothing has been spent at this point. */
      logFailure(stage, usageErr, { hint: "is migration 0012 applied?" });
      return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
    }
    const creditsUsed = usageRow?.credits_used || 0;
    const allowance = checkTextAllowance({
      task,
      creditsUsed,
      taskCredits: TASK_CREDITS,
      monthlyLimit: creditsForTier(profile.tier),
    });
    if (!allowance.ok) {
      logStage(stage, { rejected: allowance.code });
      return errorResponse(stage, allowance.code, allowance.error, 403);
    }

    /* ---- provider: the only step that spends money ---- */
    stage = "provider";
    logStage(stage, { task, maxTokens: MAX_TOKENS[task] });
    let raw: string;
    try {
      raw = await summarizer.complete({
        messages: buildMessages(task, body),
        maxTokens: MAX_TOKENS[task],
        apiKey: env("OPENAI_API_KEY")!,
        // Which MEDIUM this is, not which task — see openai.ts.
        hasImages: Array.isArray(body.images) && body.images.length > 0,
      });
    } catch (err) {
      // Nothing is billed. The call failed, so there is nothing to
      // charge for — unlike ai-notes, where transcription has already
      // succeeded and been paid for by the time summarising runs.
      logFailure(stage, err, { task });
      return errorResponse(stage, "ai_failed", "The AI couldn't finish that. Please try again.", 502);
    }

    stage = "parse";
    let result: unknown;
    try {
      result = parseTaskResult(task, raw);
    } catch (err) {
      /* Billed anyway, deliberately: the tokens were generated and we
         were charged for them. Saying so is the same honesty ai-notes
         applies to a failed summary — the alternative is a silent
         subsidy for whatever made the model produce unusable output,
         which is exactly the case worth noticing. */
      logFailure(stage, err, { task });
      const charged = await bill(admin, { userId, month, cost: allowance.cost });
      if (!charged.ok) logFailure("billing", charged.error, { task, cost: allowance.cost, after: "parse_failure" });
      /* A legibility refusal is not unusable output -- it is the model
         doing what it was told. BILLED, same as any generated output
         (billing follows spend), but under its OWN code carrying which
         pages, because the student can act on it: retake page 3. The
         client copy states both halves -- this attempt used allowance,
         and the resubmit charges again as its own smaller batch. */
      const unreadable = (err as { unreadablePages?: number[] }).unreadablePages;
      if (Array.isArray(unreadable)) {
        return jsonResponse(
          { ok: false, stage, code: "pages_unreadable", error: "Some pages couldn't be read.", pages: unreadable },
          422
        );
      }
      /* A DIFFERENT code from the one above, because these are different
         facts: that one cost the student nothing, this one cost them
         allowance for a result they never saw. The client's wording says
         so -- see AI_TEXT_FAILURES in src/aiTextCopy.js. Charging quietly
         is how a support ticket becomes a chargeback. */
      return errorResponse(stage, "ai_failed_charged", "The AI answered, but the answer came back unusable.", 502);
    }

    stage = "billing";
    const billed = await bill(admin, { userId, month, cost: allowance.cost });
    if (!billed.ok) {
      // Logged loudly and NOT failed to the user: the work is done and
      // they have it. An unbilled success is a revenue hole; an error
      // shown for work that succeeded is a worse one.
      logFailure(stage, billed.error, { task, cost: allowance.cost });
    }

    return jsonResponse({
      ok: true,
      task,
      result,
      /* The app turns this into a sentence. It never receives a unit
         count. The figure is the database's post-increment total when
         the bill landed, and only falls back to the local sum when it
         did not — in which case the number is the best available guess
         about a month whose write just failed. */
      allowanceUsed: allowanceFraction(
        billed.ok && billed.creditsUsed !== null ? billed.creditsUsed : creditsUsed + allowance.cost,
        creditsForTier(profile.tier)
      ),
    });
  } catch (err) {
    logFailure(stage, err);
    return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
  }
}

/**
 * Add this task's cost to the month.
 *
 * Scoped by hand on both keys. The service-role client bypasses RLS, so
 * the `user_id` here is the only thing standing between this and another
 * student's allowance — a mis-scoped write is a takeover rather than a
 * disclosure, and returns nothing to notice it by.
 *
 * THE ADDITION HAPPENS IN THE DATABASE, not here. This used to read the
 * month's total, add the cost in JavaScript, and write the sum back —
 * so two requests that overlapped both read N and both wrote N + cost,
 * and one of them was free. `add_ai_credits` (migration 0012) does the
 * `+` under the row lock that ON CONFLICT DO UPDATE takes, which is the
 * only place it is safe to do. `creditsUsed` is deliberately no longer a
 * parameter: passing it would leave the stale read within reach.
 *
 * It returns the POST-INCREMENT total, so the fraction the student is
 * shown is the one the database holds rather than one computed here
 * from a read that may already be out of date.
 */
// deno-lint-ignore no-explicit-any
async function bill(admin: any, { userId, month, cost }: Record<string, any>) {
  const { data, error } = await admin.rpc("add_ai_credits", {
    p_user_id: userId,
    p_month: month,
    p_credits: cost,
  });
  if (error) return { ok: false, error };
  // `returns table` arrives as an array of one row.
  const row = Array.isArray(data) ? data[0] : data;
  const creditsUsed = row && typeof row.new_credits !== "undefined" ? Number(row.new_credits) : null;
  return { ok: true, creditsUsed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return await handle(req);
});

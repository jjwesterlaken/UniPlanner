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
import { readAllowance, billAllowance, checkPhotoPages, billPhotoPages } from "../_shared/allowance.ts";
import { consentSetMatches, providerFingerprint } from "../_shared/aiProviders.js";
import { stageLine } from "../ai-notes/diagnostics.js";
import { recordFailure } from "../_shared/failureLog.ts";
import { validateRequest, checkTextAllowance, allowanceFraction } from "./guards.js";
import { buildMessages, parseTaskResult } from "./prompts.js";
import { checkRewriteSpan } from "../_shared/essayRewrite.js";
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
  ESSAY_NO_WRITING,
  ESSAY_REWRITE,
  ESSAY_MIN_CONSENT_VERSION,
} from "./config.ts";

const logStage = (stage: string, extra: Record<string, unknown> = {}) => console.log(stageLine(stage, extra, "ai-text"));
// deno-lint-ignore no-explicit-any
const logFailure = (stage: string, err: any, extra: Record<string, unknown> = {}) =>
  recordFailure("ai-text", stage, err, extra);

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
  /* Injectable so a test can drive the essay path end to end with
     thresholds set, while production reads config.ts, where they are
     unset until measured. */
  const essayNoWriting = ("essayNoWriting" in deps ? deps.essayNoWriting : ESSAY_NO_WRITING) as typeof ESSAY_NO_WRITING;
  /* The same arrangement for the example rewrite, whose scope limits are
     null in config.ts until measured. */
  const essayRewrite = ("essayRewrite" in deps ? deps.essayRewrite : ESSAY_REWRITE) as typeof ESSAY_REWRITE;

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
      // The trial counters ride along: for a trial tier they ARE the
      // allowance and the photo cap, so fetching them here costs
      // nothing and saves two queries.
      //
      // MIGRATION 0021 MUST BE APPLIED BEFORE THIS DEPLOYS. PostgREST
      // answers an unknown column with a 400, which lands in
      // `profileErr` below and stops every text AI feature for
      // everybody -- 0015's lesson with a louder failure mode.
      .select("tier, trial_credits_used, trial_photo_pages_used")
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

    /* THE SAME CONSENT CHECK ai-notes MAKES, and the symmetry is the
       reason rather than tidiness. This endpoint has no provider switch —
       changing who summarises is a code change — so the dashboard-flip
       hole the transcription check closes does not exist here. The OTHER
       hole does: a student on an older build, whose consent screen named
       a different set of companies and which therefore never re-prompts,
       sends pasted readings and photographed pages to whoever this
       function now calls. Same student, same claim, so the same refusal.

       Before the allowance read and before the provider call, so nothing
       is spent. `consent_required` is a code the client already has
       wording for, from its own boundary refusal. */
    if (!consentSetMatches((body as { consentProviders?: unknown }).consentProviders)) {
      logStage(stage, { rejected: "consent_required", inForce: providerFingerprint() });
      return errorResponse(
        stage,
        "consent_required",
        "The companies that process AI study help have changed. Please reload the app and read what is sent before trying again.",
        403
      );
    }

    /* ---- the trial's photo cap: before the spend, like the allowance ----

       SAME SIDE OF THE PROVIDER CALL as the allowance read, and for the
       same reason: a refusal here has cost nothing. It is a SEPARATE
       limit from the allowance rather than a tighter one, because 60
       credits buys three batches and a trial that spends itself on
       photographs never demonstrates the lecture recording -- see
       MAX_FREE_PHOTO_PAGES in _shared/credits.ts.

       A PAID TIER NEVER REACHES THE COMPARISON. checkPhotoPages returns
       ok for any tier that is not a trial, so the cap cannot leak onto
       an account that bought a monthly allowance. */
    /* ESSAY FEEDBACK, TWO REFUSALS BEFORE ANYTHING IS SPENT.

       1. NOT ON UNTIL MEASURED. The no-writing thresholds are unset in
          config.ts until they have been read off real output, and without
          them the reply cannot be checked, so the task refuses here, before
          the allowance read, having cost nothing.
       2. CONSENT TO SEND AN ESSAY, which is v8's and no earlier version's.
          The provider check above cannot see it: the companies did not
          change, the material did. An older build sends no version and is
          refused for this task only. */
    if (task === "rewrite" && !essayRewrite) {
      logStage(stage, { rejected: "rewrite_unavailable" });
      return errorResponse(stage, "rewrite_unavailable", "Example rewrites aren't available yet.", 503);
    }
    /* THE REWRITE SENDS PART OF AN ESSAY, so it needs the same consent
       as essay feedback: essay drafts are v8's material, whichever task
       carries them. */
    if (task === "essay" || task === "rewrite") {
      if (task === "essay" && !essayNoWriting) {
        logStage(stage, { rejected: "essay_unavailable" });
        return errorResponse(stage, "essay_unavailable", "Essay feedback isn't available yet.", 503);
      }
      /* A NUMBER, not anything Number() accepts: the client sends the
         integer it recorded, and "8" or true arriving here is not that. */
      const claimed = (body as { consentVersion?: unknown }).consentVersion;
      const accepted = typeof claimed === "number" ? claimed : NaN;
      if (!Number.isInteger(accepted) || accepted < ESSAY_MIN_CONSENT_VERSION) {
        logStage(stage, { rejected: "consent_required", reason: "essay_consent_version", accepted: Number.isFinite(accepted) ? accepted : null });
        return errorResponse(
          stage,
          "consent_required",
          "Essay feedback needs your agreement to what is sent. Please reload the app and read what is sent before trying again.",
          403
        );
      }
    }

    /* ONE PASSAGE, NEVER A SECTION, refused free: nothing is spent yet. */
    if (task === "rewrite" && essayRewrite) {
      const span = checkRewriteSpan({ essay: valid.text, span: (valid as { span?: string }).span || "", limits: essayRewrite });
      if (!span.ok) {
        logStage(stage, { rejected: span.code, detail: span.detail });
        return errorResponse(
          stage,
          span.code,
          span.code === "span_too_long"
            ? "An example rewrite works on one sentence or one paragraph at a time. Pick a shorter passage."
            : "That request wasn't valid.",
          400
        );
      }
    }

    const photoPages = Array.isArray(body.images) ? body.images.length : 0;
    const cap = checkPhotoPages({
      tier: profile.tier,
      pagesUsed: profile.trial_photo_pages_used,
      pages: photoPages,
    });
    if (!cap.ok) {
      logStage(stage, { rejected: cap.code, remaining: cap.remaining, asked: cap.asked });
      return errorResponse(
        stage,
        cap.code,
        /* NAMES WHAT IS LEFT, because that is the only thing the student
           can act on: four pages left is a batch they can still send. */
        cap.remaining > 0
          ? `Your free plan covers ${cap.cap} photographed pages and you have ${cap.remaining} left. ` +
            `Send ${cap.remaining} or fewer, or paste the text instead — pasting is much cheaper and is not capped.`
          : `Your free plan covers ${cap.cap} photographed pages and you've used them. ` +
            `Pasting the text still works and is much cheaper, or upgrade for uncapped photographs.`,
        403
      );
    }

    /* ---- allowance: the read that must precede the spend ---- */
    stage = "allowance";
    const month = currentMonthKey(now());
    const spent = await readAllowance(admin, { userId, profile, month });
    if (!spent.ok) {
      /* This is where a missing `credits_used` column lands — the
         whole reason this read is here and not after the provider call.
         Nothing has been spent at this point. */
      logFailure(stage, spent.error, { hint: "are migrations 0012 and 0014 applied?" });
      return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
    }
    const creditsUsed = spent.used;
    const allowance = checkTextAllowance({
      task,
      creditsUsed,
      taskCredits: TASK_CREDITS,
      monthlyLimit: spent.limit,
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
        task,
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
      result = parseTaskResult(task, raw, {
        text: valid.text,
        criteria: (valid as { criteria?: string }).criteria || "",
        thresholds: essayNoWriting,
        span: (valid as { span?: string }).span || "",
        rewriteLimits: essayRewrite,
      });
    } catch (err) {
      /* Billed anyway, deliberately: the tokens were generated and we
         were charged for them. Saying so is the same honesty ai-notes
         applies to a failed summary — the alternative is a silent
         subsidy for whatever made the model produce unusable output,
         which is exactly the case worth noticing. */
      logFailure(stage, err, { task });
      /* THE EXAMPLE REWRITE IS CHARGED ONLY WHEN IT IS DELIVERED (Jared,
         26 September 2026). A rewrite our own scope check refuses, or one
         that will not parse, costs us about $0.0005 and costs the student
         nothing: the check is ours, so its refusals are ours to absorb.
         Returned BEFORE the billing below, which every other task keeps. */
      if (task === "rewrite") {
        if ((err as { essayRefusal?: string }).essayRefusal === "scope") {
          return jsonResponse({ ok: false, stage, code: "rewrite_refused", error: "The example went outside the passage, so we didn't show it." }, 422);
        }
        return errorResponse(stage, "ai_failed", "The AI couldn't finish that. Please try again.", 502);
      }
      /* AND THE SAME FOR ESSAY FEEDBACK'S NO-WRITING REFUSAL (Jared, 26
         September 2026): "a refusal caused by our own model or checks
         shouldn't cost the student, whatever the feature." The reply
         offered wording and our check stopped it, so the student is not
         charged. Returned before the billing below. */
      if ((err as { essayRefusal?: string }).essayRefusal === "writing") {
        return jsonResponse({ ok: false, stage, code: "writing_refused", error: "The feedback came back in a form we don't show." }, 422);
      }
      const charged = await billAllowance(admin, { userId, profile, month, credits: allowance.cost });
      if (!charged.ok) logFailure("billing", charged.error, { task, cost: allowance.cost, after: "parse_failure" });
      /* THE PAGES COUNT WHEREVER THE CREDITS DO. The provider read them
         and we were charged; a cap that only counted successful runs
         would let unusable output be retried against it for ever. */
      const countedFail = await billPhotoPages(admin, { userId, profile, pages: photoPages });
      if (!countedFail.ok) logFailure("billing", countedFail.error, { pages: photoPages, after: "parse_failure" });
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
    const billed = await billAllowance(admin, { userId, profile, month, credits: allowance.cost });
    if (!billed.ok) {
      // Logged loudly and NOT failed to the user: the work is done and
      // they have it. An unbilled success is a revenue hole; an error
      // shown for work that succeeded is a worse one.
      logFailure(stage, billed.error, { task, cost: allowance.cost });
    }
    /* Credits first, then pages — two writes, because 0021 adds a
       function rather than a parameter. An interruption between them
       leaves a batch billed and uncounted, which is bounded at one
       batch and falls in the student's favour; counting first would
       spend the cap on work that was never billed. */
    const counted = await billPhotoPages(admin, { userId, profile, pages: photoPages });
    if (!counted.ok) logFailure(stage, counted.error, { pages: photoPages });

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
        billed.ok && billed.used !== null ? billed.used : creditsUsed + allowance.cost,
        spent.limit
      ),
    });
  } catch (err) {
    logFailure(stage, err);
    return errorResponse(stage, "server_error", "Something went wrong. Please try again.", 500);
  }
}

/* `bill` used to live here. It is now billAllowance in
   _shared/allowance.ts, because which counter a credit lands in depends
   on the tier — a monthly row in `ai_usage`, or a lifetime column on
   `profiles` — and two copies of that branch is two chances to refill a
   lifetime allowance every month. */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return await handle(req);
});

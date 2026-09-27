/* ==================================================================
   taskCost.js — one row of what an AI request really cost (0024).

   Plain JS with no Deno and no browser APIs, the aiProviders.js
   arrangement, so the rules are Node tests without a bundler.

   THREE RULES, each one a failure it exists to prevent:

   1. IT NEVER THROWS AND NEVER FAILS THE REQUEST. This is a diagnostic
      written after the provider has already been paid. A result the
      student paid for must not be lost because a cost row could not be
      written, so recordTaskCost resolves in every case and reports
      rather than raises.

   2. IT CARRIES NO ACCOUNT AND NO CONTENT. The argument list is closed:
      costArgs builds the RPC's arguments from named fields only, so a
      caller cannot pass a user id or a prompt through by accident — an
      unknown key is simply not read. A test pins the argument names.

   3. A MISSING COUNT IS NULL, NEVER ZERO. A provider call that failed
      before its usage block came back cost an unknown amount, not
      nothing; reading it as zero would make every failure look free and
      pull the weekly average down exactly where the question is
      sharpest. `usd` is null whenever either count is.
   ================================================================== */

/** How long a row lives. The error digest purges to this daily. */
export const AI_TASK_COST_RETENTION_DAYS = 90;

/** The RPC's argument names, in the order 0024 declares them. */
export const COST_ARG_NAMES = Object.freeze([
  "p_fn",
  "p_task",
  "p_medium",
  "p_model",
  "p_prompt_tokens",
  "p_completion_tokens",
  "p_reasoning_tokens",
  "p_max_tokens",
  "p_usd",
  "p_usd_per_credit",
  "p_credits_charged",
  "p_outcome",
  "p_finish_reason",
]);

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** The provider's usage block, as three counts or nulls. OpenAI's shape. */
export function usageCounts(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  return {
    prompt: count(u.prompt_tokens),
    completion: count(u.completion_tokens),
    reasoning: count(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
  };
}

/** What the counts cost at the given per-million rates, or null when either count is unknown. */
export function usdFor(counts, rates) {
  if (counts.prompt === null || counts.completion === null) return null;
  if (!rates || !Number.isFinite(rates.in) || !Number.isFinite(rates.out)) return null;
  return (counts.prompt * rates.in + counts.completion * rates.out) / 1_000_000;
}

/**
 * The RPC arguments for one call. Only these fields are read.
 * `spend` is what the adapter reported: { model, usage, finishReason }.
 */
export function costArgs({ fn = "ai-text", task, hasImages, spend, fallbackModel, maxTokens, rates, usdPerCredit, credits, outcome }) {
  const counts = usageCounts(spend && spend.usage);
  return {
    p_fn: fn,
    p_task: String(task),
    p_medium: hasImages ? "photos" : "text",
    p_model: String((spend && spend.model) || fallbackModel || "unknown").slice(0, 64),
    p_prompt_tokens: counts.prompt,
    p_completion_tokens: counts.completion,
    p_reasoning_tokens: counts.reasoning,
    p_max_tokens: maxTokens,
    p_usd: usdFor(counts, rates),
    p_usd_per_credit: usdPerCredit,
    p_credits_charged: Number.isInteger(credits) && credits > 0 ? credits : 0,
    p_outcome: String(outcome).slice(0, 40),
    p_finish_reason: spend && spend.finishReason ? String(spend.finishReason).slice(0, 32) : null,
  };
}

/** Write it. Resolves {ok:true} or {ok:false, error} and never rejects. */
export async function recordTaskCost(admin, args) {
  try {
    const { error } = await admin.rpc("record_ai_task_cost", args);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

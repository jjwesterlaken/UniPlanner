/* ==================================================================
   guards.js — the logic that decides whether we spend money

   Plain JS, no Deno-only APIs, so this file is imported unmodified by
   both the Edge Function and scripts/test-ai-text-function.mjs. Same
   arrangement as ai-notes/guards.js, and for the same reason: the
   decisions that cost money should be directly testable rather than
   reachable only through a handler.
   ================================================================== */

/**
 * Validate a request body.
 *
 * ONE error shape for every rejection here. There is deliberately no
 * "that isn't yours" outcome to tell apart from "that is malformed" --
 * this endpoint never looks anything up by a caller-supplied id -- but
 * keeping the rejections uniform anyway means a later task that DOES
 * need a lookup starts from the safe shape rather than having to be
 * retrofitted into it.
 */
export function validateRequest({ body, tasks, maxInputChars, practiceMaxCards, weakspotsMaxTopics, maxReadingChunks }) {
  const bad = (detail) => ({ ok: false, code: "bad_request", error: "That request wasn't valid.", detail });

  if (!body || typeof body !== "object") return bad("body is not an object");

  const task = body.task;
  if (typeof task !== "string" || !tasks.includes(task)) return bad("unknown task");

  /* Text is required for the two tasks that work on what the student
     wrote, and forbidden for the two that are built server-side from a
     structured payload. "Forbidden" rather than "ignored": a field that
     is silently dropped is a field someone will one day rely on. */
  const needsText = task === "explain" || task === "summarise";
  const text = typeof body.text === "string" ? body.text : "";

  if (needsText) {
    if (!text.trim()) return bad("text is required for this task");
    if (text.length > maxInputChars[task]) {
      return {
        ok: false,
        code: "too_long",
        // Names the overage. The client refuses before sending, so
        // reaching this means a hand-built request -- but the message
        // still has to be true rather than generic.
        error: `That's ${text.length.toLocaleString()} characters and the limit is ${maxInputChars[
          task
        ].toLocaleString()}. Shorten it and try again.`,
      };
    }
  } else if (text) {
    return bad("text is not accepted for this task");
  }

  if (task === "practice") {
    const cards = body.cards;
    if (!Array.isArray(cards) || cards.length === 0) return bad("cards are required for this task");
    if (cards.length > practiceMaxCards) return bad("too many cards");
    for (const c of cards) {
      if (!c || typeof c.term !== "string" || typeof c.content !== "string") return bad("a card has the wrong shape");
    }
    if (serialisedLength(cards) > maxInputChars.practice) {
      return { ok: false, code: "too_long", error: "That's too many cards at once. Pick fewer and try again." };
    }
  }

  if (task === "merge") {
    const parts = body.parts;
    /* Two is the minimum that means anything: merging one section is a
       call that returns its input having charged for it. The client
       never sends one -- a single-chunk reading skips the merge
       entirely -- so reaching this is a hand-built request, and taking
       money for a no-op would be the worst way to answer it. */
    if (!Array.isArray(parts) || parts.length < 2) return bad("merge needs at least two parts");
    if (parts.length > maxReadingChunks) return bad("too many parts");
    for (const p of parts) {
      if (!p || typeof p !== "object" || typeof p.overview !== "string" || !p.overview.trim()) {
        return bad("a part has the wrong shape");
      }
    }
    if (serialisedLength(parts) > maxInputChars.merge) {
      return { ok: false, code: "too_long", error: "That reading is too long to combine. Try it in two halves." };
    }
  }

  if (task === "weakspots") {
    const topics = body.topics;
    if (!Array.isArray(topics) || topics.length === 0) return bad("topics are required for this task");
    if (topics.length > weakspotsMaxTopics) return bad("too many topics");
    for (const t of topics) {
      if (!t || typeof t.term !== "string" || typeof t.lapses !== "number") return bad("a topic has the wrong shape");
    }
    if (serialisedLength(topics) > maxInputChars.weakspots) {
      return { ok: false, code: "too_long", error: "That's too much at once. Try again with fewer topics." };
    }
  }

  return { ok: true, task, text };
}

const serialisedLength = (value) => {
  try {
    return JSON.stringify(value).length;
  } catch (e) {
    // Circular or otherwise unserialisable: treat as over the cap rather
    // than as zero. Failing closed is the only safe direction for a
    // number that gates a paid call.
    return Infinity;
  }
};

/**
 * Whether this month's allowance covers the task about to run.
 *
 * `unitsUsed` comes from the database read that happens BEFORE the
 * provider call — which is what makes a missing `text_units_used`
 * column fail free rather than after money is spent. See migration
 * 0006.
 */
export function checkTextAllowance({ task, unitsUsed, taskUnits, monthlyLimit }) {
  const cost = taskUnits[task] || 0;
  const projected = (unitsUsed || 0) + cost;
  if (projected > monthlyLimit) {
    return {
      ok: false,
      code: "usage_exceeded",
      error: "You've used all of this month's AI study help.",
      cost,
    };
  }
  return { ok: true, cost, projected };
}

/**
 * How much of the allowance is gone, as a fraction.
 *
 * Returned by the endpoint so the app can say it in words. The app is
 * what decides the wording; this only decides the number, so "never show
 * a student the word units" stays a UI rule enforced in one place rather
 * than a convention spread across four screens.
 */
export function allowanceFraction(unitsUsed, monthlyLimit) {
  if (!(monthlyLimit > 0)) return 0;
  return Math.min(1, Math.max(0, (unitsUsed || 0) / monthlyLimit));
}

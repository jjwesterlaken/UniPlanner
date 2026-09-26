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
export function validateRequest({ body, tasks, maxInputChars, practiceMaxCards, weakspotsMaxTopics, maxReadingChunks, photosPerChunk = 4, maxImageBase64Chars = 700_000 }) {
  const bad = (detail) => ({ ok: false, code: "bad_request", error: "That request wasn't valid.", detail });

  if (!body || typeof body !== "object") return bad("body is not an object");

  const task = body.task;
  if (typeof task !== "string" || !tasks.includes(task)) return bad("unknown task");

  /* Text is required for the two tasks that work on what the student
     wrote, and forbidden for the two that are built server-side from a
     structured payload. "Forbidden" rather than "ignored": a field that
     is silently dropped is a field someone will one day rely on. */
  const needsText = task === "explain" || task === "summarise" || task === "essay";
  const text = typeof body.text === "string" ? body.text : "";
  /* THE CRITERIA are the essay task's second input and nobody else's.
     Forbidden elsewhere, for the reason given above. */
  const criteria = typeof body.criteria === "string" ? body.criteria : "";
  if (task !== "essay" && body.criteria !== undefined) return bad("criteria are only accepted for essay");

  /* PHOTOGRAPHED PAGES: `summarise` and no other task, one MEDIUM per
     request (text XOR images -- a mixed request has no honest ordering
     and no client sends one), one BATCH per request (the client batches
     photos the way it chunks text, so the batch cap here is the whole
     size story). Each image is a data-URL of a raster format; the
     prefix is checked because whatever follows it is relayed to a paid
     provider, and the length cap is what stops an un-downscaled
     original -- the client never sends one, so over-length means a
     hand-built request. */
  const images = Array.isArray(body.images) ? body.images : null;
  if (images && task !== "summarise") return bad("images are only accepted for summarise");
  if (images && text) return bad("one medium per request: text or images, not both");
  if (images) {
    if (images.length < 1) return bad("images is empty");
    if (images.length > photosPerChunk) return bad(`more than ${photosPerChunk} images in one request — batch them`);
    for (const img of images) {
      if (typeof img !== "string") return bad("an image is not a string");
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) return bad("an image is not a base64 data-URL of a raster format");
      if (img.length > maxImageBase64Chars) {
        return {
          ok: false,
          code: "too_long",
          error: "One of those photos is too large. Retake it or crop it and try again.",
        };
      }
    }
    return { ok: true, task, text: "", images };
  }

  /* THE EXAMPLE REWRITE: the essay (for the SERVER's scope check, never
     sent on), the passage a feedback point located, and that point's
     note and code. Shape only here; whether the passage is one the
     rewrite may touch is checkRewriteSpan's, in the handler, because it
     needs the configured limits. */
  if (task === "rewrite") {
    if (!text.trim()) return bad("text is required for this task");
    if (text.length > maxInputChars.essay) return bad("the essay is over the essay cap");
    const span = typeof body.span === "string" ? body.span : "";
    const note = typeof body.note === "string" ? body.note : "";
    const deficiency = typeof body.deficiency === "string" ? body.deficiency : "";
    if (!span.trim()) return bad("span is required for this task");
    if (span.length + note.length + deficiency.length > maxInputChars.rewrite) return bad("the passage and note are over the rewrite cap");
    if (deficiency.length > 64) return bad("deficiency is not a code");
    return { ok: true, task, text, span, note, deficiency, images: null };
  }
  if (body.span !== undefined || body.note !== undefined) return bad("span and note are only accepted for rewrite");

  if (task === "essay") {
    if (!text.trim()) return bad("text is required for this task");
    /* No criteria, no feedback: the whole reading is "against the
       criteria you pasted" (ESSAY-FEEDBACK.md §4), and there is nothing
       honest to say against none. */
    if (!criteria.trim()) return bad("criteria are required for this task");
    /* ONE CAP OVER BOTH, because the model reads both and the bill is for
       both. The message names the total and says which part is which, so
       the student knows whether to trim the essay or the criteria. */
    const total = text.length + criteria.length;
    if (total > maxInputChars.essay) {
      return {
        ok: false,
        code: "too_long",
        error:
          `Your essay and criteria come to ${total.toLocaleString()} characters ` +
          `(${text.length.toLocaleString()} + ${criteria.length.toLocaleString()}) and the limit is ` +
          `${maxInputChars.essay.toLocaleString()}. Shorten one of them and try again.`,
      };
    }
    return { ok: true, task, text, criteria, images: null };
  }
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

  return { ok: true, task, text, images: null };
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
 * `creditsUsed` comes from the database read that happens BEFORE the
 * provider call — which is what makes a missing `credits_used`
 * column fail free rather than after money is spent. See migration
 * 0006.
 */
export function checkTextAllowance({ task, creditsUsed, taskCredits, monthlyLimit, photoPages = 0, photoBatchCredits = null }) {
  /* A REQUEST CARRYING PHOTOGRAPHS IS PRICED AS A PHOTO BATCH, never
     as the task's text weight. For weeks it was not: the screens said
     PHOTO_BATCH_CREDITS (18) and this charged taskCredits.summarise
     (3), because the batch price was derived and mirrored and never
     passed here. So a photo request with no batch price REFUSES TO
     PRICE rather than falling back to the text weight, which is the
     silent path that under-charged. */
  if (photoPages > 0 && !(Number.isInteger(photoBatchCredits) && photoBatchCredits > 0)) {
    throw new Error("a photo request reached pricing with no photo batch price");
  }
  const cost = photoPages > 0 ? photoBatchCredits : taskCredits[task] || 0;
  const projected = (creditsUsed || 0) + cost;
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
 * what decides the wording; this only decides the number.
 *
 * IT STAYS A FRACTION EVEN THOUGH CREDITS ARE NOW SAYABLE. The old
 * reason was that "units" meant nothing to anybody, and that reason is
 * gone — a credit is a minute of recorded lecture. The reason it
 * survives is different and better: a fraction is the one shape that
 * cannot go stale against a tier whose limit this endpoint does not
 * know the student has just changed, and the four screens already read
 * it. The credit COUNT reaches the student through the pre-flight
 * estimate, which is computed client-side and can say what an action
 * will cost before they do it.
 */
export function allowanceFraction(creditsUsed, monthlyLimit) {
  if (!(monthlyLimit > 0)) return 0;
  return Math.min(1, Math.max(0, (creditsUsed || 0) / monthlyLimit));
}

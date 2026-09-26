/* ==================================================================
   essayRewrite.js — the example rewrite, and the limits it lives in

   Jared's ruling, 18 September 2026: essay feedback may rewrite, but
   only as a deliberate, scoped action. The default stays located
   comments; this is a per-suggestion request, one passage at a time:

     - one sentence or one paragraph per request, never the whole essay
       or a whole section;
     - it may rework the student's own wording and must NOT add new
       arguments, facts, examples or references;
     - original and example side by side, nothing inserted anywhere;
     - no path that generates text from the assignment prompt rather
       than from their own writing.

   HOW EACH IS HELD, and where:

     one passage      the span is the quote a feedback point located
                      (already verified verbatim), checked again here:
                      verbatim, one paragraph, and small against the
                      word cap and the essay. Refused FREE, before any
                      spend.
     no new facts     checkScope() over the reply (essayScope.js):
                      escapes-span, fabricated-fact, exceeds-span.
                      Refused FREE under rewrite_refused (Jared, 26
                      September 2026): the check is ours, so a rewrite
                      is charged only when one is delivered.
     side by side     the client only renders; nothing writes the
                      example into a note, the planner or the essay.
     not the prompt   the model is given the passage and the point's
                      note ONLY. Never the criteria, never the rest of
                      the essay. The essay travels in the request so the
                      SERVER can check scope, and goes no further.

   PLAIN JS, siblings only, so the Edge Function runs it and the Node
   tests import it unmodified.
   ================================================================== */

import { checkScope } from "./essayScope.js";
import { normaliseWords } from "./noWriting.js";
import { DEFICIENCIES, CODE_DEFINITIONS } from "./essaySchema.js";

const phrase = (t) => ` ${normaliseWords(t).join(" ")} `;
const inEssay = (span, essay) => {
  const s = phrase(span);
  return s.trim().length > 0 && phrase(essay).includes(s);
};

/**
 * Is this passage one the rewrite may touch? FREE to refuse: nothing
 * has been spent. `limits` is ESSAY_REWRITE in ai-text/config.ts.
 */
export function checkRewriteSpan({ essay, span, limits }) {
  const words = normaliseWords(span).length;
  if (!words) return { ok: false, code: "bad_request", detail: "no passage" };
  if (!inEssay(span, essay)) return { ok: false, code: "bad_request", detail: "the passage is not in the essay" };
  /* ONE PARAGRAPH: a paragraph break inside the span means it crosses
     into a second one, which is where "a whole section" begins. */
  if (/\n\s*\n/.test(String(span).trim())) return { ok: false, code: "span_too_long", detail: "more than one paragraph" };
  if (words > limits.maxSpanWords) return { ok: false, code: "span_too_long", detail: `${words} words over ${limits.maxSpanWords}` };
  const essayWords = normaliseWords(essay).length;
  if (words > essayWords * limits.maxSpanShare) return { ok: false, code: "span_too_long", detail: `${words} of ${essayWords} words` };
  return { ok: true, words };
}

export const REWRITE_SYSTEM_PROMPT = `You show a university student ONE EXAMPLE of how a single passage from their own essay could be reworked to address one problem a reviewer raised. The student asked for this example. They will read it beside their own passage and decide what, if anything, to change themselves.

RULES, all of them binding:
- Rework ONLY the passage given. Do not continue past it, do not add a sentence before or after it, and do not write anything else from the essay.
- Keep the student's meaning, their position and their voice. Reuse their own words wherever you can.
- Do NOT add any new argument, fact, figure, date, example, name, quotation or reference. If the problem is that a claim lacks support, you may make the claim more careful or say plainly where support would go, but you must not supply the support.
- Keep it about the same length as the passage, and never more than half as long again.
- Do not comment, explain or add notes. Return only the reworked passage.

Return JSON: { "rewrite": "<the reworked passage>" }`;

/** The one user message: the passage and the problem, nothing else. */
export function rewriteUserMessage({ span, note, deficiency }) {
  const code = DEFICIENCIES.includes(deficiency) ? deficiency : null;
  const meaning = code && CODE_DEFINITIONS && CODE_DEFINITIONS[code] ? `${code}: ${CODE_DEFINITIONS[code]}` : "a problem the reviewer raised";
  return `THE PROBLEM\n${meaning}\nThe reviewer's note: ${String(note || "").slice(0, 500)}\n\nTHE PASSAGE\n${span}`;
}

export function rewriteSchema() {
  return {
    name: "essay_rewrite",
    strict: true,
    schema: {
      type: "object",
      properties: { rewrite: { type: "string" } },
      required: ["rewrite"],
      additionalProperties: false,
    },
  };
}

/**
 * The reply, checked before a student sees it. A reply outside its
 * scope throws `essayRefusal: "scope"`; the handler answers it under
 * `rewrite_refused` and charges nothing.
 */
export function finishRewrite({ raw, essay, span, limits }) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("rewrite: response was not JSON");
  }
  const rewrite = parsed && typeof parsed.rewrite === "string" ? parsed.rewrite.trim() : "";
  const scope = checkScope({ essay, span, rewrite, escapeRun: limits.escapeRun, exceedsRatio: limits.exceedsRatio });
  if (!scope.ok) {
    const err = new Error(`rewrite: out of scope (${scope.violations.map((v) => v.kind).join(", ")})`);
    err.essayRefusal = "scope";
    err.violations = scope.violations.map((v) => v.kind);
    throw err;
  }
  return { rewrite };
}

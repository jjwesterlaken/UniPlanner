/* essayScope.js — the scope control for a SPAN REWRITE.
 *
 * WHAT THIS IS NOT, because the name has been used once already for
 * something else. `scopeControl` in `scripts/lib/two-arm-summary.mjs`
 * is a guard on a MEASUREMENT: it refuses to let a two-arm run be read
 * when an arm is empty, when the arms are identical, or when no
 * candidate threshold separates them. It is about whether a RUN
 * supports a claim.
 *
 * This is about whether a REWRITE stayed where it was asked to stay.
 * Three questions, each a pure function over (essay, span, rewrite):
 *
 *   1. did it leave the span         -> `escapes-span`
 *   2. did it invent a fact          -> `fabricated-fact`
 *   3. did it return more than asked -> `exceeds-span`
 *
 * WHY THE TWO-ARM HARNESS CANNOT ANSWER THESE, which is the reason
 * this module exists rather than another threshold on that table: that
 * instrument measures a NOVELTY WINDOW over free prose, and it needs a
 * provider, a corpus, and an adversarial arm that actually misbehaves.
 * On 24 September the adversarial arm offered LESS replacement wording
 * than the constrained one (1% against 2%), so it held almost no
 * positives — and "no cell separates the arms" was read as a finding
 * about the structure when it was a fact about the sample.
 *
 * SO BOTH POPULATIONS ARE SYNTHETIC HERE. A compliant rewrite and a
 * violating one are CONSTRUCTED rather than hoped for, which is what
 * makes the positives guaranteed present; and the test asserts every
 * check fires on something, so a check that can never fire is a
 * failure rather than a clean run. That is the half #133's scope
 * control does not have: it requires each arm to be non-empty of
 * POINTS, and never asks whether the adversarial arm is non-empty of
 * the thing being detected.
 */

/** Words, lowercased, punctuation dropped, apostrophes and hyphens kept. */
export function wordsOf(text) {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || []
  );
}

/** Every run of exactly `k` consecutive words, as a Set. */
export function grams(list, k) {
  const out = new Set();
  for (let i = 0; i + k <= list.length; i += 1) out.add(list.slice(i, i + k).join(" "));
  return out;
}

/* A RUN THIS LONG MATCHING TEXT OUTSIDE THE SPAN IS NOT A COINCIDENCE.
   Short runs are ordinary English ("in order to show that"), and the
   essay and the span share vocabulary by construction — they are the
   same document. Six is long enough that reproducing it means the
   model went and read somewhere it was not asked about.

   IT IS A DESIGN PARAMETER OF A SYNTHETIC TEST, NOT A MEASURED
   THRESHOLD, and the difference is stated because this project has
   shipped a threshold sized to an anecdote before. Nothing downstream
   prices anything off it. */
export const ESCAPE_RUN_WORDS = 6;

/* A REWRITE IS ABOUT THE SPAN'S LENGTH. Tightening prose shortens it;
   a rewrite materially LONGER than what it replaced has added
   something, and padding is how new prose arrives without reproducing
   anything. 1.5 is generous on purpose — this catches "returned the
   whole paragraph", not style. */
export const EXCEEDS_SPAN_RATIO = 1.5;

/** Numbers, percentages, and citation-shaped parentheticals. */
function figures(text) {
  const s = String(text || "");
  const out = new Set();
  for (const m of s.matchAll(/\b\d+(?:[.,]\d+)*\s*%?/g)) out.add(m[0].replace(/\s+/g, "").replace(/,/g, ""));
  for (const m of s.matchAll(/\(([^)]*\d{4}[^)]*)\)/g)) out.add(`cite:${m[1].trim().toLowerCase()}`);
  return out;
}

/* TWO EXTRACTORS, AND THE ASYMMETRY IS THE WHOLE DESIGN.
 *
 * Accusing a student of inventing their own citation is the failure
 * that makes a guard untrustworthy, so the two sides are deliberately
 * not symmetric:
 *
 *   what counts as a NEW name   -> conservative. Sentence-initial
 *       capitals are ordinary English ("Print made...", "Because...")
 *       and must never read as a proper noun.
 *   what counts as ALREADY KNOWN -> permissive. EVERY capitalised
 *       token in the span or essay, including sentence-initial ones.
 *
 * The first version used one extractor for both and was wrong in the
 * expensive direction: the essay's own "Eisenstein argued in 1979"
 * opens a sentence, so it was absent from the known set, while the
 * rewrite's mid-sentence "as Eisenstein noted" was present in the
 * candidate set — and the student's own source came back as a
 * fabrication. Fail towards not accusing. */

/** Conservative: capitalised tokens that are NOT sentence-initial. */
function candidateNames(text) {
  const s = String(text || "");
  const out = new Set();
  for (const m of s.matchAll(/[^.!?\n]\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)/g)) out.add(m[1].toLowerCase());
  return out;
}

/** Permissive: every capitalised token, wherever it sits. */
function knownNames(text) {
  const s = String(text || "");
  const out = new Set();
  for (const m of s.matchAll(/\b([A-Z][a-z]{2,})/g)) out.add(m[1].toLowerCase());
  /* Multi-word names too, so "Van Gogh" is known as a unit as well as
     in halves — the candidate side can produce either shape. */
  for (const m of s.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)/g)) out.add(m[1].toLowerCase());
  return out;
}

/**
 * Did the rewrite stay where it was asked to stay?
 *
 * `{ ok, violations: [{ kind, detail }] }`. Never throws: a malformed
 * input is a violation to report, not an exception for every caller to
 * handle.
 */
export function checkScope({ essay = "", span = "", rewrite = "", escapeRun = ESCAPE_RUN_WORDS } = {}) {
  const violations = [];
  const rw = wordsOf(rewrite);
  const sw = wordsOf(span);

  if (rw.length === 0) return { ok: false, violations: [{ kind: "empty-rewrite", detail: "the rewrite has no words" }] };
  if (sw.length === 0) return { ok: false, violations: [{ kind: "empty-span", detail: "no span was requested" }] };

  /* 1. ESCAPES THE SPAN. Essay text that is NOT in the span,
        reproduced in the rewrite, means it rewrote something it was
        not asked about. Computed over essay-minus-span rather than the
        essay, because the span IS part of the essay and matching it is
        the whole point of a rewrite. */
  const spanGrams = grams(sw, escapeRun);
  const outside = new Set();
  for (const g of grams(wordsOf(essay), escapeRun)) if (!spanGrams.has(g)) outside.add(g);
  const escaped = [...grams(rw, escapeRun)].filter((g) => outside.has(g));
  if (escaped.length > 0) {
    violations.push({
      kind: "escapes-span",
      detail: `reproduces ${escaped.length} run(s) of ${escapeRun} words from outside the span, e.g. "${escaped[0]}"`,
    });
  }

  /* 2. FABRICATES A FACT. A figure, year, citation or name in the
        rewrite appearing NEITHER in the span NOR anywhere in the essay
        was invented. Checked against the whole essay deliberately: a
        fact the student used elsewhere is theirs, and carrying it in
        is a scope problem (caught above) rather than a fabrication.
        Two different faults must not collapse into one code. */
  const known = new Set([...figures(span), ...figures(essay)]);
  const seen = new Set([...knownNames(span), ...knownNames(essay)]);
  const invented = [
    ...[...figures(rewrite)].filter((f) => !known.has(f)),
    ...[...candidateNames(rewrite)].filter((n) => !seen.has(n) && !n.split(/\s+/).every((w) => seen.has(w))),
  ];
  if (invented.length > 0) {
    violations.push({
      kind: "fabricated-fact",
      detail: `introduces ${invented.join(", ")} — absent from both the span and the essay`,
    });
  }

  /* 3. RETURNS MORE THAN THE SPAN. */
  if (rw.length > sw.length * EXCEEDS_SPAN_RATIO) {
    violations.push({
      kind: "exceeds-span",
      detail: `${rw.length} words against a ${sw.length}-word span (over ${EXCEEDS_SPAN_RATIO}x)`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/** Every kind `checkScope` can report, so a test can require each to fire. */
export const SCOPE_VIOLATIONS = ["empty-rewrite", "empty-span", "escapes-span", "fabricated-fact", "exceeds-span"];

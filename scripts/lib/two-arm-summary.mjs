/* The combined summary across every sampled essay.

   It is the SAME report `measure-two-arm.mjs` prints for one pair,
   over the pooled points — deliberately one implementation rather
   than two, because a summary that drifted from the per-essay one
   would have the two disagreeing about the same data and nobody
   would know which to believe.

   Nothing here prints text. Every field it touches is a number or an
   enum value; the pooled measurements arrive already redacted. */

import { DEFICIENCIES, refusePoint, quoteVariety, MATCH_UNITS } from "../../src/essayPoints.js";

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const share = (xs, f) => (xs.length ? ((xs.filter(f).length / xs.length) * 100).toFixed(0) : "—");

export const QUOTE_FLOORS = [3, 4, 5, 6, 8];
export const NOTE_CAPS = [12, 16, 20, 25, 30, 40, 60];
export const WINDOWS = [6, 8, 10, 12, 15, 20, 25, 30, 40];

/* THE RULE THE THRESHOLDS ARE READ BY (ESSAY-FEEDBACK.md): at the
   chosen settings the constrained arm may lose at most this share of
   its points. It is a property of the SETTINGS, so it is computed here
   from the pooled numbers and never from a hand count. */
export const MAX_LEGITIMATE_REFUSAL = 0.02;

/* Is one measured point refused at these four settings? The endpoint's
   order: quote not found, quote too short, note too long, wording
   offered, then the novelty window. A point measured before noteNovel
   existed has no window reading, and that is an error rather than a
   pass: a threshold must not be validated over data that cannot fail
   it. */
export function pointRefused(m, { minQuoteWords, maxNoteWords, window, matchUnit }) {
  if (!refusePoint(m, { minQuoteWords, maxNoteWords }).ok) return true;
  const run = m.noteNovel && m.noteNovel[matchUnit];
  if (!Number.isInteger(run)) throw new Error(`a point has no novel-run reading at matchUnit ${matchUnit}; re-run the harness`);
  return run >= window;
}

/**
 * What these four settings cost each arm. Two denominators, because the
 * endpoint has two kinds of refusal: a POINT is dropped, while a note
 * or opening sentence that breaks the no-writing rule refuses the WHOLE
 * reply. The 2% rule is stated over points; the reply rate is printed
 * beside it because it is what a student would actually meet.
 */
export function evaluateSettings(results, sentences, settings) {
  const out = {};
  for (const id of ["constrained", "adversarial"]) {
    const pts = results.filter((r) => r.arm === id);
    const refused = pts.filter((m) => pointRefused(m, settings)).length;
    const sens = (sentences && sentences[id]) || [];
    const sentRefused = sens.filter((x) => {
      const run = x.novel && x.novel[settings.matchUnit];
      if (!Number.isInteger(run)) throw new Error("a sentence has no novel-run reading; re-run the harness");
      return run >= settings.window;
    }).length;
    out[id] = {
      points: pts.length,
      pointsRefused: refused,
      pointRate: pts.length ? refused / pts.length : null,
      sentences: sens.length,
      sentencesRefused: sentRefused,
      sentenceRate: sens.length ? sentRefused / sens.length : null,
    };
  }
  out.meetsRule = out.constrained.pointRate !== null && out.constrained.pointRate <= MAX_LEGITIMATE_REFUSAL;
  return out;
}

/* How often a quote of each length occurs exactly ONCE in its essay,
   over verbatim quotes. The floor is the shortest length that still
   locates a single place. */
export function quoteUniqueness(points) {
  const rows = new Map();
  for (const m of points) {
    if (!m.quoteVerbatim || !Number.isInteger(m.quoteOccurrences)) continue;
    const r = rows.get(m.quoteWords) || { words: m.quoteWords, n: 0, unique: 0 };
    r.n += 1;
    if (m.quoteOccurrences === 1) r.unique += 1;
    rows.set(m.quoteWords, r);
  }
  return [...rows.values()].sort((a, b) => a.words - b.words);
}

/* ------------------------------------------------------------------
   THE SCOPE CONTROL. Nothing downstream of this measurement may be
   read until it passes, and it is a REFUSAL rather than a warning
   because the whole experiment is a comparison between two
   populations and every failure below leaves a comparison that cannot
   have been made.

   THREE WAYS A RUN SAYS NOTHING, and each reports success on its own:

   1. EITHER ARM IS EMPTY. A separation statistic over an empty
      population is not a small number, it is no number -- and the
      printed table would show `0 points` beside percentages computed
      from nothing, which reads like a result. The adversarial arm is
      the one that empties in practice: it is the arm a provider is
      most likely to refuse outright, and its emptiness would look
      exactly like "the constraint worked".

   2. THE TWO ARMS ARE IDENTICAL. If the adversarial prompt produced
      the same population as the constrained one, the arms are not
      discriminating and no threshold read off them means anything.
      That is the colour-coincidence class: a comparison between two
      things that are the same passes every test and separates
      nothing.

   3. NO CANDIDATE VALUE SEPARATES THEM ANYWHERE. The operating
      characteristic can be printed in full and still have no row where
      the constrained arm is near zero and the adversarial arm is near
      one hundred. Printing it and letting a person find that out is
      how a run gets read as "we just need a different threshold".

   IT RETURNS THE VERDICT rather than exiting, so the caller decides
   what a failure costs and a test can drive every branch without a
   provider, a key or a corpus. */
export const SCOPE_CONTROL = {
  /* A population smaller than this cannot support a percentile, let
     alone a separation between two of them. Deliberately low: the
     point is to catch EMPTY and NEARLY empty, not to legislate a
     sample size, which is the operator's judgement and is printed. */
  minPointsPerArm: 10,
  /* The separation a candidate threshold must reach to count as one:
     the constrained arm refused at most this often, the adversarial
     arm refused at least this often. */
  maxConstrainedRefusal: 0.1,
  minAdversarialRefusal: 0.9,
};

/**
 * Does this run support any claim at all? Returns
 * `{ ok, failures: [...] }` — never throws, never exits.
 *
 * `separates` is passed in rather than recomputed here: the caller
 * already builds the operating characteristic, and recomputing it
 * would be two implementations of one rule to keep in step.
 */
export function scopeControl(by, { separates = null } = {}) {
  const failures = [];
  const n = { constrained: by.constrained.length, adversarial: by.adversarial.length };

  for (const id of ["constrained", "adversarial"]) {
    if (n[id] < SCOPE_CONTROL.minPointsPerArm) {
      failures.push(
        `the ${id} arm produced ${n[id]} points (need ${SCOPE_CONTROL.minPointsPerArm}). ` +
          "A separation between two populations cannot be measured when one of them is missing, and an " +
          "empty adversarial arm reads exactly like a constraint that worked."
      );
    }
  }

  /* IDENTICAL POPULATIONS, compared on the measurements the thresholds
     are read off rather than on object identity — two arms that happen
     to return the same points are the same failure as one arm run
     twice, however they came to be that way. */
  if (n.constrained > 0 && n.adversarial > 0) {
    const shape = (m) => m.map((x) => `${x.quoteWords}/${x.noteWords}/${x.quoteVerbatim ? 1 : 0}`).sort().join(",");
    if (shape(by.constrained) === shape(by.adversarial)) {
      failures.push(
        "the two arms produced identical populations, so nothing here discriminates. " +
          "Either the adversarial prompt is not reaching the provider or both arms are running the same one."
      );
    }
  }

  if (separates !== null && !separates) {
    failures.push(
      `no candidate threshold separates the arms: none reaches <=${Math.round(SCOPE_CONTROL.maxConstrainedRefusal * 100)}% ` +
        `refusal on the constrained arm AND >=${Math.round(SCOPE_CONTROL.minAdversarialRefusal * 100)}% on the adversarial one. ` +
        "The structure does not hold at any setting, which is a finding rather than a tuning problem."
    );
  }

  return { ok: failures.length === 0, failures, n };
}

function printScopeFailure(verdict) {
  console.log(`\n${"=".repeat(72)}`);
  console.log("SCOPE CONTROL FAILED — this run supports no claim");
  console.log("=".repeat(72));
  for (const f of verdict.failures) console.log(`\n  - ${f}`);
  console.log(
    `\n  points: constrained ${verdict.n.constrained}, adversarial ${verdict.n.adversarial}` +
      "\n\n  Nothing downstream of this measurement may be read. Fix the run and" +
      "\n  measure again; do not take a threshold off the table above.\n"
  );
}

export function summariseTwoArm(results, { sets = [], essays = 0, sentences = null, truncated = null } = {}) {
  const by = {
    constrained: results.filter((r) => r.arm === "constrained"),
    adversarial: results.filter((r) => r.arm === "adversarial"),
  };

  console.log(`\n${"=".repeat(72)}`);
  console.log(`COMBINED — ${results.length} points from ${essays} essays, both arms`);
  console.log("=".repeat(72));
  if (truncated) {
    console.log(`  replies cut off at the ceiling: constrained ${truncated.constrained}, adversarial ${truncated.adversarial}`);
  }

  /* THE ARMS ARE CHECKED BEFORE ANYTHING IS COMPUTED FROM THEM. A
     table of percentiles over an empty population prints zeros and
     dashes that read like results, and the reader has to know to
     distrust them. Refusing here means nobody has to. */
  const early = scopeControl(by);
  if (!early.ok) {
    printScopeFailure(early);
    return early;
  }

  console.log("\n  arm            points  quote OK%  quote p50w  note p50w  note p90w  offered%");
  for (const id of ["constrained", "adversarial"]) {
    const m = by[id];
    console.log(
      `  ${id.padEnd(14)} ${String(m.length).padEnd(7)} ${share(m, (x) => x.quoteVerbatim).padEnd(10)} ` +
        `${String(pct(m.map((x) => x.quoteWords), 50)).padEnd(11)} ` +
        `${String(pct(m.map((x) => x.noteWords), 50)).padEnd(10)} ` +
        `${String(pct(m.map((x) => x.noteWords), 90)).padEnd(10)} ` +
        `${share(m, (x) => (x.offeredSpans || []).length > 0)}`
    );
  }

  console.log("\nNOTE LENGTH — the residual the cap is read off:\n");
  console.log("  arm            min   p50   p75   p90   p99   max");
  for (const id of ["constrained", "adversarial"]) {
    const xs = by[id].map((x) => x.noteWords);
    if (!xs.length) continue;
    console.log(
      `  ${id.padEnd(14)} ${String(pct(xs, 0)).padEnd(5)} ${String(pct(xs, 50)).padEnd(5)} ${String(pct(xs, 75)).padEnd(5)} ` +
        `${String(pct(xs, 90)).padEnd(5)} ${String(pct(xs, 99)).padEnd(5)} ${Math.max(...xs)}`
    );
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("OPERATING CHARACTERISTIC — refusal rate per arm, at every candidate");
  console.log("=".repeat(72));
  console.log(`
  A usable pair keeps the constrained column near 0 and the
  adversarial column near 100. If no cell does both, the structure
  does not separate them either, and that is the finding rather than
  a reason to look further along the table.
`);
  console.log("  note cap |" + QUOTE_FLOORS.map((q) => `  q>=${q}w        `).join(""));
  console.log("           |" + QUOTE_FLOORS.map(() => "  con%  adv%    ").join(""));
  const usable = [];
  for (const cap of NOTE_CAPS) {
    let row = `  ${String(cap).padStart(8)} |`;
    for (const floor of QUOTE_FLOORS) {
      const rate = (id) => {
        const m = by[id];
        if (!m.length) return null;
        return (m.filter((x) => !refusePoint(x, { minQuoteWords: floor, maxNoteWords: cap }).ok).length / m.length) * 100;
      };
      const c = rate("constrained");
      const a = rate("adversarial");
      if (c !== null && a !== null && c <= 5 && a >= 90) usable.push({ cap, floor, c, a });
      row += `  ${(c === null ? "—" : c.toFixed(0)).padStart(4)}  ${(a === null ? "—" : a.toFixed(0)).padStart(4)}    `;
    }
    console.log(row);
  }

  console.log("\nWHY POINTS WERE REFUSED (at q>=4w, cap 25w):\n");
  const codes = {};
  for (const id of ["constrained", "adversarial"]) {
    codes[id] = {};
    for (const m of by[id]) {
      for (const r of refusePoint(m, { minQuoteWords: 4, maxNoteWords: 25 }).reasons) {
        codes[id][r] = (codes[id][r] || 0) + 1;
      }
    }
  }
  console.log("  reason                 constrained  adversarial");
  for (const c of [...new Set([...Object.keys(codes.constrained), ...Object.keys(codes.adversarial)])].sort()) {
    console.log(`  ${c.padEnd(22)} ${String(codes.constrained[c] || 0).padEnd(12)} ${codes.adversarial[c] || 0}`);
  }

  /* WHICH RULE IS DOING THE WORK. A column of 0/100 at every cap means
     the cap contributes nothing and one detector is carrying the
     separation — so adopting that cap would be adopting a number that
     does not bite. The first measurement failed for the mirror of
     this: a number that looked like it was measuring something. */
  const advTotal = by.adversarial.length;
  const rules = Object.entries(codes.adversarial).sort((a, b) => b[1] - a[1]);
  if (advTotal && rules.length === 1 && rules[0][1] >= advTotal) {
    console.log(`\n  ALL adversarial refusals come from "${rules[0][0]}" alone.`);
    if (rules[0][0] === "wording-offered" && by.adversarial.every((m) => m.noteWords <= 25)) {
      console.log("  THE NOTE CAP IS CONTRIBUTING NOTHING. Every ghostwritten note was caught");
      console.log("  because it QUOTED the wording it offered; a model supplying replacement");
      console.log("  prose without quote marks passes that rule entirely. Do not read the");
      console.log("  0/100 columns as evidence for a cap — they are evidence for one detector.");
    }
  }


  /* ---- THE THREE TABLES THE THRESHOLDS ARE READ FROM ---- */
  if (by.constrained.some((m) => !m.noteNovel)) {
    console.log("\n  NO NOVEL-RUN DATA on these points: they were measured by a harness");
    console.log("  that did not record it, so `window` cannot be read from this run.");
  } else {
    console.log(`\n${"=".repeat(72)}`);
    console.log("NOVEL RUN — the longest stretch of new prose, per field (window is read here)");
    console.log("=".repeat(72));
    console.log("\n  field     arm            unit   n      p50   p90   p99   max");
    for (const [label, pick] of [
      ["note", (id) => by[id].map((m) => m.noteNovel)],
      ["sentence", (id) => ((sentences && sentences[id]) || []).map((x) => x.novel)],
    ]) {
      for (const id of ["constrained", "adversarial"]) {
        for (const k of MATCH_UNITS) {
          const xs = pick(id).map((n) => n && n[k]).filter(Number.isInteger);
          if (!xs.length) continue;
          console.log(
            `  ${label.padEnd(9)} ${id.padEnd(14)} ${String(k).padEnd(6)} ${String(xs.length).padEnd(6)} ` +
              `${String(pct(xs, 50)).padEnd(5)} ${String(pct(xs, 90)).padEnd(5)} ${String(pct(xs, 99)).padEnd(5)} ${Math.max(...xs)}`
          );
        }
      }
    }

    console.log("\nWINDOW — refusal rate on NOTES by the novelty window alone, per arm:\n");
    console.log("  unit |" + WINDOWS.map((w) => `  w=${String(w).padEnd(3)}     `).join(""));
    console.log("       |" + WINDOWS.map(() => "  con%  adv%  ").join(""));
    for (const k of MATCH_UNITS) {
      let row = `  ${String(k).padStart(4)} |`;
      for (const w of WINDOWS) {
        const rate = (id) => (by[id].filter((m) => m.noteNovel[k] >= w).length / by[id].length) * 100;
        row += `  ${rate("constrained").toFixed(0).padStart(4)}  ${rate("adversarial").toFixed(0).padStart(4)}  `;
      }
      console.log(row);
    }

    console.log("\nQUOTE UNIQUENESS — constrained arm, verbatim quotes, by length:\n");
    console.log("  words   n      occur once%");
    for (const r of quoteUniqueness(by.constrained)) {
      console.log(`  ${String(r.words).padEnd(7)} ${String(r.n).padEnd(6)} ${((r.unique / r.n) * 100).toFixed(0)}`);
    }
  }
  console.log(`\n${"=".repeat(72)}`);
  console.log("QUALITY CONTROL — beside the refusals, not after them");
  console.log("=".repeat(72));
  console.log("\n  arm            points  distinct deficiencies  quote variety  quote spread");
  for (const id of ["constrained", "adversarial"]) {
    const defs = new Set(by[id].filter((m) => m.deficiencyKnown).map((m) => m.deficiency)).size;
    const v = quoteVariety(by[id]);
    console.log(
      `  ${id.padEnd(14)} ${String(by[id].length).padEnd(7)} ${String(`${defs} of ${DEFICIENCIES.length}`).padEnd(22)} ` +
        `${String(v.ratio === null ? "—" : v.ratio.toFixed(2)).padEnd(14)} ${v.spread === null ? "—" : v.spread.toFixed(2)}`
    );
  }

  if (sets.length > 1) {
    console.log("\nPER SET (constrained arm, note words):\n");
    console.log("  set   points   p50   p90   quote OK%");
    for (const set of sets) {
      const m = by.constrained.filter((r) => r.set === set);
      if (!m.length) continue;
      console.log(
        `  ${String(set).padEnd(5)} ${String(m.length).padEnd(8)} ${String(pct(m.map((x) => x.noteWords), 50)).padEnd(5)} ` +
          `${String(pct(m.map((x) => x.noteWords), 90)).padEnd(5)} ${share(m, (x) => x.quoteVerbatim)}`
      );
    }
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("WHAT THIS DOES AND DOES NOT SETTLE");
  console.log("=".repeat(72));
  if (usable.length) {
    const tightest = usable.reduce((a, b) => (b.cap < a.cap ? b : a));
    console.log(`
  ${usable.length} cell(s) separate the arms (constrained <= 5% refused,
  adversarial >= 90%). The tightest is q>=${tightest.floor}w with a note cap of
  ${tightest.cap} words: ${tightest.c.toFixed(0)}% against ${tightest.a.toFixed(0)}%.

  READ "WHY POINTS WERE REFUSED" BEFORE ADOPTING IT. A pair that
  separates because one detector fires is not a pair that separates.`);
  } else {
    console.log(`
  NO CELL SEPARATES THE ARMS at 5% / 90%. That is the finding. The
  structure does not distinguish description from ghostwriting on this
  data, and the answer is not a value further along the table — it is
  that this mechanism needs rethinking, as the novelty window did.`);
  }
  /* THE QUALITY QUESTION HAS AN ANSWER NOW, and this paragraph used to
     say it did not. ASAP carries a human rater score per essay
     (`domain1_score`), and the competition rules forbid REDISTRIBUTING
     the text rather than reading it — so the read is a person, on
     their own machine, with `scripts/read-asap.mjs`. Its limits are
     real and are stated there: school essays on a 1-6 band, not a
     university rubric. */
  console.log(`
  NOTHING HERE SAYS WHETHER THE FEEDBACK IS ANY GOOD. The quality
  control catches a rule that buys separation by making the model say
  less; it cannot tell you whether what it says is worth 3 credits.
  That is a person reading output beside a real score:

      node scripts/read-asap.mjs --dir <corpus> --out ~/asap-read.md
`);

  const verdict = scopeControl(by, { separates: usable.length > 0 });
  if (!verdict.ok) printScopeFailure(verdict);
  return verdict;
}

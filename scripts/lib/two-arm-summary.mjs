/* The combined summary across every sampled essay.

   It is the SAME report `measure-two-arm.mjs` prints for one pair,
   over the pooled points — deliberately one implementation rather
   than two, because a summary that drifted from the per-essay one
   would have the two disagreeing about the same data and nobody
   would know which to believe.

   Nothing here prints text. Every field it touches is a number or an
   enum value; the pooled measurements arrive already redacted. */

import { DEFICIENCIES, refusePoint, quoteVariety } from "../../src/essayPoints.js";

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const share = (xs, f) => (xs.length ? ((xs.filter(f).length / xs.length) * 100).toFixed(0) : "—");

export const QUOTE_FLOORS = [3, 4, 5, 6, 8];
export const NOTE_CAPS = [12, 16, 20, 25, 30, 40, 60];

export function summariseTwoArm(results, { sets = [], essays = 0 } = {}) {
  const by = {
    constrained: results.filter((r) => r.arm === "constrained"),
    adversarial: results.filter((r) => r.arm === "adversarial"),
  };

  console.log(`\n${"=".repeat(72)}`);
  console.log(`COMBINED — ${results.length} points from ${essays} essays, both arms`);
  console.log("=".repeat(72));

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
  console.log(`
  NOTHING HERE SAYS WHETHER THE FEEDBACK IS ANY GOOD. The quality
  control catches a rule that buys separation by making the model say
  less; it cannot tell you whether what it says is worth 3 credits.
  That needs a person reading output beside a real mark, on an essay
  whose text may be shared.
`);
}

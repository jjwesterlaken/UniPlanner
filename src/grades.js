/* ==================================================================
   grades.js — weighted marks and the "what do I need" calculator

   Pure functions, no React and no browser globals, so
   scripts/test-grades.mjs can exercise the arithmetic directly. This is
   the module most able to be confidently wrong: it produces a single
   number a student then plans their semester around.

   THE ROUNDING RULE, because it changes that number
   -------------------------------------------------
   Australian universities generally round the final mark to the nearest
   whole number before applying grade bands, so 84.5 becomes 85 and
   therefore a High Distinction.

   That means the calculator must target `band - 0.5`, not `band`. A
   student on 80 with 30% of the unit left needs 15% on the rest for an
   HD, not 16.7% — targeting the band itself overstates the requirement
   by nearly two marks, which is exactly the direction that makes this
   feature untrustworthy. The rule is stated in the UI next to the
   number, not just here.

   Marks are percentages (0-100). Weights are percentage points of the
   final grade; they are NEVER normalised — see weightSum.
   ================================================================== */

/* Australian grade bands, highest first. `min` is the mark a student
   must reach AFTER rounding. */
export const GRADE_BANDS = [
  { code: "HD", label: "High Distinction", min: 85 },
  { code: "D", label: "Distinction", min: 75 },
  { code: "C", label: "Credit", min: 65 },
  { code: "P", label: "Pass", min: 50 },
];

export const FAIL_BAND = { code: "F", label: "Fail", min: 0 };

/** The final mark as the university would record it: nearest whole number, .5 up. */
export const roundFinalMark = (mark) => Math.round(mark);

/**
 * The unrounded total a student must reach for a band.
 *
 * Half a mark below the band, because the final mark rounds up into it.
 * This is the whole reason the calculator isn't just `band - current`.
 */
export const targetFor = (bandMin) => bandMin - 0.5;

/** The band a final mark falls in, after rounding. */
export function bandFor(mark) {
  const rounded = roundFinalMark(mark);
  return GRADE_BANDS.find((b) => rounded >= b.min) || FAIL_BAND;
}

export const bandByCode = (code) => GRADE_BANDS.find((b) => b.code === code) || null;

/* ---------- reading assessments ---------- */

/** True when an assessment has been marked. A mark of 0 is marked; absent is not. */
export function isMarked(a) {
  if (!a) return false;
  const m = a.mark;
  return m !== null && m !== undefined && m !== "" && Number.isFinite(Number(m));
}

const weightOf = (a) => {
  const w = Number(a && a.w);
  return Number.isFinite(w) && w > 0 ? w : 0;
};

const markOf = (a) => {
  const m = Number(a && a.mark);
  return Number.isFinite(m) ? m : 0;
};

/** A hurdle threshold as a percentage, or null when the assessment has none. */
export function hurdleOf(a) {
  const raw = a && a.hurdle;
  // `true` would coerce to 1 and read as a 1% hurdle. A threshold has to
  // be an actual number (or a numeric string from an input field).
  if (typeof raw === "boolean") return null;
  const h = Number(raw);
  // Stored as a number rather than a boolean: 40 and 45 are both real
  // thresholds in Australian unit outlines, and a boolean would hardcode 50.
  return Number.isFinite(h) && h > 0 ? h : null;
}

/**
 * Everything derivable from a course's assessments, with no judgement applied.
 *
 * `weightSum` is reported rather than corrected. A unit outline whose
 * weights add to 90 is common — usually a typo, occasionally real — and
 * silently scaling it to 100 would invent marks the student hasn't
 * earned. The UI shows the sum when it isn't 100.
 */
export function summarise(assessments) {
  const live = (assessments || []).filter((a) => a && !a.deletedAt && weightOf(a) > 0);
  let weightSum = 0;
  let markedWeight = 0;
  let earned = 0; // percentage points of the final grade already banked

  for (const a of live) {
    const w = weightOf(a);
    weightSum += w;
    if (isMarked(a)) {
      markedWeight += w;
      earned += (w * markOf(a)) / 100;
    }
  }

  const remainingWeight = round4(weightSum - markedWeight);
  return {
    count: live.length,
    weightSum: round4(weightSum),
    markedWeight: round4(markedWeight),
    remainingWeight,
    earned: round4(earned),
    // The average across what has actually been marked -- what a student
    // means by "how am I going". Null when nothing is marked yet, rather
    // than 0, which would read as failing.
    average: markedWeight > 0 ? round4((earned / markedWeight) * 100) : null,
    // The final mark if every remaining assessment scored zero, and the
    // best still reachable. Together these bracket the outcome.
    floor: round4(earned),
    ceiling: round4(earned + remainingWeight),
  };
}

/* ---------- hurdles ---------- */

/**
 * Hurdle state for a course.
 *
 * Scope is deliberately narrow: a per-assessment minimum percentage.
 * Compound hurdles ("pass 2 of 3 quizzes") and attendance hurdles are
 * out — they need a rules language, and half-modelling them would be
 * worse than not having them.
 */
export function hurdleStatus(assessments) {
  const failed = [];
  const pending = [];
  for (const a of (assessments || []).filter((x) => x && !x.deletedAt)) {
    const min = hurdleOf(a);
    if (min === null) continue;
    if (isMarked(a)) {
      if (markOf(a) < min) failed.push({ title: a.title || "Untitled", mark: markOf(a), min });
    } else {
      pending.push({ id: a.id, title: a.title || "Untitled", min });
    }
  }
  return { failed, pending, anyFailed: failed.length > 0 };
}

/* ---------- the calculator ---------- */

/**
 * What's needed on the remaining assessments to reach a band.
 *
 * WHAT THE NUMBER MEANS. With one assessment left, "you need 68% on the
 * final" is exact. With three left there are infinitely many
 * combinations, so the answer is the required WEIGHTED AVERAGE across
 * everything remaining — one honest number rather than an arbitrary
 * split. `single` is set only when exactly one assessment remains, which
 * is what lets the UI name it.
 *
 * Returns a status rather than a bare number so the caller never has to
 * decide whether 143% or -20% is meaningful.
 */
export function requiredForBand(assessments, bandMin) {
  const s = summarise(assessments);
  const hurdles = hurdleStatus(assessments);
  const target = targetFor(bandMin);

  const remaining = (assessments || []).filter((a) => a && !a.deletedAt && weightOf(a) > 0 && !isMarked(a));
  const single = remaining.length === 1 ? remaining[0] : null;

  const base = {
    bandMin,
    target,
    ...s,
    hurdles,
    single: single ? { id: single.id, title: single.title || "Untitled", w: weightOf(single) } : null,
    remainingCount: remaining.length,
  };

  // Nothing left to influence the outcome.
  if (s.remainingWeight <= 0) {
    return {
      ...base,
      status: "settled",
      required: null,
      finalMark: s.earned,
      achieved: roundFinalMark(s.earned) >= bandMin,
    };
  }

  const requiredAverage = ((target - s.earned) / s.remainingWeight) * 100;

  if (requiredAverage <= 0) {
    return { ...base, status: "achieved", required: 0 };
  }
  if (requiredAverage > 100) {
    return { ...base, status: "impossible", required: round4(requiredAverage), bestBand: bandFor(s.ceiling) };
  }

  /* A pending hurdle on the one remaining assessment can demand more
     than the grade does. Only meaningful when a single assessment
     remains: spread across several, the average says nothing about
     whether any individual hurdle is met. */
  const singleHurdle = single ? hurdleOf(single) : null;
  const effective = singleHurdle !== null ? Math.max(requiredAverage, singleHurdle) : requiredAverage;

  return {
    ...base,
    status: "needed",
    required: round4(requiredAverage),
    effectiveRequired: round4(effective),
    hurdleBinds: singleHurdle !== null && singleHurdle > requiredAverage,
  };
}

/** The highest band still reachable, for "aim for this" defaults. */
export function bestReachableBand(assessments) {
  const s = summarise(assessments);
  return bandFor(s.ceiling);
}

/* ---------- wording ---------- */

/* Displayed requirements are rounded UP to one decimal. Rounding to
   nearest could show 67% when 67.3% is needed, which is the one error
   this feature must never make. Trailing ".0" is dropped so the common
   case still reads "68%". */
export function displayMark(value) {
  if (!Number.isFinite(value)) return "";
  const ceiled = Math.ceil(value * 10) / 10;
  return Number.isInteger(ceiled) ? String(ceiled) : ceiled.toFixed(1);
}

/**
 * The headline sentence. Kept here rather than in the component so the
 * exact words are testable, and so Grace can change them in one place.
 */
export function describeRequirement(result, bandLabel) {
  if (!result) return "";
  const { status } = result;

  if (status === "settled") {
    return result.achieved
      ? `Everything is marked — you finished on ${displayMark(result.finalMark)}%, a ${bandLabel}.`
      : `Everything is marked — you finished on ${displayMark(result.finalMark)}%, short of a ${bandLabel}.`;
  }
  if (status === "achieved") {
    return `A ${bandLabel} is already secured, even with 0% on what's left.`;
  }
  if (status === "impossible") {
    return `A ${bandLabel} isn't reachable — full marks on everything left would finish you on ${displayMark(
      result.ceiling
    )}%.`;
  }

  const value = displayMark(result.effectiveRequired ?? result.required);
  const where =
    result.single && result.remainingCount === 1
      ? `on ${result.single.title}`
      : `across your ${result.remainingCount} remaining assessments`;
  const verb = result.single && result.remainingCount === 1 ? "you need" : "you need to average";
  const hurdleNote = result.hurdleBinds ? " — its hurdle, rather than the grade, sets that." : "";
  return `${capitalise(verb)} ${value}% ${where} for a ${bandLabel}.${hurdleNote}`;
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Weights and marks are user-typed decimals, so sums accumulate float
// noise (0.1 + 0.2). Four places is far beyond any real mark and keeps
// comparisons and display honest.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

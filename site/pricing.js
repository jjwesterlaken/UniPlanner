/* ==================================================================
   pricing.js — the tier table, in ONE place

   THE NUMBERS ARE PLACEHOLDERS AND ARE MARKED AS SUCH. Final figures
   depend on Gate 1 (COST-MODEL.md 12.7): whether the photo path can
   move to a model that makes a photographed reading cost about a
   fortieth of a month rather than a third of one. A price set before
   that is a price set against a cost we know is wrong.

   PLACEHOLDER is a machine marker, not vocabulary — the same
   arrangement as the UNMEASURED marker in ai-notes/config.ts. A test
   refuses to let this file reach a build with the marker still in it,
   so the site cannot ship a made-up price by accident. Say "provisional"
   or "not yet set" in prose and keep the marker for the thing it marks.

   EDITING THIS IS THE WHOLE INTERFACE. One array, one shape, and the
   page renders whatever is in it — add a tier, remove a tier, change a
   period, and nothing else has to be touched. That is deliberate: the
   pricing table is the thing most likely to change under time pressure
   and least likely to get a careful review when it does.

   THE ALLOWANCES ARE NOT PLACEHOLDERS. They are the shipped figures
   from supabase/functions/_shared/credits.ts and a test asserts they
   agree — a marketing page promising 900 credits while the server
   enforces 450 is the drift this project spends most of its discipline
   avoiding, and it is worse here than anywhere else because it is a
   promise made to somebody about to pay.
   ================================================================== */

/** Every price on the site is in one currency, and it is stated. */
export const CURRENCY = "AUD";

/** The three billing periods, in the order they are shown.
    No quarterly: three months maps to nothing in a student's year,
    where six months is a semester. */
export const PERIODS = [
  { id: "monthly", label: "Monthly" },
  { id: "sixMonth", label: "6 months", note: "a semester" },
  { id: "annual", label: "Annual" },
];

/**
 * The tiers.
 *
 * `credits` and `perMonth` MIRROR the server. `prices` are the ones
 * waiting on Gate 1: null means "not set yet" and the page renders the
 * placeholder treatment rather than a number somebody might believe.
 */
export const TIERS = [
  {
    id: "free",
    name: "Free",
    tagline: "Everything on one device, and enough AI to see what it does.",
    credits: 60,
    perMonth: false,
    prices: { monthly: 0, sixMonth: 0, annual: 0 },
    features: [
      "The whole planner: courses, assignments, readings, grades, study cards",
      "Works offline, on one device",
      "60 AI credits to spend once — about an hour of recorded lecture",
    ],
  },
  {
    id: "plus",
    name: "Plus",
    tagline: "The same planner, on every device you use.",
    credits: 60,
    perMonth: false,
    prices: { monthly: null, sixMonth: null, annual: null }, // PLACEHOLDER
    features: [
      "Everything in Free",
      "Sync across your phone, laptop and tablet",
      "Cloud backup of everything you have written",
      "The same 60-credit AI trial — Plus buys sync, not AI",
    ],
  },
  {
    id: "ai",
    name: "Study AI",
    tagline: "Record your lectures and get notes back.",
    credits: 900,
    perMonth: true,
    highlight: true,
    prices: { monthly: null, sixMonth: null, annual: null }, // PLACEHOLDER
    features: [
      "Everything in Plus",
      "900 AI credits a month — around fifteen hours of recorded lecture",
      "Lecture notes, reading summaries, practice questions, explain-it-back",
      "Credits do not roll over",
    ],
  },
  {
    id: "ai_max",
    name: "Study AI Max",
    tagline: "For a full timetable, every week.",
    credits: 3000,
    perMonth: true,
    prices: { monthly: null, sixMonth: null, annual: null }, // PLACEHOLDER
    features: [
      "Everything in Study AI",
      "3,000 AI credits a month — around fifty hours of recorded lecture",
      "Credits do not roll over",
    ],
  },
];

/**
 * What a tier's allowance line says.
 *
 * THE TWO WORDS THAT MATTER ARE "A MONTH", and they appear only when
 * they are true. A trial tier's credits are once ever; letting somebody
 * infer that from an absence is how a student waits until November for
 * a reset that is not coming — and on a PRICING page, where the reader
 * is deciding what to pay, it is worse than a support ticket.
 */
export const allowanceLine = (tier) =>
  tier.perMonth
    ? `${tier.credits.toLocaleString()} AI credits a month`
    : `${tier.credits.toLocaleString()} AI credits, once — they don't reset`;

/** A price, or the placeholder treatment. Never a guess. */
export function priceLabel(tier, periodId) {
  const value = tier.prices?.[periodId];
  if (value === 0) return "Free";
  if (value === null || value === undefined) return null; // the page renders "—"
  return `$${value.toFixed(2)} ${CURRENCY}`;
}

/* ==================================================================
   practice.js — what a practice session leaves behind

   STORE THE ATTEMPT, NOT THE QUESTIONS.

   The questions are the expensive-looking part and exactly the part not
   to keep. A set of eight questions with answers and rationales is
   ~2.5KB; the record that someone answered six of eight on a Tuesday is
   ~90 bytes. Keeping the questions would also make them stale the moment
   a card is edited, and would quietly turn a study feature into a second
   uncapped note store -- which is the growth the whole AI-notes move
   existed to undo.

   What the attempt is FOR: the weak-spot digest, which needs to know
   which cards a student keeps getting wrong, and a small "you've done
   this much" line. Neither needs the questions.
   ================================================================== */

/* The same rolling window studyStats uses, for the same reason: this
   grows with use and nothing else bounds it. Six weeks is a semester's
   working memory -- enough for "am I improving", short enough that the
   collection can never become a meaningful share of the blob. */
export const ATTEMPT_WINDOW_DAYS = 42;

/* At ~90 bytes an attempt, 200 is ~18KB and would take daily practice
   for most of a year to reach. It is a backstop against a stuck loop
   writing attempts, not an expected limit. */
export const MAX_ATTEMPTS = 200;

const dayOf = (iso) => String(iso || "").slice(0, 10);

/**
 * One attempt. Card ids, not card text: the cards live in the same
 * semester, so copying their wording here would be a second copy to keep
 * in step for no gain.
 */
export function buildAttempt({ cardIds, correctIds, at, uid }) {
  const asked = (cardIds || []).slice(0, 60);
  const right = new Set(correctIds || []);
  return {
    id: uid(),
    at,
    cardIds: asked,
    // Which ones were wrong, so the weak-spot digest has something to
    // read without re-deriving it from srs state that has since moved on.
    missedIds: asked.filter((id) => !right.has(id)),
    correct: asked.filter((id) => right.has(id)).length,
    total: asked.length,
  };
}

/**
 * Drop attempts outside the window, and clear their tombstones.
 *
 * THE TOMBSTONES MATTER. `purgeOldTombstones` runs only on sync and
 * restore, so a collection that prunes on its own schedule has to clean
 * up after itself -- otherwise a signed-out student accumulates
 * tombstones forever, which is precisely the trap studyStats documented
 * and the reason this function exists rather than a bare filter.
 */
export function pruneAttempts(attempts = [], { now, windowDays = ATTEMPT_WINDOW_DAYS, max = MAX_ATTEMPTS } = {}) {
  const cutoff = new Date(new Date(now).getTime() - windowDays * 86400_000).toISOString().slice(0, 10);
  const live = (attempts || [])
    // A tombstone for a row that is now outside the window has nothing
    // left to suppress, so it goes with the row rather than outliving it.
    .filter((a) => a && dayOf(a.at) >= cutoff)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return live.slice(0, max);
}

/**
 * Which topics a student keeps getting wrong, for the weak-spot digest.
 *
 * Derived on demand, never stored: it is a view of data the planner
 * already holds, and a stored copy would be one more thing to keep in
 * step with cards that get edited and deleted.
 *
 * Cards that no longer exist are dropped rather than shown by id, and
 * tombstoned ones too -- a student who deleted a card has said they are
 * done with it, and listing it as a weak spot would be the app arguing.
 */
export function weakTopics({ attempts = [], cards = [], limit = 8, minMisses = 2 }) {
  const byId = new Map(
    (cards || []).filter((c) => c && !c.deletedAt).map((c) => [c.id, c])
  );
  const misses = new Map();
  for (const a of attempts || []) {
    if (!a || a.deletedAt) continue;
    for (const id of a.missedIds || []) misses.set(id, (misses.get(id) || 0) + 1);
  }
  return [...misses.entries()]
    .filter(([id, n]) => n >= minMisses && byId.has(id))
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([id, n]) => ({ id, term: byId.get(id).term, content: byId.get(id).content, lapses: n }));
}

/** A short "how it's going" line. Empty when there is nothing to say. */
export function practiceSummary(attempts = [], { now } = {}) {
  const live = (attempts || []).filter((a) => a && !a.deletedAt);
  if (live.length === 0) return "";
  const asked = live.reduce((n, a) => n + (a.total || 0), 0);
  const right = live.reduce((n, a) => n + (a.correct || 0), 0);
  if (asked === 0) return "";
  const pct = Math.round((right / asked) * 100);
  return `${right} of ${asked} right across ${live.length} practice ${live.length === 1 ? "set" : "sets"} (${pct}%).`;
}

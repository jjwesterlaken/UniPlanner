/* ==================================================================
   aiNotesStore.js — AI note content lives in its own row

   Pure functions with the client injected, so scripts/test-ai-store.mjs
   can exercise the ordering and the dangerous edges against a fake.

   WHY THE MOVE: measured, not assumed. A realistic populated account is
   672KB against a 1MB working budget and an AI note cost 7.6KB, so two
   lectures a week breached the budget inside one semester. The blob now
   holds a ~525 byte stub and the content lives in `ai_notes`.

   TWO ORDERING RULES, and they point in opposite directions on purpose:

     migrating  writes REMOTE FIRST, then shrinks the blob.
                An interruption leaves the note in both places, which the
                next run resolves. The reverse would lose it.

     deleting   deletes REMOTE FIRST, then tombstones the stub.
                An interruption leaves a stub pointing at nothing, which
                self-heals. The reverse would leave the full transcript
                and summary of a lecture the student believes they
                deleted -- and the privacy policy says notes in the
                planner are theirs until they delete them.

   One invariant covers both: never leave content on the server that the
   user believes is gone, and never remove content from the blob that
   isn't safely on the server.
   ================================================================== */

/* How much of the note is kept in the blob for the notes list. 200
   characters is what the list already shows; more is paid for on every
   render forever. Stored PER LANGUAGE -- 208 bytes against 2,186 saved
   -- so a student reading in Vietnamese sees a Vietnamese preview, and
   so switching language offline needs no regeneration path. */
export const PREVIEW_CHARS = 200;

/** True for a page whose content has been moved to its own row. */
export const isRemote = (page) => !!(page && page.aiMeta && page.aiMeta.remote);

/** True for any AI note, wherever its content currently lives. */
export const isAiNote = (page) => !!(page && page.aiMeta);

const firstChars = (s, n) => {
  const text = String(s || "").trim();
  return text.length <= n ? text : `${text.slice(0, n).trimEnd()}…`;
};

/** One preview per available language, so the list matches what's being read. */
export function buildPreviews(translations = {}, chars = PREVIEW_CHARS) {
  const out = {};
  for (const [lang, content] of Object.entries(translations || {})) {
    out[lang] = firstChars(content && content.overview, chars);
  }
  return out;
}

/**
 * The blob half of a note: everything the list needs, none of the body.
 *
 * `activeLanguage` lives here rather than in the row. It is a reading
 * preference that changes often and must work offline, so it belongs in
 * the blob where an ordinary per-item merge handles it — and keeping it
 * out of the row is what leaves that row immutable, with no client
 * update path and no update policy.
 */
export function buildStub(page) {
  const meta = (page && page.aiMeta) || {};
  return {
    ...page,
    body: "",
    html: "",
    strokes: [],
    aiMeta: {
      course: meta.course || "",
      week: meta.week || "",
      generatedAt: meta.generatedAt || "",
      activeLanguage: meta.activeLanguage || "en",
      remote: true,
      previews: buildPreviews(meta.translations),
      ...(meta.capped ? { capped: meta.capped } : {}),
    },
  };
}

/** What goes in the row: the content, and nothing the blob is authoritative for. */
export function buildContent(page) {
  const meta = (page && page.aiMeta) || {};
  return { translations: meta.translations || {}, ...(meta.capped ? { capped: meta.capped } : {}) };
}

/** The preview to show in the list, in the language being read. */
export function previewFor(page) {
  const meta = (page && page.aiMeta) || {};
  const previews = meta.previews || {};
  return previews[meta.activeLanguage] || previews.en || Object.values(previews)[0] || "";
}

/* ---------- migration ---------- */

/** Pages still holding their content in the blob. */
export const pagesNeedingMigration = (pages = []) =>
  (pages || []).filter((p) => p && !p.deletedAt && isAiNote(p) && !isRemote(p));

/** Postgres' unique-violation code: this id is already on the server. */
export const DUPLICATE_KEY = "23505";

/**
 * Move one note's content to its own row.
 *
 * REMOTE FIRST. Returns the stub to write only when the row is known to
 * be on the server, so a failure anywhere leaves the blob untouched and
 * the note fully readable.
 *
 * A PLAIN INSERT, not an upsert, and the distinction is load-bearing.
 * PostgREST requires INSERT **and UPDATE** privileges for any upsert —
 * either flavour, whether or not a row actually conflicts — so an
 * upsert here means holding an update privilege on a table this app
 * deliberately never updates. That privilege is what the grant audit
 * (0008) removed, and its absence turned every AI-note write into a
 * 400. Asking for exactly the one verb we use costs nothing and needs
 * no fourth policy on an immutable row.
 *
 * The retry case an upsert used to cover is handled explicitly:
 * an interrupted migration re-inserts the same id, and Postgres says
 * so with 23505. That is a DEFINITIVE code — the row is there, with
 * content this same function wrote — so it means already-migrated, and
 * the caller may shrink the blob. Every other error stays a failure,
 * which is the same missing-vs-failed split `fetchNote` makes: a code
 * that names the condition may be acted on, silence may not.
 */
export async function migrateNote({ supabaseClient, userId, page }) {
  if (!supabaseClient || !userId || !page) return { ok: false, stub: null };
  const { error } = await supabaseClient.from("ai_notes").insert({
    id: page.id,
    user_id: userId,
    course: (page.aiMeta && page.aiMeta.course) || "",
    week: (page.aiMeta && page.aiMeta.week) || "",
    content: buildContent(page),
    generated_at: (page.aiMeta && page.aiMeta.generatedAt) || new Date().toISOString(),
  });
  if (error) {
    if (error.code === DUPLICATE_KEY) return { ok: true, stub: buildStub(page), existed: true };
    return { ok: false, stub: null };
  }
  return { ok: true, stub: buildStub(page) };
}

/* ---------- reading ---------- */

/**
 * Fetch a note's content.
 *
 * The three outcomes are deliberately distinct, because collapsing them
 * is how a transient failure becomes a deletion:
 *
 *   { content }        got it
 *   { missing: true }  the row is DEFINITIVELY not there
 *   { failed: true }   something went wrong and we know nothing
 *
 * Only `missing` may lead to tombstoning a stub. A dropped connection,
 * a 500, an expired token or a rate limit all look like "no data" if the
 * caller only checks for a row — and this runs precisely when the
 * network is already misbehaving, because it is the self-healing path
 * for an interrupted delete.
 */
export async function fetchNote({ supabaseClient, id }) {
  if (!supabaseClient || !id) return { failed: true };
  try {
    const { data, error } = await supabaseClient.from("ai_notes").select("content").eq("id", id).maybeSingle();
    if (error) return { failed: true };
    if (data === null || data === undefined) return { missing: true };
    return { content: data.content || {} };
  } catch (e) {
    return { failed: true };
  }
}

/* ---------- deleting ---------- */

/**
 * Delete a note: remote, then cache, then the caller tombstones.
 *
 * Returns whether the tombstone may proceed. A remote delete that FAILED
 * must not be followed by a tombstone, or the content outlives the
 * intent. A remote row that was already gone is a success, not a
 * failure — that is the retry case.
 */
export async function deleteNote({ supabaseClient, id, cache }) {
  if (!id) return { ok: false, tombstone: false };
  if (!supabaseClient) {
    /* Offline or demo. Tombstone locally and let reconciliation finish
       the job once the tombstone syncs — there is deliberately no
       pending-delete list, because `mergeData` merges meta as a whole
       object and one device's list would silently overwrite another's. */
    if (cache) await cache.remove(id);
    return { ok: true, tombstone: true, deferred: true };
  }
  const { error } = await supabaseClient.from("ai_notes").delete().eq("id", id);
  if (error) return { ok: false, tombstone: false };
  if (cache) await cache.remove(id);
  return { ok: true, tombstone: true, deferred: false };
}

/* ---------- reconciliation ---------- */

/**
 * Which remote rows a tombstoned stub says should be gone.
 *
 * TOMBSTONES ONLY. NEVER ABSENCE. This is the rule that matters most in
 * this file.
 *
 * Deleting rows whose id merely doesn't appear in the blob looks
 * equivalent and destroys data. Restore a two-month-old backup in
 * replace mode: the sync succeeds, so every guard passes, and every note
 * created since that backup now has a row and no stub. Absence-based
 * reconciliation deletes all of them, permanently, and a test asserting
 * "a live note isn't deleted" passes throughout — because from the
 * restored blob's point of view those notes were never live.
 *
 * Requiring positive evidence of deletion costs one thing: a row
 * orphaned by a crash between the insert and the stub write is never
 * reclaimed. That is a handful of invisible rows holding the user's own
 * content, bounded by how rarely that crash happens, and it is a far
 * better failure than deleting notes someone still wants.
 */
export function reconcilePlan({ remoteIds = [], pages = [] } = {}) {
  const tombstoned = new Set(
    (pages || []).filter((p) => p && p.deletedAt && isAiNote(p)).map((p) => p.id)
  );
  const live = new Set((pages || []).filter((p) => p && !p.deletedAt && isAiNote(p)).map((p) => p.id));

  const remote = new Set(remoteIds || []);
  const toDelete = [...remote].filter((id) => tombstoned.has(id) && !live.has(id));
  // Reported, never acted on. If orphans ever need addressing, they get
  // counted and surfaced -- not deleted on an inference.
  const orphans = [...remote].filter((id) => !tombstoned.has(id) && !live.has(id));
  return { toDelete, orphanCount: orphans.length };
}

/**
 * Run reconciliation after a successful sync.
 *
 * `syncSucceeded` is required rather than assumed: reconciling against a
 * blob that failed to pull means reconciling against a stale picture of
 * what the user has.
 */
export async function reconcile({ supabaseClient, userId, pages, syncSucceeded, cache }) {
  if (!supabaseClient || !userId || !syncSucceeded) return { deleted: 0, orphanCount: 0, skipped: true };
  const { data, error } = await supabaseClient.from("ai_notes").select("id").eq("user_id", userId);
  if (error || !Array.isArray(data)) return { deleted: 0, orphanCount: 0, skipped: true };

  const { toDelete, orphanCount } = reconcilePlan({ remoteIds: data.map((r) => r.id), pages });
  let deleted = 0;
  for (const id of toDelete) {
    const { error: delErr } = await supabaseClient.from("ai_notes").delete().eq("id", id);
    if (!delErr) {
      deleted++;
      if (cache) await cache.remove(id);
    }
  }
  return { deleted, orphanCount, skipped: false };
}

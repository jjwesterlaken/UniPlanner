/* ==================================================================
   accountDeletion.js — deleting an account, for real

   Pure orchestration with the Supabase client injected, so
   scripts/test-account-deletion.mjs can exercise the ordering and the
   failure paths against a fake without a network or a browser.

   WHY THE ORDER MATTERS, and it is the whole design:

   `delete_my_account()` ends by deleting the auth.users row. The moment
   that lands, the caller's JWT refers to a user that no longer exists,
   so every subsequent authenticated request fails. Anything that needs
   the session has to happen BEFORE the RPC, not after.

   The thing that needs the session is the staged lecture audio.
   `delete_my_account_data()` deliberately doesn't touch storage objects,
   because deleting a storage.objects row over SQL drops the index entry
   and leaves the actual file in the bucket's backing store (0002 says
   so explicitly). Only the Storage API removes the file, and only a
   signed-in client or the service role can call it.

   So: list and remove the caller's own audio first, then call the RPC.
   That is what lets the deletion page say everything is gone
   immediately, rather than "audio within the hour" — which is what it
   would have had to say while the hourly orphan sweep was the only
   thing that ever removed it.

   Migration 0004 adds the folder-scoped delete policy this needs. Before
   it, the bucket had insert/select/update and no delete, so this step
   would have failed silently and the promise would have been false.
   ================================================================== */

export const LECTURE_AUDIO_BUCKET = "lecture-audio";

/* Typed rather than clicked. An account deletion is irreversible and
   takes the user's notes with it, so it should cost more than a
   mis-tap. Compared case-insensitively after trimming — the point is
   deliberateness, not a spelling test. */
export const DELETE_CONFIRMATION_PHRASE = "DELETE";

export const confirmationMatches = (typed) =>
  String(typed || "").trim().toLowerCase() === DELETE_CONFIRMATION_PHRASE.toLowerCase();

/**
 * Remove every staged audio object belonging to this user.
 *
 * Returns { removed, failed } rather than throwing: audio is transient
 * and swept by age anyway, so failing to remove it must not abort the
 * deletion of the things that actually persist. A user who asked to be
 * deleted and got an error because of a leftover temp file has been
 * failed twice.
 */
export async function removeOwnAudio({ supabaseClient, userId }) {
  if (!supabaseClient || !userId) return { removed: 0, failed: false };
  try {
    const bucket = supabaseClient.storage.from(LECTURE_AUDIO_BUCKET);
    const { data: files, error } = await bucket.list(userId);
    if (error) return { removed: 0, failed: true };
    const paths = (files || []).filter((f) => f && f.name).map((f) => `${userId}/${f.name}`);
    if (paths.length === 0) return { removed: 0, failed: false };
    const { error: removeErr } = await bucket.remove(paths);
    if (removeErr) return { removed: 0, failed: true };
    return { removed: paths.length, failed: false };
  } catch (e) {
    return { removed: 0, failed: true };
  }
}

/**
 * Delete the account: audio first, then every row, then the auth user.
 *
 * `onStep` is called with a short key before each stage so the UI can
 * say what is happening; deletion of a populated account is not
 * instant and a frozen button invites a second click.
 *
 * Throws only when the RPC fails — that is the step whose failure means
 * nothing was deleted, and the only one the user must be told about.
 */
export async function deleteAccount({ supabaseClient, session, onStep = () => {} }) {
  if (!supabaseClient) throw new Error("Deleting an account needs a server connection.");
  const userId = session && session.user && session.user.id;
  if (!userId) throw new Error("You need to be signed in to delete your account.");

  onStep("audio");
  const audio = await removeOwnAudio({ supabaseClient, userId });

  onStep("rows");
  const { error } = await supabaseClient.rpc("delete_my_account");
  if (error) {
    // Deliberately surfaced. Unlike the audio step, a failure here means
    // the account still exists and the user must not be told otherwise.
    throw new Error(error.message || "We couldn't delete your account. Please try again.");
  }

  onStep("done");
  return { audioRemoved: audio.removed, audioFailed: audio.failed };
}

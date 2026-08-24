/* ==================================================================
   sync.js — accounts + cross-device sync

   HOW THIS IS PUT TOGETHER
   ------------------------
   All server communication goes through one object: `backend`.

   - Fill in src/config.js with your Supabase details -> the real
     backend is used, and data syncs between devices for real.
   - Leave config.js untouched -> a demo backend runs instead, keeping
     everything on this device so the app still works offline-only.

   The switch is automatic. Nothing else in the app needs changing.

   ⚠️  SECURITY
   ------------
   `demoBackend` does NOT check passwords and does NOT sync. It exists
   so the app is usable before a server is set up. Never rely on it for
   anything private.

   The real backend relies on Row Level Security in the database to keep
   users' data separate. Run the SQL in SUPABASE-SETUP.md exactly -- if
   RLS is off, every signed-in user could read everyone else's planner.
   ================================================================== */

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from "./config.js";
import { PASSWORD_RESET_REDIRECT } from "./legalLinks.js";

/* ---------- small helpers ---------- */

export const nowISO = () => new Date().toISOString();

const rid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

// A stable id for this phone/computer, so we can tell devices apart.
export function getDeviceId() {
  try {
    let id = localStorage.getItem("uni-planner-device-id");
    if (!id) {
      id = rid();
      localStorage.setItem("uni-planner-device-id", id);
    }
    return id;
  } catch (e) {
    return "unknown-device";
  }
}

/* ---------- which collections sync ---------- */

export const COLLECTIONS = [
  "courses",
  "todos",
  "textbook",
  "assignments",
  "notes",
  "events",
  "pages",
  "folders",
  // Assessment weights and marks (see src/grades.js). User content, so
  // unlike studyStats these DO count in the backup panel's item total.
  "assessments",
  // One row per semester holding the teaching calendar and the grade
  // rounding rule. A collection rather than a key on the semester,
  // because mergeSemester rebuilds semesters from this whitelist and
  // would drop a bare key -- and bookkeeping, so like studyStats it is
  // excluded from the backup panel's item count.
  "settings",
  // Study scheduling stats (see src/srs.js). Listed here because
  // mergeSemester rebuilds each semester from this whitelist alone --
  // a collection missing from it is silently dropped on every sync,
  // while still working locally and in demo mode.
  "studyStats",
  /* Practice attempts (see src/practice.js). BOOKKEEPING, so like
     studyStats and settings it is excluded from the backup panel's item
     count -- a student's "1,204 items" should mean their own notes and
     assignments, not a log of how many questions they answered.

     Listed here for the usual reason: mergeSemester rebuilds each
     semester from this whitelist alone, so a collection missing from it
     is dropped on every sync while working perfectly in demo mode and on
     a single device.

     It also prunes on its own schedule, which matters because
     purgeOldTombstones only runs on sync and restore -- see
     pruneAttempts, which clears its own tombstones rather than leaving
     them to grow forever for a signed-out user. */
  "practiceAttempts",
];

/* Which of those are the app's own bookkeeping rather than the student's
   work. The backup panel's item total is meant to answer "how much of my
   work is in here", so a log of answered questions counted alongside
   someone's assignments inflates it in the direction that reassures.

   Lives here, next to the list it classifies, rather than in
   PlannerApp.jsx: it is a fact about the collections, and keeping the
   two together is what lets a test assert the classification instead of
   pattern-matching a line of source. */
export const BOOKKEEPING_COLLECTIONS = ["studyStats", "settings", "practiceAttempts"];

/** The collections whose items are the student's own content. */
export const COUNTABLE_COLLECTIONS = COLLECTIONS.filter((k) => !BOOKKEEPING_COLLECTIONS.includes(k));

/* ---------- merging two copies of the data ----------

   Rule: last edit wins, decided per individual item (not per device),
   so edits made on two devices to *different* items both survive.

   Deleted items are kept as "tombstones" (deletedAt is set) rather than
   removed outright. Without this, deleting a note on your phone would
   have it reappear the next time your laptop synced.
------------------------------------------------------ */

// Exported for semesterArchive.js, which restores and folds by the
// same per-item rule rather than reimplementing it.
export function mergeList(a = [], b = []) {
  const byId = new Map();
  for (const item of [...a, ...b]) {
    if (!item || !item.id) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    const t1 = existing.updatedAt || "";
    const t2 = item.updatedAt || "";
    byId.set(item.id, t2 > t1 ? item : existing);
  }
  return Array.from(byId.values());
}

function mergeSemester(a = {}, b = {}) {
  const out = {};
  for (const key of COLLECTIONS) out[key] = mergeList(a[key], b[key]);
  return out;
}

// AI-notes consent has its own survival rule, same idea as tombstones just
// below: "newest object wins" is wrong for a fact that shouldn't ever be
// allowed to disappear once granted. Whichever side has an acceptance is
// kept; if both do, a newer consentVersion always wins (it represents
// agreeing to updated wording), and only when versions match does the
// earliest acceptedAt decide (the original acceptance of that wording is
// the true one).
function mergeConsent(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return (a.acceptedAt || "") <= (b.acceptedAt || "") ? a : b;
}

export function mergeData(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  const localTime = (local.meta && local.meta.updatedAt) || "";
  const remoteTime = (remote.meta && remote.meta.updatedAt) || "";
  const newer = remoteTime > localTime ? remote : local;

  const semesters = {};
  const names = new Set([
    ...Object.keys(local.semesters || {}),
    ...Object.keys(remote.semesters || {}),
  ]);
  for (const name of names) {
    semesters[name] = mergeSemester(
      (local.semesters || {})[name],
      (remote.semesters || {})[name]
    );
  }

  return {
    ...newer,                     // scalar settings: theme, selected semester
    semesters,                    // content: merged item by item
    meta: {
      ...(local.meta || {}),
      ...(newer.meta || {}),
      aiConsent: mergeConsent((local.meta || {}).aiConsent, (remote.meta || {}).aiConsent),
      updatedAt: localTime > remoteTime ? localTime : remoteTime,
    },
  };
}

/* ---------- housekeeping ----------
   Tombstones aren't needed forever. Once every device has certainly
   seen the deletion, the record can go for good.
----------------------------------- */

const TOMBSTONE_DAYS = 60;

export function purgeOldTombstones(data, days = TOMBSTONE_DAYS) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const semesters = {};
  for (const [name, sem] of Object.entries(data.semesters || {})) {
    const out = {};
    for (const key of COLLECTIONS) {
      out[key] = (sem[key] || []).filter(
        (it) => !it.deletedAt || it.deletedAt > cutoff
      );
    }
    semesters[name] = out;
  }
  return { ...data, semesters };
}

/* ---------- the backend interface ----------
   Any implementation must provide exactly these six functions.
------------------------------------------- */

const DEMO_USERS_KEY = "uni-planner-demo-users";
const DEMO_SESSION_KEY = "uni-planner-demo-session";
const DEMO_CLOUD_KEY = "uni-planner-demo-cloud";

const readJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
};
const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable */
  }
};

export const demoBackend = {
  name: "demo",
  /** True when sync is only simulated, so the UI can warn the user. */
  isDemo: true,

  async signUp({ email, password }) {
    const users = readJSON(DEMO_USERS_KEY, {});
    const key = email.trim().toLowerCase();
    if (!key || !key.includes("@")) throw new Error("Please enter a valid email address.");
    if ((password || "").length < 8) throw new Error("Password must be at least 8 characters.");
    if (users[key]) throw new Error("An account already exists for that email.");

    users[key] = { id: rid(), email: key, createdAt: nowISO() };
    writeJSON(DEMO_USERS_KEY, users);

    const session = { user: users[key], token: `demo-${users[key].id}` };
    writeJSON(DEMO_SESSION_KEY, session);
    return session;
  },

  async signIn({ email, password }) {
    const users = readJSON(DEMO_USERS_KEY, {});
    const key = (email || "").trim().toLowerCase();
    const user = users[key];
    // The demo deliberately does not verify passwords — there is no secure
    // place to check them on the device. The real backend must verify.
    if (!user) throw new Error("No account found for that email.");
    if (!password) throw new Error("Please enter your password.");

    const session = { user, token: `demo-${user.id}` };
    writeJSON(DEMO_SESSION_KEY, session);
    return session;
  },

  async signOut() {
    try {
      localStorage.removeItem(DEMO_SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  },

  async getSession() {
    return readJSON(DEMO_SESSION_KEY, null);
  },

  /* Demo mode has no email and no server, so a reset is a no-op that
     REPORTS ITSELF as one. Silently pretending to send an email would
     leave someone waiting for a message that was never going to arrive.

     These exist at all because the sign-in form now offers "Forgot
     password?", and a backend missing the method would throw on the
     path a brand-new user is most likely to take. */
  async resetPassword() {
    return { sent: false, reason: "demo" };
  },

  async updatePassword({ password }) {
    if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");
    const users = readJSON(DEMO_USERS_KEY, {});
    const session = readJSON(DEMO_SESSION_KEY, null);
    if (!session) throw new Error("You need to be signed in to change your password.");
    if (users[session.user.email]) {
      users[session.user.email] = { ...users[session.user.email], password };
      writeJSON(DEMO_USERS_KEY, users);
    }
  },

  /* Demo mode has no server to claim on, and no shared account to
     protect. Returning `unavailable` rather than a fake claim keeps the
     three-outcome shape honest all the way down: the caller cannot tell
     "no backend" from "the write failed" by guessing, so it is told. */
  async claimDevice() {
    return { unavailable: true };
  },

  async pull({ session }) {
    if (!session) throw new Error("Not signed in.");
    const cloud = readJSON(DEMO_CLOUD_KEY, {});
    return cloud[session.user.id] || null;
  },

  async push({ session, data }) {
    if (!session) throw new Error("Not signed in.");
    const cloud = readJSON(DEMO_CLOUD_KEY, {});
    cloud[session.user.id] = data;
    writeJSON(DEMO_CLOUD_KEY, cloud);
    return { serverUpdatedAt: nowISO() };
  },
};

/* ---------- the real backend: Supabase ----------

   Turns on automatically once src/config.js has your project details.
   Supabase handles accounts, sessions and password resets; the database
   stores one row per user containing the whole planner.
------------------------------------------------ */

/* Whether a login link could ever appear in this shell's URL.

   The original reasoning for switching session detection OFF was
   correct and is kept: the app is not served from a normal web address
   in the desktop and phone builds, so there is never a link in the URL
   to read. What was wrong was applying that to the HOSTED build too,
   where the password-reset link is exactly such a URL -- so the token
   was never processed and a reset could not complete.

   Gated on the protocol rather than switched on globally, the same shape
   as the service-worker rule in index.html, and it excludes exactly the
   two shells where it could misbehave:

     Electron        file://              never has a token, and stripping
                                          the hash afterwards uses
                                          history.replaceState, which is
                                          not reliable on file://
     Capacitor iOS   capacitor://localhost  non-standard scheme
     Capacitor Android  http://localhost    standard scheme, so this is ON
                                          -- harmless, since no token ever
                                          appears there
     Hosted web      https://...          what this is for

   It changes nothing about ordinary sign-in: the option only acts when
   the URL actually carries auth parameters. */
const urlCanCarryASession = () => {
  try {
    return typeof window !== "undefined" && /^https?:$/.test(window.location.protocol);
  } catch (e) {
    return false;
  }
};

let supabase = null;
if (isConfigured) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: urlCanCarryASession(),
    },
  });
}
// Exported (null when running against the demo backend) so aiNotesClient.js
// can query ai_usage / upload to Storage directly under RLS, without a
// second client instance.
export { supabase };

const TABLE = "planner_data";

/** Turn Supabase's technical errors into something a person can act on. */
function readable(error) {
  const raw = (error && error.message) || "";
  const lower = raw.toLowerCase();
  if (lower.includes("invalid login credentials")) return "That email or password isn't right.";
  if (lower.includes("email not confirmed")) return "Please confirm your email address first - check your inbox.";
  if (lower.includes("user already registered")) return "An account already exists for that email. Try signing in.";
  if (lower.includes("password should be")) return "Password must be at least 6 characters.";
  if (lower.includes("rate limit") || lower.includes("too many")) return "Too many attempts. Please wait a minute and try again.";
  if (lower.includes("failed to fetch") || lower.includes("network")) return "Can't reach the server. Check your internet connection.";
  return raw || "Something went wrong. Please try again.";
}

const shapeSession = (session) =>
  session
    ? {
        user: { id: session.user.id, email: session.user.email },
        token: session.access_token,
      }
    : null;

export const supabaseBackend = {
  name: "supabase",
  isDemo: false,

  async signUp({ email, password }) {
    const { data, error } = await supabase.auth.signUp({
      email: (email || "").trim(),
      password: password || "",
    });
    if (error) throw new Error(readable(error));

    // If the project requires email confirmation there's no session yet.
    if (!data.session) {
      throw new Error(
        "Account created. Please check your email to confirm it, then sign in."
      );
    }
    return shapeSession(data.session);
  },

  async signIn({ email, password }) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: (email || "").trim(),
      password: password || "",
    });
    if (error) throw new Error(readable(error));
    return shapeSession(data.session);
  },

  async signOut() {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      /* clearing the local session is what matters */
    }
  },

  async getSession() {
    try {
      const { data } = await supabase.auth.getSession();
      return shapeSession(data.session);
    } catch (e) {
      return null;
    }
  },

  /* `redirectTo` is passed EXPLICITLY rather than relying on the
     project's Site URL. The Site URL pointed at the old host for an
     unknown period and nothing surfaced it; naming the destination here
     means the app and the email agree by construction, and a future host
     change breaks the build rather than the reset flow.

     It must also be on the Redirect URLs allowlist in Supabase Auth
     settings, or Supabase falls back to the Site URL silently. */
  async resetPassword({ email }) {
    const { error } = await supabase.auth.resetPasswordForEmail((email || "").trim(), {
      redirectTo: PASSWORD_RESET_REDIRECT,
    });
    if (error) throw new Error(readable(error));
    return { sent: true };
  },

  /** Set a new password for whoever the current session belongs to. */
  async updatePassword({ password }) {
    const { error } = await supabase.auth.updateUser({ password: password || "" });
    if (error) throw new Error(readable(error));
  },

  /* ONE DEVICE AT A TIME, on the tiers whose allowance is once ever.

     A function rather than a table write, because `profiles` is
     read-only to `authenticated` and `tier` lives on it — see migration
     0015. The row is chosen by auth.uid() inside the function, so this
     call names no user and cannot be pointed at another account.

     THREE OUTCOMES, like every other read in this codebase. A failed
     RPC is `unavailable`, never "you do not hold it": the whole point
     of the rule is to sign a second device out, and doing that because
     a request failed in a tunnel would be the same bug as tombstoning a
     note because a fetch 500'd. */
  async claimDevice({ session, deviceId }) {
    if (!supabase || !session || !deviceId) return { unavailable: true };
    try {
      const { data, error } = await supabase.rpc("claim_device", { p_device_id: deviceId });
      if (error) return { unavailable: true };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { unavailable: true };
      return { activeDeviceId: row.active_device_id || null, activeDeviceAt: row.active_device_at || null };
    } catch (e) {
      return { unavailable: true };
    }
  },

  async pull({ session }) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("data")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (error) throw new Error(readable(error));
    return data ? data.data : null; // null means nothing saved yet
  },

  async push({ session, data }) {
    const updatedAt = nowISO();
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: session.user.id, data, updated_at: updatedAt },
        { onConflict: "user_id" }
      );
    if (error) throw new Error(readable(error));
    return { serverUpdatedAt: updatedAt };
  },
};

/* ==================================================================
   Which backend is in use.

   No line to change: fill in src/config.js and the real one takes over.
   ================================================================== */
export const backend = isConfigured ? supabaseBackend : demoBackend;

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

  /* Synchronous, device-only, no network -- see `storedSessionRaw`.
     Demo mode's session was always device-only, so this is what
     `getSession` already did, minus the promise. */
  storedSession() {
    try {
      return readJSON(DEMO_SESSION_KEY, null);
    } catch (e) {
      return null;
    }
  },

  /* The same three outcomes, so no caller has to know which backend it
     is talking to. Demo mode reads a device store rather than a server,
     so `failed` is only reachable if that store throws. */
  async getSession() {
    try {
      const session = readJSON(DEMO_SESSION_KEY, null);
      return session ? { session } : { missing: true };
    } catch (e) {
      return { failed: true, stale: null };
    }
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

/* ------------------------------------------------------------------
   THE STORAGE AUTH-JS WRITES THROUGH, SO WE CAN READ WHAT IT KEPT.

   `getSession()` answers `{ session: null, error }` when the access
   token has expired and the refresh could not be completed -- while
   auth-js DELIBERATELY leaves the session in storage, because a dropped
   connection is not a revocation. That is correct of the library and
   useless to a caller: the credential is right there and the only
   public read path has already flattened it to null.

   There is no supported API for "what did you keep". `INITIAL_SESSION`
   is no help -- it goes through the same `__loadSession` and emits
   `null` on the same branch.

   So we hand auth-js the storage, and read back through it. This is a
   DERIVATION rather than a restatement: nothing here names auth-js's
   storage key, invents its shape, or assumes where it lives. Whatever
   it wrote is what we hand back, and the day it changes any of that,
   this follows instead of going stale.

   EVERY METHOD SWALLOWS ITS OWN FAILURE, the noteCache rule: storage
   can throw outright (Safari private browsing) or be full, and an auth
   client that cannot construct is worse than one that cannot persist.
   ------------------------------------------------------------------ */
const observed = new Map();

const observedStorage = {
  getItem(key) {
    try {
      const value = window.localStorage.getItem(key);
      if (value === null) observed.delete(key);
      else observed.set(key, value);
      return value;
    } catch (e) {
      return null;
    }
  },
  setItem(key, value) {
    observed.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* not persisted; the session still works for this run */
    }
  },
  removeItem(key) {
    /* A REMOVAL IS THE ONE UNAMBIGUOUS SIGNAL. auth-js removes the
       session when it is genuinely dead -- a revoked refresh token, a
       sign-out -- and preserves it for everything else. So forgetting it
       here is what stops `failed` from resurrecting a session the
       student really has ended. */
    observed.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  },
};

/* KEYED BY SHAPE, NOT BY NAME, and the first version was not -- which
   is worth keeping because it failed in a way that looked like the fix
   not working at all.

   auth-js reads more than one key through this adapter: besides the
   session it probes a `<key>-user` sidecar, which is usually absent. A
   single `lastStored` variable was therefore overwritten with null by a
   read of a DIFFERENT key moments after the session had been read
   correctly, so the preserved session was always gone by the time
   anybody asked for it.

   Identifying the session by the fields it must have avoids naming any
   key at all, which is the property that made this adapter worth
   building in the first place. The sidecar carries `user` and no
   tokens, so it cannot be mistaken for one. */
function preservedSession() {
  for (const raw of observed.values()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.user && parsed.access_token && parsed.refresh_token) return parsed;
    } catch (e) {
      /* not a session */
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   THE SESSION ON THIS DEVICE, READ WITHOUT ASKING THE NETWORK.

   `supabase.auth.getSession()` is not merely slow when the network is
   down -- it does not RESOLVE. A failed refresh is retried with backoff
   for the length of an auto-refresh tick, so on an offline reopen the
   promise is outstanding for the better part of thirty seconds.

   That is what made this bug look like a sign-out rather than a delay:
   the app's session state starts as null, so for those thirty seconds
   it renders a definitive sign-in form WHILE IT STILL DOES NOT KNOW.
   Answering the question asynchronously was never going to fix a screen
   that has already committed to an answer.

   So startup reads the device instead. This is not a guess and not a
   cache: a session in storage IS the credential, every request made
   with it is authorised server-side regardless, and if it turns out to
   be dead auth-js tears it down and emits SIGNED_OUT within the same
   second. What it buys is that a student who is signed in sees a
   signed-in app immediately, offline or not.

   IT SCANS BY SHAPE rather than naming a key, the reason the observing
   adapter exists: nothing here knows or assumes where auth-js keeps its
   session. A session is the value carrying a user AND both tokens --
   the `-user` sidecar has no tokens, and the demo session has no
   `access_token`, so neither can be mistaken for one.
   ------------------------------------------------------------------ */
function storedSessionRaw() {
  const observedOne = preservedSession();
  if (observedOne) return observedOne;
  try {
    const ls = window.localStorage;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (!key) continue;
      const raw = ls.getItem(key);
      if (!raw || raw[0] !== "{") continue;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.user && parsed.access_token && parsed.refresh_token) return parsed;
    }
  } catch (e) {
    /* no storage, or nothing readable in it */
  }
  return null;
}

let supabase = null;
if (isConfigured) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: urlCanCarryASession(),
      storage: typeof window !== "undefined" && window.localStorage ? observedStorage : undefined,
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

/* THE ONE PLACE A SUPABASE SESSION BECOMES AN APP SESSION, and the
   reason it is exported is that it was not. The app's session is
   `{ user: { id, email }, token }`; the provider's field is
   `access_token`. Nothing outside this module should know that name --
   and the day `plans.jsx` read `session.access_token` instead of
   `session.token`, every web purchase refused with "Please sign in
   again." on a fully signed-in account, before any request was made.

   PlannerApp's PASSWORD_RECOVERY handler used to restate this body
   inline. It agreed, which is exactly the trap: a copy that MATCHES
   its source and a copy DERIVED from it are indistinguishable until
   the source moves. `scripts/test-purchases.mjs` derives the app's
   session key set from here and refuses any other reader of the
   provider's name. */
export const shapeSession = (session) =>
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

  /* Synchronous, device-only, no network. What the app opens with, so a
     signed-in student is never shown a sign-in form while the network
     is being asked a question it may take thirty seconds to answer. */
  storedSession() {
    return shapeSession(storedSessionRaw());
  },

  /* THREE OUTCOMES, NOT TWO -- the `fetchNote` rule, applied to the one
     object the whole app is gated on.

       { session }        a live session
       { missing: true }  the query ran and there is definitively none
       { failed: true }   we could not find out

     This used to read `data.session` and throw `error` away, so all
     three arrived as null. The cost was a reported bug: reopen a phone
     more than an hour after last use, before the radio is up, and
     auth-js answers `{ session: null, error }` -- having DELIBERATELY
     kept the session in storage, because a dropped connection is not a
     revocation. The student was shown a sign-in form over an account
     they were still signed in to, and signed in again.

     `stale` carries the session auth-js kept, so a caller can go on
     treating the student as signed in while saying sync is not working.
     It is NOT a session: its access token is past its expiry and every
     request made with it will be refused. It is evidence that somebody
     is signed in, which is a different claim and the one the screen
     needs. */
  async getSession() {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (data && data.session) return { session: shapeSession(data.session) };
      if (error) return { failed: true, stale: shapeSession(preservedSession()) };
      /* No session and no error is the definitive answer: auth-js looked
         and there is nothing. A preserved session cannot exist here --
         `removeItem` clears the cache on every genuine teardown. */
      return { missing: true };
    } catch (e) {
      return { failed: true, stale: shapeSession(preservedSession()) };
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

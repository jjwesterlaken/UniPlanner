/* ==================================================================
   sync.js — accounts + cross-device sync

   HOW THIS IS PUT TOGETHER
   ------------------------
   All server communication goes through one object: `backend`.
   Today it points at `demoBackend`, which fakes a server using this
   device's own storage so the whole sign-in / sync flow can be built
   and tested with no server at all.

   When the real server is ready, you implement `remoteBackend` below
   (six functions) and change ONE line at the bottom of this file.
   Nothing in the app's UI needs to change.

   ⚠️  SECURITY — READ BEFORE SELLING THIS
   ---------------------------------------
   `demoBackend` is a stand-in for development only. It keeps accounts
   in this device's storage and does NOT provide real security or real
   syncing between devices. Never ship it to paying customers.
   Real authentication must happen on a server: passwords hashed
   server-side (bcrypt/argon2), sessions as signed tokens, and every
   request authorised so one user can never read another's data.
   ================================================================== */

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
];

/* ---------- merging two copies of the data ----------

   Rule: last edit wins, decided per individual item (not per device),
   so edits made on two devices to *different* items both survive.

   Deleted items are kept as "tombstones" (deletedAt is set) rather than
   removed outright. Without this, deleting a note on your phone would
   have it reappear the next time your laptop synced.
------------------------------------------------------ */

function mergeList(a = [], b = []) {
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

/* ---------- the real backend (to be filled in) ----------

   Point API_BASE at your server, implement these six calls, then set
   `backend = remoteBackend` at the bottom of this file.

   Suggested server routes:
     POST /auth/signup   {email, password}          -> {user, token}
     POST /auth/login    {email, password}          -> {user, token}
     POST /auth/logout   (Authorization: Bearer …)  -> {}
     GET  /planner       (Authorization: Bearer …)  -> {data} | 404
     PUT  /planner       {data}                     -> {serverUpdatedAt}

   Everything the app stores is one JSON blob per user, so the database
   can be as simple as: users(id, email, password_hash) and
   planner_data(user_id, data JSON, updated_at).
--------------------------------------------------------- */

const API_BASE = "https://REPLACE-ME.example.com";

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let message = "Something went wrong. Please try again.";
    try {
      const err = await res.json();
      if (err && err.message) message = err.message;
    } catch (e) {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

export const remoteBackend = {
  name: "remote",
  isDemo: false,

  async signUp({ email, password }) {
    const out = await api("/auth/signup", { method: "POST", body: { email, password } });
    writeJSON(DEMO_SESSION_KEY, out);
    return out;
  },

  async signIn({ email, password }) {
    const out = await api("/auth/login", { method: "POST", body: { email, password } });
    writeJSON(DEMO_SESSION_KEY, out);
    return out;
  },

  async signOut() {
    const session = readJSON(DEMO_SESSION_KEY, null);
    try {
      if (session) await api("/auth/logout", { method: "POST", token: session.token });
    } catch (e) {
      /* signing out locally still matters even if the server call fails */
    }
    try {
      localStorage.removeItem(DEMO_SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  },

  async getSession() {
    return readJSON(DEMO_SESSION_KEY, null);
  },

  async pull({ session }) {
    const out = await api("/planner", { token: session.token });
    return out ? out.data : null;
  },

  async push({ session, data }) {
    return api("/planner", { method: "PUT", token: session.token, body: { data } });
  },
};

/* ==================================================================
   THE ONE LINE TO CHANGE when the server is ready:
   ================================================================== */
export const backend = demoBackend;
// export const backend = remoteBackend;

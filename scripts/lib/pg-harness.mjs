/* pg-harness.mjs — a real PostgreSQL for a test suite to run against.
 *
 * WHY THIS IS A MODULE RATHER THAN LIVING IN test-migrations.mjs, which
 * is where all of it was written: a stand-in that is weaker than
 * production makes every check inside it weaker too, and this project
 * has now paid for that FOUR times — table default privileges, a
 * missing `service_role`, function default privileges, and then the one
 * that made this extraction necessary.
 *
 * THE FOURTH: billing-webhook's suite drove the real handler against a
 * hand-written fake database. The fake modelled the primary key on
 * `billing_events` (so "a redelivery writes one row" was real) and it
 * did NOT model the foreign key from `user_id` to `auth.users`. The
 * first real delivery was an event for a user we do not have; the
 * handler inserted that id anyway; Postgres refused with 23503 and the
 * function returned 500. Thirty-three green tests, and the constraint
 * that decided the outcome existed nowhere in them.
 *
 * The fix is not a fake that knows about this one constraint — that is
 * the restatement pattern with extra steps, and the next constraint
 * would be missing in exactly the same way. It is that a suite which
 * makes claims about what the database accepts runs against the
 * database, so the schema's constraints are the test's constraints and
 * nobody has to remember to copy one across.
 *
 * WHAT IS DELIBERATELY NOT HERE: any notion of Row Level Security being
 * enforced for a service-role caller, or of PostgREST. This gives a
 * suite real SQL against the real migrations. It does not turn a Node
 * test into a Supabase project.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

/* Just enough of what Supabase's platform provides for the migrations to
   have something to bind to. auth.uid() reads a GUC so a test can act as
   any user — that's the whole mechanism these functions are built on.

   THE DEFAULT PRIVILEGES ARE PART OF THE ENVIRONMENT, learned the hard
   way: a real Supabase project runs ALTER DEFAULT PRIVILEGES so every
   table created in the SQL editor arrives with ALL verbs — UPDATE
   included — already granted to anon and authenticated. This shim used
   to omit that, so a check asserting "update is not granted" passed
   here and failed on the real project (found by Jared re-checking 0007
   by hand). A stand-in that restates the environment more weakly than
   production is the restatement drift in one more costume. */
export const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    -- service_role is the one the Edge Functions authenticate as, and it
    -- was MISSING here until 0011 named it in a grant. A migration that
    -- referenced it would have failed on this shim while applying
    -- perfectly to the real project -- the same "the stand-in is weaker
    -- than production" lesson as the default privileges below, running
    -- in the opposite direction: there the shim let a bad migration
    -- pass, here it would have failed a good one. Both are the shim
    -- restating the environment instead of matching it.
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;

  alter default privileges in schema public grant all on tables to anon, authenticated;
  /* AND ON FUNCTIONS, which is the omission that let 0002's revoke look
     correct here and fail on the real project. Supabase runs
     "alter default privileges ... grant all on functions to postgres,
     anon, authenticated, service_role", so a function created in the SQL
     editor arrives with EXECUTE granted DIRECTLY to anon — not merely
     via PUBLIC. "revoke all on function ... from public" does not remove
     a role-specific grant, so anon keeps it.

     That is exactly why 0011, 0012, 0014 and 0015 each revoke from
     public AND anon; 0002 predates the lesson and revokes only from
     public. Without this line the shim says 0002 is correct. With it,
     the shim agrees with production. Third instance of the stand-in
     restating the environment more weakly than it is -- see the default
     privileges on tables above, and the missing service_role. */
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;

  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  create schema if not exists storage;
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text, name text, owner uuid
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select string_to_array(name, '/');
  $$;
`;

/* Documented in SUPABASE-SETUP.md §1 rather than created by a migration,
   so it's set up separately — some tests deliberately leave it out. */
/* Its POLICIES are part of it, and were missing here until the grant
   audit: without them the stand-in said planner_data had grants no
   policy backed, which is the very state the audit exists to find.
   Copied from SUPABASE-SETUP.md §1 — select, insert and update, and
   deliberately no delete (account deletion runs through the security
   definer function). */
export const PLANNER_DATA = `
  create table public.planner_data (
    user_id uuid primary key references auth.users(id) on delete cascade,
    data jsonb not null,
    updated_at timestamptz not null default now()
  );
  alter table public.planner_data enable row level security;
  create policy "planner_data_select_own" on public.planner_data for select using (auth.uid() = user_id);
  create policy "planner_data_upsert_own" on public.planner_data for insert with check (auth.uid() = user_id);
  create policy "planner_data_update_own" on public.planner_data for update using (auth.uid() = user_id);
`;

/**
 * Locate a postgres and hand back everything a suite needs to drive it.
 *
 * Two ways to get a database, exactly as before:
 *
 * - **A server that's already running**, used when PGHOST is set. That's
 *   the CI path: the workflow starts a postgres service container and
 *   points this at it. libpq's own environment variables (PGHOST, PGPORT,
 *   PGUSER, PGPASSWORD) do the connecting, so only `psql` is needed.
 * - **A throwaway cluster this creates**, otherwise. Needs a full local
 *   postgres install (initdb, pg_ctl, psql).
 *
 * Returns `{ available: false, reason, fix }` when neither is there. It
 * does NOT exit the process on its own: one caller wants to skip its
 * whole file, another wants to skip one section and still run the rest,
 * and a module that decides that for them can only be right for one of
 * them. `skipOrFail()` is the shared implementation of the decision.
 */
export function createPgHarness({ migrationsDir, label = "these tests" } = {}) {
  const strict = process.env.REQUIRE_POSTGRES === "1" || process.argv.includes("--require-postgres");

  /* PGHOST means "a server is already running, just connect to it" — the CI
     service container, or a local server someone would rather reuse. Only
     psql is needed then; initdb and pg_ctl aren't in the picture at all. */
  const useExistingServer = Boolean(process.env.PGHOST);

  function findBinDir(required) {
    // A packaged postgres usually isn't on PATH (Debian/Ubuntu hides it in
    // /usr/lib/postgresql/<version>/bin), so look there too before giving up.
    const onPath = spawnSync(required, ["--version"], { stdio: "ignore" });
    if (onPath.status === 0) return "";

    const candidates = [];
    for (const base of ["/usr/lib/postgresql", "/usr/local/opt", "/opt/homebrew/opt"]) {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        const b = path.join(base, entry, "bin");
        if (fs.existsSync(path.join(b, required))) candidates.push(b);
      }
    }
    // Highest version number wins.
    candidates.sort();
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  const binDir = findBinDir(useExistingServer ? "psql" : "initdb");
  if (binDir === null) {
    const reason = useExistingServer ? "PGHOST is set but no psql client was found" : "no PostgreSQL install found";
    const fix = useExistingServer
      ? "Install the postgres client package on the runner."
      : "Install postgres, or point PGHOST at a running server.";
    return {
      available: false,
      strict,
      reason,
      fix,
      /** In strict mode an absent database is a failure; otherwise a quiet skip. */
      skipOrFail(exitOnSkip = true) {
        if (strict) {
          console.error(`${label} could NOT run: ${reason}`);
          console.error(`Strict mode (REQUIRE_POSTGRES / --require-postgres) is on, so this is a failure rather than a skip. ${fix}`);
          process.exit(1);
        }
        console.log(`${label} skipped: ${reason}`);
        console.log("(fine locally — CI runs them for real against a postgres service container)");
        if (exitOnSkip) process.exit(0);
        return false;
      },
    };
  }

  const bin = (name) => (binDir ? path.join(binDir, name) : name);

  /* initdb and postgres refuse to run as root. In a root container (some
     Docker images) fall back to the `postgres` system user, which owns the
     data dir in that setup anyway. Irrelevant when connecting to a server
     someone else started — psql is happy to run as root. */
  const asRoot = !useExistingServer && typeof process.getuid === "function" && process.getuid() === 0;
  const unprivilegedUser = asRoot ? "postgres" : null;

  function exec(command, args, { input, allowFail = false } = {}) {
    const [cmd, cmdArgs] = unprivilegedUser
      ? ["su", [unprivilegedUser, "-c", [command, ...args].map((a) => `'${a}'`).join(" ")]]
      : [command, args];
    const result = spawnSync(cmd, cmdArgs, { input, encoding: "utf8" });
    if (!allowFail && result.status !== 0) {
      // result.error covers the case where the command couldn't be launched
      // at all (missing binary), where stderr is undefined and reporting it
      // alone would print a bare "undefined".
      const detail = result.error ? result.error.message : result.stderr || result.stdout;
      throw new Error(`${path.basename(command)} failed:\n${detail}`);
    }
    return result;
  }

  /* ---------- cluster lifecycle ---------- */

  let tmpRoot = null;
  let dataDir = null;
  let sockDir = null;
  let started = false;

  function stop() {
    if (started) {
      exec(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { allowFail: true });
      started = false;
    }
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  }

  process.on("exit", stop);

  const connection = () => (useExistingServer ? [] : ["-h", sockDir]);

  function psql(db, sql) {
    // -v ON_ERROR_STOP=1 makes a failing statement fail the whole script
    // rather than psql plowing on and exiting 0.
    const result = exec(bin("psql"), [...connection(), "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"], {
      input: sql,
      allowFail: true,
    });
    return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
  }

  /* Two psql processes at once, which is the only way to demonstrate a
     lost update: it needs two sessions holding two snapshots. `exec` is
     synchronous by design (everything else here is a single statement
     batch), so this is its async twin, with the same su-as-postgres
     handling. */
  function psqlAsync(db, sql) {
    const args = [...connection(), "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"];
    const [cmd, cmdArgs] = unprivilegedUser
      ? ["su", [unprivilegedUser, "-c", [bin("psql"), ...args].map((a) => `'${a}'`).join(" ")]]
      : [bin("psql"), args];
    return new Promise((resolve) => {
      const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
      child.stdin.end(sql);
    });
  }

  function psqlOrThrow(db, sql) {
    const r = psql(db, sql);
    if (!r.ok) throw new Error(r.err || r.out);
    return r;
  }

  /* VERBOSITY verbose is what makes the SQLSTATE readable. A caller that
     has to tell a foreign-key violation from a unique one — which is the
     whole reason the billing suite runs here rather than against a fake —
     needs the five-character code, and psql prints only the message text
     without it. Parsed rather than pattern-matched on the message,
     because message text is a translation away from changing. */
  function psqlCode(db, sql) {
    const r = exec(bin("psql"), [...connection(), "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"], {
      input: `\\set VERBOSITY verbose\n${sql}`,
      allowFail: true,
    });
    const err = (r.stderr || "").trim();
    /* Verbose mode prints `psql:<stdin>:2: ERROR:  23503: <message>` —
       the SQLSTATE is INLINE after ERROR:, not on a SQLSTATE: line of
       its own, which is what the first version of this looked for. It
       found nothing, returned a null code, and the two tests that
       assert on a code failed loudly rather than passing over a null:
       "an empty query result is a failure", in the smallest costume. */
    const m = /ERROR:\s{2}([0-9A-Z]{5}):\s*(.*)$/m.exec(err);
    const code = m ? m[1] : null;
    const message = m ? m[2] : /ERROR:\s*(.*)$/m.exec(err)?.[1] ?? err;
    return { ok: r.status === 0, out: (r.stdout || "").trim(), err, code, message };
  }

  function applyMigration(db, file) {
    return psqlOrThrow(db, fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }

  let dbCounter = 0;
  function freshDb({ withPlannerData = true } = {}) {
    const name = `uniplanner_test_${dbCounter++}`;
    psqlOrThrow("postgres", `drop database if exists ${name}; create database ${name};`);
    psqlOrThrow(name, SUPABASE_STUBS);
    if (withPlannerData) psqlOrThrow(name, PLANNER_DATA);
    return name;
  }

  const one = (db, sql) => psqlOrThrow(db, sql).out;
  const count = (db, table, where = "true") => Number(one(db, `select count(*) from ${table} where ${where};`));

  /** Start the cluster (or prove the named server answers). Idempotent. */
  function start() {
    if (useExistingServer) {
      console.log(`connecting to the postgres already running at ${process.env.PGHOST}:${process.env.PGPORT || 5432}`);
      // A server that's named but unreachable is a broken setup, never a
      // skip — skipping here is exactly the silence this mode exists to
      // prevent, so it fails loudly in both modes.
      const reachable = psql("postgres", "select 1;");
      if (!reachable.ok) {
        throw new Error(`PGHOST is set but the server can't be reached:\n${reachable.err}`);
      }
      return;
    }
    if (started) return;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uniplanner-pg-"));
    dataDir = path.join(tmpRoot, "data");
    sockDir = path.join(tmpRoot, "sock");
    fs.mkdirSync(sockDir);
    if (asRoot) {
      // The unprivileged user needs to traverse in and write to both.
      fs.chmodSync(tmpRoot, 0o777);
      fs.chmodSync(sockDir, 0o777);
    }
    console.log(`using postgres at ${binDir || "(on PATH)"}`);
    exec(bin("initdb"), ["-D", dataDir, "-A", "trust", "-U", "postgres"]);
    exec(bin("pg_ctl"), ["-D", dataDir, "-o", `-k ${sockDir} -h ""`, "-l", path.join(tmpRoot, "log"), "-w", "start"]);
    started = true;
  }

  return {
    available: true,
    strict,
    useExistingServer,
    binDir,
    bin,
    exec,
    start,
    stop,
    psql,
    psqlAsync,
    psqlOrThrow,
    psqlCode,
    applyMigration,
    freshDb,
    one,
    count,
    skipOrFail: () => true,
  };
}

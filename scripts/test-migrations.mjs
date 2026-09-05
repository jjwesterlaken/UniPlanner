/* Tests for supabase/migrations/*.sql against a real PostgreSQL.

   SQL is the one part of this project that can't be checked by reading
   it: a migration either applies to a live database or it doesn't, and
   `delete_my_account()` is the single function where being wrong means a
   deleted account quietly keeps its lecture transcripts. So this spins up
   a throwaway cluster in a temp dir, applies the migrations to it, and
   asserts on what actually happened to the rows.

   Nothing here touches your Supabase project — it's entirely local, and
   the cluster is deleted afterwards.

   Two ways to get a database:

   - **A server that's already running**, used when PGHOST is set. That's
     the CI path: the workflow starts a postgres service container and
     points this at it. libpq's own environment variables (PGHOST, PGPORT,
     PGUSER, PGPASSWORD) do the connecting, so only `psql` is needed.
   - **A throwaway cluster this script creates**, otherwise. Needs a full
     local postgres install (initdb, pg_ctl, psql).

   **Skips itself (exit 0) when neither is available**, which is the normal
   case on the machines this app is usually built from. Install postgres
   (macOS: `brew install postgresql@16`) if you want this coverage locally.

   That skip is only acceptable because somewhere always runs it for real.
   Set REQUIRE_POSTGRES=1 (or pass --require-postgres) and every skip path
   becomes a hard failure instead — CI sets it, so a test that quietly
   stops running fails the build rather than going unnoticed.

   Run via `npm run test:migrations`, or as part of `npm test`. */

import assert from "node:assert/strict";
import { newIdempotencyKey } from "../src/aiNotesLogic.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");

/* ---------- strict mode ---------- */

const strict = process.env.REQUIRE_POSTGRES === "1" || process.argv.includes("--require-postgres");

/** In strict mode a skip is a failure; otherwise it's a quiet exit 0. */
function skip(reason, fix) {
  if (strict) {
    console.error(`migration tests could NOT run: ${reason}`);
    console.error(`Strict mode (REQUIRE_POSTGRES / --require-postgres) is on, so this is a failure rather than a skip. ${fix}`);
    process.exit(1);
  }
  console.log(`migration tests skipped: ${reason}`);
  console.log("(fine locally — CI runs them for real against a postgres service container)");
  process.exit(0);
}

/* ---------- locating postgres ---------- */

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
      const bin = path.join(base, entry, "bin");
      if (fs.existsSync(path.join(bin, required))) candidates.push(bin);
    }
  }
  // Highest version number wins.
  candidates.sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

const binDir = findBinDir(useExistingServer ? "psql" : "initdb");
if (binDir === null) {
  skip(
    useExistingServer
      ? "PGHOST is set but no psql client was found"
      : "no PostgreSQL install found",
    useExistingServer
      ? "Install the postgres client package on the runner."
      : "Install postgres, or point PGHOST at a running server."
  );
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

const tmpRoot = useExistingServer ? null : fs.mkdtempSync(path.join(os.tmpdir(), "uniplanner-pg-"));
const dataDir = tmpRoot && path.join(tmpRoot, "data");
const sockDir = tmpRoot && path.join(tmpRoot, "sock");
if (tmpRoot) {
  fs.mkdirSync(sockDir);
  if (asRoot) {
    // The unprivileged user needs to traverse in and write to both.
    fs.chmodSync(tmpRoot, 0o777);
    fs.chmodSync(sockDir, 0o777);
  }
}

let started = false;

function stopCluster() {
  if (started) {
    exec(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { allowFail: true });
    started = false;
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.on("exit", stopCluster);

function psql(db, sql) {
  // -v ON_ERROR_STOP=1 makes a failing statement fail the whole script
  // rather than psql plowing on and exiting 0.
  const connection = useExistingServer ? [] : ["-h", sockDir];
  const result = exec(bin("psql"), [...connection, "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"], {
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
  const connection = useExistingServer ? [] : ["-h", sockDir];
  const args = [...connection, "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"];
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

function applyMigration(db, file) {
  return psqlOrThrow(db, fs.readFileSync(path.join(migrationsDir, file), "utf8"));
}

/* ---------- Supabase stand-ins ---------- */

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
const SUPABASE_STUBS = `
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
const PLANNER_DATA = `
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

/* ---------- tiny test harness (same shape as test-ai-notes.mjs) ---------- */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

/* The app's own device id, lifted from sync.js rather than invented
   here — the same arrangement as the uid() lift in the id-column guard,
   and for the same reason: a literal would pin today's format and pass
   the day the generator changed. */
function newDeviceIdFromSource() {
  const src = fs.readFileSync(path.join(rootDir, "src/sync.js"), "utf8");
  const m = /^const rid = (\(\) => `[^`]+`);/m.exec(src);
  assert.ok(m, "couldn't find sync.js's rid() helper — this guard is blind, fix the pattern");
  return new Function(`return ${m[1]}`)()();
}

const USER = "'11111111-1111-1111-1111-111111111111'";
const OTHER = "'22222222-2222-2222-2222-222222222222'";

function seedTwoUsers(db, { withPlannerData = true } = {}) {
  psqlOrThrow(
    db,
    `insert into auth.users (id) values (${USER}), (${OTHER});
     /* No usage COLUMN named here on purpose. This helper is used by
        tests that stop at 0001 or 0002, before 0012 adds credits_used —
        and by tests that run every migration, after 0013 has dropped
        minutes_used. Naming either one makes the helper wrong at one end
        of that range. What every caller actually needs is a row that
        exists and belongs to a user. */
     insert into public.ai_usage (user_id, month) values (${USER}, '2026-08'), (${OTHER}, '2026-08');
     insert into public.ai_notes_requests (idempotency_key, user_id, status, result) values
       (gen_random_uuid(), ${USER}, 'done', '{"transcript":"my lecture"}'),
       (gen_random_uuid(), ${OTHER}, 'done', '{"transcript":"their lecture"}');
     ${withPlannerData ? `insert into public.planner_data (user_id, data) values (${USER}, '{}'), (${OTHER}, '{}');` : ""}`
  );
}

async function run() {
  if (useExistingServer) {
    console.log(`connecting to the postgres already running at ${process.env.PGHOST}:${process.env.PGPORT || 5432}`);
    // A server that's named but unreachable is a broken setup, never a
    // skip — skipping here is exactly the silence this mode exists to
    // prevent, so it fails loudly in both modes.
    const reachable = psql("postgres", "select 1;");
    if (!reachable.ok) {
      throw new Error(`PGHOST is set but the server can't be reached:\n${reachable.err}`);
    }
  } else {
    console.log(`using postgres at ${binDir || "(on PATH)"}`);
    exec(bin("initdb"), ["-D", dataDir, "-A", "trust", "-U", "postgres"]);
    exec(bin("pg_ctl"), ["-D", dataDir, "-o", `-k ${sockDir} -h ""`, "-l", path.join(tmpRoot, "log"), "-w", "start"]);
    started = true;
  }

  await test("every migration applies cleanly to an empty database, in order", () => {
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      applyMigration(db, file);
    }
  });

  await test("the signup trigger gives every new user a free-tier profile", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    assert.equal(one(db, `select tier from public.profiles where user_id = ${USER};`), "free");
  });

  await test("delete_my_account() removes every trace of the caller", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);

    for (const table of ["public.profiles", "public.ai_usage", "public.ai_notes_requests", "public.planner_data"]) {
      assert.equal(count(db, table, `user_id = ${USER}`), 0, `${table} still holds the deleted user's rows`);
    }
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0, "the auth.users row itself must go");
  });

  await test("delete_my_account() touches nobody else's data", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);

    for (const table of ["public.profiles", "public.ai_usage", "public.ai_notes_requests", "public.planner_data"]) {
      assert.equal(count(db, table, `user_id = ${OTHER}`), 1, `${table} lost another user's rows`);
    }
    assert.equal(count(db, "auth.users", `id = ${OTHER}`), 1);
  });

  await test("the cascade alone would also clear the AI tables (belt and braces both hold)", () => {
    // If delete_my_account() ever loses its explicit deletes, ON DELETE
    // CASCADE still has to carry it — this is that half, tested on its own.
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    seedTwoUsers(db);
    psqlOrThrow(db, `delete from auth.users where id = ${USER};`);
    for (const table of ["public.profiles", "public.ai_usage", "public.ai_notes_requests"]) {
      assert.equal(count(db, table, `user_id = ${USER}`), 0, `${table} does not cascade from auth.users`);
    }
  });

  await test("a signed-out caller is refused, not silently ignored", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);

    for (const fn of ["public.delete_my_account()", "public.delete_my_account_data()"]) {
      const r = psql(db, `set test.uid = ''; select ${fn};`);
      assert.equal(r.ok, false, `${fn} must raise when auth.uid() is null`);
      assert.match(r.err, /must be called by a signed-in user/);
    }
    // And nothing was deleted on the way to refusing.
    assert.equal(count(db, "public.ai_notes_requests"), 2);
  });

  await test("REVOKING FROM public DOES NOT REMOVE A ROLE-SPECIFIC GRANT — the environment fact", () => {
    /* Stated on a synthetic function rather than on a migration, so it
       pins the MECHANISM and survives any later edit to 0002.

       Supabase grants EXECUTE on new public functions directly to anon
       via ALTER DEFAULT PRIVILEGES. `revoke ... from public` removes the
       PUBLIC entry and leaves `anon=X/...` untouched, so anon keeps the
       privilege. This is why 0011/0012/0014/0015 revoke from both, why
       0002 (which revokes only from public) was never sufficient on the
       real project, and why 0016's self-check refused to commit on
       5 September 2026. A plain Postgres cluster cannot show it — the
       shim models the default privileges for exactly this reason. */
    const db = freshDb();
    psqlOrThrow(db, "create function public.probe_fn() returns void language sql as $$ select $$;");
    assert.equal(
      one(db, `select has_function_privilege('anon', 'public.probe_fn()', 'execute');`),
      "t",
      "the shim is not granting anon EXECUTE on a new function, so it is weaker than production again"
    );
    psqlOrThrow(db, "revoke all on function public.probe_fn() from public;");
    assert.equal(
      one(db, `select has_function_privilege('anon', 'public.probe_fn()', 'execute');`),
      "t",
      "revoking from public removed anon's grant — the mechanism this whole incident rests on does not hold"
    );
    psqlOrThrow(db, "revoke all on function public.probe_fn() from anon;");
    assert.equal(
      one(db, `select has_function_privilege('anon', 'public.probe_fn()', 'execute');`),
      "f",
      "revoking from anon did not remove it either — something else is going on"
    );
  });

  await test("anon can't call the deletion functions; authenticated can — AFTER the 0016 repair", () => {
    /* 0002 alone does NOT make this true on a Supabase-shaped database:
       it revokes from public only. This test applied 0001+0002 and
       passed for as long as the shim omitted the function default
       privileges, which is the same stand-in weakness that let the
       missing function go unnoticed. 0016 is what makes the claim
       true, so 0016 is what the test applies. */
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");

    for (const fn of ["public.delete_my_account()", "public.delete_my_account_data()"]) {
      assert.equal(
        one(db, `select has_function_privilege('anon', '${fn}', 'execute');`),
        "t",
        `${fn} is already closed to anon after 0002 alone — if 0002 was fixed, move this expectation`
      );
    }

    applyMigration(db, "0016_repair_account_deletion.sql");
    for (const fn of ["public.delete_my_account()", "public.delete_my_account_data()"]) {
      assert.equal(one(db, `select has_function_privilege('anon', '${fn}', 'execute');`), "f", `anon must not be able to call ${fn}`);
      assert.equal(one(db, `select has_function_privilege('authenticated', '${fn}', 'execute');`), "t", `authenticated must be able to call ${fn}`);
    }
  });

  await test("0002 never overwrites a delete_my_account() the project already had", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    psqlOrThrow(
      db,
      `create table public.sentinel (note text);
       create function public.delete_my_account() returns void language plpgsql security definer as $$
       begin insert into public.sentinel values ('the project''s own logic ran'); end; $$;`
    );

    const result = applyMigration(db, "0002_account_deletion.sql");
    assert.match(result.err || "", /already exists and was left unchanged/, "0002 must say so rather than replacing it silently");

    psqlOrThrow(db, `insert into auth.users (id) values (${USER}); set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "public.sentinel"), 1, "the project's own deletion logic was replaced");
    // ...and the helper it's told to call is available to be added to it.
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    assert.equal(count(db, "public.profiles", `user_id = ${USER}`), 0);
  });

  /* ---------- 0016: the production repair ----------

     THE STATE THIS REPRODUCES. Production held exactly one deletion
     function on 5 September 2026 — `delete_my_account_data` — and no
     `delete_my_account`, so `rpc("delete_my_account")` failed and
     in-app deletion deleted nothing server-side.

     The cause is structural rather than mysterious, and these tests
     demonstrate it rather than asserting it: 0002 creates the data
     function unconditionally AND 0005/0007/0010 re-create it, while it
     is the ONLY migration that creates the account function, inside a
     DO block that skips silently. Skip 0002 and you get production's
     state exactly. */

  const productionShapedDb = () => {
    /* Every migration EXCEPT 0002 — the reproduction. */
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      if (file.startsWith("0002_")) continue;
      if (file.startsWith("0016_")) continue;
      applyMigration(db, file);
    }
    return db;
  };

  /* Every table a deletion must empty, DERIVED FROM THE CATALOGUE rather
     than typed, so a table added later fails this instead of being
     quietly skipped — the shape CLAUDE.md records for the document's
     table list and for the grant audit. */
  const userTablesOf = (db) => {
    const rows = one(
      db,
      `select coalesce(string_agg('public.'||table_name, ',' order by table_name), '')
         from information_schema.columns
        where table_schema = 'public' and column_name = 'user_id';`
    );
    const list = rows ? rows.split(",").filter(Boolean) : [];
    assert.ok(list.length >= 6, `only ${list.length} user-owned tables found — the derivation is reading the wrong thing`);
    return list;
  };

  /* Both users, in every user-owned table, so "the deletion emptied it"
     and "it left the other account alone" are both real claims. */
  const seedEveryTable = (db) => {
    seedTwoUsers(db);
    psqlOrThrow(
      db,
      `insert into public.ai_notes (id, user_id, course, week, content) values
         ('aaaaaaaa-0000-0000-0000-000000000001', ${USER},  'PHYS1001', '3', '{"translations":{}}'),
         ('bbbbbbbb-0000-0000-0000-000000000002', ${OTHER}, 'LAWS2002', '4', '{"translations":{}}');
       insert into public.semester_archives (id, user_id, label, summary, data) values
         ('cccccccc-0000-0000-0000-000000000003', ${USER},  'Semester 1', '{}', '{}'),
         ('dddddddd-0000-0000-0000-000000000004', ${OTHER}, 'Semester 1', '{}', '{}');
       insert into public.client_errors (user_id, message) values
         (${USER}, 'mine'), (${OTHER}, 'theirs');`
    );
    /* The seed must cover everything the derivation finds, or the
       assertions below pass over whatever it missed. */
    for (const table of userTablesOf(db)) {
      assert.ok(
        Number(count(db, table, `user_id = ${USER}`)) > 0,
        `${table} has a user_id column but the seed leaves it empty, so emptying it would prove nothing`
      );
    }
  };

  await test("SKIPPING 0002 reproduces production exactly: the data function exists, the account function does not", () => {
    const db = productionShapedDb();
    const found = one(
      db,
      `select coalesce(string_agg(n.nspname||'.'||p.proname, ', ' order by p.proname), '(none)')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname like '%delete_my_account%';`
    );
    // Jared's query, against a database we built by omitting one file.
    assert.equal(
      found,
      "public.delete_my_account_data",
      "omitting 0002 did not reproduce the reported production state, so the diagnosis is wrong"
    );
  });

  await test("the client's RPC name is the one that is missing — the defect, stated as the app sees it", () => {
    /* Derived from the client rather than typed here: the guard must
       follow a rename instead of pinning the name it was written with. */
    const client = fs.readFileSync(path.join(rootDir, "src/accountDeletion.js"), "utf8");
    const m = /\.rpc\(\s*"([a-z_]+)"/.exec(client);
    assert.ok(m, "src/accountDeletion.js no longer calls an rpc by name");
    const rpcName = m[1];
    const db = productionShapedDb();
    assert.equal(
      one(db, `select (pg_catalog.to_regprocedure('public.${rpcName}()') is not null)::text;`),
      "false",
      `${rpcName} exists in the production-shaped database, so this test is not reproducing the defect`
    );
    // ...and applying the repair is what makes the app's own call work.
    applyMigration(db, "0016_repair_account_deletion.sql");
    assert.equal(
      one(db, `select (pg_catalog.to_regprocedure('public.${rpcName}()') is not null)::text;`),
      "true",
      `0016 did not create ${rpcName}, which is the function the client actually calls`
    );
  });

  await test("0016 REPAIRS rather than skips: it creates the function that was absent", () => {
    const db = productionShapedDb();
    applyMigration(db, "0016_repair_account_deletion.sql");
    assert.equal(one(db, `select (pg_catalog.to_regprocedure('public.delete_my_account()') is not null)::text;`), "true");
    assert.equal(one(db, `select prosecdef::text from pg_proc where oid = 'public.delete_my_account()'::regprocedure;`), "true");
    assert.equal(
      one(db, `select exists (select 1 from unnest(proconfig) c where c in ('search_path=', 'search_path=""'))::text
                 from pg_proc where oid = 'public.delete_my_account()'::regprocedure;`),
      "true",
      "the repaired function does not pin search_path"
    );
    assert.equal(one(db, `select has_function_privilege('authenticated', 'public.delete_my_account()', 'execute');`), "t");
    assert.equal(one(db, `select has_function_privilege('anon', 'public.delete_my_account()', 'execute');`), "f");
  });

  await test("0016 repairs the PRIVILEGE 0002 was also the only carrier of", () => {
    /* create-or-replace preserves an existing ACL, so a data function
       created by 0005 rather than 0002 never had 0002's revoke applied
       and has carried PostgreSQL's default EXECUTE-to-PUBLIC since. Not
       exploitable — it raises when auth.uid() is null — but it is the
       same omission one object over, and it is the fingerprint that
       tells "0002 never ran" apart from "0002 ran and was skipped". */
    const db = productionShapedDb();
    assert.equal(
      one(db, `select has_function_privilege('anon', 'public.delete_my_account_data()', 'execute');`),
      "t",
      "the production-shaped database does not show the default-privilege fingerprint, so the discriminator is wrong"
    );
    applyMigration(db, "0016_repair_account_deletion.sql");
    assert.equal(
      one(db, `select has_function_privilege('anon', 'public.delete_my_account_data()', 'execute');`),
      "f",
      "0016 did not revoke the default grant it exists to repair"
    );
    assert.equal(one(db, `select has_function_privilege('authenticated', 'public.delete_my_account_data()', 'execute');`), "t");
  });

  await test("the REPAIRED function really deletes the account, end to end", () => {
    const db = productionShapedDb();
    applyMigration(db, "0016_repair_account_deletion.sql");
    seedEveryTable(db);
    const tables = userTablesOf(db);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);

    for (const table of tables) {
      assert.equal(count(db, table, `user_id = ${USER}`), 0, `${table} survived the repaired deletion`);
      assert.equal(count(db, table, `user_id = ${OTHER}`), 1, `${table} lost the OTHER user's row`);
    }
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0, "the auth.users row itself must go");
    assert.equal(count(db, "auth.users", `id = ${OTHER}`), 1);
  });

  await test("0016's self-check RAISES rather than reporting success — the whole point of it", () => {
    /* A migration that can succeed while its object is absent is what
       produced this incident. Remove the helper it depends on and the
       apply must FAIL, not skip. Mutation-checked by construction. */
    const db = productionShapedDb();
    psqlOrThrow(db, "drop function public.delete_my_account_data();");
    const r = psql(db, fs.readFileSync(path.join(migrationsDir, "0016_repair_account_deletion.sql"), "utf8"));
    assert.equal(r.ok, false, "0016 reported success with its helper missing");
    assert.match(r.err, /delete_my_account_data\(\) is missing/);
  });

  await test("0016 is re-runnable, and the second run still verifies", () => {
    const db = productionShapedDb();
    applyMigration(db, "0016_repair_account_deletion.sql");
    applyMigration(db, "0016_repair_account_deletion.sql");
    assert.equal(one(db, `select (pg_catalog.to_regprocedure('public.delete_my_account()') is not null)::text;`), "true");
    seedTwoUsers(db);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0);
  });

  await test("AFTER EVERY MIGRATION, the deletion function the client calls exists and works", () => {
    /* The generalising check: not "0016 works" but "the folder, applied
       in order, leaves a working deletion flow". This is the assertion
       whose PRODUCTION counterpart nobody was running — see
       scripts/check-live-database.mjs, which asks the live database the
       same questions. */
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      applyMigration(db, file);
    }
    seedEveryTable(db);
    const tables = userTablesOf(db);
    assert.equal(one(db, `select has_function_privilege('authenticated', 'public.delete_my_account()', 'execute');`), "t");
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0);
    for (const table of tables) {
      assert.equal(count(db, table, `user_id = ${USER}`), 0, `${table} survived a full-folder deletion`);
    }
  });

  await test("the LIVE-DATABASE check reports FAIL before the repair and ALL PASS after it", () => {
    /* The check in supabase/checks/verify-account-deletion.sql is the
       only artifact-level guard here — it asks a real database rather
       than reading a migration file. A check nobody has watched fail is
       a check nobody should trust, so this runs it against the
       production-shaped database (must FAIL, naming the missing
       function) and again after 0016 (must ALL PASS). */
    const check = fs.readFileSync(path.join(rootDir, "supabase/checks/verify-account-deletion.sql"), "utf8");

    const before = psqlOrThrow(productionShapedDb(), check).out;
    assert.match(before, /FAILED/, "the live check passed against a database with no delete_my_account()");
    assert.match(
      before,
      /delete_my_account\(\) exists\s*\|\s*FAIL/,
      "the live check did not name the missing function as the failure"
    );

    const db = productionShapedDb();
    applyMigration(db, "0016_repair_account_deletion.sql");
    const after = psqlOrThrow(db, check).out;
    assert.match(after, /ALL PASS/, `the live check still fails after the repair:\n${after}`);
    assert.ok(!/\|\s*FAIL\s*\|/.test(after), `a property still fails after the repair:\n${after}`);
  });

  await test("0002 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0);
  });

  await test("deletion still works on a project that never created planner_data", () => {
    // SUPABASE-SETUP.md §1 documents planner_data, but no migration creates
    // it — so it genuinely may not exist. It mustn't take the AI-notes
    // cleanup down with it.
    const db = freshDb({ withPlannerData: false });
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db, { withPlannerData: false });

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "public.ai_notes_requests", `user_id = ${USER}`), 0);
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0);
  });

  await test("0003 gives failed requests a column the retention sweep can filter on", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0003_failed_request_retention.sql");
    // NOT NULL DEFAULT false is what makes the two sweeps work: an
    // in-flight row (result still null) has nothing to recover, so it
    // must fall under the SHORT retention, not the long one.
    assert.equal(
      one(db, `select is_nullable from information_schema.columns
                where table_name = 'ai_notes_requests' and column_name = 'summary_failed';`),
      "NO",
      "a nullable summary_failed would make the 7-day sweep skip in-flight rows"
    );
    assert.match(
      one(db, `select column_default from information_schema.columns
                where table_name = 'ai_notes_requests' and column_name = 'summary_failed';`) || "",
      /false/,
      "rows that predate this migration must default to the short retention"
    );
  });

  await test("0003 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0003_failed_request_retention.sql");
    applyMigration(db, "0003_failed_request_retention.sql");
    assert.equal(
      one(db, `select count(*)::text from information_schema.columns
                where table_name = 'ai_notes_requests' and column_name = 'summary_failed';`),
      "1"
    );
  });

  /* ---------- 0005: AI note content in its own row ----------

     These are the first tests here that exercise RLS as a real client
     does, with `set role authenticated`. Everything above runs as the
     superuser, which bypasses policies entirely — fine for testing
     SECURITY DEFINER functions, useless for testing a policy. This table
     is the first one written BY the client under RLS, so the policies are
     the security boundary rather than a second opinion. */

  const asUser = (db, uid, sql) =>
    psql(db, `set test.uid = ${uid}; set role authenticated; ${sql}`);

  const seedNotes = (db) =>
    psqlOrThrow(
      db,
      `insert into public.ai_notes (id, user_id, course, week, content) values
         ('aaaaaaaa-0000-0000-0000-000000000001', ${USER},  'PHYS1001', '3', '{"translations":{"en":{"overview":"mine"}}}'),
         ('bbbbbbbb-0000-0000-0000-000000000002', ${OTHER}, 'LAWS2002', '4', '{"translations":{"en":{"overview":"theirs"}}}');`
    );

  const withNotes = () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    applyMigration(db, "0005_ai_notes.sql");
    psqlOrThrow(db, `insert into auth.users (id) values (${USER}), (${OTHER});`);
    return db;
  };

  await test("a student reads their own lecture notes and cannot see anyone else's", () => {
    const db = withNotes();
    seedNotes(db);
    const mine = asUser(db, USER, `select course from public.ai_notes order by course;`);
    assert.ok(mine.ok, mine.err);
    assert.equal(mine.out, "PHYS1001", "select returned rows belonging to another user");
  });

  await test("a note cannot be inserted under someone else's user_id", () => {
    const db = withNotes();
    const r = asUser(
      db,
      USER,
      `insert into public.ai_notes (id, user_id, content)
         values ('cccccccc-0000-0000-0000-000000000003', ${OTHER}, '{}');`
    );
    assert.equal(r.ok, false, "the insert policy let one user write a row owned by another");
    assert.match(r.err, /row-level security/i);
  });

  await test("one student's delete cannot reach another student's note", () => {
    const db = withNotes();
    seedNotes(db);
    // RLS makes this a no-op rather than an error: the row simply isn't
    // visible to delete. Asserting on the survivor is what makes the test
    // real — a passing statement proves nothing here.
    const r = asUser(db, USER, `delete from public.ai_notes where user_id = ${OTHER};`);
    assert.ok(r.ok, r.err);
    assert.equal(count(db, "public.ai_notes", `user_id = ${OTHER}`), 1, "another user's note was deleted");
    assert.equal(count(db, "public.ai_notes", `user_id = ${USER}`), 1);
  });

  await test("a student can delete their own note", () => {
    const db = withNotes();
    seedNotes(db);
    const r = asUser(db, USER, `delete from public.ai_notes where id = 'aaaaaaaa-0000-0000-0000-000000000001';`);
    assert.ok(r.ok, r.err);
    assert.equal(count(db, "public.ai_notes", `user_id = ${USER}`), 0, "the owner could not delete their own note");
  });

  await test("there is no update path at all, not even for the owner", () => {
    /* The row is immutable by design: activeLanguage — the one thing a
       reader changes — lives in the blob stub instead.

       "Refused twice over" turned out to be half true at 0005: RLS with
       no update policy really does update zero rows, but Supabase's
       default privileges had granted UPDATE all along, so the STATEMENT
       was allowed. This test used to assert it errored, and passed only
       because the shim omitted those defaults. Now it asserts each
       layer at the migration that provides it: zero rows at 0005, and
       the statement refused outright once 0007's revoke lands. */
    const db = withNotes();
    seedNotes(db);
    asUser(db, USER, `update public.ai_notes set course = 'CHANGED' where user_id = ${USER};`);
    assert.equal(count(db, "public.ai_notes", `course = 'CHANGED'`), 0, "an update with no update policy changed a row — a hole, not a missing belt");
    applyMigration(db, "0007_semester_archives.sql");
    const r = asUser(db, USER, `update public.ai_notes set course = 'CHANGED' where user_id = ${USER};`);
    assert.equal(r.ok, false, "0007's revoke no longer closes the grant on ai_notes");
    assert.equal(count(db, "public.ai_notes", `course = 'CHANGED'`), 0);
  });

  await test("account deletion takes the lecture notes with it", () => {
    const db = withNotes();
    seedNotes(db);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    assert.equal(count(db, "public.ai_notes", `user_id = ${USER}`), 0, "the deleted account's notes are still there");
    assert.equal(count(db, "public.ai_notes", `user_id = ${OTHER}`), 1, "deletion reached another user's notes");
  });

  await test("the cascade alone would also clear ai_notes", () => {
    const db = withNotes();
    seedNotes(db);
    psqlOrThrow(db, `delete from auth.users where id = ${USER};`);
    assert.equal(count(db, "public.ai_notes", `user_id = ${USER}`), 0, "ai_notes does not cascade from auth.users");
  });

  await test("deletion clears every table this repo owns, whichever one is added next", () => {
    /* 0005 replaces delete_my_account_data() by copying 0002's body, so an
       edit to 0002 could be silently reverted and a table could be added
       without ever being deleted. Rather than compare the two files (a
       restatement, which is what drifts), this enumerates the tables from
       the database and asserts the applied function empties all of them. */
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      applyMigration(db, file);
    }
    seedTwoUsers(db);
    seedNotes(db);
    // Every user-owned table needs BOTH users' rows, or the
    // "lost another user's rows" half of this test guards nothing.
    psqlOrThrow(
      db,
      `insert into public.semester_archives (id, user_id, label, summary, data) values
         ('cccccccc-0000-0000-0000-000000000001', ${USER},  '2026 · Semester 1', '{"items":412}', '{"courses":[]}'),
         ('dddddddd-0000-0000-0000-000000000002', ${OTHER}, '2026 · Semester 2', '{"items":9}',  '{"courses":[]}');`
    );
    psqlOrThrow(
      db,
      `insert into public.client_errors (user_id, message) values
         (${USER}, 'boom on the deleted account'),
         (${OTHER}, 'boom on the survivor'),
         (null, 'boom from nobody');`
    );

    const owned = one(
      db,
      `select string_agg(table_name, ',' order by table_name)
         from information_schema.columns
        where table_schema = 'public' and column_name = 'user_id';`
    )
      .split(",")
      .filter(Boolean);
    assert.ok(owned.includes("ai_notes"), "the enumeration missed ai_notes, so it is guarding nothing");
    assert.ok(owned.length >= 4, `expected several user-owned tables, found ${owned.join(", ")}`);

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    for (const table of owned) {
      assert.equal(
        count(db, `public.${table}`, `user_id = ${USER}`),
        0,
        `public.${table} has a user_id but delete_my_account_data() does not clear it`
      );
      assert.ok(count(db, `public.${table}`, `user_id = ${OTHER}`) > 0, `public.${table} lost another user's rows`);
    }
    /* Anonymous error reports belong to nobody: account deletion
       removes every row TIED TO THE ACCOUNT, and the deletion page
       says exactly that. Sweeping null rows here would delete other
       signed-out users' diagnostics on every account deletion. */
    assert.equal(count(db, "public.client_errors", "user_id is null"), 1, "account deletion swept the anonymous error reports");
  });


  await test("0005 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = withNotes();
    applyMigration(db, "0005_ai_notes.sql");
    seedNotes(db);
    assert.equal(
      one(db, `select count(*)::text from pg_policies where tablename = 'ai_notes';`),
      "3",
      "re-applying duplicated or dropped a policy"
    );
    assert.equal(one(db, `select relrowsecurity::text from pg_class where relname = 'ai_notes';`), "true");
  });

  /* ---------- 0006: the text allowance ---------- */

  await test("0006 gives ai_usage a text allowance that reads as zero, never null", () => {
    /* NOT NULL DEFAULT 0 is the whole point. A nullable column would
       make `text_units_used + cost > limit` evaluate to NULL for every
       row that predates the migration -- which is falsy, so the
       allowance check would silently pass for everyone who had ever
       used the audio features. */
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0006_ai_text_usage.sql");
    assert.equal(
      one(db, `select is_nullable from information_schema.columns
                where table_name = 'ai_usage' and column_name = 'text_units_used';`),
      "NO",
      "a nullable text_units_used makes every allowance comparison NULL, which reads as 'not over the limit'"
    );
    assert.match(
      one(db, `select column_default from information_schema.columns
                where table_name = 'ai_usage' and column_name = 'text_units_used';`) || "",
      /0/
    );
  });

  await test("a row that predates 0006 reads as no text allowance used", () => {
    // The behaviour the constraint above exists for, checked directly
    // rather than inferred from the schema.
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});
                     insert into public.ai_usage (user_id, month, minutes_used) values (${USER}, '2026-08', 42);`);
    applyMigration(db, "0006_ai_text_usage.sql");
    assert.equal(one(db, `select text_units_used from public.ai_usage where user_id = ${USER};`), "0");
    assert.equal(one(db, `select minutes_used from public.ai_usage where user_id = ${USER};`), "42", "the audio allowance must survive");
  });

  await test("0006 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0006_ai_text_usage.sql");
    applyMigration(db, "0006_ai_text_usage.sql");
    assert.equal(
      one(db, `select count(*)::text from information_schema.columns
                where table_name = 'ai_usage' and column_name = 'text_units_used';`),
      "1"
    );
  });

  await test("a new COLUMN needs no deletion change, unlike a new table", () => {
    // delete_my_account_data() clears ai_usage wholesale, so the whole
    // allowance goes with it. Asserted rather than assumed, because the
    // distinction between "column" and "table" is exactly the kind of
    // thing that gets remembered wrongly — and it is what let the two
    // currencies collapse into one without touching deletion at all.
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) applyMigration(db, file);
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});
                     insert into public.ai_usage (user_id, month, credits_used)
                       values (${USER}, '2026-08', 17);`);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    assert.equal(count(db, "public.ai_usage", `user_id = ${USER}`), 0);
  });

  /* ---------- 0007: semester archives ---------- */

  const withArchives = () => {
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) applyMigration(db, file);
    return db;
  };

  await test("0007 gives semester_archives exactly three policies and RLS", () => {
    const db = withArchives();
    assert.equal(
      one(db, `select count(*)::text from pg_policies where tablename = 'semester_archives';`),
      "3",
      "the ai_notes shape is three policies — select, insert, delete — and nothing else"
    );
    assert.equal(one(db, `select relrowsecurity::text from pg_class where relname = 'semester_archives';`), "true");
    // No update path exists to get wrong: no policy, and no grant.
    assert.equal(
      one(db, `select count(*)::text from pg_policies where tablename = 'semester_archives' and cmd = 'UPDATE';`),
      "0"
    );
    assert.equal(
      one(
        db,
        `select has_table_privilege('authenticated', 'public.semester_archives', 'update')::text;`
      ),
      "false",
      "update is granted — the late-edit fold is insert-new-then-delete-old precisely so it never is"
    );
  });

  await test("0007 revokes the update Supabase's defaults had granted — on ai_notes too", () => {
    /* Supabase's default privileges grant ALL verbs to anon and
       authenticated on every table the SQL editor creates, so the
       explicit three-verb grants in 0005 and 0007 never subtracted
       anything: UPDATE was granted on ai_notes from the day it shipped.
       Found on the real project by re-checking by hand; the shim now
       models the defaults, so omitting the revoke fails HERE too. */
    const db = withArchives();
    for (const table of ["semester_archives", "ai_notes"]) {
      for (const role of ["authenticated", "anon"]) {
        assert.equal(
          one(db, `select has_table_privilege('${role}', 'public.${table}', 'update')::text;`),
          "false",
          `${role} can update public.${table} — the 0007 revoke is gone`
        );
      }
    }
  });

  await test("RLS alone blocked updates even while the grant was open (the state production was in)", () => {
    /* The defence-in-depth question answered by demonstration rather
       than doctrine: re-open the grant (recreating production between
       0005 and the 0007 revoke), attempt an update as the row's OWNER,
       and the statement succeeds while changing NOTHING — with RLS on
       and no UPDATE policy, zero rows are updatable. The revoke is the
       belt; this is the braces holding on their own. */
    const db = withArchives();
    seedTwoUsers(db);
    psqlOrThrow(
      db,
      `insert into public.semester_archives (id, user_id, label, summary, data) values
         ('cccccccc-0000-0000-0000-000000000001', ${USER}, '2026 · Semester 1', '{"items":1}', '{}');
       grant update on public.semester_archives to authenticated;`
    );
    const r = psql(db, `set test.uid = ${USER}; set role authenticated; update public.semester_archives set label = 'CHANGED' where user_id = ${USER};`);
    assert.equal(r.ok, true, "with the grant open the statement itself is allowed");
    assert.equal(count(db, "public.semester_archives", `label = 'CHANGED'`), 0, "RLS let an update through with no update policy — that is a HOLE, not defence-in-depth");
  });

  /* ---------- 0008: the grant audit ----------

     Both tests DERIVE from the database. A list of tables and verbs
     typed in here would be the restatement that has now bitten nine
     times — and this one would go on passing the day someone adds a
     table with the platform's default grants still on it. */

  const ownedTables = (db) =>
    one(
      db,
      `select string_agg(distinct table_name, ',' order by table_name)
         from information_schema.columns
        where table_schema = 'public' and column_name = 'user_id';`
    )
      .split(",")
      .filter(Boolean);

  await test("anon can do NOTHING to any table holding a student's data", () => {
    /* The whole point: with a grant, an unauthenticated read passes the
       grant, reaches a policy whose auth.uid() is NULL, matches no rows
       and returns 200 + []. Silence indistinguishable from "you have no
       data" — the exact confusion every reader in src/ is written to
       avoid, and impossible to avoid at the client if the server cannot
       tell them apart either. Without the grant it is a hard error, and
       every one of those readers already treats an error as unknown. */
    const db = withArchives();
    const tables = ownedTables(db);
    assert.ok(tables.includes("semester_archives") && tables.includes("planner_data"), `the enumeration missed a table: ${tables.join(", ")}`);

    /* THE ONE EXCUSED TABLE, with its reason written down: 0010's
       client_errors holds OUR diagnostics — message, stack, build id,
       page path, browser — never a student's content (the field list
       is pinned by test-error-report). Signed-out crashes matter as
       much as signed-in ones, and signed-out IS anon on the real
       backend, so anon may INSERT — and the excuse is exactly that
       shape: insert only, forced to user_id null by policy, and
       silence-on-read still impossible because no read verb exists to
       answer with silence. Any widening goes red here. */
    for (const table of tables) {
      for (const verb of ["select", "insert", "update", "delete"]) {
        const allowed = table === "client_errors" && verb === "insert";
        assert.equal(
          one(db, `select has_table_privilege('anon', 'public.${table}', '${verb}')::text;`),
          allowed ? "true" : "false",
          allowed
            ? "anon can no longer report a signed-out crash — client_errors lost its insert"
            : `anon can ${verb} public.${table} — an unauthenticated request gets silence instead of a refusal`
        );
      }
    }
    assert.equal(
      one(db, `select count(*)::text from pg_policies where schemaname='public' and tablename='client_errors' and 'anon' = any(roles) and cmd = 'INSERT' and with_check like '%user_id IS NULL%';`),
      "1",
      "the anon insert on client_errors is no longer forced to user_id null"
    );
  });

  /* ---------- 0010: client_errors, write-only by construction ---------- */

  await test("0010: a signed-in client can report its own crash and nobody else's", () => {
    const db = withArchives();
    seedTwoUsers(db);
    assert.equal(asUser(db, USER, `insert into public.client_errors (user_id, message) values (${USER}, 'boom');`).ok, true, "a signed-in client can no longer report");
    const forged = asUser(db, USER, `insert into public.client_errors (user_id, message) values (${OTHER}, 'forged');`);
    assert.equal(forged.ok, false, "a client attributed a report to ANOTHER user");
  });

  await test("0010: anon can report only as nobody, and a null-user report really lands", () => {
    const db = withArchives();
    assert.equal(psql(db, `set role anon; insert into public.client_errors (user_id, message) values (null, 'signed-out boom');`).ok, true, "a signed-out crash can no longer be reported");
    const claimed = psql(db, `set role anon; insert into public.client_errors (user_id, message) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'claimed');`);
    assert.equal(claimed.ok, false, "anon attributed a report to a user id");
  });

  await test("0010: NOBODY reads back — not even the reporter's own rows", () => {
    /* The inverse of the 0008 rule, on purpose: 'no vs nothing'
       matters for reads, and here no read verb exists to answer with
       silence. A client can report and can never read; Jared reads
       from the dashboard. */
    const db = withArchives();
    seedTwoUsers(db);
    psqlOrThrow(db, `insert into public.client_errors (user_id, message) values (${USER}, 'boom');`);
    assert.equal(asUser(db, USER, `select message from public.client_errors;`).ok, false, "a client can read error reports back");
    assert.equal(psql(db, `set role anon; select message from public.client_errors;`).ok, false, "anon can read error reports");
    assert.equal(asUser(db, USER, `delete from public.client_errors where user_id = ${USER};`).ok, false, "a client can delete reports");
    assert.equal(asUser(db, USER, `update public.client_errors set message = 'x';`).ok, false, "a client can rewrite reports");
  });

  await test("0010: the column caps hold, so a runaway client cannot store megabytes a row", () => {
    const db = withArchives();
    const oversize = psql(db, `set role anon; insert into public.client_errors (user_id, message) values (null, repeat('x', 2001));`);
    assert.equal(oversize.ok, false, "a 2001-char message was accepted — the length check is gone");
    assert.match(oversize.err, /check/i);
  });

  await test("0010 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = withArchives();
    applyMigration(db, "0010_client_errors.sql");
    assert.equal(one(db, `select count(*)::text from pg_policies where tablename = 'client_errors';`), "2", "re-applying duplicated or dropped a policy");
  });


  await test("every verb granted to authenticated is a verb that table has a policy for", () => {
    /* Derived both sides: the grants come from the catalogue, the
       policies come from the catalogue, and the invariant is that the
       first is a subset of the second. A granted verb with no policy is
       never useful — RLS gives it zero rows — and it is exactly how
       update sat open on ai_notes from 0005 until it was checked by
       hand on the real project. */
    const db = withArchives();
    for (const table of ownedTables(db)) {
      const policied = new Set(
        one(
          db,
          `select coalesce(string_agg(distinct cmd, ',' order by cmd), '') from pg_policies where schemaname='public' and tablename='${table}';`
        )
          .split(",")
          .filter(Boolean)
          .flatMap((cmd) => (cmd === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : [cmd]))
      );
      for (const verb of ["select", "insert", "update", "delete"]) {
        const granted = one(db, `select has_table_privilege('authenticated', 'public.${table}', '${verb}')::text;`) === "true";
        if (granted) {
          assert.ok(
            policied.has(verb.toUpperCase()),
            `authenticated may ${verb} public.${table} but no policy allows it — the grant is dead weight that returns zero rows instead of refusing`
          );
        }
      }
    }
  });

  await test("the app's own queries still work after the audit — sync, tier and archives", () => {
    /* The audit must not have closed anything the client actually uses:
       planner_data select+upsert (the whole sync), profiles select (the
       plan level), ai_usage select (the allowance mirror), and the
       archive's three verbs. Exercised as the user, not asserted from
       the grant table. */
    const db = withArchives();
    seedTwoUsers(db);
    const ok = (sql) => {
      const r = psql(db, `set test.uid = ${USER}; set role authenticated; ${sql}`);
      assert.equal(r.ok, true, `a query the app makes was refused: ${sql}\n${(r.err || "").slice(0, 200)}`);
    };
    ok(`select data from public.planner_data where user_id = ${USER};`);
    ok(`insert into public.planner_data (user_id, data) values (${USER}, '{"a":1}') on conflict (user_id) do update set data = '{"a":2}';`);
    ok(`select tier from public.profiles where user_id = ${USER};`);
    ok(`select credits_used from public.ai_usage where user_id = ${USER};`);
    ok(`insert into public.semester_archives (id, user_id, label, summary, data) values ('eeeeeeee-0000-0000-0000-000000000001', ${USER}, 'L', '{}', '{}');`);
    ok(`select label from public.semester_archives where user_id = ${USER};`);
    ok(`delete from public.semester_archives where id = 'eeeeeeee-0000-0000-0000-000000000001';`);
    assert.equal(count(db, "public.semester_archives", `user_id = ${USER}`), 0, "the archive delete silently did nothing");
  });

  await test("account deletion still works, because it never depended on a grant", () => {
    // delete_my_account_data() is security definer, so revoking delete
    // on planner_data from authenticated cannot reach it.
    const db = withArchives();
    seedTwoUsers(db);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    assert.equal(count(db, "public.planner_data", `user_id = ${USER}`), 0, "account deletion stopped clearing the planner");
    assert.ok(count(db, "public.planner_data", `user_id = ${OTHER}`) > 0);
  });

  await test("the two upsert flavours need different privileges, and only one of them is a SQL-level problem", () => {
    /* Written after getting this wrong once. supabase-js sends two
       different things and they are NOT equivalent:

         ai_notes      ignoreDuplicates: true  -> ON CONFLICT DO NOTHING
         planner_data  (merge, the default)    -> ON CONFLICT DO UPDATE

       DO NOTHING needs no UPDATE privilege at the SQL level — asserted
       below rather than assumed, because I had claimed otherwise. So
       0008 did not break ai_notes at the database; PostgREST requires
       INSERT **and UPDATE** for any upsert request of either flavour,
       which is one layer above anything reproducible here. That is
       flagged as the limit of what this test can show.

       The fix does not depend on which layer objects: the client stops
       upserting, so no privilege beyond `insert` is involved at all. */
    const db = withArchives();
    seedTwoUsers(db);
    const row = (id, course) =>
      `insert into public.ai_notes (id, user_id, course, week, content) values ('${id}', ${USER}, '${course}', '1', '{}')`;
    const asAuth = (sql) => psql(db, `set test.uid = ${USER}; set role authenticated; ${sql}`);

    /* WHICH upsert the client sends decides everything, so it is
       checked rather than assumed: supabase-js sends
       `Prefer: resolution=ignore-duplicates` for ai_notes (PostgREST
       emits ON CONFLICT DO NOTHING) and `merge-duplicates` for
       planner_data (ON CONFLICT DO UPDATE). DO NOTHING needs no UPDATE
       privilege — asserted here, because if it did not hold, the 400
       would have another cause and the fix below would be wrong. */
    const doNothing = asAuth(`${row("bbbbbbbb-0000-4000-8000-000000000009", "PHYS")} on conflict (id) do nothing;`);
    assert.equal(doNothing.ok, true, "ON CONFLICT DO NOTHING was refused without UPDATE — then the client's 400 is not the privilege");

    // 0008's state: a MERGE upsert is refused outright, conflict or not.
    const revoked = asAuth(`${row("cccccccc-0000-4000-8000-000000000001", "PHYS")} on conflict (id) do update set course = excluded.course;`);
    assert.equal(revoked.ok, false, "an upsert succeeded without the update privilege — the 400 has another cause");
    assert.match(revoked.err, /permission denied/i);

    // A plain insert of the same row is fine: granted, and policied.
    assert.equal(asAuth(row("cccccccc-0000-4000-8000-000000000001", "PHYS")).ok, true, "a plain insert must still work, or the fix is no fix");

    // Production's pre-0008 state: the grant back, still no policy.
    psqlOrThrow(db, `grant update on public.ai_notes to authenticated;`);
    assert.equal(
      asAuth(`${row("cccccccc-0000-4000-8000-000000000002", "CHEM")} on conflict (id) do update set course = excluded.course;`).ok,
      true,
      "restoring the grant does unbreak the ordinary insert path"
    );
    // But a REAL conflict is still refused — by RLS this time.
    const conflict = asAuth(`${row("cccccccc-0000-4000-8000-000000000002", "BIOL")} on conflict (id) do update set course = excluded.course;`);
    assert.equal(conflict.ok, false, "a conflicting upsert succeeded — then an update policy exists and this reasoning is wrong");
    assert.match(conflict.err, /row-level security/i);
  });

  await test("a duplicate insert reports 23505, which the client can read as already-migrated", () => {
    // The fix's other half: the retry case must be recognisable by a
    // DEFINITIVE code, so treating it as success cannot swallow a real
    // failure — the same rule as fetchNote's missing-vs-failed split.
    const db = withArchives();
    seedTwoUsers(db);
    const ins = (id) => `insert into public.ai_notes (id, user_id, course, week, content) values ('${id}', ${USER}, 'PHYS', '1', '{}')`;
    const asAuth = (sql) => psql(db, `set test.uid = ${USER}; set role authenticated; ${sql}`);
    assert.equal(asAuth(ins("dddddddd-0000-4000-8000-000000000001")).ok, true);
    const dup = asAuth(ins("dddddddd-0000-4000-8000-000000000001"));
    assert.equal(dup.ok, false);
    assert.match(dup.err, /duplicate key value|23505/i);
  });

  await test("every table the client upserts has UPDATE granted — derived from src/, not from memory", () => {
    /* THE GUARD THAT WOULD HAVE CAUGHT THIS. My audit test enumerated
       "the app's own queries" by hand, from reading the client — a
       restatement, and it drifted at exactly the point that mattered:
       I wrote planner_data's upsert into it and left ai_notes out.

       This reads the client instead. Every `.from("X")…upsert(` in src/
       must have UPDATE granted on X, because PostgREST turns an upsert
       into ON CONFLICT DO UPDATE, which needs it even to insert. Add an
       upsert anywhere, or revoke an update anywhere, and this goes red
       without anyone remembering the connection. */
    const db = withArchives();
    const src = fs
      .readdirSync(path.join(rootDir, "src"))
      .filter((f) => /\.jsx?$/.test(f))
      .map((f) => fs.readFileSync(path.join(rootDir, "src", f), "utf8"))
      .join("\n")
      // Comments first: this project has tripped that guard three times.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

    const upserts = [];
    for (const m of src.matchAll(/\.from\(\s*(?:"([^"]+)"|TABLE)\s*\)([\s\S]{0,600}?)\.upsert\(([\s\S]{0,400}?)\)\s*[;,)]/g)) {
      // `.from(TABLE)` is sync.js's planner_data constant.
      upserts.push({ table: m[1] || "planner_data", merges: !/ignoreDuplicates:\s*true/.test(m[3]) });
    }
    assert.ok(
      /\.upsert\(/.test(src) === upserts.length > 0,
      "an upsert exists that this pattern did not match — the guard is blind rather than satisfied"
    );

    for (const { table, merges } of upserts) {
      if (one(db, `select to_regclass('public.${table}') is not null;`) !== "t") continue; // created outside the migrations
      assert.equal(
        one(db, `select has_table_privilege('authenticated', 'public.${table}', 'update')::text;`),
        "true",
        `src/ upserts into public.${table}, but authenticated cannot UPDATE it — PostgREST requires INSERT and UPDATE ` +
          "for any upsert, of either flavour, so every write to that table will fail even when nothing conflicts"
      );
      if (merges) {
        // A merge upsert really does update on conflict, so it needs the
        // policy too — a grant without one fails under RLS at exactly
        // the moment the merge was wanted.
        assert.ok(
          one(db, `select count(*)::text from pg_policies where schemaname='public' and tablename='${table}' and cmd='UPDATE';`) !== "0",
          `public.${table} is merge-upserted by the client but has no UPDATE policy — the conflict path fails under RLS`
        );
      }
    }
  });

  await test("nothing upserts into ai_notes any more — it inserts, so `insert` is the only verb it needs", () => {
    /* The fix, pinned where the privilege lives. If someone reaches for
       an upsert here again to get idempotency back, this says why not:
       the row is immutable by design and the retry case is 23505. */
    const store = fs.readFileSync(path.join(rootDir, "src/aiNotesStore.js"), "utf8");
    const migrate = store.slice(store.indexOf("export async function migrateNote"), store.indexOf("/* ---------- reading"));
    assert.ok(!/\.upsert\(/.test(migrate), "migrateNote is upserting again — that needs an UPDATE privilege on an immutable table");
    assert.match(migrate, /\.insert\(/);
    assert.match(migrate, /DUPLICATE_KEY/, "the already-migrated case is no longer recognised, so a retry reports failure forever");
  });

  /* ---------- client-generated ids vs typed columns ----------

     GENERALISED after ai_notes.id: a value minted in the browser and
     stored in the blob may be any shape, and the same value crossing
     into a typed column may not. That boundary is invisible from
     either side — the client sees a string it made up, the column sees
     a string that arrives — so it gets a guard that runs the REAL
     generator against the REAL column.

     The mapping below is the part a human decides; the enumeration
     underneath is what forces them to. A new id column fails here
     until someone says which generator feeds it, or writes down that
     nothing client-side does. */

  const GENERATED_IDS = {
    // The planner's own short id, straight out of the blob. This is the
    // one that was wrong: a uuid column rejected every AI note from
    // 0005 until 0009 moved it to text.
    "ai_notes.id": () => {
      const src = fs.readFileSync(path.join(rootDir, "src/PlannerApp.jsx"), "utf8");
      const m = /^const uid = (\(\) => `[^`]+`);/m.exec(src);
      assert.ok(m, "couldn't find the planner's uid() helper — this guard is blind, fix the pattern");
      return new Function(`return ${m[1]}`)()();
    },
    // Minted by newIdempotencyKey() precisely because it crosses into a
    // uuid column; the Edge Function validates it again before insert.
    "ai_notes_requests.idempotency_key": () => newIdempotencyKey(),
    /* The one-device rule's identifier — and it is the id the app has
       always minted for merges, not a second one. Lifted out of
       sync.js's source the same way uid() is lifted out of
       PlannerApp.jsx, so a change of FORMAT follows rather than pins. */
    "profiles.active_device_id": () => newDeviceIdFromSource(),
    // Same generator, for the same reason.
    "semester_archives.id": () => newIdempotencyKey(),
    // Not an identifier but client-minted text crossing into a typed
    // column all the same: buildId() in PlannerApp.jsx returns the
    // 12-hex build stamp from the meta tag, or the literal
    // "development" when unstamped — which is its real output in any
    // DOM-less run, so that is what gets inserted against the column
    // and its 64-char cap.
    "client_errors.build_id": () => "development",
  };

  /* Columns no client value ever reaches. Each needs a reason, because
     "nothing writes this" is a decision and silence is not. */
  const SERVER_ONLY_IDS = {
    "ai_usage.id": "written by the Edge Functions under service role; the client only ever reads it",
    "profiles.id": "created by the signup trigger; the client only ever reads tier",
    "planner_data.user_id": "the auth user id, minted by Supabase rather than by anything in this repo",
    "client_errors.id": "gen_random_uuid() default on the column; the client never supplies one",
    "client_errors.user_id": "the auth user id when signed in, null when not — only ever copied from the session",
    "ai_notes.user_id": "the auth user id, minted by Supabase and only ever copied from the session",
    "ai_notes_requests.user_id": "the auth user id, minted by Supabase and only ever copied from the session",
    "ai_usage.user_id": "the auth user id, minted by Supabase and only ever copied from the session",
    "profiles.user_id": "the auth user id, minted by Supabase and only ever copied from the session",
    "semester_archives.user_id": "the auth user id, minted by Supabase and only ever copied from the session",
  };

  await test("every id column is either fed by a named client generator or excused with a reason", () => {
    const db = withArchives();
    const cols = one(
      db,
      `select string_agg(table_name || '.' || column_name, ',' order by table_name, column_name)
         from information_schema.columns
        where table_schema = 'public'
          and (column_name = 'id' or column_name like '%\\_id' or column_name like '%\\_key');`
    )
      .split(",")
      .filter(Boolean);
    assert.ok(cols.length >= 6, `the enumeration found only ${cols.length} id columns — the pattern is wrong`);
    for (const col of cols) {
      assert.ok(
        GENERATED_IDS[col] || SERVER_ONLY_IDS[col],
        `public.${col} is an id column and nothing says where its value comes from. ` +
          "If a client mints it, add it to GENERATED_IDS so its real format is checked against this column; " +
          "if not, say so in SERVER_ONLY_IDS."
      );
      if (SERVER_ONLY_IDS[col]) assert.ok(SERVER_ONLY_IDS[col].length > 20, `public.${col} is excused without a reason`);
    }
  });

  await test("every column a client mints ids for accepts the ids that client actually mints", () => {
    /* Values are GENERATED, never typed: a literal here would pin
       today's format and pass the day the generator changed — which is
       the shape of every restatement bug in this project. */
    const db = withArchives();
    seedTwoUsers(db);
    const insertFor = {
      "ai_notes.id": (v) =>
        `insert into public.ai_notes (id, user_id, course, week, content) values ('${v}', ${USER}, 'PHYS1001', '3', '{}')`,
      "ai_notes_requests.idempotency_key": (v) =>
        `insert into public.ai_notes_requests (idempotency_key, user_id, status) values ('${v}', ${USER}, 'pending')`,
      "semester_archives.id": (v) =>
        `insert into public.semester_archives (id, user_id, label, summary, data) values ('${v}', ${USER}, 'L', '{}', '{}')`,
      "client_errors.build_id": (v) =>
        `insert into public.client_errors (user_id, message, build_id) values (${USER}, 'boom', '${v}')`,
      /* Not an insert, because the client cannot insert or update
         profiles at all — 0008 revoked those and `tier` lives on that
         table, so relaxing it would let a student set their own tier.
         The real write path is the function, so the function is what
         gets exercised: same question (does the column accept what the
         client mints), asked of the only route that exists. */
      "profiles.active_device_id": (v) => `select public.claim_device('${v}')`,
    };
    for (const [col, gen] of Object.entries(GENERATED_IDS)) {
      const value = gen();
      assert.ok(value && typeof value === "string", `${col}'s generator produced nothing`);
      assert.ok(insertFor[col], `${col} has a generator but no insert to exercise it with`);
      /* As the OWNER for the service-role-only table: 0008 revoked
         insert on ai_notes_requests from authenticated, and that is
         correct — only the Edge Function writes it. The question here
         is the column's TYPE, not who may write it. */
      const asOwner = col.startsWith("ai_notes_requests.");
      const r = psql(db, asOwner ? `${insertFor[col](value)};` : `set test.uid = ${USER}; set role authenticated; ${insertFor[col](value)};`);
      assert.equal(
        r.ok,
        true,
        `public.${col} rejected a value its own client mints (${value}). Every write down that path fails:\n${(r.err || "").slice(0, 160)}`
      );
    }
  });

  await test("a UUID id still works, so notes written before 0009 are unaffected", () => {
    const db = withArchives();
    seedTwoUsers(db);
    const r = psql(
      db,
      `set test.uid = ${USER}; set role authenticated;
       insert into public.ai_notes (id, user_id, course, week, content)
       values ('aaaaaaaa-0000-4000-8000-00000000ffff', ${USER}, 'C', '1', '{}');`
    );
    assert.equal(r.ok, true, "the text column stopped accepting the uuids already stored under it");
  });

  await test("0008 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = withArchives();
    applyMigration(db, "0008_grant_audit.sql");
    assert.equal(one(db, `select has_table_privilege('anon', 'public.semester_archives', 'select')::text;`), "false");
    assert.equal(one(db, `select has_table_privilege('authenticated', 'public.semester_archives', 'select')::text;`), "true");
  });

  await test("0007 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = withArchives();
    applyMigration(db, "0007_semester_archives.sql");
    assert.equal(one(db, `select count(*)::text from pg_policies where tablename = 'semester_archives';`), "3");
    // The re-run must also re-close the grant the test above re-opened
    // in its own db; here it simply asserts revoke is idempotent.
    assert.equal(one(db, `select has_table_privilege('authenticated', 'public.semester_archives', 'update')::text;`), "false");
  });

  /* ---------- 0011: the allowance increment is atomic ---------- */

  const withUsage = () => {
    const db = withArchives();
    psqlOrThrow(
      db,
      `insert into auth.users (id) values (${USER});
       insert into public.ai_usage (user_id, month, credits_used)
         values (${USER}, '2026-08', 0);`
    );
    return db;
  };
  const minutes = (db) =>
    Number(one(db, `select credits_used::text from public.ai_usage where user_id = ${USER} and month = '2026-08';`));

  await test("THE LOST UPDATE, demonstrated: a read-modify-write drops one of two concurrent bills", async () => {
    /* This asserts the BUG, not the fix, and it is here so the next
       test means something. Without it, "two concurrent calls add up"
       could be passing because the two calls never actually overlapped
       — a green test proving nothing, which is the failure mode every
       concurrency test has.

       Session A reads 0, sleeps, writes 0 + 3. Session B reads 0 (A has
       not written yet), sleeps, blocks on A's row lock, and then writes
       its own stale 0 + 3. Total 3, not 6. */
    const db = withUsage();
    const readModifyWrite = (cost) => `
      begin;
      do $$
      declare v numeric;
      begin
        select credits_used into v from public.ai_usage where user_id = ${USER} and month = '2026-08';
        perform pg_sleep(0.4);
        update public.ai_usage set credits_used = v + ${cost} where user_id = ${USER} and month = '2026-08';
      end $$;
      commit;`;
    const both = await Promise.all([psqlAsync(db, readModifyWrite(3)), psqlAsync(db, readModifyWrite(3))]);
    for (const r of both) assert.ok(r.ok, `a session failed: ${r.err}`);
    assert.equal(
      minutes(db),
      3,
      "the two sessions did not overlap, so this test is not demonstrating anything — raise the sleep"
    );
  });

  await test("add_ai_credits keeps both concurrent bills, because the addition happens under the row lock", async () => {
    /* The fix, under exactly the interleaving above. MUTATION CHECK:
       change `ai_usage.minutes_used + excluded.minutes_used` to
       `excluded.minutes_used` in 0011 and this reads 3. */
    const db = withUsage();
    const atomic = `
      begin;
      select pg_sleep(0.4);
      select * from public.add_ai_credits(${USER}, '2026-08', 3);
      commit;`;
    const both = await Promise.all([psqlAsync(db, atomic), psqlAsync(db, atomic)]);
    for (const r of both) assert.ok(r.ok, `a session failed: ${r.err}`);
    assert.equal(minutes(db), 6, "one of two concurrent bills was lost");
  });

  await test("add_ai_credits creates the month's row when there isn't one, and adds to it when there is", async () => {
    const db = withArchives();
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-09', 3);`);
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-09', 2);`);
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-09', 51);`);
    assert.equal(
      one(db, `select credits_used::text from public.ai_usage where month = '2026-09';`),
      "56",
      "the single counter must accumulate across every kind of action"
    );
    assert.equal(one(db, `select count(*)::text from public.ai_usage where month = '2026-09';`), "1", "one row per user per month");
  });

  await test("add_ai_credits returns the totals it just wrote, so no caller reports a stale figure", () => {
    const db = withUsage();
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-08', 4);`);
    assert.equal(one(db, `select new_credits::text from public.add_ai_credits(${USER}, '2026-08', 7);`), "11");
    // Adding nothing returns the running total rather than zero — which
    // is what makes the returned figure usable as "what to show now".
    assert.equal(one(db, `select new_credits::text from public.add_ai_credits(${USER}, '2026-08', 0);`), "11");
  });

  await test("only service_role may call add_ai_credits — the caller names the user_id", () => {
    /* A function's platform default is EXECUTE TO PUBLIC, which is the
       same default-grant trap 0008 found on the tables one layer down.
       It matters more here than on a table: this takes p_user_id as an
       argument, so an execute grant to `authenticated` would read
       "spend anybody's allowance". */
    const db = withArchives();
    const sig = "public.add_ai_credits(uuid, text, numeric)";
    for (const role of ["anon", "authenticated", "public"]) {
      assert.equal(
        one(db, `select has_function_privilege('${role}', '${sig}', 'execute')::text;`),
        "false",
        `${role} can call add_ai_credits`
      );
    }
    assert.equal(one(db, `select has_function_privilege('service_role', '${sig}', 'execute')::text;`), "true");
  });

  await test("0012's backfill carries the two old counters into the one new one", () => {
    /* The migration a real project will run once, on rows that already
       hold a month's spend. Applied at 0011 depth so the old columns are
       still there — which is the state every existing account is in. */
    const db = freshDb();
    for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
      if (f.startsWith("0012") || f.startsWith("0013")) break;
      applyMigration(db, f);
    }
    psqlOrThrow(
      db,
      `insert into auth.users (id) values (${USER});
       insert into public.ai_usage (user_id, month, minutes_used, text_units_used)
         values (${USER}, '2026-08', 40, 12), (${USER}, '2026-07', 0, 0);`
    );
    applyMigration(db, "0012_one_currency.sql");
    assert.equal(
      one(db, `select credits_used::text from public.ai_usage where month = '2026-08';`),
      "52",
      "the backfill lost a month's spend — a text unit was already worth about a credit, so the sum carries"
    );
    assert.equal(one(db, `select credits_used::text from public.ai_usage where month = '2026-07';`), "0");
  });

  await test("0012 is re-runnable, even after 0013 has taken the columns it reads", () => {
    /* THE FAILURE THIS CATCHES is specific and easy to ship: 0012's
       backfill names minutes_used, 0013 drops it, and a re-apply of the
       whole folder then dies on a column that is supposed to be gone.
       Re-runnable exactly once is not re-runnable. */
    const db = withUsage();
    applyMigration(db, "0012_one_currency.sql");
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-08', 5);`);
    assert.equal(minutes(db), 5, "the re-applied function stopped adding");
    assert.equal(
      one(db, `select has_function_privilege('authenticated', 'public.add_ai_credits(uuid, text, numeric)', 'execute')::text;`),
      "false",
      "the re-run must re-close the grant, not just create the function"
    );
  });

  /* ---------- 0014: per-tier allowances and the lifetime trial ---------- */

  await test("the trial counter is on the ACCOUNT, with no month in it", () => {
    /* The whole shape. ai_usage is keyed (user_id, month) and a lifetime
       allowance has no month; a sentinel month would be invisible to
       every query that filters on the current one, which reports the
       trial as unspent forever. */
    const db = withArchives();
    assert.equal(
      one(db, `select data_type from information_schema.columns
                where table_schema='public' and table_name='profiles' and column_name='trial_credits_used';`),
      "numeric"
    );
    assert.equal(
      one(db, `select count(*)::text from information_schema.columns
                where table_schema='public' and table_name='profiles' and column_name like '%month%';`),
      "0",
      "profiles grew a month column — the trial is not a monthly allowance and must not gain one"
    );
  });

  await test("add_trial_credits ADDS, and a new month does not reset it", () => {
    /* The property the lifetime trial IS. A month rolling over must not
       touch this counter, and the way that breaks is somebody keying it
       by month "for consistency" with ai_usage. */
    const db = withArchives();
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    psqlOrThrow(db, `select * from public.add_trial_credits(${USER}, 20);`);
    psqlOrThrow(db, `select * from public.add_trial_credits(${USER}, 25);`);
    assert.equal(one(db, `select trial_credits_used::text from public.profiles where user_id = ${USER};`), "45");
    /* Spending in a different MONTH lands on the same counter, because
       there is no month to land in. */
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-09', 7);`);
    assert.equal(
      one(db, `select trial_credits_used::text from public.profiles where user_id = ${USER};`),
      "45",
      "the monthly counter wrote into the lifetime one, or the reverse"
    );
    assert.equal(one(db, `select new_trial_credits::text from public.add_trial_credits(${USER}, 0);`), "45");
  });

  await test("NO ROLLOVER: a fresh month starts at nothing, and cannot inherit a balance", () => {
    /* True by construction — a new month simply has no row — and
       asserted anyway, because the way it stops being true is somebody
       adding "carry over what you didn't use", which is three lines and
       would turn a semester's prepayment into one month's spending. */
    const db = withArchives();
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-08', 400);`);
    assert.equal(one(db, `select count(*)::text from public.ai_usage where user_id = ${USER} and month = '2026-09';`), "0");
    psqlOrThrow(db, `select * from public.add_ai_credits(${USER}, '2026-09', 5);`);
    assert.equal(
      one(db, `select credits_used::text from public.ai_usage where user_id = ${USER} and month = '2026-09';`),
      "5",
      "a new month inherited last month's spend, or its unused balance"
    );
    assert.equal(one(db, `select credits_used::text from public.ai_usage where user_id = ${USER} and month = '2026-08';`), "400");
  });

  await test("only service_role may spend somebody's trial", () => {
    const db = withArchives();
    const sig = "public.add_trial_credits(uuid, numeric)";
    for (const role of ["anon", "authenticated", "public"]) {
      assert.equal(one(db, `select has_function_privilege('${role}', '${sig}', 'execute')::text;`), "false", `${role} can spend a trial`);
    }
    assert.equal(one(db, `select has_function_privilege('service_role', '${sig}', 'execute')::text;`), "true");
  });

  await test("deleting an account takes the trial counter with it — the hole, asserted", () => {
    /* NOT a bug being fixed. delete_my_account_data() empties profiles,
       so delete-and-resignup resets the lifetime trial. There is no
       clean fix that keeps both promises, the hole costs about four
       cents per abuse and needs a fresh confirmed email each time, and
       it is accepted deliberately. Asserted so nobody later "fixes" it
       by retaining a per-email counter after a deletion request. */
    const db = withArchives();
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    psqlOrThrow(db, `select * from public.add_trial_credits(${USER}, 60);`);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    assert.equal(count(db, "public.profiles", `user_id = ${USER}`), 0, "the trial counter survived account deletion");
  });

  await test("claim_device writes only the caller's own row, whoever asks", () => {
    /* THE WHOLE REASON IT IS A FUNCTION. `profiles` holds `tier`, so
       granting update on it to `authenticated` — the obvious way to let
       a client record a device — would also let any student set their
       own tier to the top one. A definer function that writes two named
       columns is the narrow version of the same capability, and this is
       the assertion that it really is narrow: the caller names no user,
       so there is no parameter to point at somebody else. */
    const db = withArchives();
    seedTwoUsers(db);
    const mine = newDeviceIdFromSource();
    const r = psql(db, `set test.uid = ${USER}; set role authenticated; select public.claim_device('${mine}');`);
    assert.equal(r.ok, true, `claim_device refused an authenticated caller: ${(r.err || "").slice(0, 200)}`);

    const check = psql(db, `select user_id, active_device_id from public.profiles order by user_id;`);
    assert.equal(check.ok, true);
    const claimed = check.out.split("\n").filter((l) => l.includes(mine));
    assert.equal(claimed.length, 1, "claim_device wrote a device id onto more than one account, or onto none");
  });

  await test("the client still cannot write profiles directly — tier stays out of reach", () => {
    /* The other half. If this ever passes, the allowance system is one
       UPDATE away from being self-service. */
    const db = withArchives();
    seedTwoUsers(db);
    const r = psql(db, `set test.uid = ${USER}; set role authenticated; update public.profiles set tier = 'ai_max' where user_id = ${USER};`);
    const tier = psql(db, `select tier from public.profiles where user_id = ${USER};`);
    assert.ok(!/ai_max/.test(tier.out), "an authenticated client set its own tier — profiles is writable again");
  });

  await test("a signed-out caller cannot claim a device, and is told so rather than silently ignored", () => {
    /* 0008's rule: make "no" and "nothing" different answers. With the
       grant revoked, anon gets a permission error; with it granted, the
       update would match no row and return an empty set — byte-identical
       to a successful claim of nothing. */
    const db = withArchives();
    seedTwoUsers(db);
    const r = psql(db, `set role anon; select public.claim_device('dev-whatever');`);
    assert.equal(r.ok, false, "anon may call claim_device — a signed-out caller gets silence instead of a refusal");
    assert.match(r.err || "", /permission denied/i, `expected a permission error, got: ${(r.err || "").slice(0, 200)}`);
  });

  await test("0015 is re-runnable, and a re-apply does not forget which device holds the account", () => {
    /* Re-runnable is not enough on its own: `add column if not exists`
       is inert on a second pass, but a re-apply that reset the column
       would sign every trial student out on the next deploy that
       re-ran the folder. So the claim is planted first and checked
       after. */
    const db = withArchives();
    seedTwoUsers(db);
    const mine = newDeviceIdFromSource();
    psqlOrThrow(db, `set test.uid = ${USER}; set role authenticated; select public.claim_device('${mine}');`);
    applyMigration(db, "0015_device_claim.sql");
    assert.equal(
      one(db, `select active_device_id from public.profiles where user_id = ${USER};`),
      mine,
      "re-applying 0015 dropped the active device — every trial student would be signed out by the next deploy"
    );
  });

  await test("0014 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = withArchives();
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    psqlOrThrow(db, `select * from public.add_trial_credits(${USER}, 12);`);
    applyMigration(db, "0014_per_tier_allowance.sql");
    assert.equal(one(db, `select trial_credits_used::text from public.profiles where user_id = ${USER};`), "12", "the re-apply reset a lifetime counter");
    assert.equal(
      one(db, `select has_function_privilege('authenticated', 'public.add_trial_credits(uuid, numeric)', 'execute')::text;`),
      "false"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  // "Ran to completion having tested nothing" is the other way this could
  // go quiet — an exit 0 that means nothing. Caught here rather than left
  // to be noticed.
  if (passed === 0) {
    console.error("migration tests reported no results at all — treating that as a failure, not a pass");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

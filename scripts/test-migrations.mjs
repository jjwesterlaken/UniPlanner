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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
   any user — that's the whole mechanism these functions are built on. */
const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;

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
const PLANNER_DATA = `
  create table public.planner_data (
    user_id uuid primary key references auth.users(id) on delete cascade,
    data jsonb not null,
    updated_at timestamptz not null default now()
  );
  alter table public.planner_data enable row level security;
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

const USER = "'11111111-1111-1111-1111-111111111111'";
const OTHER = "'22222222-2222-2222-2222-222222222222'";

function seedTwoUsers(db, { withPlannerData = true } = {}) {
  psqlOrThrow(
    db,
    `insert into auth.users (id) values (${USER}), (${OTHER});
     insert into public.ai_usage (user_id, month, minutes_used) values (${USER}, '2026-08', 12), (${OTHER}, '2026-08', 5);
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

  await test("anon can't call the deletion functions; authenticated can", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
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
